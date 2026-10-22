import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@lecturn/contracts/relay";

import * as ManagedAccess from "../billing/ManagedAccess.ts";
import * as ManagedReservations from "../billing/ManagedReservations.ts";
import * as RelayConfiguration from "../Config.ts";
import {
  managedEndpointDigestInput,
  managedEndpointForHostname,
  managedEndpointHostname,
  managedEndpointTunnelName,
  relayStageSlug,
} from "../deploymentConfig.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import {
  ManagedGatewayEnrollment,
  type GatewayEnrollmentMapping,
} from "./ManagedGatewayEnrollment.ts";

export class ManagedEndpointProvisioningNotConfigured extends Schema.TaggedError<ManagedEndpointProvisioningNotConfigured>()(
  "ManagedEndpointProvisioningNotConfigured",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    missingSettings: Schema.Array(
      Schema.Literals(["managedEndpointBaseDomain", "managedEndpointNamespace"]),
    ),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning is not configured for user '${this.userId}', environment '${this.environmentId}': missing ${this.missingSettings.join(", ")}`;
  }
}

const ManagedEndpointProvisioningStage = Schema.Literals([
  "derive-environment-hash",
  "check-tunnel-limit",
  "reserve-allocation",
  "ensure-tunnel",
  "validate-tunnel-response",
  "record-tunnel",
  "configure-tunnel",
  "ensure-dns-record",
  "record-dns",
  "get-tunnel-token",
  "mark-allocation-ready",
  "gateway-enrollment",
  "load-allocation",
  "verify-endpoint",
  "sync-origin",
]);

// Why a stage failed without an underlying error. `claim-lost` means another
// provision, release, or deprovision changed the allocation's generation or
// tunnel after this one loaded it.
const ManagedEndpointProvisioningFailureReason = Schema.Literals([
  "claim-lost",
  "endpoint-mismatch",
  "invalid-tunnel-response",
]);

export class ManagedEndpointProvisioningFailed extends Schema.TaggedError<ManagedEndpointProvisioningFailed>()(
  "ManagedEndpointProvisioningFailed",
  {
    stage: ManagedEndpointProvisioningStage,
    reason: Schema.optionalKey(ManagedEndpointProvisioningFailureReason),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    returnedTunnelName: Schema.optionalKey(Schema.String),
    returnedTunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

const ManagedEndpointDeprovisioningStage = Schema.Literals([
  "load-allocation",
  "load-tunnel",
  "claim-release",
  "claim-deprovision",
  "delete-dns-record",
  "delete-tunnel",
  "remove-allocation",
  "gateway-cutoff",
]);

export class ManagedEndpointDeprovisioningFailed extends Schema.TaggedError<ManagedEndpointDeprovisioningFailed>()(
  "ManagedEndpointDeprovisioningFailed",
  {
    stage: ManagedEndpointDeprovisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed endpoint deprovisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class ManagedEndpointOriginNotAllowed extends Schema.TaggedError<ManagedEndpointOriginNotAllowed>()(
  "ManagedEndpointOriginNotAllowed",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    host: Schema.String,
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed endpoint origin '${this.host}:${this.port}' is not allowed for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export type ManagedEndpointProviderError =
  | ManagedAccess.ManagedAccessRequired
  | ManagedAccess.ManagedAccessUnavailable
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedEndpointOriginNotAllowed
  | ManagedTunnelLimits.ManagedTunnelLimitExceeded;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
}

export type ManagedEndpointOriginSyncResult = "ready" | "recovery_required";

export interface ManagedEndpointDeprovisionTarget {
  readonly allocation: ManagedEndpointAllocations.ManagedEndpointAllocation | null;
  readonly reservationGeneration: number | null;
  readonly gatewayMapping?: GatewayEnrollmentMapping | null;
}

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  {
    readonly provision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly origin: RelayManagedEndpointOrigin;
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
    readonly reconcileOrigin: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<ManagedEndpointOriginSyncResult, ManagedEndpointProviderError>;
    /**
     * Repoints an already provisioned tunnel at the environment's current
     * loopback origin. Environments call this at boot because their local port
     * can change between launches while the tunnel keeps the origin captured at
     * link time. Upkeep only: it never creates tunnels, DNS records, or
     * reservations. Resolves to whether a tunnel's ingress was rewritten.
     */
    readonly syncOrigin: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly origin: RelayManagedEndpointOrigin;
    }) => Effect.Effect<
      boolean,
      | ManagedAccess.ManagedAccessUnavailable
      | ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError
      | ManagedEndpointOriginNotAllowed
      | ManagedEndpointProvisioningFailed
    >;
    /**
     * Captures the allocation generation owned by an unlink before its link
     * revocation commits. Passing this target to `deprovision` prevents a
     * concurrent relink from having its newer allocation torn down.
     */
    readonly prepareDeprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<
      ManagedEndpointDeprovisionTarget | null,
      ManagedEndpointDeprovisioningFailed
    >;
    readonly deprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly target?: ManagedEndpointDeprovisionTarget | null;
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
    /**
     * Deletes the provisioned Cloudflare tunnel while keeping the allocation
     * (hostname + tunnel name reservation) and DNS record. Cloudflare bills per
     * provisioned tunnel, so environments release the tunnel when they shut
     * down; the next `provision` recreates it under the same name and repoints
     * the CNAME, preserving the endpoint URL.
     *
     * Resolves to whether the caller's connector token is now dead: true when
     * the tunnel was deleted (or none was recorded to begin with), false when
     * a concurrent provision outbid the release claim and the recorded tunnel
     * — and any token issued for it — stays live.
     */
    readonly release: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly expectedTunnelId?: string;
      readonly expectedInactiveBefore?: string;
      readonly expectedStatus?: "inactive" | "down";
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
  }
>()("lecturn-relay/environments/ManagedEndpointProvider") {}

export interface ManagedEndpointTunnel {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly status?: string | null;
  readonly createdAt?: string | null;
  readonly connsInactiveAt?: string | null;
}

export interface ManagedEndpointTunnelListRequest {
  readonly isDeleted: false;
  readonly name?: string;
  readonly includePrefix?: string;
  readonly status?: "inactive" | "down";
  readonly existedAt?: string;
  readonly wasInactiveAt?: string;
  readonly page?: number;
  readonly perPage?: number;
}

const ManagedEndpointTunnelClientOperation = Schema.Literals([
  "get",
  "list",
  "create",
  "put-configuration",
  "get-token",
  "delete",
]);

export class ManagedEndpointTunnelClientError extends Schema.TaggedError<ManagedEndpointTunnelClientError>()(
  "ManagedEndpointTunnelClientError",
  {
    operation: ManagedEndpointTunnelClientOperation,
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.tunnelId ?? this.tunnelName;
    return `Managed endpoint tunnel provider '${this.operation}' request failed${target === undefined ? "" : ` for '${target}'`}`;
  }
}

export class ManagedEndpointTunnelClient extends Context.Service<
  ManagedEndpointTunnelClient,
  {
    readonly get: (
      tunnelId: string,
    ) => Effect.Effect<ManagedEndpointTunnel, ManagedEndpointTunnelClientError>;
    readonly list: (request: ManagedEndpointTunnelListRequest) => Effect.Effect<
      {
        readonly result: ReadonlyArray<ManagedEndpointTunnel>;
        readonly resultInfo?: {
          readonly page?: number | null;
          readonly perPage?: number | null;
          readonly totalCount?: number | null;
        } | null;
      },
      ManagedEndpointTunnelClientError
    >;
    readonly create: (request: {
      readonly name: string;
      readonly configSrc: "cloudflare";
    }) => Effect.Effect<ManagedEndpointTunnel, ManagedEndpointTunnelClientError>;
    readonly putConfiguration: (
      tunnelId: string,
      config: {
        readonly ingress: Array<{
          readonly hostname?: string;
          readonly service: string;
          readonly originRequest?: { readonly httpHostHeader: string };
        }>;
      },
    ) => Effect.Effect<unknown, ManagedEndpointTunnelClientError>;
    readonly getToken: (
      tunnelId: string,
    ) => Effect.Effect<string, ManagedEndpointTunnelClientError>;
    readonly delete: (tunnelId: string) => Effect.Effect<unknown, ManagedEndpointTunnelClientError>;
  }
>()("lecturn-relay/environments/ManagedEndpointProvider/ManagedEndpointTunnelClient") {}

export const layerTunnelClient = (client: ManagedEndpointTunnelClient["Service"]) =>
  Layer.succeed(ManagedEndpointTunnelClient, client);

interface ManagedEndpointCnameRecordInput {
  readonly type: "CNAME";
  readonly name: string;
  readonly content: string;
  readonly ttl: 1;
  readonly proxied: true;
}

const ManagedEndpointDnsClientOperation = Schema.Literals([
  "list-records",
  "create-record",
  "update-record",
  "delete-record",
]);

export class ManagedEndpointDnsClientError extends Schema.TaggedError<ManagedEndpointDnsClientError>()(
  "ManagedEndpointDnsClientError",
  {
    operation: ManagedEndpointDnsClientOperation,
    hostname: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.dnsRecordId ?? this.hostname;
    return `Managed endpoint DNS provider '${this.operation}' request failed${target === undefined ? "" : ` for '${target}'`}`;
  }
}

export class ManagedEndpointDnsClient extends Context.Service<
  ManagedEndpointDnsClient,
  {
    readonly listRecords: (hostname: string) => Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly type?: string | null;
        readonly content?: string | null;
        readonly proxied?: boolean | null;
      }>,
      ManagedEndpointDnsClientError
    >;
    readonly createRecord: (
      request: ManagedEndpointCnameRecordInput,
    ) => Effect.Effect<{ readonly id: string }, ManagedEndpointDnsClientError>;
    readonly updateRecord: (
      dnsRecordId: string,
      request: ManagedEndpointCnameRecordInput,
    ) => Effect.Effect<unknown, ManagedEndpointDnsClientError>;
    readonly deleteRecord: (
      dnsRecordId: string,
    ) => Effect.Effect<unknown, ManagedEndpointDnsClientError>;
  }
>()("lecturn-relay/environments/ManagedEndpointProvider/ManagedEndpointDnsClient") {}

export const layerDnsClient = (client: ManagedEndpointDnsClient["Service"]) =>
  Layer.succeed(ManagedEndpointDnsClient, client);

const requireCloudflareSettings = Effect.fnUntraced(function* (
  settings: RelayConfiguration.RelayConfiguration["Service"],
  input: { readonly userId: string; readonly environmentId: string },
) {
  const baseDomain = settings.managedEndpointBaseDomain;
  const namespace = settings.managedEndpointNamespace;
  const missingSettings: Array<"managedEndpointBaseDomain" | "managedEndpointNamespace"> = [];
  if (!baseDomain) {
    missingSettings.push("managedEndpointBaseDomain");
  }
  if (!namespace) {
    missingSettings.push("managedEndpointNamespace");
  }
  if (!baseDomain || !namespace) {
    return yield* new ManagedEndpointProvisioningNotConfigured({
      ...input,
      missingSettings,
    });
  }
  return {
    baseDomain,
    namespace,
  };
});

function formatOriginService(origin: RelayManagedEndpointOrigin): string {
  const host = origin.localHttpHost.includes(":")
    ? `[${origin.localHttpHost.replace(/^\[(.*)\]$/u, "$1")}]`
    : origin.localHttpHost;
  return `http://${host}:${origin.localHttpPort}`;
}

/**
 * The ingress both `provision` and `syncOrigin` write. Gateway allocations are
 * reached through their origin hostname and present the public hostname as the
 * Host header; legacy allocations are reached on the public hostname directly.
 */
function managedEndpointIngress(input: {
  readonly hostname: string;
  readonly origin: RelayManagedEndpointOrigin;
  readonly gatewayMapping: Pick<GatewayEnrollmentMapping, "originHostname"> | null;
}) {
  return [
    {
      hostname: input.gatewayMapping?.originHostname ?? input.hostname,
      service: formatOriginService(input.origin),
      ...(input.gatewayMapping ? { originRequest: { httpHostHeader: input.hostname } } : {}),
    },
    { service: "http_status:404" },
  ];
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackOrigin(origin: RelayManagedEndpointOrigin): boolean {
  const hostname = normalizeHostname(origin.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort > 0 &&
    origin.localHttpPort <= 65_535
  );
}

export function isManagedEndpointNotFound(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if ("_tag" in cause && (cause._tag === "NotFound" || cause._tag === "TunnelNotFound")) {
    return true;
  }
  if ("status" in cause && cause.status === 404) {
    return true;
  }
  return "cause" in cause && isManagedEndpointNotFound(cause.cause);
}

type ManagedEndpointClientError = ManagedEndpointTunnelClientError | ManagedEndpointDnsClientError;

const ignoreNotFound = <A>(
  effect: Effect.Effect<A, ManagedEndpointClientError>,
): Effect.Effect<void, ManagedEndpointClientError> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchTags({
      ManagedEndpointTunnelClientError: (error) =>
        isManagedEndpointNotFound(error.cause) ? Effect.void : Effect.fail(error),
      ManagedEndpointDnsClientError: (error) =>
        isManagedEndpointNotFound(error.cause) ? Effect.void : Effect.fail(error),
    }),
  );

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;
  const tunnels = yield* ManagedEndpointTunnelClient;
  const dns = yield* ManagedEndpointDnsClient;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const tunnelLimits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
  const managedAccess = yield* ManagedAccess.ManagedAccess;
  const reservations = yield* ManagedReservations.ManagedReservations;
  const gateway = Option.getOrNull(yield* Effect.serviceOption(ManagedGatewayEnrollment));
  const isGatewayHostname = (hostname: string) =>
    /^[a-f0-9]{16}-g-[a-z0-9-]+\./.test(hostname) || hostname.startsWith("g-");

  const updateExistingDnsRecords = Effect.fnUntraced(function* (
    records: ReadonlyArray<{ readonly id: string }>,
    preferredDnsRecordId: string | null,
    dnsRecord: ManagedEndpointCnameRecordInput,
  ) {
    const keptRecord = records.find((record) => record.id === preferredDnsRecordId) ?? records[0];
    if (keptRecord === undefined) {
      return null;
    }
    yield* Effect.forEach(
      records,
      (record) => (record.id === keptRecord.id ? Effect.void : dns.deleteRecord(record.id)),
      { discard: true },
    );
    yield* dns.updateRecord(keptRecord.id, dnsRecord);
    return keptRecord.id;
  });

  const ensureDnsRecord = Effect.fnUntraced(function* (
    hostname: string,
    preferredDnsRecordId: string | null,
    dnsRecord: ManagedEndpointCnameRecordInput,
  ) {
    if (preferredDnsRecordId !== null) {
      const checkpointedRecordUpdated = yield* dns
        .updateRecord(preferredDnsRecordId, dnsRecord)
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            ManagedEndpointDnsClientError: (error) =>
              isManagedEndpointNotFound(error.cause) ? Effect.succeed(false) : Effect.fail(error),
          }),
        );
      if (checkpointedRecordUpdated) {
        return preferredDnsRecordId;
      }
    }
    const existingDnsRecords = yield* dns.listRecords(hostname);
    const existingDnsRecordId = yield* updateExistingDnsRecords(
      existingDnsRecords,
      preferredDnsRecordId,
      dnsRecord,
    );
    if (existingDnsRecordId !== null) {
      return existingDnsRecordId;
    }
    return yield* dns.createRecord(dnsRecord).pipe(
      Effect.map((record) => record.id),
      Effect.catchTags({
        ManagedEndpointDnsClientError: (createError) =>
          Effect.gen(function* () {
            let records = yield* dns.listRecords(hostname);
            for (let attempt = 0; records.length === 0 && attempt < 4; attempt++) {
              yield* Effect.sleep("200 millis");
              records = yield* dns.listRecords(hostname);
            }
            return records;
          }).pipe(
            Effect.flatMap((records) =>
              records.length > 0
                ? updateExistingDnsRecords(records, preferredDnsRecordId, dnsRecord)
                : Effect.fail(createError),
            ),
            Effect.filterOrFail(
              (dnsRecordId) => dnsRecordId !== null,
              () => createError,
            ),
          ),
      }),
    );
  });

  // Gateway records are immutable while their tunnel exists. An obsolete provision must never
  // re-resolve a hostname and overwrite a newer enrollment's DNS target.
  const ensureGatewayDnsRecord = Effect.fnUntraced(function* (
    record: ManagedEndpointCnameRecordInput,
  ) {
    const verify = (
      records: ReadonlyArray<{
        readonly id: string;
        readonly type?: string | null;
        readonly content?: string | null;
        readonly proxied?: boolean | null;
      }>,
    ) => {
      if (records.length === 0) return null;
      const matching = records.find(
        (existing) =>
          existing.type === record.type &&
          existing.content === record.content &&
          existing.proxied === record.proxied,
      );
      return matching && records.length === 1 ? matching.id : false;
    };
    const existing = verify(yield* dns.listRecords(record.name));
    if (existing === false)
      return yield* new ManagedEndpointDnsClientError({
        operation: "create-record",
        hostname: record.name,
        cause: new Error("Gateway DNS target changed; wait for cleanup before retrying"),
      });
    if (existing !== null) return existing;
    return yield* dns.createRecord(record).pipe(
      Effect.map((created) => created.id),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const raced = verify(yield* dns.listRecords(record.name));
          if (typeof raced === "string") return raced;
          return yield* cause;
        }),
      ),
    );
  });

  const prepareDeprovision = Effect.fn("relay.managed_endpoint_provider.prepare_deprovision")(
    function* (input: { readonly userId: string; readonly environmentId: string }) {
      const reservation = yield* reservations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
      const allocation = yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
      const gatewayMapping = gateway
        ? yield* gateway.get(input).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "load-allocation",
                  cause,
                }),
            ),
          )
        : null;
      if (allocation && isGatewayHostname(allocation.hostname) && !gateway)
        return yield* new ManagedEndpointDeprovisioningFailed({
          ...input,
          stage: "gateway-cutoff",
          cause: new Error("Gateway service required for managed cleanup"),
        });
      return allocation === null && reservation === null && gatewayMapping === null
        ? null
        : {
            allocation,
            reservationGeneration: reservation?.generation ?? null,
            ...(gatewayMapping ? { gatewayMapping } : {}),
          };
    },
  );

  const reconcileOrigin = Effect.fn("relay.managed_endpoint_provider.reconcile_origin")(
    function* (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly endpoint: RelayManagedEndpoint;
    }) {
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          userId: input.userId,
          environmentId: input.environmentId,
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      const allocation = yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
      if (
        allocation === null ||
        allocation.tunnelId !== input.tunnelId ||
        allocation.dnsRecordId === null ||
        allocation.readyAt === null
      ) {
        return "recovery_required";
      }
      const cf = yield* requireCloudflareSettings(config, input);
      const recordedEndpoint = ManagedEndpointAllocations.resolveReadyManagedEndpoint({
        allocation,
        baseDomain: cf.baseDomain,
      });
      if (
        recordedEndpoint === null ||
        recordedEndpoint.httpBaseUrl !== input.endpoint.httpBaseUrl ||
        recordedEndpoint.wsBaseUrl !== input.endpoint.wsBaseUrl ||
        recordedEndpoint.providerKind !== input.endpoint.providerKind
      ) {
        return yield* new ManagedEndpointProvisioningFailed({
          ...input,
          stage: "verify-endpoint",
          reason: "endpoint-mismatch",
          hostname: allocation.hostname,
        });
      }
      if (
        allocation.origin?.localHttpHost === input.origin.localHttpHost &&
        allocation.origin.localHttpPort === input.origin.localHttpPort
      ) {
        return "ready";
      }
      let gatewayMapping: GatewayEnrollmentMapping | null = null;
      if (isGatewayHostname(allocation.hostname)) {
        gatewayMapping = gateway
          ? yield* gateway.get(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointProvisioningFailed({
                    ...input,
                    stage: "sync-origin",
                    hostname: allocation.hostname,
                    cause,
                  }),
              ),
            )
          : null;
        // Without a live mapping the origin hostname is unknown; never write a
        // legacy ingress onto a gateway tunnel. The environment retries later.
        if (gatewayMapping === null || gatewayMapping.deleting) {
          return yield* new ManagedEndpointProvisioningFailed({
            ...input,
            stage: "sync-origin",
            hostname: allocation.hostname,
          });
        }
      }

      const updated = yield* allocations
        .withClaimedTunnel(
          {
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: input.tunnelId,
            generation: allocation.generation,
          },
          tunnels
            .putConfiguration(input.tunnelId, {
              ingress: managedEndpointIngress({
                hostname: allocation.hostname,
                origin: input.origin,
                gatewayMapping,
              }),
            })
            .pipe(
              Effect.as("configured" as const),
              Effect.catchTags({
                ManagedEndpointTunnelClientError: (error) =>
                  isManagedEndpointNotFound(error.cause)
                    ? Effect.succeed("missing" as const)
                    : Effect.fail(error),
              }),
              Effect.filterOrElse(
                (result): result is "missing" => result === "missing",
                () =>
                  allocations
                    .markReady({
                      ...input,
                      generation: allocation.generation,
                    })
                    .pipe(
                      Effect.map((updated) =>
                        updated ? ("configured" as const) : ("stale" as const),
                      ),
                    ),
              ),
            ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                ...input,
                stage: "sync-origin",
                cause,
              }),
          ),
        );
      if (Option.isNone(updated) || updated.value === "stale") {
        return yield* new ManagedEndpointProvisioningFailed({
          ...input,
          stage: "sync-origin",
          reason: "claim-lost",
        });
      }
      return updated.value === "configured" ? "ready" : "recovery_required";
    },
  );

  return ManagedEndpointProvider.of({
    prepareDeprovision,
    reconcileOrigin,
    deprovision: Effect.fn("relay.managed_endpoint_provider.deprovision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
      });
      const target = input.target === undefined ? yield* prepareDeprovision(input) : input.target;
      const releaseReservation =
        target?.reservationGeneration == null
          ? Effect.void
          : reservations
              .release({
                userId: input.userId,
                environmentId: input.environmentId,
                generation: target.reservationGeneration,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointDeprovisioningFailed({
                      ...input,
                      stage: "remove-allocation",
                      cause,
                    }),
                ),
              );
      const allocation = target?.allocation ?? null;
      if (allocation === null) {
        const captured = target?.gatewayMapping;
        // A prior cleanup may have removed the allocation before finalizing its durable tombstone.
        if (captured?.deleting && gateway)
          yield* gateway.finalizeRemove({ ...input, generation: captured.generation }).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "remove-allocation",
                  cause,
                }),
            ),
          );
        yield* releaseReservation;
        return true;
      }
      const claimedGeneration = yield* allocations
        .claimDeprovision({
          userId: input.userId,
          environmentId: input.environmentId,
          generation: allocation.generation,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "claim-deprovision",
                ...(allocation.tunnelId === null ? {} : { tunnelId: allocation.tunnelId }),
                ...(allocation.dnsRecordId === null ? {} : { dnsRecordId: allocation.dnsRecordId }),
                cause,
              }),
          ),
        );
      if (claimedGeneration === null) {
        return false;
      }
      // Gateway cutoff runs before the allocation row lock: the gateway store
      // takes its own account lock and also writes allocation checkpoints.
      const capturedGateway = target?.gatewayMapping;
      if (capturedGateway) {
        if (!gateway)
          return yield* new ManagedEndpointDeprovisioningFailed({
            ...input,
            stage: "gateway-cutoff",
            cause: new Error("Gateway service unavailable"),
          });
        const removed = yield* gateway
          .remove({ ...input, generation: capturedGateway.generation })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "gateway-cutoff",
                  cause,
                }),
            ),
          );
        if (!removed) return false;
        yield* gateway.sync(input.userId).pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "gateway-cutoff",
                cause,
              }),
          ),
        );
        if (capturedGateway.originDnsRecordId)
          yield* ignoreNotFound(dns.deleteRecord(capturedGateway.originDnsRecordId)).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "delete-dns-record",
                  cause,
                }),
            ),
          );
      } else if (isGatewayHostname(allocation.hostname)) {
        return yield* new ManagedEndpointDeprovisioningFailed({
          ...input,
          stage: "gateway-cutoff",
          cause: new Error("Gateway enrollment target missing"),
        });
      }
      const tunnelId = allocation.tunnelId;
      const deprovision = Effect.gen(function* () {
        const dnsRecordId = allocation.dnsRecordId;
        if (dnsRecordId !== null) {
          yield* ignoreNotFound(dns.deleteRecord(dnsRecordId)).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "delete-dns-record",
                  dnsRecordId,
                  cause,
                }),
            ),
          );
        }
        if (tunnelId !== null) {
          yield* ignoreNotFound(tunnels.delete(tunnelId)).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "delete-tunnel",
                  tunnelId,
                  cause,
                }),
            ),
          );
        }
        return yield* allocations
          .removeClaimed({
            userId: input.userId,
            environmentId: input.environmentId,
            generation: claimedGeneration,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "remove-allocation",
                  ...(allocation.tunnelId === null ? {} : { tunnelId: allocation.tunnelId }),
                  ...(allocation.dnsRecordId === null
                    ? {}
                    : { dnsRecordId: allocation.dnsRecordId }),
                  cause,
                }),
            ),
          );
      });
      const removed =
        tunnelId === null
          ? yield* deprovision
          : Option.getOrElse(
              yield* allocations
                .withClaimedTunnel(
                  {
                    userId: input.userId,
                    environmentId: input.environmentId,
                    tunnelId,
                    generation: claimedGeneration,
                  },
                  deprovision,
                )
                .pipe(
                  Effect.catchTags({
                    ManagedEndpointAllocationPersistenceError: (cause) =>
                      Effect.fail(
                        new ManagedEndpointDeprovisioningFailed({
                          ...input,
                          stage: "claim-deprovision",
                          tunnelId,
                          cause,
                        }),
                      ),
                  }),
                ),
              () => false,
            );
      if (removed) {
        if (capturedGateway && gateway)
          yield* gateway.finalizeRemove({ ...input, generation: capturedGateway.generation }).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "remove-allocation",
                  cause,
                }),
            ),
          );
        yield* releaseReservation;
      }
      return removed;
    }),
    release: Effect.fn("relay.managed_endpoint_provider.release")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
      });
      const allocation = yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
      const releaseMapping = gateway
        ? yield* gateway.get(input).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "load-allocation",
                  cause,
                }),
            ),
          )
        : null;
      if (allocation && isGatewayHostname(allocation.hostname) && (!gateway || !releaseMapping))
        return yield* new ManagedEndpointDeprovisioningFailed({
          ...input,
          stage: "gateway-cutoff",
          cause: new Error("Gateway enrollment unavailable"),
        });
      const tunnelId = allocation?.tunnelId ?? null;
      if (allocation === null || tunnelId === null) {
        return true;
      }
      if (input.expectedTunnelId !== undefined && input.expectedTunnelId !== tunnelId) {
        return false;
      }
      // Claim the release against the allocation's current generation before
      // touching Cloudflare. A provision racing this release (fast environment
      // restart) increments the generation when it records its tunnel, so a stale
      // claim means the recorded tunnel may already back a fresh connector and
      // must be left alive. A provision that starts after the claim instead
      // fails loudly on the deleted tunnel and the client-side retry
      // provisions a replacement.
      const claimedGeneration = yield* allocations
        .claimRelease({
          userId: input.userId,
          environmentId: input.environmentId,
          tunnelId,
          generation: allocation.generation,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "claim-release",
                tunnelId,
                cause,
              }),
          ),
        );
      if (claimedGeneration === null) {
        return false;
      }
      const deleteTunnel = ignoreNotFound(tunnels.delete(tunnelId)).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "delete-tunnel",
              tunnelId,
              cause,
            }),
        ),
      );
      if (input.expectedInactiveBefore !== undefined && input.expectedStatus !== undefined) {
        const expectedStatus = input.expectedStatus;
        const inactiveBefore = input.expectedInactiveBefore;
        const currentTunnel = yield* tunnels.get(tunnelId).pipe(
          Effect.asSome,
          Effect.catchTags({
            ManagedEndpointTunnelClientError: (cause) =>
              isManagedEndpointNotFound(cause.cause)
                ? Effect.succeedNone
                : Effect.fail(
                    new ManagedEndpointDeprovisioningFailed({
                      ...input,
                      stage: "load-tunnel",
                      tunnelId,
                      cause,
                    }),
                  ),
          }),
        );
        if (Option.isNone(currentTunnel)) {
          return true;
        }
        const inactiveAt =
          expectedStatus === "down"
            ? currentTunnel.value.connsInactiveAt
            : currentTunnel.value.createdAt;
        if (
          currentTunnel.value.id !== tunnelId ||
          currentTunnel.value.status !== expectedStatus ||
          typeof inactiveAt !== "string"
        ) {
          return false;
        }
        const inactiveTime = DateTime.make(inactiveAt);
        const cutoff = DateTime.make(inactiveBefore);
        if (
          Option.isNone(inactiveTime) ||
          Option.isNone(cutoff) ||
          inactiveTime.value.epochMilliseconds > cutoff.value.epochMilliseconds
        ) {
          return false;
        }
      }
      // Gateway cutoff stays outside the allocation row lock: the gateway store
      // takes its own account lock and also writes allocation checkpoints.
      if (releaseMapping && gateway) {
        const paused = yield* gateway
          .pause({ ...input, generation: releaseMapping.generation })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "gateway-cutoff",
                  cause,
                }),
            ),
          );
        if (!paused) return false;
        yield* gateway.sync(input.userId).pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "gateway-cutoff",
                cause,
              }),
          ),
        );
        for (const recordId of [releaseMapping.originDnsRecordId, allocation.dnsRecordId]) {
          if (recordId)
            yield* ignoreNotFound(dns.deleteRecord(recordId)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDeprovisioningFailed({
                    ...input,
                    stage: "delete-dns-record",
                    cause,
                  }),
              ),
            );
        }
      }
      const released = yield* allocations
        .withClaimedTunnel(
          {
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId,
            generation: claimedGeneration,
          },
          Effect.gen(function* () {
            const finalGeneration = yield* allocations
              .claimRelease({
                userId: input.userId,
                environmentId: input.environmentId,
                tunnelId,
                generation: claimedGeneration,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointDeprovisioningFailed({
                      ...input,
                      stage: "claim-release",
                      tunnelId,
                      cause,
                    }),
                ),
              );
            if (finalGeneration === null) {
              return false;
            }
            yield* deleteTunnel;
            return true;
          }),
        )
        .pipe(
          Effect.catchTags({
            ManagedEndpointAllocationPersistenceError: (cause) =>
              Effect.fail(
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "claim-release",
                  tunnelId,
                  cause,
                }),
              ),
          }),
        );
      // The recorded tunnelId is now stale, but the allocation row is left
      // untouched deliberately: connect/status authorization requires a fully
      // recorded allocation, and an offline environment must keep reporting
      // "offline" (health probe fails) rather than "not authorized". The next
      // provision lists tunnels by name, finds none, creates a replacement and
      // re-records the fresh id.
      return Option.getOrElse(released, () => false);
    }),
    syncOrigin: Effect.fn("relay.managed_endpoint_provider.sync_origin")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
        "relay.managed_endpoint.origin_host": input.origin.localHttpHost,
        "relay.managed_endpoint.origin_port": input.origin.localHttpPort,
      });
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          userId: input.userId,
          environmentId: input.environmentId,
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      const allocation = yield* allocations.get({
        userId: input.userId,
        environmentId: input.environmentId,
      });
      const tunnelId = allocation?.tunnelId ?? null;
      if (allocation === null || tunnelId === null) {
        return false;
      }
      const { hostname, tunnelName } = allocation;
      let gatewayMapping: GatewayEnrollmentMapping | null = null;
      if (isGatewayHostname(hostname)) {
        gatewayMapping = gateway
          ? yield* gateway.get({ userId: input.userId, environmentId: input.environmentId })
          : null;
        // Without a live mapping the origin hostname is unknown; leave the
        // tunnel alone rather than write a legacy ingress onto a gateway tunnel.
        if (gatewayMapping === null || gatewayMapping.deleting) {
          return false;
        }
      }
      // `release` deletes the tunnel but keeps its id on the allocation, so a
      // missing tunnel means there is nothing to repoint until the next provision.
      return yield* tunnels
        .putConfiguration(tunnelId, {
          ingress: managedEndpointIngress({ hostname, origin: input.origin, gatewayMapping }),
        })
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            ManagedEndpointTunnelClientError: (cause) =>
              isManagedEndpointNotFound(cause.cause)
                ? Effect.succeed(false)
                : Effect.fail(
                    new ManagedEndpointProvisioningFailed({
                      userId: input.userId,
                      environmentId: input.environmentId,
                      stage: "configure-tunnel",
                      hostname,
                      tunnelName,
                      tunnelId,
                      cause,
                    }),
                  ),
          }),
        );
    }),
    provision: Effect.fn("relay.managed_endpoint_provider.provision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
        "relay.managed_endpoint.origin_host": input.origin.localHttpHost,
        "relay.managed_endpoint.origin_port": input.origin.localHttpPort,
      });
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          userId: input.userId,
          environmentId: input.environmentId,
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      yield* managedAccess.check(input.userId, "managedConnect", undefined, input.environmentId);
      const cf = yield* requireCloudflareSettings(config, input);
      const useGateway = gateway ? yield* gateway.enabledFor(input.userId) : false;
      const namespace = useGateway ? `g-${cf.namespace}` : cf.namespace;
      const environmentHash = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            managedEndpointDigestInput(namespace, input.userId, input.environmentId),
          ),
        )
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "derive-environment-hash",
                cause,
              }),
          ),
        );
      const requestedHostname = useGateway
        ? `${environmentHash.slice(0, 16)}-g-${relayStageSlug(cf.namespace)}.${cf.baseDomain}`
        : managedEndpointHostname(namespace, cf.baseDomain, environmentHash);
      const requestedTunnelName = managedEndpointTunnelName(namespace, environmentHash);
      const existingAllocation = yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              ...input,
              stage: "gateway-enrollment",
              cause,
            }),
        ),
      );
      if (
        (useGateway && existingAllocation && existingAllocation.hostname !== requestedHostname) ||
        (!useGateway && existingAllocation && isGatewayHostname(existingAllocation.hostname))
      ) {
        return yield* new ManagedAccess.ManagedAccessUnavailable({
          message: useGateway
            ? "This environment needs explicit unlink and relink after stopping its old connector before gateway enrollment."
            : "This environment requires the managed gateway. Retry after gateway access is restored.",
        });
      }
      const reservation = yield* reservations.reserve(input).pipe(
        Effect.mapError((error) => {
          if (error.code === "subscription_required")
            return new ManagedAccess.ManagedAccessRequired({ message: error.message });
          if (error.code === "quota")
            return new ManagedTunnelLimits.ManagedTunnelLimitExceeded({
              userId: input.userId,
              environmentId: input.environmentId,
              maxTunnels: 3,
              activeTunnels: 3,
            });
          return new ManagedAccess.ManagedAccessUnavailable({
            message: "Managed environment capacity is temporarily unavailable.",
          });
        }),
      );
      if (reservation === null)
        yield* tunnelLimits
          .ensureCapacity({
            userId: input.userId,
            environmentId: input.environmentId,
          })
          .pipe(
            Effect.catchTags({
              ManagedTunnelLimitPersistenceError: (cause) =>
                Effect.fail(
                  new ManagedEndpointProvisioningFailed({
                    userId: input.userId,
                    environmentId: input.environmentId,
                    stage: "check-tunnel-limit",
                    hostname: requestedHostname,
                    tunnelName: requestedTunnelName,
                    cause,
                  }),
                ),
            }),
          );
      const allocation = yield* allocations
        .reserve({
          userId: input.userId,
          environmentId: input.environmentId,
          hostname: requestedHostname,
          tunnelName: requestedTunnelName,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "reserve-allocation",
                hostname: requestedHostname,
                tunnelName: requestedTunnelName,
                cause,
              }),
          ),
        );
      const { hostname, tunnelName } = allocation;
      if (hostname !== requestedHostname && (useGateway || isGatewayHostname(hostname)))
        return yield* new ManagedAccess.ManagedAccessUnavailable({
          message: "Managed gateway enrollment changed during provisioning.",
        });
      const gatewayMapping =
        useGateway && gateway
          ? yield* gateway.registerPending({
              userId: input.userId,
              environmentId: input.environmentId,
              publicHostname: hostname,
              originHostname: managedEndpointHostname(
                `gw-origin-${cf.namespace}`,
                cf.baseDomain,
                environmentHash,
              ),
            })
          : null;
      if (gatewayMapping && gateway) yield* gateway.sync(input.userId);

      const tunnelResponse = yield* tunnels.list({ name: tunnelName, isDeleted: false }).pipe(
        Effect.map((tunnels) => tunnels.result),
        Effect.map(Arr.findFirst((tunnel) => tunnel.name === tunnelName)),
        Effect.flatMap(
          Option.match({
            onSome: (tunnel) => Effect.succeed(tunnel),
            onNone: () => tunnels.create({ name: tunnelName, configSrc: "cloudflare" }),
          }),
        ),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              userId: input.userId,
              environmentId: input.environmentId,
              stage: "ensure-tunnel",
              hostname,
              tunnelName,
              cause,
            }),
        ),
      );
      if (!tunnelResponse.id || tunnelResponse.name !== tunnelName) {
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "validate-tunnel-response",
          reason: "invalid-tunnel-response",
          hostname,
          tunnelName,
          ...(tunnelResponse.id ? { returnedTunnelId: tunnelResponse.id } : {}),
          ...(tunnelResponse.name ? { returnedTunnelName: tunnelResponse.name } : {}),
        });
      }
      const tunnel = { id: tunnelResponse.id, name: tunnelResponse.name };
      // Gateway allocations checkpoint through the gateway store under their
      // enrollment generation. Legacy allocations guard each step with the
      // allocation generation and hold the claimed tunnel row while writing.
      let tunnelGeneration = 0;
      if (gatewayMapping && gateway) {
        const current = yield* gateway.get(input);
        if (!current || current.deleting || current.generation !== gatewayMapping.generation)
          return yield* new ManagedAccess.ManagedAccessUnavailable({
            message: "Managed gateway enrollment changed before tunnel configuration.",
          });
        yield* gateway
          .checkpointAllocation({
            userId: input.userId,
            environmentId: input.environmentId,
            generation: gatewayMapping.generation,
            step: "tunnel",
            tunnelId: tunnel.id,
          })
          .pipe(
            Effect.flatMap((recorded) =>
              recorded
                ? Effect.void
                : Effect.fail(
                    new ManagedAccess.ManagedAccessUnavailable({
                      message: "Managed gateway allocation changed before its tunnel checkpoint.",
                    }),
                  ),
            ),
            Effect.mapError(
              (cause) =>
                new ManagedEndpointProvisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "record-tunnel",
                  hostname,
                  tunnelName,
                  tunnelId: tunnel.id,
                  cause,
                }),
            ),
          );
      } else {
        const recordedGeneration = yield* allocations
          .recordTunnel({
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: tunnel.id,
            generation: allocation.generation,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointProvisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "record-tunnel",
                  hostname,
                  tunnelName,
                  tunnelId: tunnel.id,
                  cause,
                }),
            ),
          );
        if (recordedGeneration === null) {
          // A newer provision can adopt this tunnel by name at any point after
          // our claim fails. Leave it available for that provision or a retry.
          return yield* new ManagedEndpointProvisioningFailed({
            userId: input.userId,
            environmentId: input.environmentId,
            stage: "record-tunnel",
            reason: "claim-lost",
            hostname,
            tunnelName,
            tunnelId: tunnel.id,
          });
        }
        tunnelGeneration = recordedGeneration;
      }
      const withTunnelClaim = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<
        Option.Option<A>,
        E | ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError,
        R
      > =>
        gatewayMapping && gateway
          ? Effect.asSome(effect)
          : allocations.withClaimedTunnel(
              {
                userId: input.userId,
                environmentId: input.environmentId,
                tunnelId: tunnel.id,
                generation: tunnelGeneration,
              },
              effect,
            );

      const configured = yield* withTunnelClaim(
        tunnels
          .putConfiguration(tunnel.id, {
            ingress: managedEndpointIngress({ hostname, origin: input.origin, gatewayMapping }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointProvisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "configure-tunnel",
                  hostname,
                  tunnelName,
                  tunnelId: tunnel.id,
                  cause,
                }),
            ),
          ),
      ).pipe(
        Effect.catchTags({
          ManagedEndpointAllocationPersistenceError: (cause) =>
            Effect.fail(
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "configure-tunnel",
                hostname,
                tunnelName,
                tunnelId: tunnel.id,
                cause,
              }),
            ),
        }),
      );
      if (Option.isNone(configured)) {
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "configure-tunnel",
          reason: "claim-lost",
          hostname,
          tunnelName,
          tunnelId: tunnel.id,
        });
      }

      const dnsRecord = {
        type: "CNAME",
        name: hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        ttl: 1,
        proxied: true,
      } as const;

      let dnsRecordId: string;
      let dnsGeneration = 0;
      if (gatewayMapping && gateway) {
        dnsRecordId = yield* ensureGatewayDnsRecord(dnsRecord).pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "ensure-dns-record",
                hostname,
                tunnelName,
                tunnelId: tunnel.id,
                ...(allocation.dnsRecordId === null ? {} : { dnsRecordId: allocation.dnsRecordId }),
                cause,
              }),
          ),
        );
        const recordedDnsRecordId = dnsRecordId;
        yield* gateway
          .checkpointAllocation({
            userId: input.userId,
            environmentId: input.environmentId,
            generation: gatewayMapping.generation,
            step: "dns",
            dnsRecordId: recordedDnsRecordId,
          })
          .pipe(
            Effect.flatMap((recorded) =>
              recorded
                ? Effect.void
                : Effect.fail(
                    new ManagedAccess.ManagedAccessUnavailable({
                      message: "Managed gateway allocation changed before its DNS checkpoint.",
                    }),
                  ),
            ),
            Effect.mapError(
              (cause) =>
                new ManagedEndpointProvisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "record-dns",
                  hostname,
                  tunnelName,
                  tunnelId: tunnel.id,
                  dnsRecordId: recordedDnsRecordId,
                  cause,
                }),
            ),
          );

        const originDnsRecordId = yield* ensureGatewayDnsRecord({
          ...dnsRecord,
          name: gatewayMapping.originHostname,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                ...input,
                stage: "gateway-enrollment",
                cause,
              }),
          ),
        );
        const recorded = yield* gateway.recordOriginDns({
          userId: input.userId,
          environmentId: input.environmentId,
          generation: gatewayMapping.generation,
          originDnsRecordId,
        });
        if (!recorded)
          return yield* new ManagedAccess.ManagedAccessUnavailable({
            message: "Managed gateway enrollment changed during DNS setup.",
          });
      } else {
        const recordedDns = yield* allocations
          .withClaimedTunnel(
            {
              userId: input.userId,
              environmentId: input.environmentId,
              tunnelId: tunnel.id,
              generation: tunnelGeneration,
            },
            Effect.gen(function* () {
              const ensuredDnsRecordId = yield* ensureDnsRecord(
                hostname,
                allocation.dnsRecordId,
                dnsRecord,
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointProvisioningFailed({
                      userId: input.userId,
                      environmentId: input.environmentId,
                      stage: "ensure-dns-record",
                      hostname,
                      tunnelName,
                      tunnelId: tunnel.id,
                      ...(allocation.dnsRecordId === null
                        ? {}
                        : { dnsRecordId: allocation.dnsRecordId }),
                      cause,
                    }),
                ),
              );
              const recordedGeneration = yield* allocations
                .recordDns({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  dnsRecordId: ensuredDnsRecordId,
                  tunnelId: tunnel.id,
                  generation: tunnelGeneration,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointProvisioningFailed({
                        userId: input.userId,
                        environmentId: input.environmentId,
                        stage: "record-dns",
                        hostname,
                        tunnelName,
                        tunnelId: tunnel.id,
                        dnsRecordId: ensuredDnsRecordId,
                        cause,
                      }),
                  ),
                );
              if (recordedGeneration === null) {
                return yield* new ManagedEndpointProvisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "record-dns",
                  reason: "claim-lost",
                  hostname,
                  tunnelName,
                  tunnelId: tunnel.id,
                  dnsRecordId: ensuredDnsRecordId,
                });
              }
              return { dnsRecordId: ensuredDnsRecordId, dnsGeneration: recordedGeneration };
            }),
          )
          .pipe(
            Effect.catchTags({
              ManagedEndpointAllocationPersistenceError: (cause) =>
                Effect.fail(
                  new ManagedEndpointProvisioningFailed({
                    userId: input.userId,
                    environmentId: input.environmentId,
                    stage: "record-dns",
                    hostname,
                    tunnelName,
                    tunnelId: tunnel.id,
                    cause,
                  }),
                ),
            }),
          );
        if (Option.isNone(recordedDns)) {
          return yield* new ManagedEndpointProvisioningFailed({
            userId: input.userId,
            environmentId: input.environmentId,
            stage: "record-dns",
            reason: "claim-lost",
            hostname,
            tunnelName,
            tunnelId: tunnel.id,
          });
        }
        dnsRecordId = recordedDns.value.dnsRecordId;
        dnsGeneration = recordedDns.value.dnsGeneration;
      }

      const connectorToken = yield* tunnels.getToken(tunnel.id).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              userId: input.userId,
              environmentId: input.environmentId,
              stage: "get-tunnel-token",
              hostname,
              tunnelName,
              tunnelId: tunnel.id,
              dnsRecordId,
              cause,
            }),
        ),
      );
      const markReadyFailed = (cause?: unknown) =>
        new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "mark-allocation-ready",
          hostname,
          tunnelName,
          tunnelId: tunnel.id,
          dnsRecordId,
          ...(cause === undefined ? { reason: "claim-lost" as const } : { cause }),
        });
      if (gatewayMapping && gateway) {
        yield* gateway
          .checkpointAllocation({
            userId: input.userId,
            environmentId: input.environmentId,
            generation: gatewayMapping.generation,
            step: "ready",
          })
          .pipe(
            Effect.flatMap((recorded) =>
              recorded
                ? Effect.void
                : Effect.fail(
                    new ManagedAccess.ManagedAccessUnavailable({
                      message: "Managed gateway allocation changed before activation.",
                    }),
                  ),
            ),
            Effect.mapError(markReadyFailed),
          );
      } else {
        const ready = yield* allocations
          .markReady({
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: tunnel.id,
            generation: dnsGeneration,
            origin: input.origin,
          })
          .pipe(Effect.mapError(markReadyFailed));
        if (!ready) {
          return yield* markReadyFailed();
        }
      }

      yield* managedAccess.check(input.userId, "managedConnect", undefined, input.environmentId);
      const completed = yield* reservations.complete(reservation).pipe(
        Effect.mapError(
          () =>
            new ManagedAccess.ManagedAccessUnavailable({
              message: "Managed environment reservation could not be confirmed.",
            }),
        ),
      );
      if (!completed)
        return yield* new ManagedAccess.ManagedAccessUnavailable({
          message: "Managed access changed during provisioning. Retry after reconciliation.",
        });
      if (gatewayMapping && gateway) {
        const ready = yield* gateway.markReady({
          userId: input.userId,
          environmentId: input.environmentId,
          generation: gatewayMapping.generation,
        });
        if (!ready)
          return yield* new ManagedAccess.ManagedAccessUnavailable({
            message: "Managed gateway enrollment changed before activation.",
          });
        yield* gateway.sync(input.userId);
      }
      return {
        endpoint: managedEndpointForHostname(hostname),
        runtime: {
          providerKind: "cloudflare_tunnel",
          connectorToken,
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);

export const layerCloudflareBindings = (
  tunnelClient: Cloudflare.Tunnel.ReadWriteTunnelClient,
  dnsClient: Cloudflare.DNS.ReadWriteDnsClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerTunnelClient({
          get: (tunnelId) =>
            tunnelClient.get(tunnelId).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "get",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          list: (request) =>
            tunnelClient.list(request).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "list",
                    ...(request.name === undefined ? {} : { tunnelName: request.name }),
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          create: (request) =>
            tunnelClient.create(request).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "create",
                    tunnelName: request.name,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          putConfiguration: (tunnelId, config) =>
            tunnelClient.putConfiguration(tunnelId, config).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "put-configuration",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          getToken: (tunnelId) =>
            tunnelClient.getToken(tunnelId).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "get-token",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          delete: (tunnelId) =>
            tunnelClient.delete(tunnelId).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "delete",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
        }),
        layerDnsClient({
          listRecords: (hostname) =>
            dnsClient.listDnsRecords({ search: hostname }).pipe(
              Effect.timeout("8 seconds"),
              Effect.map((response) =>
                response.result.filter(
                  (record): record is typeof record & { readonly id: string } =>
                    typeof record.id === "string" &&
                    normalizeHostname(record.name) === normalizeHostname(hostname),
                ),
              ),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "list-records",
                    hostname,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          createRecord: (request) =>
            dnsClient.createDnsRecord(request).pipe(
              Effect.timeout("8 seconds"),
              Effect.map((response) => ({ id: response.id })),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "create-record",
                    hostname: request.name,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          updateRecord: (dnsRecordId, request) =>
            dnsClient.updateDnsRecord(dnsRecordId, request).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "update-record",
                    hostname: request.name,
                    dnsRecordId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          deleteRecord: (dnsRecordId) =>
            dnsClient.deleteDnsRecord(dnsRecordId).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "delete-record",
                    dnsRecordId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
        }),
      ),
    ),
  );
