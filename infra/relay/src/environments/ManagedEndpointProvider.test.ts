import * as ManagedAccess from "../billing/ManagedAccess.ts";
import * as ManagedReservations from "../billing/ManagedReservations.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import {
  ManagedGatewayEnrollment,
  type GatewayEnrollmentMapping,
} from "./ManagedGatewayEnrollment.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: "t3code.test",
  managedEndpointNamespace: "dev_julius",
});

interface TunnelCall {
  readonly operation: "list" | "create" | "putConfiguration" | "getToken" | "delete";
  readonly input: unknown;
}

interface DnsCall {
  readonly operation: "listRecords" | "createRecord" | "updateRecord" | "deleteRecord";
  readonly input: unknown;
}

interface AllocationCall {
  readonly operation:
    | "get"
    | "reserve"
    | "recordTunnel"
    | "recordDns"
    | "markReady"
    | "claimRelease"
    | "claimDeprovision"
    | "remove"
    | "removeClaimed";
  readonly input: unknown;
}

function allocationKey(input: { readonly userId: string; readonly environmentId: string }) {
  return `${input.userId}:${input.environmentId}`;
}

function makeTunnelClient(calls: TunnelCall[] = []) {
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    list: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "list", input: request });
        return { result: [] };
      }),
    create: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "create", input: request });
        return { id: "tunnel-id", name: request.name };
      }),
    putConfiguration: (tunnelId, tunnelConfig) =>
      Effect.sync(() => {
        calls.push({ operation: "putConfiguration", input: { tunnelId, tunnelConfig } });
      }),
    getToken: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "getToken", input: tunnelId });
        return "connector-token";
      }),
    delete: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "delete", input: tunnelId });
      }),
  });
}

function makePersistentTunnelClient(calls: TunnelCall[] = []) {
  let tunnel: { readonly id: string; readonly name: string } | null = null;
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    list: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "list", input: request });
        return { result: tunnel === null ? [] : [tunnel] };
      }),
    create: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "create", input: request });
        tunnel = { id: "tunnel-id", name: request.name };
        return tunnel;
      }),
    putConfiguration: (tunnelId, tunnelConfig) =>
      Effect.sync(() => {
        calls.push({ operation: "putConfiguration", input: { tunnelId, tunnelConfig } });
      }),
    getToken: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "getToken", input: tunnelId });
        return "connector-token";
      }),
    delete: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "delete", input: tunnelId });
        tunnel = null;
      }),
  });
}

function makeDnsClient(
  calls: DnsCall[] = [],
  records: ReadonlyArray<{ readonly id: string }> = [],
) {
  let currentRecords = [...records];
  return ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    listRecords: (hostname) =>
      Effect.sync(() => {
        calls.push({ operation: "listRecords", input: hostname });
        return currentRecords;
      }),
    createRecord: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "createRecord", input: request });
        const record = { id: "created-record-id" };
        currentRecords = [record];
        return record;
      }),
    updateRecord: (dnsRecordId, request) =>
      Effect.gen(function* () {
        calls.push({ operation: "updateRecord", input: { dnsRecordId, request } });
        if (!currentRecords.some((record) => record.id === dnsRecordId)) {
          return yield* new ManagedEndpointProvider.ManagedEndpointDnsClientError({
            operation: "update-record",
            hostname: request.name,
            dnsRecordId,
            cause: { _tag: "NotFound", dnsRecordId },
          });
        }
      }),
    deleteRecord: (dnsRecordId) =>
      Effect.sync(() => {
        calls.push({ operation: "deleteRecord", input: dnsRecordId });
        currentRecords = currentRecords.filter((record) => record.id !== dnsRecordId);
      }),
  });
}

function makeAllocations(calls: AllocationCall[] = []) {
  const allocations = new Map<string, ManagedEndpointAllocations.ManagedEndpointAllocation>();
  let generation = 0;
  const mutate = (
    key: string,
    change: (
      allocation: ManagedEndpointAllocations.ManagedEndpointAllocation,
    ) => ManagedEndpointAllocations.ManagedEndpointAllocation,
  ) => {
    const allocation = allocations.get(key);
    if (allocation !== undefined) {
      allocations.set(key, { ...change(allocation), updatedAt: `generation-${++generation}` });
    }
  };
  return ManagedEndpointAllocations.ManagedEndpointAllocations.of({
    get: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "get", input });
        return allocations.get(allocationKey(input)) ?? null;
      }),
    reserve: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "reserve", input });
        const allocation = allocations.get(allocationKey(input)) ?? {
          ...input,
          tunnelId: null,
          dnsRecordId: null,
          readyAt: null,
          updatedAt: `generation-${++generation}`,
        };
        allocations.set(allocationKey(input), allocation);
        return allocation;
      }),
    recordTunnel: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "recordTunnel", input });
        mutate(allocationKey(input), (allocation) => ({
          ...allocation,
          tunnelId: input.tunnelId,
        }));
      }),
    recordDns: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "recordDns", input });
        mutate(allocationKey(input), (allocation) => ({
          ...allocation,
          dnsRecordId: input.dnsRecordId,
        }));
      }),
    markReady: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "markReady", input });
        mutate(allocationKey(input), (allocation) => ({
          ...allocation,
          readyAt: "2026-06-02T00:00:00.000Z",
        }));
      }),
    claimRelease: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "claimRelease", input });
        const allocation = allocations.get(allocationKey(input));
        if (
          allocation === undefined ||
          allocation.tunnelId !== input.tunnelId ||
          allocation.updatedAt !== input.updatedAt
        ) {
          return false;
        }
        mutate(allocationKey(input), (current) => current);
        return true;
      }),
    claimDeprovision: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "claimDeprovision", input });
        const allocation = allocations.get(allocationKey(input));
        if (allocation === undefined || allocation.updatedAt !== input.updatedAt) {
          return null;
        }
        mutate(allocationKey(input), (current) => current);
        return allocations.get(allocationKey(input))?.updatedAt ?? null;
      }),
    remove: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "remove", input });
        allocations.delete(allocationKey(input));
      }),
    removeClaimed: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "removeClaimed", input });
        const allocation = allocations.get(allocationKey(input));
        if (allocation === undefined || allocation.updatedAt !== input.updatedAt) {
          return false;
        }
        allocations.delete(allocationKey(input));
        return true;
      }),
  });
}

function makeTunnelLimits(
  calls: Array<{ readonly userId: string; readonly environmentId: string }> = [],
  result: ManagedTunnelLimits.ManagedTunnelLimitExceeded | null = null,
) {
  return ManagedTunnelLimits.ManagedTunnelLimits.of({
    ensureCapacity: (input) =>
      Effect.suspend(() => {
        calls.push(input);
        return result === null ? Effect.void : Effect.fail(result);
      }),
  });
}

function providerLayer(
  tunnelClient = makeTunnelClient(),
  dnsClient = makeDnsClient(),
  allocations = makeAllocations(),
  tunnelLimits = makeTunnelLimits(),
  access = ManagedAccess.disabled,
  reservationService?: ManagedReservations.ManagedReservations["Service"],
  gatewayService?: ManagedGatewayEnrollment["Service"],
) {
  return ManagedEndpointProvider.layer.pipe(
    Layer.provide(
      gatewayService
        ? Layer.succeed(
            ManagedGatewayEnrollment,
            ManagedGatewayEnrollment.of({
              ...gatewayService,
              checkpointAllocation: (input) =>
                Effect.gen(function* () {
                  if (!(yield* gatewayService.checkpointAllocation(input))) return false;
                  if (input.step === "tunnel") yield* allocations.recordTunnel(input);
                  else if (input.step === "dns") yield* allocations.recordDns(input);
                  else yield* allocations.markReady(input);
                  return true;
                }).pipe(
                  Effect.mapError(
                    () =>
                      new ManagedAccess.ManagedAccessUnavailable({
                        message: "Allocation checkpoint failed",
                      }),
                  ),
                ),
            }),
          )
        : Layer.empty,
    ),
    Layer.provide(Layer.succeed(ManagedAccess.ManagedAccess, access)),
    Layer.provide(
      reservationService
        ? Layer.succeed(ManagedReservations.ManagedReservations, reservationService)
        : ManagedReservations.layer({ enabled: false }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnelClient)),
    Layer.provide(ManagedEndpointProvider.layerDnsClient(dnsClient)),
    Layer.provide(
      Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, allocations),
    ),
    Layer.provide(Layer.succeed(ManagedTunnelLimits.ManagedTunnelLimits, tunnelLimits)),
  );
}

function expectedManagedHostname(environmentId: string, userId = "user_ABC"): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`dev_julius:${userId}:${environmentId}`)
    .digest("hex")
    .slice(0, 16);
  return `dev-julius-${hash}.t3code.test`;
}

function expectedManagedTunnelName(environmentId: string, userId = "user_ABC"): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`dev_julius:${userId}:${environmentId}`)
    .digest("hex")
    .slice(0, 16);
  return `t3coderelay-managedendpoint-dev-julius-${hash}`;
}

describe("ManagedEndpointProvider", () => {
  it.effect("does not require the deployment RuntimeContext when building the Worker layer", () => {
    const tunnelClient = {
      list: () => Effect.succeed({ result: [] }),
      create: (request: { readonly name: string }) =>
        Effect.succeed({ id: "tunnel-id", name: request.name }),
      putConfiguration: () => Effect.void,
      getToken: () => Effect.succeed("connector-token"),
      delete: () => Effect.void,
    } as unknown as Cloudflare.Tunnel.ReadWriteTunnelClient;
    const dnsClient = {
      listDnsRecords: () => Effect.succeed({ result: [] }),
      createDnsRecord: () => Effect.succeed({ id: "dns-record-id" }),
      updateDnsRecord: () => Effect.void,
      deleteDnsRecord: () => Effect.void,
    } as unknown as Cloudflare.DNS.ReadWriteDnsClient;
    const runtimeContext = {} as Alchemy.BaseRuntimeContext;
    const layer = ManagedEndpointProvider.layerCloudflareBindings(
      tunnelClient,
      dnsClient,
      runtimeContext,
    ).pipe(
      Layer.provide(ManagedAccess.layerDisabled),
      Layer.provide(ManagedReservations.layer({ enabled: false })),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(RelayConfiguration.layer(config)),
      Layer.provide(
        Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, makeAllocations()),
      ),
      Layer.provide(Layer.succeed(ManagedTunnelLimits.ManagedTunnelLimits, makeTunnelLimits())),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(result.runtime.connectorToken).toBe("connector-token");
    }).pipe(Effect.provide(layer));
  });

  it.effect("provisions a Cloudflare tunnel endpoint and connector token", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];

    return Effect.gen(function* () {
      const hostname = expectedManagedHostname("env_ABC");
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(result).toEqual({
        endpoint: {
          httpBaseUrl: `https://${hostname}/`,
          wsBaseUrl: `wss://${hostname}/ws`,
          providerKind: "cloudflare_tunnel",
        },
        runtime: {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
          tunnelId: "tunnel-id",
          tunnelName: expectedManagedTunnelName("env_ABC"),
        },
      });
      expect(dnsCalls).toEqual([
        { operation: "listRecords", input: hostname },
        {
          operation: "createRecord",
          input: {
            type: "CNAME",
            name: hostname,
            content: "tunnel-id.cfargotunnel.com",
            ttl: 1,
            proxied: true,
          },
        },
      ]);
      expect(tunnelCalls.map((call) => call.operation)).toEqual([
        "list",
        "create",
        "putConfiguration",
        "getToken",
      ]);
      expect(tunnelCalls[2]?.input).toMatchObject({
        tunnelConfig: {
          ingress: [
            {
              hostname,
              service: "http://127.0.0.1:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
      expect(tunnelCalls[0]?.input).toEqual({
        name: expectedManagedTunnelName("env_ABC"),
        isDeleted: false,
      });
      expect(allocationCalls.map((call) => call.operation)).toEqual([
        "get",
        "reserve",
        "recordTunnel",
        "recordDns",
        "markReady",
      ]);
    }).pipe(
      Effect.provide(
        providerLayer(
          makeTunnelClient(tunnelCalls),
          makeDnsClient(dnsCalls),
          makeAllocations(allocationCalls),
        ),
      ),
    );
  });

  it.effect("checks the managed tunnel limit before reserving an allocation", () => {
    const limitCalls: Array<{ readonly userId: string; readonly environmentId: string }> = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(limitCalls).toEqual([{ userId: "user_ABC", environmentId: "env_ABC" }]);
    }).pipe(
      Effect.provide(
        providerLayer(
          makeTunnelClient(),
          makeDnsClient(),
          makeAllocations(),
          makeTunnelLimits(limitCalls),
        ),
      ),
    );
  });

  it.effect("refuses to provision past the managed tunnel limit without side effects", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const exceeded = new ManagedTunnelLimits.ManagedTunnelLimitExceeded({
      userId: "user_ABC",
      environmentId: "env_ABC",
      maxTunnels: 10,
      activeTunnels: 10,
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error).toBe(exceeded);
      expect(tunnelCalls).toEqual([]);
      expect(dnsCalls).toEqual([]);
      expect(allocationCalls.map((call) => call.operation)).toEqual(["get"]);
    }).pipe(
      Effect.provide(
        providerLayer(
          makeTunnelClient(tunnelCalls),
          makeDnsClient(dnsCalls),
          makeAllocations(allocationCalls),
          makeTunnelLimits([], exceeded),
        ),
      ),
    );
  });

  it.effect("uses stage-scoped stable names without leaking unusual environment ids", () => {
    const tunnelCalls: TunnelCall[] = [];

    return Effect.gen(function* () {
      const environmentId = "ENV With Spaces/../Symbols!" + "x".repeat(80);
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      const requestedName = (
        tunnelCalls.find((call) => call.operation === "list")?.input as
          | { readonly name?: string }
          | undefined
      )?.name;
      expect(requestedName).toMatch(/^t3coderelay-managedendpoint-dev-julius-[a-f0-9]{16}$/);
      const configBody = (
        tunnelCalls.find((call) => call.operation === "putConfiguration")?.input as
          | { readonly tunnelConfig?: unknown }
          | undefined
      )?.tunnelConfig;
      expect(configBody).toMatchObject({
        ingress: [
          {
            hostname: expect.stringMatching(/^dev-julius-[a-f0-9]{16}\.t3code\.test$/),
          },
          { service: "http_status:404" },
        ],
      });
      const hostname = (
        configBody as
          | {
              readonly ingress?: readonly [{ readonly hostname?: unknown }, unknown];
            }
          | undefined
      )?.ingress?.[0]?.hostname;
      expect(typeof hostname === "string" ? hostname.split(".")[0]?.length : 0).toBeLessThanOrEqual(
        63,
      );
      expect(tunnelCalls.find((call) => call.operation === "create")?.input).toMatchObject({
        name: requestedName,
        configSrc: "cloudflare",
      });
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls))));
  });

  it.effect("formats IPv6 loopback origins as valid Cloudflare ingress service URLs", () => {
    const tunnelCalls: TunnelCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env-ipv6",
        origin: { localHttpHost: "::1", localHttpPort: 3773 },
      });

      expect(
        tunnelCalls.find((call) => call.operation === "putConfiguration")?.input,
      ).toMatchObject({
        tunnelConfig: {
          ingress: [
            {
              service: "http://[::1]:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls))));
  });

  it.effect("rejects non-loopback managed endpoint origins before calling Cloudflare", () => {
    const dnsCalls: DnsCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "192.168.1.10", localHttpPort: 3773 },
        }),
      );

      expect(dnsCalls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "ManagedEndpointOriginNotAllowed",
          userId: "user_ABC",
          environmentId: "env_ABC",
          host: "192.168.1.10",
          port: 3773,
        });
      }
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls))));
  });

  it.effect("rejects invalid managed endpoint origin ports before calling Cloudflare", () => {
    const dnsCalls: DnsCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 65_536 },
        }),
      );

      expect(dnsCalls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ManagedEndpointOriginNotAllowed");
      }
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls))));
  });

  it.effect("reconciles an existing same-host DNS record through the DNS client", () => {
    const dnsCalls: DnsCall[] = [];
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(dnsCalls.map((call) => call.operation)).toEqual(["listRecords", "updateRecord"]);
      expect(dnsCalls[1]?.input).toMatchObject({ dnsRecordId: "existing-record-id" });
    }).pipe(
      Effect.provide(
        providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls, [{ id: "existing-record-id" }])),
      ),
    );
  });

  it.effect("reuses checkpointed resources when provisioning is retried", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const layer = providerLayer(
      makePersistentTunnelClient(tunnelCalls),
      makeDnsClient(dnsCalls),
      makeAllocations(allocationCalls),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const request = {
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      } as const;
      yield* provider.provision(request);
      yield* provider.provision(request);

      expect(tunnelCalls.map((call) => call.operation)).toEqual([
        "list",
        "create",
        "putConfiguration",
        "getToken",
        "list",
        "putConfiguration",
        "getToken",
      ]);
      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "updateRecord",
      ]);
      expect(allocationCalls.map((call) => call.operation)).toEqual([
        "get",
        "reserve",
        "recordTunnel",
        "recordDns",
        "markReady",
        "get",
        "reserve",
        "recordTunnel",
        "recordDns",
        "markReady",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("recreates a checkpointed DNS record when it was removed externally", () => {
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const dnsClient = makeDnsClient(dnsCalls);
    const layer = providerLayer(
      makePersistentTunnelClient(),
      dnsClient,
      makeAllocations(allocationCalls),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const request = {
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      } as const;
      yield* provider.provision(request);
      yield* dnsClient.deleteRecord("created-record-id");
      yield* provider.provision(request);

      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "deleteRecord",
        "updateRecord",
        "listRecords",
        "createRecord",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not hide non-not-found checkpoint update failures", () => {
    const dnsCalls: DnsCall[] = [];
    const failure = new ManagedEndpointProvider.ManagedEndpointDnsClientError({
      operation: "update-record",
      dnsRecordId: "created-record-id",
      cause: new Error("Cloudflare DNS unavailable"),
    });
    let records: ReadonlyArray<{ readonly id: string }> = [];
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      listRecords: (hostname) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "listRecords", input: hostname });
          return records;
        }),
      createRecord: (request) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "createRecord", input: request });
          const record = { id: "created-record-id" };
          records = [record];
          return record;
        }),
      updateRecord: (dnsRecordId, request) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "updateRecord", input: { dnsRecordId, request } });
        }).pipe(Effect.andThen(Effect.fail(failure))),
      deleteRecord: () => Effect.void,
    });
    const layer = providerLayer(makePersistentTunnelClient(), dnsClient, makeAllocations());

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const request = {
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      } as const;
      yield* provider.provision(request);
      const error = yield* Effect.flip(provider.provision(request));

      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "ensure-dns-record",
        userId: "user_ABC",
        environmentId: "env_ABC",
      });
      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "updateRecord",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "deprovisions checkpointed DNS and tunnel resources before removing the allocation",
    () => {
      const tunnelCalls: TunnelCall[] = [];
      const dnsCalls: DnsCall[] = [];
      const allocationCalls: AllocationCall[] = [];
      const layer = providerLayer(
        makePersistentTunnelClient(tunnelCalls),
        makeDnsClient(dnsCalls),
        makeAllocations(allocationCalls),
      );

      return Effect.gen(function* () {
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
        yield* provider.provision({
          ...key,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        });
        yield* provider.deprovision(key);

        expect(dnsCalls.map((call) => call.operation)).toEqual([
          "listRecords",
          "createRecord",
          "deleteRecord",
        ]);
        expect(tunnelCalls.map((call) => call.operation)).toEqual([
          "list",
          "create",
          "putConfiguration",
          "getToken",
          "delete",
        ]);
        expect(allocationCalls.map((call) => call.operation)).toEqual([
          "get",
          "reserve",
          "recordTunnel",
          "recordDns",
          "markReady",
          "get",
          "claimDeprovision",
          "removeClaimed",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does not deprovision an allocation superseded by a concurrent relink", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const layer = providerLayer(
      makePersistentTunnelClient(tunnelCalls),
      makeDnsClient(dnsCalls),
      makeAllocations(allocationCalls),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      const request = {
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      } as const;
      yield* provider.provision(request);
      const unlinkTarget = yield* provider.prepareDeprovision(key);
      expect(unlinkTarget).not.toBeNull();
      if (unlinkTarget === null) {
        return;
      }

      // A relink refreshes the allocation generation after unlink captured its
      // target but before unlink begins external teardown.
      yield* provider.provision(request);
      const tunnelCallCount = tunnelCalls.length;
      const dnsCallCount = dnsCalls.length;
      const allocationCallCount = allocationCalls.length;

      yield* provider.deprovision({ ...key, target: unlinkTarget });

      expect(tunnelCalls).toHaveLength(tunnelCallCount);
      expect(dnsCalls).toHaveLength(dnsCallCount);
      expect(allocationCalls.slice(allocationCallCount).map((call) => call.operation)).toEqual([
        "claimDeprovision",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("releases the tunnel while keeping the allocation, DNS record, and hostname", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const layer = providerLayer(
      makePersistentTunnelClient(tunnelCalls),
      makeDnsClient(dnsCalls),
      makeAllocations(allocationCalls),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 } as const;
      const first = yield* provider.provision({ ...key, origin });
      const released = yield* provider.release(key);
      const second = yield* provider.provision({ ...key, origin });

      expect(released).toBe(true);
      expect(second.endpoint).toEqual(first.endpoint);
      expect(tunnelCalls.map((call) => call.operation)).toEqual([
        // first provision
        "list",
        "create",
        "putConfiguration",
        "getToken",
        // release deletes only the tunnel...
        "delete",
        // ...and the next provision recreates it under the same name
        "list",
        "create",
        "putConfiguration",
        "getToken",
      ]);
      // The DNS record survives the release and is repointed, never deleted.
      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "updateRecord",
      ]);
      expect(allocationCalls.map((call) => call.operation)).not.toContain("remove");
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats an environment without a recorded tunnel as already released", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const layer = providerLayer(
      makePersistentTunnelClient(tunnelCalls),
      makeDnsClient(dnsCalls),
      makeAllocations(),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const released = yield* provider.release({ userId: "user_ABC", environmentId: "env_ABC" });

      expect(released).toBe(true);
      expect(tunnelCalls).toEqual([]);
      expect(dnsCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the tunnel alive when a concurrent provision outdates the release claim", () => {
    const tunnelCalls: TunnelCall[] = [];
    const allocations = makeAllocations();
    // Simulates a provision racing the release: the allocation generation no
    // longer matches what the release loaded, so the claim fails.
    const outdated = ManagedEndpointAllocations.ManagedEndpointAllocations.of({
      ...allocations,
      claimRelease: () => Effect.succeed(false),
    });
    const layer = providerLayer(makePersistentTunnelClient(tunnelCalls), makeDnsClient(), outdated);

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.provision({
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      const released = yield* provider.release(key);

      // false tells the caller its connector token is still live, so it must
      // keep its runtime config.
      expect(released).toBe(false);
      expect(tunnelCalls.map((call) => call.operation)).toEqual([
        "list",
        "create",
        "putConfiguration",
        "getToken",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats an already deleted tunnel as successfully released", () => {
    const notFound = { _tag: "NotFound" } as const;
    const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...makeTunnelClient(),
      delete: (tunnelId) =>
        Effect.fail(
          new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
            operation: "delete",
            tunnelId,
            cause: notFound,
          }),
        ),
    });
    const layer = providerLayer(tunnelClient, makeDnsClient(), makeAllocations());

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.provision({
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      yield* provider.release(key);
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces non-not-found tunnel deletion failures when releasing", () => {
    const failure = new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
      operation: "delete",
      tunnelId: "tunnel-id",
      cause: "Cloudflare tunnel deletion failed",
    });
    const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...makeTunnelClient(),
      delete: () => Effect.fail(failure),
    });
    const layer = providerLayer(tunnelClient, makeDnsClient(), makeAllocations());

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.provision({
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      const error = yield* Effect.flip(provider.release(key));

      expect(error).toMatchObject({
        _tag: "ManagedEndpointDeprovisioningFailed",
        stage: "delete-tunnel",
        userId: key.userId,
        environmentId: key.environmentId,
        tunnelId: "tunnel-id",
      });
      expect(error.cause).toBe(failure);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats an absent allocation as already deprovisioned", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];
    const allocationCalls: AllocationCall[] = [];
    const layer = providerLayer(
      makePersistentTunnelClient(tunnelCalls),
      makeDnsClient(dnsCalls),
      makeAllocations(allocationCalls),
    );

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.deprovision(key);

      expect(tunnelCalls).toEqual([]);
      expect(dnsCalls).toEqual([]);
      expect(allocationCalls).toEqual([{ operation: "get", input: key }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the allocation when tunnel cleanup fails so unlink can retry", () => {
    const allocationCalls: AllocationCall[] = [];
    const tunnelCalls: TunnelCall[] = [];
    let deleteAttempts = 0;
    const failure = new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
      operation: "delete",
      tunnelId: "tunnel-id",
      cause: "Cloudflare tunnel deletion failed",
    });
    const tunnels = makePersistentTunnelClient(tunnelCalls);
    const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...tunnels,
      delete: (tunnelId) =>
        Effect.gen(function* () {
          tunnelCalls.push({ operation: "delete", input: tunnelId });
          deleteAttempts++;
          if (deleteAttempts === 1) {
            return yield* failure;
          }
        }),
    });
    const layer = providerLayer(tunnelClient, makeDnsClient(), makeAllocations(allocationCalls));

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.provision({
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      const first = yield* Effect.result(provider.deprovision(key));
      expect(first._tag).toBe("Failure");
      if (first._tag === "Failure") {
        expect(first.failure).toMatchObject({
          _tag: "ManagedEndpointDeprovisioningFailed",
          stage: "delete-tunnel",
          userId: key.userId,
          environmentId: key.environmentId,
          tunnelId: "tunnel-id",
        });
        expect(first.failure.cause).toBe(failure);
      }
      yield* provider.deprovision(key);

      expect(allocationCalls.map((call) => call.operation)).toEqual([
        "get",
        "reserve",
        "recordTunnel",
        "recordDns",
        "markReady",
        "get",
        "claimDeprovision",
        "get",
        "claimDeprovision",
        "removeClaimed",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats already deleted remote resources as successfully deprovisioned", () => {
    const allocationCalls: AllocationCall[] = [];
    const notFound = { _tag: "NotFound" } as const;
    const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...makeTunnelClient(),
      delete: () =>
        Effect.fail(
          new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
            operation: "delete",
            tunnelId: "tunnel-id",
            cause: notFound,
          }),
        ),
    });
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      ...makeDnsClient(),
      deleteRecord: () =>
        Effect.fail(
          new ManagedEndpointProvider.ManagedEndpointDnsClientError({
            operation: "delete-record",
            dnsRecordId: "created-record-id",
            cause: notFound,
          }),
        ),
    });
    const layer = providerLayer(tunnelClient, dnsClient, makeAllocations(allocationCalls));

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
      yield* provider.provision({
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      yield* provider.deprovision(key);

      expect(allocationCalls.map((call) => call.operation)).toContain("removeClaimed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("scopes managed endpoint resources by user", () => {
    const tunnelCalls: TunnelCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_shared",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      yield* provider.provision({
        userId: "user_DEF",
        environmentId: "env_shared",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(
        tunnelCalls.filter((call) => call.operation === "list").map((call) => call.input),
      ).toEqual([
        { name: expectedManagedTunnelName("env_shared", "user_ABC"), isDeleted: false },
        { name: expectedManagedTunnelName("env_shared", "user_DEF"), isDeleted: false },
      ]);
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls))));
  });

  it.effect("recovers when DNS creation reports failure after the record became visible", () => {
    const dnsCalls: DnsCall[] = [];
    const failure = new ManagedEndpointProvider.ManagedEndpointDnsClientError({
      operation: "create-record",
      hostname: expectedManagedHostname("env_ABC"),
      cause: "ambiguous Cloudflare DNS response",
    });
    let records: ReadonlyArray<{ readonly id: string }> = [];
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      listRecords: (hostname) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "listRecords", input: hostname });
          return records;
        }),
      createRecord: (request) =>
        Effect.gen(function* () {
          dnsCalls.push({ operation: "createRecord", input: request });
          records = [{ id: "created-record-id" }];
          return yield* failure;
        }),
      updateRecord: (dnsRecordId, request) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "updateRecord", input: { dnsRecordId, request } });
        }),
      deleteRecord: (dnsRecordId) =>
        Effect.sync(() => {
          dnsCalls.push({ operation: "deleteRecord", input: dnsRecordId });
        }),
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user_ABC",
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listRecords",
        "createRecord",
        "listRecords",
        "updateRecord",
      ]);
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), dnsClient)));
  });

  it.effect("reports mismatched tunnel responses without manufacturing a cause", () => {
    const dnsCalls: DnsCall[] = [];
    const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...makeTunnelClient(),
      create: () => Effect.succeed({ id: "returned-tunnel-id", name: "unexpected-tunnel" }),
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "validate-tunnel-response",
        userId: "user_ABC",
        environmentId: "env_ABC",
        hostname: expectedManagedHostname("env_ABC"),
        tunnelName: expectedManagedTunnelName("env_ABC"),
        returnedTunnelId: "returned-tunnel-id",
        returnedTunnelName: "unexpected-tunnel",
      });
      if (error._tag === "ManagedEndpointProvisioningFailed") {
        expect(error.cause).toBeUndefined();
      }
      expect(dnsCalls).toHaveLength(0);
    }).pipe(Effect.provide(providerLayer(tunnelClient, makeDnsClient(dnsCalls))));
  });

  it.effect("fails provisioning when the DNS client fails", () => {
    const failure = new ManagedEndpointProvider.ManagedEndpointDnsClientError({
      operation: "list-records",
      hostname: expectedManagedHostname("env_ABC"),
      cause: "Cloudflare DNS failure",
    });
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      listRecords: () => Effect.fail(failure),
      createRecord: () => Effect.die("unused"),
      updateRecord: () => Effect.die("unused"),
      deleteRecord: () => Effect.die("unused"),
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user_ABC",
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "ensure-dns-record",
        userId: "user_ABC",
        environmentId: "env_ABC",
        hostname: expectedManagedHostname("env_ABC"),
        tunnelName: expectedManagedTunnelName("env_ABC"),
        tunnelId: "tunnel-id",
      });
      if (error._tag === "ManagedEndpointProvisioningFailed") {
        expect(error.cause).toBe(failure);
      }
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), dnsClient)));
  });
});

const provisionInput = {
  userId: "user_ABC",
  environmentId: "env_ABC",
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
};

function makeGatewayEnrollment(events: string[] = [], options: { staleReady?: boolean } = {}) {
  let enabled = true;
  let mappingGeneration = 0;
  let mapping: GatewayEnrollmentMapping | null = null;
  const service = ManagedGatewayEnrollment.of({
    enabledFor: () => Effect.sync(() => enabled),
    get: () => Effect.sync(() => mapping),
    registerPending: (input) =>
      Effect.suspend(() => {
        if (mapping?.deleting)
          return Effect.fail(
            new ManagedAccess.ManagedAccessUnavailable({
              message: "Managed environment cleanup is still pending.",
            }),
          );
        events.push("gateway:pending");
        mapping = {
          ...input,
          generation: ++mappingGeneration,
          originDnsRecordId: mapping?.originDnsRecordId ?? null,
        };
        return Effect.succeed(mapping);
      }),
    checkpointAllocation: (input) =>
      Effect.sync(() => !!mapping && !mapping.deleting && input.generation === mapping.generation),
    recordOriginDns: (input) =>
      Effect.sync(() => {
        if (!mapping || input.generation !== mapping.generation) return false;
        mapping = { ...mapping, originDnsRecordId: input.originDnsRecordId };
        events.push("gateway:origin-dns");
        return true;
      }),
    markReady: (input) =>
      Effect.sync(() => {
        if (options.staleReady || !mapping || input.generation !== mapping.generation) return false;
        events.push("gateway:ready");
        return true;
      }),
    pause: (input) =>
      Effect.sync(() => {
        if (!mapping || input.generation !== mapping.generation) return false;
        mapping = { ...mapping, generation: ++mappingGeneration };
        events.push("gateway:pause");
        return true;
      }),
    remove: (input) =>
      Effect.sync(() => {
        if (!mapping || input.generation !== mapping.generation) return false;
        mapping = { ...mapping, deleting: true };
        events.push("gateway:remove");
        return true;
      }),
    finalizeRemove: (input) =>
      Effect.sync(() => {
        if (!mapping?.deleting || input.generation !== mapping.generation) return false;
        mapping = null;
        events.push("gateway:finalize");
        return true;
      }),
    sync: () =>
      Effect.sync(() => {
        events.push("gateway:sync");
      }),
  });
  return {
    service,
    mapping: () => mapping,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    advance: () => {
      if (mapping) mapping = { ...mapping, generation: ++mappingGeneration };
    },
  };
}

function makeGatewayDnsClient(calls: DnsCall[] = [], events: string[] = []) {
  const records = new Map<string, { id: string; type: "CNAME"; content: string; proxied: true }>();
  let recordGeneration = 0;
  return ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    listRecords: (hostname) =>
      Effect.sync(() => {
        calls.push({ operation: "listRecords", input: hostname });
        const record = records.get(hostname);
        return record ? [record] : [];
      }),
    createRecord: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "createRecord", input });
        const record = { ...input, id: `dns-${++recordGeneration}` };
        records.set(input.name, record);
        return record;
      }),
    updateRecord: (id, input) =>
      Effect.sync(() => {
        calls.push({ operation: "updateRecord", input: { dnsRecordId: id, request: input } });
        records.set(input.name, { ...input, id });
      }),
    deleteRecord: (id) =>
      Effect.sync(() => {
        calls.push({ operation: "deleteRecord", input: id });
        events.push(`dns:delete:${id}`);
        for (const [hostname, record] of records) if (record.id === id) records.delete(hostname);
      }),
  });
}

describe("managed gateway enrollment", () => {
  it.effect(
    "a late tunnel creation response cannot overwrite a relinked allocation checkpoint",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let sequence = 0;
        const tunnels = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
          ...makeTunnelClient(),
          create: (input) =>
            Effect.gen(function* () {
              const created = { id: `checkpoint-${++sequence}`, name: input.name };
              if (sequence === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
              }
              return created;
            }),
        });
        const allocations = makeAllocations();
        const gateway = makeGatewayEnrollment();
        yield* Effect.gen(function* () {
          const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
          const old = yield* provider
            .provision(provisionInput)
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* provider.deprovision(provisionInput);
          yield* provider.provision(provisionInput);
          const before = yield* allocations.get(provisionInput);
          expect(before?.tunnelId).toBe("checkpoint-2");
          yield* Deferred.succeed(resume, undefined);
          expect((yield* Fiber.join(old))._tag).toBe("Failure");
          expect(yield* allocations.get(provisionInput)).toEqual(before);
        }).pipe(
          Effect.provide(
            providerLayer(
              tunnels,
              makeGatewayDnsClient(),
              allocations,
              undefined,
              undefined,
              undefined,
              gateway.service,
            ),
          ),
        );
      }),
  );

  it.effect("a superseded provision cannot overwrite a relinked environment's new DNS target", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let first = true;
      let sequence = 0;
      let currentTunnel: { id: string; name: string } | null = null;
      const tunnels = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
        ...makeTunnelClient(),
        list: () => Effect.sync(() => ({ result: currentTunnel ? [currentTunnel] : [] })),
        create: (input) =>
          Effect.sync(() => {
            currentTunnel = { id: `tunnel-${++sequence}`, name: input.name };
            return currentTunnel;
          }),
        delete: (id) =>
          Effect.sync(() => {
            if (currentTunnel?.id === id) currentTunnel = null;
          }),
        putConfiguration: () =>
          Effect.gen(function* () {
            if (first) {
              first = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
          }),
      });
      const dnsCalls: DnsCall[] = [];
      const dns = makeGatewayDnsClient(dnsCalls);
      const allocations = makeAllocations();
      const gateway = makeGatewayEnrollment();
      yield* Effect.gen(function* () {
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        const obsolete = yield* provider
          .provision(provisionInput)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* provider.deprovision(provisionInput);
        const replacement = yield* provider.provision(provisionInput);
        expect(replacement.runtime.tunnelId).toBe("tunnel-2");
        const mapping = gateway.mapping()!;
        yield* Deferred.succeed(resume, undefined);
        const oldResult = yield* Fiber.join(obsolete);
        expect(oldResult._tag).toBe("Failure");
        expect(yield* dns.listRecords(mapping.originHostname)).toMatchObject([
          { content: "tunnel-2.cfargotunnel.com" },
        ]);
        expect(dnsCalls.filter((call) => call.operation === "updateRecord")).toEqual([]);
      }).pipe(
        Effect.provide(
          providerLayer(
            tunnels,
            dns,
            allocations,
            undefined,
            undefined,
            undefined,
            gateway.service,
          ),
        ),
      );
    }),
  );

  it.effect(
    "gives new enrollments a separate public hostname and only exposes the guarded origin in tunnel ingress",
    () => {
      const tunnels: TunnelCall[] = [];
      const dns: DnsCall[] = [];
      const allocations = makeAllocations();
      const gateway = makeGatewayEnrollment();
      return Effect.gen(function* () {
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        const result = yield* provider.provision(provisionInput);
        const hash = NodeCrypto.createHash("sha256")
          .update("g-dev_julius:user_ABC:env_ABC")
          .digest("hex")
          .slice(0, 16);
        const publicHostname = `${hash}-g-dev-julius.t3code.test`;
        const originHostname = `gw-origin-dev-julius-${hash}.t3code.test`;
        expect(result.endpoint.httpBaseUrl).toBe(`https://${publicHostname}/`);
        expect(tunnels.find((call) => call.operation === "putConfiguration")?.input).toMatchObject({
          tunnelConfig: {
            ingress: [
              {
                hostname: originHostname,
                service: "http://127.0.0.1:3773",
                originRequest: { httpHostHeader: publicHostname },
              },
              { service: "http_status:404" },
            ],
          },
        });
        expect(
          dns.filter((call) => call.operation === "createRecord").map((call) => call.input),
        ).toEqual([
          {
            type: "CNAME",
            name: publicHostname,
            content: "tunnel-id.cfargotunnel.com",
            ttl: 1,
            proxied: true,
          },
          {
            type: "CNAME",
            name: originHostname,
            content: "tunnel-id.cfargotunnel.com",
            ttl: 1,
            proxied: true,
          },
        ]);
        const allocation = yield* allocations.get(provisionInput);
        expect(allocation?.dnsRecordId).toBe("dns-1");
        expect(gateway.mapping()?.originDnsRecordId).toBe("dns-2");
        expect(result.runtime.connectorToken).toBe("connector-token");
      }).pipe(
        Effect.provide(
          providerLayer(
            makeTunnelClient(tunnels),
            makeGatewayDnsClient(dns),
            allocations,
            undefined,
            undefined,
            undefined,
            gateway.service,
          ),
        ),
      );
    },
  );

  it.effect(
    "refuses to silently migrate an existing legacy connector before any Cloudflare mutation",
    () => {
      const tunnels: TunnelCall[] = [];
      const dns: DnsCall[] = [];
      const allocations = makeAllocations();
      const gateway = makeGatewayEnrollment();
      return Effect.gen(function* () {
        yield* allocations.reserve({
          ...provisionInput,
          hostname: expectedManagedHostname("env_ABC"),
          tunnelName: expectedManagedTunnelName("env_ABC"),
        });
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        expect((yield* Effect.flip(provider.provision(provisionInput)))._tag).toBe(
          "ManagedAccessUnavailable",
        );
        expect(tunnels).toEqual([]);
        expect(dns).toEqual([]);
      }).pipe(
        Effect.provide(
          providerLayer(
            makeTunnelClient(tunnels),
            makeGatewayDnsClient(dns),
            allocations,
            undefined,
            undefined,
            undefined,
            gateway.service,
          ),
        ),
      );
    },
  );

  it.effect("refuses to downgrade a gateway allocation when enrollment is disabled", () => {
    const tunnels: TunnelCall[] = [];
    const dns: DnsCall[] = [];
    const gateway = makeGatewayEnrollment();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(provisionInput);
      gateway.setEnabled(false);
      tunnels.length = 0;
      dns.length = 0;
      expect((yield* Effect.flip(provider.provision(provisionInput)))._tag).toBe(
        "ManagedAccessUnavailable",
      );
      expect(tunnels).toEqual([]);
      expect(dns).toEqual([]);
    }).pipe(
      Effect.provide(
        providerLayer(
          makeTunnelClient(tunnels),
          makeGatewayDnsClient(dns),
          undefined,
          undefined,
          undefined,
          undefined,
          gateway.service,
        ),
      ),
    );
  });

  it.effect(
    "does not return connector credentials when enrollment activation loses its generation claim",
    () => {
      const gateway = makeGatewayEnrollment([], { staleReady: true });
      return Effect.gen(function* () {
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        const result = yield* Effect.result(provider.provision(provisionInput));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("ManagedAccessUnavailable");
      }).pipe(
        Effect.provide(
          providerLayer(
            undefined,
            makeGatewayDnsClient(),
            undefined,
            undefined,
            undefined,
            undefined,
            gateway.service,
          ),
        ),
      );
    },
  );

  it.effect(
    "leaves current external resources intact when an old unlink loses its gateway generation claim",
    () => {
      const tunnels: TunnelCall[] = [];
      const dns: DnsCall[] = [];
      const gateway = makeGatewayEnrollment();
      return Effect.gen(function* () {
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        yield* provider.provision(provisionInput);
        const target = yield* provider.prepareDeprovision(provisionInput);
        gateway.advance();
        tunnels.length = 0;
        dns.length = 0;
        yield* provider.deprovision({ ...provisionInput, target });
        expect(tunnels).toEqual([]);
        expect(dns).toEqual([]);
        expect(gateway.mapping()).not.toBeNull();
      }).pipe(
        Effect.provide(
          providerLayer(
            makeTunnelClient(tunnels),
            makeGatewayDnsClient(dns),
            undefined,
            undefined,
            undefined,
            undefined,
            gateway.service,
          ),
        ),
      );
    },
  );

  it.effect(
    "a released gateway reconnects using fresh DNS records for its replacement tunnel",
    () => {
      const gateway = makeGatewayEnrollment();
      const dns = makeGatewayDnsClient();
      let sequence = 0;
      let tunnel: { id: string; name: string } | null = null;
      const client = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
        ...makeTunnelClient(),
        list: () => Effect.sync(() => ({ result: tunnel ? [tunnel] : [] })),
        create: (input) =>
          Effect.sync(() => {
            tunnel = { id: `restart-${++sequence}`, name: input.name };
            return tunnel;
          }),
        delete: (id) =>
          Effect.sync(() => {
            if (tunnel?.id === id) tunnel = null;
          }),
      });
      return Effect.gen(function* () {
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        yield* provider.provision(provisionInput);
        const firstDns = gateway.mapping()!.originDnsRecordId;
        expect(yield* provider.release(provisionInput)).toBe(true);
        const next = yield* provider.provision(provisionInput);
        expect(next.runtime.tunnelId).toBe("restart-2");
        const current = gateway.mapping()!;
        expect(current.originDnsRecordId).not.toBe(firstDns);
        expect(yield* dns.listRecords(current.originHostname)).toMatchObject([
          { content: "restart-2.cfargotunnel.com" },
        ]);
      }).pipe(
        Effect.provide(
          providerLayer(client, dns, undefined, undefined, undefined, undefined, gateway.service),
        ),
      );
    },
  );

  it.effect("pauses and synchronizes gateway access before release deletes the tunnel", () => {
    const events: string[] = [];
    const gateway = makeGatewayEnrollment(events);
    const tunnels = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
      ...makeTunnelClient(),
      delete: () =>
        Effect.sync(() => {
          events.push("tunnel:delete");
        }),
    });
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(provisionInput);
      events.length = 0;
      expect(yield* provider.release(provisionInput)).toBe(true);
      expect(events).toEqual([
        "gateway:pause",
        "gateway:sync",
        "dns:delete:dns-2",
        "dns:delete:dns-1",
        "tunnel:delete",
      ]);
      expect(gateway.mapping()).not.toBeNull();
    }).pipe(
      Effect.provide(
        providerLayer(
          tunnels,
          makeGatewayDnsClient([], events),
          undefined,
          undefined,
          undefined,
          undefined,
          gateway.service,
        ),
      ),
    );
  });

  it.effect(
    "retains gateway cleanup targets across failed cutoff sync and blocks relink until cleanup completes",
    () => {
      const events: string[] = [];
      const tunnelCalls: TunnelCall[] = [];
      const dnsCalls: DnsCall[] = [];
      const allocations = makeAllocations();
      const gateway = makeGatewayEnrollment(events);
      let failCutoffSync = true;
      const enrollment = ManagedGatewayEnrollment.of({
        ...gateway.service,
        sync: (userId) =>
          Effect.gen(function* () {
            yield* gateway.service.sync(userId);
            if (gateway.mapping()?.deleting && failCutoffSync) {
              failCutoffSync = false;
              return yield* new ManagedAccess.ManagedAccessUnavailable({
                message: "Gateway sync interrupted",
              });
            }
          }),
      });
      const persistentTunnels = makePersistentTunnelClient(tunnelCalls);
      const tunnels = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
        ...persistentTunnels,
        delete: (tunnelId) =>
          Effect.gen(function* () {
            events.push("tunnel:delete");
            yield* persistentTunnels.delete(tunnelId);
          }),
      });
      return Effect.gen(function* () {
        const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
        yield* provider.provision(provisionInput);
        const error = yield* Effect.flip(provider.deprovision(provisionInput));
        expect(error).toMatchObject({
          _tag: "ManagedEndpointDeprovisioningFailed",
          stage: "gateway-cutoff",
        });
        expect(gateway.mapping()).toMatchObject({ deleting: true, originDnsRecordId: "dns-2" });
        expect(tunnelCalls.filter((call) => call.operation === "delete")).toEqual([]);
        expect(dnsCalls.filter((call) => call.operation === "deleteRecord")).toEqual([]);

        tunnelCalls.length = 0;
        dnsCalls.length = 0;
        expect((yield* Effect.flip(provider.provision(provisionInput)))._tag).toBe(
          "ManagedAccessUnavailable",
        );
        expect(tunnelCalls).toEqual([]);
        expect(dnsCalls).toEqual([]);

        events.length = 0;
        yield* provider.deprovision(provisionInput);
        expect(
          dnsCalls.filter((call) => call.operation === "deleteRecord").map((call) => call.input),
        ).toEqual(["dns-2", "dns-1"]);
        expect(tunnelCalls.filter((call) => call.operation === "delete")).toHaveLength(1);
        expect(events.indexOf("gateway:sync")).toBeLessThan(events.indexOf("dns:delete:dns-2"));
        expect(events.indexOf("tunnel:delete")).toBeLessThan(events.indexOf("gateway:finalize"));
        expect(gateway.mapping()).toBeNull();
        expect(yield* allocations.get(provisionInput)).toBeNull();

        expect((yield* provider.provision(provisionInput)).runtime.connectorToken).toBe(
          "connector-token",
        );
      }).pipe(
        Effect.provide(
          providerLayer(
            tunnels,
            makeGatewayDnsClient(dnsCalls, events),
            allocations,
            undefined,
            undefined,
            undefined,
            enrollment,
          ),
        ),
      );
    },
  );
});
it.effect("denies unpaid provision before Cloudflare is touched", () => {
  const calls: TunnelCall[] = [];
  return Effect.gen(function* () {
    const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    expect((yield* Effect.flip(provider.provision(provisionInput)))._tag).toBe(
      "ManagedAccessRequired",
    );
    expect(calls).toHaveLength(0);
  }).pipe(
    Effect.provide(
      providerLayer(
        makeTunnelClient(calls),
        undefined,
        undefined,
        undefined,
        ManagedAccess.ManagedAccess.of({
          check: () => Effect.fail(new ManagedAccess.ManagedAccessRequired({ message: "expired" })),
        }),
      ),
    ),
  );
});
it.effect("withholds connector credentials if access expires during provisioning", () => {
  let checks = 0;
  return Effect.gen(function* () {
    const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    expect((yield* Effect.flip(provider.provision(provisionInput)))._tag).toBe(
      "ManagedAccessRequired",
    );
    expect(checks).toBe(2);
  }).pipe(
    Effect.provide(
      providerLayer(
        undefined,
        undefined,
        undefined,
        undefined,
        ManagedAccess.ManagedAccess.of({
          check: () =>
            Effect.suspend(() =>
              ++checks === 1
                ? Effect.void
                : Effect.fail(new ManagedAccess.ManagedAccessRequired({ message: "expired" })),
            ),
        }),
      ),
    ),
  );
});
it.effect("withholds credentials when a reservation is superseded during provider work", () => {
  const reservation: ManagedReservations.ManagedReservation = {
    ...provisionInput,
    generation: 1,
    accountGeneration: 1,
    state: "pending",
  };
  const service = ManagedReservations.ManagedReservations.of({
    get: () => Effect.succeed(reservation),
    reserve: () => Effect.succeed(reservation),
    complete: () => Effect.succeed(false),
    release: () => Effect.succeed(true),
  });
  return Effect.gen(function* () {
    const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    expect((yield* Effect.flip(provider.provision(provisionInput)))._tag).toBe(
      "ManagedAccessUnavailable",
    );
  }).pipe(
    Effect.provide(providerLayer(undefined, undefined, undefined, undefined, undefined, service)),
  );
});
it.effect(
  "old unlink captures reservation generation before a newer provision even without an allocation",
  () => {
    let generation = 1;
    const released: number[] = [];
    const service = ManagedReservations.ManagedReservations.of({
      get: () =>
        Effect.sync(() => ({
          ...provisionInput,
          generation,
          accountGeneration: 1,
          state: "pending" as const,
        })),
      reserve: () => Effect.succeed(null),
      complete: () => Effect.succeed(true),
      release: (input) =>
        Effect.sync(() => {
          if (input.generation !== generation) return false;
          released.push(generation);
          return true;
        }),
    });
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const target = yield* provider.prepareDeprovision(provisionInput);
      generation = 2;
      yield* provider.deprovision({ ...provisionInput, target });
      expect(released).toEqual([]);
      yield* provider.deprovision(provisionInput);
      expect(released).toEqual([2]);
    }).pipe(
      Effect.provide(
        providerLayer(undefined, undefined, makeAllocations(), undefined, undefined, service),
      ),
    );
  },
);
