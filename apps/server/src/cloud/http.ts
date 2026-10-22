import * as NodeCrypto from "node:crypto";
import {
  ManualCloudLinkError,
  type ManualCloudLinkProofInput,
  type ManualCloudRelayConfigInput,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentCloudLinkStateResult,
  EnvironmentCloudRelayConfigResult,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
} from "@lecturn/contracts";
import {
  RelayCloudEnvironmentHealthProofPayload,
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialProofPayload,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentHealthResponseProofPayload,
  type RelayEnvironmentHealthResponse as RelayEnvironmentHealthResponseShape,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkResponse,
  RelayEnvironmentMintResponseProofPayload,
  type RelayEnvironmentMintResponse as RelayEnvironmentMintResponseShape,
  RelayEnvironmentLinkProof,
  RelayEnvironmentLinkProofPayload,
  RelayLinkProofRequest,
  RelayManagedEndpointOrigin,
  type RelayManagedEndpointOriginSyncRequest,
  RelayManagedEndpointOriginSyncResponse,
  RelayManagedEndpointRecoveryProofPayload,
  RelayManagedEndpointRecoveryRegistrationResponse,
  RelayManagedEndpointRecoveryResponse,
  type RelayManagedEndpointRuntimeConfig,
  RelayOkResponse,
} from "@lecturn/contracts/relay";
import { withRelayClientTracing } from "@lecturn/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_LINK_PROOF_TYP,
  RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@lecturn/shared/relayJwt";
import { isSecureRelayUrl } from "@lecturn/shared/relayUrl";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as HttpEffect from "effect/http/HttpEffect";
import * as Semaphore from "effect/Semaphore";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServer from "effect/http/HttpServer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import {
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  decodeConfirmedOrigin,
  CLOUD_LINKED_USER_ID,
  CLOUD_LINKED_ORGANIZATION_ID,
  CLOUD_MINT_PUBLIC_KEY,
  decodeRuntimeConfig,
  encodeEndpointRuntimeConfigJson,
  encodeConfirmedOriginJson,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import { relayUrlConfig } from "./publicConfig.ts";
import {
  readCliDesiredCloudLink,
  readCliDesiredLinkMode,
  setCliDesiredCloudLink,
} from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";
import { deviceRelayConflict, deviceRelayPublicationBlocked } from "./DeviceRelayReservation.ts";
import { traceRelayRequest } from "./traceRelayRequest.ts";
import { filterRelayResponse, relayRequestError, shouldRetryCloudLink } from "./relayResponse.ts";

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
/** Secret store name prefixes of cloud replay markers. The server prunes expired ones. */
export const CLOUD_REPLAY_MARKER_PREFIXES = [
  CLOUD_MINT_NONCE_PREFIX,
  CLOUD_MINT_JTI_PREFIX,
  CLOUD_HEALTH_NONCE_PREFIX,
  CLOUD_HEALTH_JTI_PREFIX,
] as const;
const CLOUD_PROOF_MAX_LIFETIME_SECONDS = 5 * 60;
const CLOUD_PROOF_CLOCK_SKEW_SECONDS = 60;
// The desktop app stops its backends within seconds of writing the marker.
const DESKTOP_UPDATE_RESTART_MARKER_TTL = Duration.minutes(1);
const MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT = Duration.minutes(2);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const CLOUD_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCloudCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CLOUD_CREDENTIAL_RESPONSE_HEADERS)),
);

const failEnvironmentCloudInternalError =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, EnvironmentHttpInternalServerError> =>
    Effect.logError(message, { cause }).pipe(
      Effect.flatMap(() => Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
    );

const failCloudCliTokenManagerError = (error: CliTokenManager.CloudCliTokenManagerError) =>
  failEnvironmentCloudInternalError(error.message)(error);

const requireRelayUrl = relayUrlConfig.pipe(
  Effect.mapError(
    () =>
      new EnvironmentHttpInternalServerError({
        message: "LECTURN_RELAY_URL must be configured as a secure absolute HTTPS origin.",
      }),
  ),
);

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function consumeCloudReplayGuards(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.forEach(
    input.names,
    (name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      ),
    { concurrency: input.names.length },
  ).pipe(Effect.map((created) => created.every(Boolean)));
}

function normalizePemForSignedPayload(value: string): string {
  return value.trim();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function validateCloudMintPublicKey(
  publicKey: string,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  return Effect.try({
    try: () => NodeCrypto.createPublicKey(publicKey.replace(/\\n/g, "\n")),
    catch: () =>
      new EnvironmentHttpBadRequestError({
        message: "Cloud mint public key must be a valid Ed25519 public key.",
      }),
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519"
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpBadRequestError({
              message: "Cloud mint public key must be a valid Ed25519 public key.",
            }),
          ),
    ),
  );
}

function validateRelayConfigPayload(
  payload: RelayEnvironmentConfigRequest,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  if (!isSecureRelayUrl(payload.relayUrl)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay URL must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay issuer must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.environmentCredential.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay environment credential is required.",
      }),
    );
  }
  if (payload.cloudUserId.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Cloud user id is required.",
      }),
    );
  }
  return Effect.void;
}

function validateLinkedCloudUser(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly cloudUserId: string;
}): Effect.Effect<void, EnvironmentAuth.ServerAuthInternalError | EnvironmentHttpConflictError> {
  return input.secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthLinkedCloudAccountVerificationError({
          cause,
        }),
    ),
    Effect.flatMap((existing) => {
      if (Option.isNone(existing)) {
        return Effect.void;
      }
      const existingCloudUserId = bytesToString(existing.value);
      return existingCloudUserId === input.cloudUserId
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpConflictError({
              message:
                "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
            }),
          );
    }),
  );
}

function readInstalledCloudUserId(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError> {
  return secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthLinkedCloudAccountReadError({
          cause,
        }),
    ),
    Effect.flatMap((bytes) =>
      Option.isSome(bytes)
        ? Effect.succeed(bytesToString(bytes.value))
        : Effect.fail(new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({})),
    ),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function requestAbsoluteUrl(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return new URL(request.originalUrl).href;
  } catch {
    const host = firstForwardedHeaderValue(request.headers.host) ?? "127.0.0.1";
    try {
      return new URL(request.originalUrl, `http://${host}`).href;
    } catch {
      return null;
    }
  }
}

function hasForwardedAuthorityHeaders(request: HttpServerRequest.HttpServerRequest): boolean {
  return (
    firstForwardedHeaderValue(request.headers["x-forwarded-host"]) !== undefined ||
    firstForwardedHeaderValue(request.headers["x-forwarded-proto"]) !== undefined
  );
}

function endpointRequestPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

export function parseManagedEndpointLocalOrigin(localOrigin: string) {
  const url = new URL(localOrigin);
  if (
    localOrigin !== localOrigin.trim() ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    localOrigin.includes("?") ||
    localOrigin.includes("#")
  ) {
    throw new Error("Invalid local origin");
  }
  const wsUrl = new URL(url.origin);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    httpBaseUrl: url.origin,
    wsBaseUrl: wsUrl.origin,
    origin: {
      localHttpHost: url.hostname,
      localHttpPort: endpointRequestPort(url),
    } satisfies RelayManagedEndpointOrigin,
  };
}

function isAllowedEndpointOrigin(input: {
  readonly origin: RelayManagedEndpointOrigin;
  readonly requestUrl: string;
}): boolean {
  if (!isLoopbackHostname(input.origin.localHttpHost)) {
    return false;
  }

  const url = new URL(input.requestUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return false;
  }

  return input.origin.localHttpPort === endpointRequestPort(url);
}

// A managed (Cloudflare tunnel) endpoint is provisioned by the relay and must
// point at a loopback origin. A manual endpoint is reached out of band (e.g.
// Tailscale) or not advertised at all for publish-only links, so it is not
// tied to the managed-tunnel scope.
export function isSupportedLinkProviderKind(request: RelayLinkProofRequest): boolean {
  return (
    request.endpoint.providerKind === "cloudflare_tunnel" ||
    request.endpoint.providerKind === "manual"
  );
}

export function linkProofScopes(
  request: RelayLinkProofRequest,
): RelayEnvironmentLinkProofPayload["scopes"] {
  return request.endpoint.providerKind === "cloudflare_tunnel"
    ? ["agent_activity_notifications", "managed_tunnels"]
    : ["agent_activity_notifications"];
}

function hasExactScope(input: {
  readonly scopes: ReadonlyArray<string>;
  readonly expected: string;
}): boolean {
  return input.scopes.length === 1 && input.scopes[0] === input.expected;
}

function hasBoundedCloudProofLifetime(input: {
  readonly iat: number;
  readonly exp: number;
  readonly nowSeconds: number;
}): boolean {
  return (
    input.exp > input.iat &&
    input.exp - input.iat <= CLOUD_PROOF_MAX_LIFETIME_SECONDS &&
    input.iat <= input.nowSeconds + CLOUD_PROOF_CLOCK_SKEW_SECONDS
  );
}

const decodeCloudHealthProof = Schema.decodeUnknownEffect(RelayCloudEnvironmentHealthProofPayload);
const decodeCloudMintProof = Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload);

interface CloudHttpDependencies {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"];
  readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly cliTokenManager: CliTokenManager.CloudCliTokenManager["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly awarenessRelay: AgentAwarenessRelay.AgentAwarenessRelay["Service"];
}

// HTTP handlers and CLI reconciliation share this store instance. Lock the
// complete ownership/configuration mutation, not just the connector process.
// Different Lecturn homes have separate stores and remain independent.
const cloudLinkMutationLocks = new WeakMap<
  ServerSecretStore.ServerSecretStore["Service"],
  Semaphore.Semaphore
>();

function withCloudLinkMutation<A, E, R>(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    let lock = cloudLinkMutationLocks.get(secrets);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      cloudLinkMutationLocks.set(secrets, lock);
    }
    return lock.withPermits(1)(effect.pipe(Effect.uninterruptible));
  });
}

const cloudHttpDependencies = Effect.gen(function* () {
  return {
    secrets: yield* ServerSecretStore.ServerSecretStore,
    environment: yield* ServerEnvironment.ServerEnvironment,
    endpointRuntime: yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime,
    environmentAuth: yield* EnvironmentAuth.EnvironmentAuth,
    cliTokenManager: yield* CliTokenManager.CloudCliTokenManager,
    httpClient: yield* HttpClient.HttpClient,
    awarenessRelay: yield* AgentAwarenessRelay.AgentAwarenessRelay,
  } satisfies CloudHttpDependencies;
});

const makeCloudLinkProof = Effect.fn("environment.cloud.makeLinkProof")(function* (
  dependencies: CloudHttpDependencies,
  request: RelayLinkProofRequest,
  requestUrl: string,
) {
  if (
    !isSupportedLinkProviderKind(request) ||
    !isAllowedEndpointOrigin({
      origin: request.origin,
      requestUrl,
    })
  ) {
    return yield* new EnvironmentHttpBadRequestError({
      message: "Invalid managed endpoint origin.",
    });
  }
  return yield* signCloudLinkProof(dependencies, request);
});

const signCloudLinkProof = Effect.fn("environment.cloud.signLinkProof")(function* (
  dependencies: CloudHttpDependencies,
  request: RelayLinkProofRequest,
) {
  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const descriptor = yield* dependencies.environment.getDescriptor;
  const payload = {
    iss: `lecturn-env:${descriptor.environmentId}`,
    aud: normalizeRelayIssuer(request.relayIssuer),
    sub: descriptor.environmentId,
    jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    iat: nowSeconds,
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    challenge: request.challenge,
    descriptor,
    environmentId: descriptor.environmentId,
    environmentPublicKey: normalizePemForSignedPayload(keyPair.publicKey),
    endpoint: request.endpoint,
    origin: request.origin,
    scopes: linkProofScopes(request),
    teamPolicyVersion: 1,
  } satisfies RelayEnvironmentLinkProofPayload;
  return yield* signRelayJwt({
    privateKey: keyPair.privateKey,
    typ: RELAY_LINK_PROOF_TYP,
    payload,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthCloudLinkJwtSigningError({
          cause,
        }),
    ),
  );
});

const cloudLinkProofHandler = Effect.fn("environment.cloud.linkProof")(
  function* (dependencies: CloudHttpDependencies, request: RelayLinkProofRequest) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = requestAbsoluteUrl(httpRequest);
    if (requestUrl === null || hasForwardedAuthorityHeaders(httpRequest)) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "Invalid managed endpoint origin.",
      });
    }
    const proof = yield* makeCloudLinkProof(dependencies, request, requestUrl);
    yield* appendCloudCredentialResponseHeaders;
    return proof satisfies RelayEnvironmentLinkProof;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not generate environment link proof."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not generate environment link proof."),
  ),
);

function managedEndpointRuntimeConfigsMatch(
  left: RelayManagedEndpointRuntimeConfig,
  right: RelayManagedEndpointRuntimeConfig,
): boolean {
  return (
    left.providerKind === right.providerKind &&
    left.connectorToken === right.connectorToken &&
    left.tunnelId === right.tunnelId &&
    left.tunnelName === right.tunnelName
  );
}

const activateManagedTunnel = Effect.fn("environment.cloud.activateManagedTunnel")(function* (
  dependencies: CloudHttpDependencies,
  input: {
    readonly config: RelayManagedEndpointRuntimeConfig;
    readonly configJson: string;
    readonly origin: RelayManagedEndpointOrigin;
  },
) {
  return yield* dependencies.endpointRuntime.withLinkStateLock(
    Effect.gen(function* () {
      const currentConfig = yield* dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
      if (Option.isNone(currentConfig) || bytesToString(currentConfig.value) !== input.configJson) {
        return null;
      }
      const status = yield* dependencies.endpointRuntime.applyConfig(input.config);
      if (status.status !== "running") {
        // Lecturn surfaces the connector's own reason (for example a missing
        // cloudflared) so the link UI can say what to fix.
        return yield* new EnvironmentCloudEndpointUnavailableError({
          message:
            status.status === "failed"
              ? status.reason
              : "Managed endpoint runtime could not be started.",
          endpointRuntimeStatus: status,
        });
      }
      const marker = yield* encodeConfirmedOriginJson({
        config: input.config,
        origin: input.origin,
      });
      yield* dependencies.secrets.set(CLOUD_ENDPOINT_CONFIRMED_ORIGIN, stringToBytes(marker));
      return status;
    }),
  );
});

const activateManagedTunnelWithRetry = (
  dependencies: CloudHttpDependencies,
  input: {
    readonly config: RelayManagedEndpointRuntimeConfig;
    readonly configJson: string;
    readonly origin: RelayManagedEndpointOrigin;
  },
  retryRuntimeFailures: boolean,
) => {
  const activate = activateManagedTunnel(dependencies, input);
  return retryRuntimeFailures
    ? activate.pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "EnvironmentCloudEndpointUnavailableError" &&
            ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus(
              error.endpointRuntimeStatus,
            ),
          schedule: Schedule.exponential("1 second").pipe(
            Schedule.modifyDelay(({ duration }) =>
              Effect.succeed(Duration.min(duration, Duration.seconds(30))),
            ),
            Schedule.jittered,
          ),
        }),
      )
    : activate;
};

export const startManagedCloudTunnelIfOriginConfirmed = Effect.fn(
  "environment.cloud.startManagedCloudTunnelIfOriginConfirmed",
)(function* (localOrigin: string, options?: { readonly requireConfirmedOrigin?: boolean }) {
  const dependencies = yield* cloudHttpDependencies;
  // Another installation owns this device's relay publication.
  if (deviceRelayPublicationBlocked(dependencies.secrets)) return false;
  const requireConfirmedOrigin = options?.requireConfirmedOrigin ?? true;
  const parsedOrigin = yield* Effect.try({
    try: () => parseManagedEndpointLocalOrigin(localOrigin),
    catch: () =>
      new EnvironmentHttpBadRequestError({
        message: "Could not resolve local environment origin.",
      }),
  });
  return yield* dependencies.endpointRuntime.withLinkStateLock(
    Effect.gen(function* () {
      const [runtimeBytes, markerBytes] = yield* Effect.all([
        dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
        dependencies.secrets.get(CLOUD_ENDPOINT_CONFIRMED_ORIGIN),
      ]);
      if (Option.isNone(runtimeBytes)) return false;
      const config = Option.getOrNull(decodeRuntimeConfig(bytesToString(runtimeBytes.value)));
      if (config === null || config.providerKind !== "cloudflare_tunnel") return false;
      // With the marker required, only a config the relay already confirmed on
      // this port may start. Without it, startup is falling back after the
      // relay stayed unreachable: an unconfirmed origin may send traffic to a
      // stale port, but that beats no remote access at all.
      if (requireConfirmedOrigin) {
        if (Option.isNone(markerBytes)) return false;
        const marker = Option.getOrNull(decodeConfirmedOrigin(bytesToString(markerBytes.value)));
        if (
          marker === null ||
          !managedEndpointRuntimeConfigsMatch(marker.config, config) ||
          marker.origin.localHttpHost !== parsedOrigin.origin.localHttpHost ||
          marker.origin.localHttpPort !== parsedOrigin.origin.localHttpPort
        ) {
          return false;
        }
      }
      const status = yield* dependencies.endpointRuntime.applyConfig(config);
      if (status.status !== "running") {
        return yield* new EnvironmentCloudEndpointUnavailableError({
          message: "Managed endpoint runtime could not be started.",
          endpointRuntimeStatus: status,
        });
      }
      return true;
    }),
  );
});

type CloudRelayConfigDependencies = Pick<CloudHttpDependencies, "secrets" | "endpointRuntime"> &
  Partial<Pick<CloudHttpDependencies, "awarenessRelay">>;

export const applyCloudRelayConfig = Effect.fn("environment.cloud.applyRelayConfig")(function* (
  dependencies: CloudRelayConfigDependencies,
  payload: RelayEnvironmentConfigRequest,
  options?: {
    readonly lockHeld?: boolean;
    readonly confirmedOrigin?: RelayManagedEndpointOrigin;
  },
) {
  // Lock order: the runtime's link-state lock first, then this store's
  // ownership/configuration mutation lock.
  const apply = withCloudLinkMutation(
    dependencies.secrets,
    Effect.gen(function* () {
      yield* validateRelayConfigPayload(payload);
      yield* validateLinkedCloudUser({
        secrets: dependencies.secrets,
        cloudUserId: payload.cloudUserId,
      });
      yield* validateCloudMintPublicKey(payload.cloudMintPublicKey);
      // Reject unsupported runtimes before touching the connector so a bad
      // payload cannot stop a healthy tunnel on its way to a 503.
      if (
        payload.endpointRuntime !== null &&
        payload.endpointRuntime.providerKind !== "cloudflare_tunnel"
      ) {
        return yield* new EnvironmentCloudEndpointUnavailableError({
          message: "Managed endpoint runtime could not be started.",
          endpointRuntimeStatus: {
            status: "unsupported",
            providerKind: payload.endpointRuntime.providerKind,
          },
        });
      }
      const configKeys = [
        RELAY_URL_SECRET,
        RELAY_ISSUER_SECRET,
        CLOUD_LINKED_USER_ID,
        CLOUD_LINKED_ORGANIZATION_ID,
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        CLOUD_MINT_PUBLIC_KEY,
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
      ] as const;
      const previous = new Map(
        yield* Effect.all(
          configKeys.map((key) =>
            dependencies.secrets.get(key).pipe(Effect.map((value) => [key, value] as const)),
          ),
        ),
      );
      const previousOwner = previous.get(CLOUD_LINKED_USER_ID)!;
      const previousRuntime = previous.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)!;
      const previousConfirmed = previous.get(CLOUD_ENDPOINT_CONFIRMED_ORIGIN)!;
      const previousConfig =
        Option.isSome(previousRuntime) && Option.isSome(previousConfirmed)
          ? Option.getOrNull(decodeRuntimeConfig(bytesToString(previousRuntime.value)))
          : null;
      // Stop the connector before its config changes; it restarts once the
      // relay confirms the new origin. Publishing claims this device's relay
      // reservation, so a losing installation fails here with nothing changed.
      const stoppedStatus = yield* dependencies.endpointRuntime.applyConfig(null, {
        published: true,
      });
      if (stoppedStatus.status === "failed") {
        return yield* new EnvironmentCloudEndpointUnavailableError({
          message: stoppedStatus.reason,
          endpointRuntimeStatus: stoppedStatus,
        });
      }

      yield* Effect.gen(function* () {
        yield* dependencies.secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN);
        yield* dependencies.secrets.set(RELAY_URL_SECRET, stringToBytes(payload.relayUrl));
        yield* dependencies.secrets.set(
          RELAY_ISSUER_SECRET,
          stringToBytes(payload.relayIssuer ?? payload.relayUrl),
        );
        yield* dependencies.secrets.set(CLOUD_LINKED_USER_ID, stringToBytes(payload.cloudUserId));
        if (payload.organizationId)
          yield* dependencies.secrets.set(
            CLOUD_LINKED_ORGANIZATION_ID,
            stringToBytes(payload.organizationId),
          );
        else yield* dependencies.secrets.remove(CLOUD_LINKED_ORGANIZATION_ID);
        yield* dependencies.secrets.set(
          RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
          stringToBytes(payload.environmentCredential),
        );
        yield* dependencies.secrets.set(
          CLOUD_MINT_PUBLIC_KEY,
          stringToBytes(payload.cloudMintPublicKey),
        );
        if (payload.endpointRuntime) {
          const endpointRuntimeJson = yield* encodeEndpointRuntimeConfigJson(
            payload.endpointRuntime,
          );
          yield* dependencies.secrets.set(
            CLOUD_ENDPOINT_RUNTIME_CONFIG,
            stringToBytes(endpointRuntimeJson),
          );
        } else {
          yield* dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // Restore prior credentials/configuration if persistence fails. A
            // first publish must not strand a device lease, and a previously
            // confirmed connector comes back.
            yield* Effect.all(
              configKeys.map((key) => {
                const value = previous.get(key)!;
                return (
                  Option.isSome(value)
                    ? dependencies.secrets.set(key, value.value)
                    : dependencies.secrets.remove(key)
                ).pipe(Effect.ignore);
              }),
            );
            yield* dependencies.endpointRuntime.applyConfig(previousConfig, {
              published: Option.isSome(previousOwner),
            });
            return yield* Effect.failCause(cause);
          }),
        ),
      );
      if (dependencies.awarenessRelay) {
        yield* dependencies.awarenessRelay.requestCatchUp();
      }
      if (payload.endpointRuntime === null || options?.confirmedOrigin === undefined) {
        return {
          ok: true,
          endpointRuntimeStatus: { status: "disabled" },
        } satisfies EnvironmentCloudRelayConfigResult;
      }
      const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(
        payload.endpointRuntime,
        { published: true },
      );
      if (endpointRuntimeStatus.status !== "running") {
        return yield* new EnvironmentCloudEndpointUnavailableError({
          message:
            endpointRuntimeStatus.status === "failed"
              ? endpointRuntimeStatus.reason
              : "Managed endpoint runtime could not be started.",
          endpointRuntimeStatus,
        });
      }
      const marker = yield* encodeConfirmedOriginJson({
        config: payload.endpointRuntime,
        origin: options.confirmedOrigin,
      });
      yield* dependencies.secrets.set(CLOUD_ENDPOINT_CONFIRMED_ORIGIN, stringToBytes(marker));
      return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
    }),
  );
  return yield* options?.lockHeld ? apply : dependencies.endpointRuntime.withLinkStateLock(apply);
});

/** No request/forwarded authority is trusted here: RPC auth fixes the host identity. */
export function validateManualCloudLinkEndpoint(input: ManualCloudLinkProofInput): boolean {
  try {
    const http = new URL(input.endpoint.httpBaseUrl),
      ws = new URL(input.endpoint.wsBaseUrl);
    return (
      input.endpoint.providerKind === "manual" &&
      ["http:", "https:"].includes(http.protocol) &&
      ws.protocol === (http.protocol === "https:" ? "wss:" : "ws:") &&
      http.host === ws.host &&
      !http.username &&
      !http.password &&
      !ws.username &&
      !ws.password &&
      !http.search &&
      !http.hash &&
      !ws.search &&
      !ws.hash &&
      isSecureRelayUrl(input.relayIssuer)
    );
  } catch {
    return false;
  }
}
export const createManualCloudLinkProof = Effect.fn("environment.cloud.createManualLinkProof")(
  function* (input: ManualCloudLinkProofInput) {
    const dependencies = yield* cloudHttpDependencies;
    const descriptor = yield* dependencies.environment.getDescriptor;
    if (input.environmentId !== descriptor.environmentId || !validateManualCloudLinkEndpoint(input))
      return yield* new ManualCloudLinkError({
        message: "The selected environment or manual endpoint does not match this link request.",
      });
    if ((yield* readCloudLinkState(dependencies)).linked)
      return { environmentId: descriptor.environmentId, proof: null };
    const config = yield* ServerConfig.ServerConfig;
    const server = yield* Effect.serviceOption(HttpServer.HttpServer);
    const address = Option.isSome(server) ? server.value.address : null;
    const port =
      address && typeof address !== "string" && "port" in address ? address.port : config.port;
    if (port < 1)
      return yield* new ManualCloudLinkError({
        message: "The environment listener is not ready for cloud registration.",
      });
    const proof = yield* signCloudLinkProof(dependencies, {
      challenge: input.challenge,
      relayIssuer: input.relayIssuer,
      endpoint: input.endpoint,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: port },
    });
    return { environmentId: descriptor.environmentId, proof };
  },
  Effect.mapError(
    () =>
      new ManualCloudLinkError({
        message: "Could not prepare this environment’s manual cloud link.",
      }),
  ),
);
export const applyManualCloudRelayConfig = Effect.fn("environment.cloud.applyManualRelayConfig")(
  function* (input: ManualCloudRelayConfigInput) {
    const dependencies = yield* cloudHttpDependencies;
    const descriptor = yield* dependencies.environment.getDescriptor;
    if (input.environmentId !== descriptor.environmentId || input.endpointRuntime !== null)
      return yield* new ManualCloudLinkError({
        message: "The cloud configuration does not match this manual environment link.",
      });
    return yield* applyCloudRelayConfig(dependencies, input);
  },
  Effect.mapError(
    () =>
      new ManualCloudLinkError({
        message: "Could not configure this environment’s manual cloud link.",
      }),
  ),
);

const cloudRelayConfigHandler = Effect.fn("environment.cloud.relayConfig")(
  function* (dependencies: CloudHttpDependencies, payload: RelayEnvironmentConfigRequest) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    const result = yield* applyCloudRelayConfig(dependencies, payload);
    if (payload.endpointRuntime?.providerKind === "cloudflare_tunnel") {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        return yield* new EnvironmentHttpInternalServerError({
          message: "Could not resolve the local server origin.",
        });
      }
      const registration = yield* registerManagedCloudTunnelRecovery(
        `http://127.0.0.1:${address.port}`,
      ).pipe(
        Effect.retry({
          times: 2,
          while: (error) =>
            shouldRetryCloudLink(error) &&
            error._tag !== "EnvironmentCloudEndpointUnavailableError",
        }),
      );
      if (registration.status === "superseded") {
        return yield* new EnvironmentHttpConflictError({
          message: "The managed tunnel configuration changed during registration.",
        });
      }
      if (registration.status === "recovery_required") {
        yield* dependencies.endpointRuntime.requestRecovery(registration.config);
      }
      if (registration.status !== "ready") {
        return yield* new EnvironmentCloudEndpointUnavailableError({
          message: "Managed endpoint origin could not be confirmed.",
          endpointRuntimeStatus: { status: "disabled" },
        });
      }
      return {
        ok: true,
        endpointRuntimeStatus: registration.endpointRuntimeStatus,
      } satisfies EnvironmentCloudRelayConfigResult;
    }
    return result;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist environment relay configuration."),
  ),
  Effect.catchTags({
    SchemaError: failEnvironmentCloudInternalError(
      "Could not persist environment relay configuration.",
    ),
    PlatformError: failEnvironmentCloudInternalError(
      "Could not register the managed endpoint origin.",
    ),
  }),
);

const relayClientRequest = <A>(
  dependencies: CloudHttpDependencies,
  input: {
    readonly url: string;
    readonly token: string;
    readonly payload: unknown;
    readonly schema: Schema.Decoder<A>;
    readonly timeout?: Duration.Input;
  },
) =>
  HttpClientRequest.post(input.url).pipe(
    HttpClientRequest.bearerToken(input.token),
    HttpClientRequest.bodyJson(input.payload),
    Effect.flatMap(dependencies.httpClient.execute),
    Effect.flatMap(filterRelayResponse),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(input.schema)),
    Effect.timeout(input.timeout ?? "10 seconds"),
    Effect.mapError(relayRequestError),
    withRelayClientTracing,
  );

const reconcileDesiredCloudLinkWith = Effect.fn("environment.cloud.reconcileDesiredLinkWith")(
  function* (dependencies: CloudHttpDependencies, localOrigin: string) {
    const conflict = deviceRelayConflict(dependencies.secrets);
    if (conflict) return yield* new EnvironmentHttpConflictError({ message: conflict });
    const parsedOrigin = yield* Effect.try({
      try: () => parseManagedEndpointLocalOrigin(localOrigin),
      catch: () =>
        new EnvironmentHttpBadRequestError({
          message: "Could not resolve local environment origin.",
        }),
    });
    const token = yield* dependencies.cliTokenManager.getExisting.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new EnvironmentHttpUnauthorizedError({
                message: "Run `lecturn connect link` to authorize this environment.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const mode = yield* readCliDesiredLinkMode;
    const managedTunnelsEnabled = mode !== "publish_only";
    const relayUrl = yield* requireRelayUrl;
    const challenge = yield* relayClientRequest(dependencies, {
      url: `${relayUrl}/v1/client/environment-link-challenges`,
      token: token.accessToken,
      payload: {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled,
      },
      schema: RelayEnvironmentLinkChallengeResponse,
    });
    const proof = yield* makeCloudLinkProof(
      dependencies,
      {
        challenge: challenge.challenge,
        relayIssuer: relayUrl,
        endpoint: {
          httpBaseUrl: parsedOrigin.httpBaseUrl,
          wsBaseUrl: parsedOrigin.wsBaseUrl,
          providerKind: managedTunnelsEnabled ? "cloudflare_tunnel" : "manual",
        },
        origin: parsedOrigin.origin,
      },
      parsedOrigin.httpBaseUrl,
    );
    const link = yield* relayClientRequest(dependencies, {
      url: `${relayUrl}/v1/client/environment-links`,
      token: token.accessToken,
      payload: {
        proof,
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled,
      },
      schema: RelayEnvironmentLinkResponse,
      timeout: MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT,
    });
    yield* setCliDesiredCloudLink(true, mode);
    yield* applyCloudRelayConfig(
      dependencies,
      {
        relayUrl,
        relayIssuer: link.relayIssuer,
        cloudUserId: link.cloudUserId,
        environmentCredential: link.environmentCredential,
        cloudMintPublicKey: link.cloudMintPublicKey,
        endpointRuntime: link.endpointRuntime,
      },
      {
        lockHeld: true,
        confirmedOrigin: parsedOrigin.origin,
      },
    );
    // Callers decide on managed tunnel recovery from the mode this link
    // actually used, not from a value read before the relay round trip.
    return mode;
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist desired Lecturn Connect link state."),
  ),
  Effect.catchTags({
    CloudCliCredentialRemovalError: failCloudCliTokenManagerError,
    CloudCliCredentialRefreshError: failCloudCliTokenManagerError,
    CloudCliCredentialReadError: failCloudCliTokenManagerError,
    CloudCliAuthorizationError: failCloudCliTokenManagerError,
    CloudCliAuthorizationTimeoutError: failCloudCliTokenManagerError,
  }),
);

export const reconcileDesiredCloudLink = Effect.fn("environment.cloud.reconcileDesiredLink")(
  function* (localOrigin: string) {
    const dependencies = yield* cloudHttpDependencies;
    return yield* dependencies.endpointRuntime.withLinkStateLock(
      reconcileDesiredCloudLinkWith(dependencies, localOrigin),
    );
  },
);

export const reconcileDesiredCloudLinkIfStillDesired = Effect.fn(
  "environment.cloud.reconcileDesiredLinkIfStillDesired",
)(function* (localOrigin: string) {
  const dependencies = yield* cloudHttpDependencies;
  return yield* dependencies.endpointRuntime.withLinkStateLock(
    Effect.gen(function* () {
      if (!(yield* readCliDesiredCloudLink)) {
        return null;
      }
      return yield* reconcileDesiredCloudLinkWith(dependencies, localOrigin);
    }),
  );
});

type ManagedTunnelRecoveryProofInput = {
  readonly environmentId: RelayManagedEndpointRecoveryProofPayload["environmentId"];
  readonly cloudUserId: string;
  readonly relayUrl: string;
} & (
  | {
      readonly action: "register";
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
    }
  | { readonly action: "recover"; readonly origin: RelayManagedEndpointOrigin }
);

const makeManagedTunnelRecoveryProof = Effect.fn(
  "environment.cloud.makeManagedTunnelRecoveryProof",
)(function* (dependencies: CloudHttpDependencies, input: ManagedTunnelRecoveryProofInput) {
  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
  const configuredIssuer = yield* dependencies.secrets.get(RELAY_ISSUER_SECRET);
  const now = yield* DateTime.now;
  const issuedAt = Math.floor(now.epochMilliseconds / 1_000);
  const claims = {
    iss: `lecturn-env:${input.environmentId}`,
    aud: normalizeRelayIssuer(
      Option.isSome(configuredIssuer) ? bytesToString(configuredIssuer.value) : input.relayUrl,
    ),
    sub: input.environmentId,
    jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    iat: issuedAt,
    exp: issuedAt + 60,
    environmentId: input.environmentId,
    cloudUserId: input.cloudUserId,
  };
  const payload =
    input.action === "register"
      ? {
          ...claims,
          action: "register" as const,
          tunnelId: input.tunnelId,
          origin: input.origin,
        }
      : { ...claims, action: "recover" as const, origin: input.origin };

  return yield* signRelayJwt({
    privateKey: keyPair.privateKey,
    typ: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
    payload,
  }).pipe(
    Effect.mapError(
      () =>
        new EnvironmentHttpInternalServerError({
          message: "Could not sign the managed tunnel recovery request.",
        }),
    ),
  );
});

export const registerManagedCloudTunnelRecovery = Effect.fn(
  "environment.cloud.registerManagedCloudTunnelRecovery",
)(function* (localOrigin: string, options?: { readonly retryRuntimeFailures?: boolean }) {
  const dependencies = yield* cloudHttpDependencies;
  // Another installation owns this device's relay publication.
  if (deviceRelayPublicationBlocked(dependencies.secrets)) {
    return { status: "not_linked" as const };
  }
  const [runtimeConfig, relayUrl, cloudUserId, environmentCredential] = yield* Effect.all([
    dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
    dependencies.secrets.get(RELAY_URL_SECRET),
    dependencies.secrets.get(CLOUD_LINKED_USER_ID),
    dependencies.secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
  ]);
  if (
    Option.isNone(runtimeConfig) ||
    Option.isNone(relayUrl) ||
    Option.isNone(cloudUserId) ||
    Option.isNone(environmentCredential)
  ) {
    return { status: "not_linked" as const };
  }

  const config = Option.getOrNull(decodeRuntimeConfig(bytesToString(runtimeConfig.value)));
  if (config?.providerKind !== "cloudflare_tunnel") {
    return { status: "not_linked" as const };
  }

  const parsedOrigin = yield* Effect.try({
    try: () => parseManagedEndpointLocalOrigin(localOrigin),
    catch: () =>
      new EnvironmentHttpBadRequestError({
        message: "Could not resolve local environment origin.",
      }),
  });
  if (config.tunnelId === undefined) {
    return { status: "recovery_required" as const, config };
  }
  const origin = parsedOrigin.origin;
  const environmentId = yield* dependencies.environment.getEnvironmentId;
  const relayUrlValue = bytesToString(relayUrl.value);
  const cloudUserIdValue = bytesToString(cloudUserId.value);
  const proof = yield* makeManagedTunnelRecoveryProof(dependencies, {
    action: "register",
    environmentId,
    cloudUserId: cloudUserIdValue,
    relayUrl: relayUrlValue,
    tunnelId: config.tunnelId,
    origin,
  });
  const registered = yield* relayClientRequest(dependencies, {
    url: `${relayUrlValue}/v1/environments/${encodeURIComponent(environmentId)}/tunnel/recovery`,
    token: bytesToString(environmentCredential.value),
    payload: {
      cloudUserId: cloudUserIdValue,
      tunnelId: config.tunnelId,
      origin,
      proof,
    },
    schema: RelayManagedEndpointRecoveryRegistrationResponse,
  });
  if (registered.status === "recovery_required") {
    return { status: registered.status, config };
  }
  const endpointRuntimeStatus = yield* activateManagedTunnelWithRetry(
    dependencies,
    {
      config,
      configJson: bytesToString(runtimeConfig.value),
      origin,
    },
    options?.retryRuntimeFailures === true,
  );
  return endpointRuntimeStatus === null
    ? { status: "superseded" as const }
    : { status: "ready" as const, endpointRuntimeStatus };
});

export const recoverManagedCloudTunnel = Effect.fn("environment.cloud.recoverManagedCloudTunnel")(
  function* (
    localOrigin: string,
    expectedConfig?: RelayManagedEndpointRuntimeConfig,
    options?: { readonly retryRuntimeFailures?: boolean },
  ) {
    const dependencies = yield* cloudHttpDependencies;
    // Another installation owns this device's relay publication.
    if (deviceRelayPublicationBlocked(dependencies.secrets)) return false;
    const [runtimeConfig, relayUrl, cloudUserId, environmentCredential] = yield* Effect.all([
      dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      dependencies.secrets.get(RELAY_URL_SECRET),
      dependencies.secrets.get(CLOUD_LINKED_USER_ID),
      dependencies.secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (
      Option.isNone(runtimeConfig) ||
      Option.isNone(relayUrl) ||
      Option.isNone(cloudUserId) ||
      Option.isNone(environmentCredential)
    ) {
      return false;
    }
    if (expectedConfig !== undefined) {
      const current = Option.getOrNull(decodeRuntimeConfig(bytesToString(runtimeConfig.value)));
      if (
        current === null ||
        current.providerKind !== expectedConfig.providerKind ||
        current.connectorToken !== expectedConfig.connectorToken ||
        current.tunnelId !== expectedConfig.tunnelId ||
        current.tunnelName !== expectedConfig.tunnelName
      ) {
        return false;
      }
    }

    const parsedOrigin = yield* Effect.try({
      try: () => parseManagedEndpointLocalOrigin(localOrigin),
      catch: () =>
        new EnvironmentHttpBadRequestError({
          message: "Could not resolve local environment origin.",
        }),
    });

    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const relayUrlValue = bytesToString(relayUrl.value);
    const cloudUserIdValue = bytesToString(cloudUserId.value);
    const origin = parsedOrigin.origin;
    const proof = yield* makeManagedTunnelRecoveryProof(dependencies, {
      action: "recover",
      environmentId,
      cloudUserId: cloudUserIdValue,
      relayUrl: relayUrlValue,
      origin,
    });
    const recovered = yield* relayClientRequest(dependencies, {
      url: `${relayUrlValue}/v1/environments/${encodeURIComponent(environmentId)}/tunnel`,
      token: bytesToString(environmentCredential.value),
      payload: {
        cloudUserId: cloudUserIdValue,
        origin,
        proof,
      },
      schema: RelayManagedEndpointRecoveryResponse,
      timeout: MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT,
    });
    if (recovered.endpointRuntime.providerKind !== "cloudflare_tunnel") {
      return yield* new EnvironmentHttpInternalServerError({
        message: "Lecturn Connect returned an unsupported managed tunnel configuration.",
      });
    }

    const encoded = yield* encodeEndpointRuntimeConfigJson(recovered.endpointRuntime).pipe(
      Effect.mapError(
        () =>
          new EnvironmentHttpInternalServerError({
            message: "Could not persist the recovered managed tunnel configuration.",
          }),
      ),
    );
    const stored = yield* dependencies.endpointRuntime.withLinkStateLock(
      Effect.gen(function* () {
        const currentConfig = yield* dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
        if (
          Option.isNone(currentConfig) ||
          bytesToString(currentConfig.value) !== bytesToString(runtimeConfig.value)
        ) {
          return false;
        }
        yield* dependencies.secrets.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, stringToBytes(encoded));
        yield* dependencies.secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN);
        return true;
      }),
    );
    if (!stored) return false;
    const status = yield* activateManagedTunnelWithRetry(
      dependencies,
      {
        config: recovered.endpointRuntime,
        configJson: encoded,
        origin,
      },
      options?.retryRuntimeFailures === true,
    );
    return status !== null;
  },
);

// The launcher owns this durable state, so read it directly both when a trial
// decides whether it owns pre-activation cleanup and while a server tears down.
export const pendingServiceUpdateExists = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(config.baseDir, "runtime");
  const stateText = yield* fs
    .readFileString(path.join(runtimeDir, SERVICE_STATE_FILE))
    .pipe(Effect.option);
  return Option.isSome(stateText) && serviceStateHasPendingUpdate(stateText.value);
});

// A pending update alone is not proof a replacement server is coming: an
// explicit launcher stop (`lecturn service uninstall`, `systemctl stop`,
// `launchctl bootout`) during
// the pending window also tears this server down. The launcher marks that case
// just before it signals the child, so pending + no marker is the handoff.
const pendingUpdateHandoffExists = Effect.gen(function* () {
  if (!(yield* pendingServiceUpdateExists)) {
    return false;
  }
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(config.baseDir, "runtime");
  const stopping = yield* fs
    .exists(path.join(runtimeDir, SERVICE_STOP_MARKER_FILE))
    .pipe(Effect.orElseSucceed(() => false));
  return !stopping;
});

// The desktop app writes its marker right before it stops this server to
// install an update, whether a remote client or the local app started it.
// Reading consumes it, so shutdown checks it first. Only a fresh marker counts,
// so a marker the server never read (a hard kill) cannot keep the tunnel on a
// later quit.
const desktopUpdateRestartPending = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.join(config.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE);
  const marker = yield* fs.stat(markerPath).pipe(Effect.option);
  if (Option.isNone(marker)) {
    return false;
  }
  yield* fs.remove(markerPath).pipe(Effect.ignore);
  const now = yield* Clock.currentTimeMillis;
  return Option.match(marker.value.mtime, {
    onNone: () => false,
    onSome: (writtenAt) =>
      now - writtenAt.getTime() < Duration.toMillis(DESKTOP_UPDATE_RESTART_MARKER_TTL),
  });
});

// Cloudflare bills per provisioned tunnel, so an environment that goes offline
// must not leave its tunnel behind. Releasing deletes only the tunnel — the
// relay keeps the link and its hostname reservation, and the next startup's
// link reconcile provisions a replacement tunnel under the same URL.
export const releaseManagedTunnelOnShutdown = Effect.fn(
  "environment.cloud.releaseManagedTunnelOnShutdown",
)(function* () {
  const dependencies = yield* cloudHttpDependencies;
  if (deviceRelayPublicationBlocked(dependencies.secrets)) return false;
  // Only a managed link stores a runtime config; publish-only links have no
  // tunnel to release.
  const runtimeConfig = yield* dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (Option.isNone(runtimeConfig)) {
    return false;
  }
  // Only CLI-desired managed links release eagerly because this request uses
  // CLI authorization. Web/mobile links register startup recovery with their
  // environment credential, and the relay reaper removes them after they are
  // down for the configured grace period. Unlink still deletes either kind.
  if (!(yield* readCliDesiredCloudLink) || (yield* readCliDesiredLinkMode) !== "managed") {
    return false;
  }
  // A shutdown that hands off to a pending update is not the environment
  // going offline: the service launcher or the desktop app immediately brings
  // a server back (the new version, or the old one after a rollback). Deleting
  // the tunnel here forces that server to provision a replacement UUID, and the
  // public hostname's route to the new tunnel takes 1-2 minutes to propagate —
  // the dominant cost of an update restart. Keep the tunnel instead: the next
  // boot respawns the connector from the stored config and is reachable as
  // soon as it connects, and the reconcile confirms the still-live tunnel
  // without replacing it.
  if ((yield* desktopUpdateRestartPending) || (yield* pendingUpdateHandoffExists)) {
    yield* Effect.logInfo("Keeping the managed tunnel across the update restart");
    return false;
  }
  const token = yield* dependencies.cliTokenManager.getExisting;
  if (Option.isNone(token)) {
    return false;
  }
  // The link belongs to the relay it was installed against, so target the
  // persisted URL: LECTURN_RELAY_URL may have changed since the link was made.
  const relayUrl = yield* dependencies.secrets.get(RELAY_URL_SECRET);
  if (Option.isNone(relayUrl)) {
    return false;
  }
  const environmentId = yield* dependencies.environment.getEnvironmentId;
  // Keep the device reservation through remote deletion; release at scope shutdown.
  yield* dependencies.endpointRuntime.applyConfig(null, { published: true });
  const response = yield* HttpClientRequest.delete(
    `${bytesToString(relayUrl.value)}/v1/client/environment-links/${encodeURIComponent(environmentId)}/tunnel`,
  ).pipe(
    HttpClientRequest.bearerToken(token.value.accessToken),
    dependencies.httpClient.execute,
    Effect.flatMap(filterRelayResponse),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
    withRelayClientTracing,
  );
  // ok:false means the relay skipped deletion because a concurrent provision
  // owns the recorded tunnel now — leave the stored config alone.
  if (!response.ok) {
    return false;
  }
  // The connector token died with the tunnel. Drop the stored config so the
  // next start waits for the link reconcile instead of respawning the relay
  // client with a dead token. Kept when the release request fails: the tunnel
  // still exists, so the stored token keeps working across the restart.
  // Only dropped while it is still the config this shutdown released — a fast
  // restart may already have reconciled and stored a fresh config for its
  // replacement tunnel, and that one must survive this finalizer.
  const storedConfig = yield* dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (
    Option.isSome(storedConfig) &&
    bytesToString(storedConfig.value) === bytesToString(runtimeConfig.value)
  ) {
    yield* dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
    yield* dependencies.secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN);
  }
  return true;
});

// A managed tunnel forwards to the loopback origin the relay recorded at link
// time, but the local port can change between launches (the desktop app scans
// for a free one). Call this once the server is listening so the tunnel follows
// the port. Authenticated by the stored environment credential, so it also
// covers links installed from a web/mobile client, which have no CLI token.
// Resolves to whether the relay repointed a tunnel.
export const syncManagedEndpointOrigin = Effect.fn("environment.cloud.syncManagedEndpointOrigin")(
  function* (localOrigin: string) {
    const dependencies = yield* cloudHttpDependencies;
    if (deviceRelayPublicationBlocked(dependencies.secrets)) return false;
    // The link belongs to the relay it was installed against, so target the
    // persisted URL rather than the currently configured one.
    const [runtimeConfig, relayUrl, environmentCredential] = yield* Effect.all([
      dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      dependencies.secrets.get(RELAY_URL_SECRET),
      dependencies.secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (
      Option.isNone(runtimeConfig) ||
      Option.isNone(relayUrl) ||
      Option.isNone(environmentCredential)
    ) {
      return false;
    }
    const localUrl = new URL(localOrigin);
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const response = yield* HttpClientRequest.put(
      `${bytesToString(relayUrl.value)}/v1/environments/${encodeURIComponent(environmentId)}/managed-endpoint-origin`,
    ).pipe(
      HttpClientRequest.bearerToken(bytesToString(environmentCredential.value)),
      HttpClientRequest.bodyJson({
        origin: {
          localHttpHost: localUrl.hostname,
          localHttpPort: endpointRequestPort(localUrl),
        },
      } satisfies RelayManagedEndpointOriginSyncRequest),
      Effect.flatMap(dependencies.httpClient.execute),
      withRelayClientTracing,
    );
    // A relay that predates this endpoint answers 404. Retrying cannot help,
    // and the link keeps working as long as the port did not move.
    if (response.status === 404) {
      yield* Effect.logDebug("Lecturn Connect relay does not support managed endpoint origin sync");
      return false;
    }
    const result = yield* filterRelayResponse(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayManagedEndpointOriginSyncResponse)),
    );
    return result.updatedTunnels > 0;
  },
  Effect.mapError(relayRequestError),
);

const readCloudLinkState = Effect.fn("environment.cloud.readLinkState")(function* (
  dependencies: CloudHttpDependencies,
) {
  const [
    cloudUserId,
    relayUrl,
    relayIssuer,
    endpointRuntimeConfig,
    publishAgentActivity,
    organizationId,
  ] = yield* Effect.all(
    [
      dependencies.secrets.get(CLOUD_LINKED_USER_ID),
      dependencies.secrets.get(RELAY_URL_SECRET),
      dependencies.secrets.get(RELAY_ISSUER_SECRET),
      dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      dependencies.secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
      dependencies.secrets.get(CLOUD_LINKED_ORGANIZATION_ID),
    ],
    { concurrency: 5 },
  );
  return {
    linked: Option.isSome(cloudUserId),
    deviceRelayConflict: deviceRelayConflict(dependencies.secrets),
    organizationId: Option.isSome(organizationId) ? bytesToString(organizationId.value) : null,
    cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
    relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
    relayIssuer: Option.isSome(relayIssuer) ? bytesToString(relayIssuer.value) : null,
    // The managed tunnel runtime config is only stored for managed links; a
    // publish-only link leaves it absent.
    managedTunnelActive: Option.isSome(endpointRuntimeConfig),
    publishAgentActivity: Option.isSome(publishAgentActivity)
      ? bytesToString(publishAgentActivity.value) === "true"
      : false,
  } satisfies EnvironmentCloudLinkStateResult;
});

const cloudLinkStateHandler = Effect.fn("environment.cloud.linkState")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayReadScope);
    return yield* readCloudLinkState(dependencies);
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not read environment relay configuration."),
  ),
);

export const unlinkCloudRelayConfig = Effect.fn("environment.cloud.unlinkConfig")(function* (
  dependencies: Pick<CloudHttpDependencies, "secrets" | "endpointRuntime">,
) {
  // Lock order matches applyCloudRelayConfig: link-state lock, then mutation lock.
  return yield* dependencies.endpointRuntime.withLinkStateLock(
    withCloudLinkMutation(
      dependencies.secrets,
      Effect.gen(function* () {
        const conflict = deviceRelayConflict(dependencies.secrets);
        if (conflict) return yield* new EnvironmentHttpConflictError({ message: conflict });
        const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(null);
        yield* Effect.all(
          [
            dependencies.secrets.remove(CLOUD_LINKED_USER_ID),
            dependencies.secrets.remove(CLOUD_LINKED_ORGANIZATION_ID),
            dependencies.secrets.remove(RELAY_URL_SECRET),
            dependencies.secrets.remove(RELAY_ISSUER_SECRET),
            dependencies.secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
            dependencies.secrets.remove(CLOUD_MINT_PUBLIC_KEY),
            dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
            dependencies.secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN),
            dependencies.secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
          ],
          { concurrency: 9 },
        );
        yield* setCliDesiredCloudLink(false);
        return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
      }),
    ),
  );
});

const cloudUnlinkHandler = Effect.fn("environment.cloud.unlink")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    return yield* unlinkCloudRelayConfig(dependencies);
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not remove environment relay configuration."),
  ),
);

const cloudPreferencesHandler = Effect.fn("environment.cloud.preferences")(
  function* (
    dependencies: CloudHttpDependencies,
    payload: { readonly publishAgentActivity: boolean },
  ) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    const conflict = deviceRelayConflict(dependencies.secrets);
    if (conflict) return yield* new EnvironmentHttpConflictError({ message: conflict });
    yield* dependencies.secrets.set(
      PUBLISH_AGENT_ACTIVITY_SECRET,
      stringToBytes(String(payload.publishAgentActivity)),
    );
    yield* dependencies.awarenessRelay.requestCatchUp();
    return yield* readCloudLinkState(dependencies);
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist environment cloud preferences."),
  ),
);

const cloudEnvironmentHealthHandler = Effect.fn("environment.cloud.health")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudEnvironmentHealthRequest) {
    const cloudMintPublicKey = yield* dependencies.secrets
      .get(CLOUD_MINT_PUBLIC_KEY)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
        ),
      );
    const relayIssuer = yield* dependencies.secrets
      .get(RELAY_ISSUER_SECRET)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : dependencies.secrets
                .get(RELAY_URL_SECRET)
                .pipe(
                  Effect.flatMap((fallbackBytes) =>
                    Option.isSome(fallbackBytes)
                      ? Effect.succeed(bytesToString(fallbackBytes.value))
                      : Effect.fail(new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({})),
                  ),
                ),
        ),
      );
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_HEALTH_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `lecturn-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudHealthProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:status" })
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid cloud health request.",
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_HEALTH_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_HEALTH_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [jtiSecretName, nonceSecretName],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        message: "Cloud health request was already consumed.",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const descriptor = yield* dependencies.environment.getDescriptor;
    const responseExpiresAt = DateTime.add(now, { minutes: 5 });
    const responsePayload = {
      iss: `lecturn-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(responseExpiresAt.epochMilliseconds / 1_000),
      environmentId,
      requestNonce: proof.nonce,
      status: "online",
      descriptor,
      checkedAt: DateTime.formatIso(now),
    } satisfies RelayEnvironmentHealthResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_HEALTH_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudHealthJwtSigningError({
            cause,
          }),
      ),
    );
    const response = {
      environmentId,
      status: "online",
      descriptor,
      checkedAt: responsePayload.checkedAt,
      proof: responseProof,
    } satisfies RelayEnvironmentHealthResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not answer cloud health request."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not answer cloud health request."),
  ),
);

const cloudMintCredentialHandler = Effect.fn("environment.cloud.mintCredential")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudMintCredentialRequest) {
    const cloudMintPublicKey = yield* dependencies.secrets
      .get(CLOUD_MINT_PUBLIC_KEY)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
        ),
      );
    const relayIssuer = yield* dependencies.secrets
      .get(RELAY_ISSUER_SECRET)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : dependencies.secrets
                .get(RELAY_URL_SECRET)
                .pipe(
                  Effect.flatMap((fallbackBytes) =>
                    Option.isSome(fallbackBytes)
                      ? Effect.succeed(bytesToString(fallbackBytes.value))
                      : Effect.fail(new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({})),
                  ),
                ),
        ),
      );
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_MINT_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `lecturn-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudMintProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      proofOption.value.cnf.jkt !== proofOption.value.clientProofKeyThumbprint ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:connect" })
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid cloud mint request.",
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_MINT_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_MINT_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [jtiSecretName, nonceSecretName],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        message: "Cloud mint request was already consumed.",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const issued = yield* dependencies.environmentAuth.createPairingLink({
      scopes: AuthStandardClientScopes,
      subject: "cloud-connect",
      ttl: Duration.minutes(2),
      label: "Lecturn Connect connect",
      proofKeyThumbprint: proof.clientProofKeyThumbprint,
    });
    const responsePayload = {
      iss: `lecturn-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(issued.expiresAt.epochMilliseconds / 1_000),
      environmentId,
      clientProofKeyThumbprint: proof.clientProofKeyThumbprint,
      requestNonce: proof.nonce,
      credential: issued.credential,
    } satisfies RelayEnvironmentMintResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_MINT_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudMintJwtSigningError({
            cause,
          }),
      ),
    );
    const response = {
      credential: issued.credential,
      expiresAt: DateTime.formatIso(issued.expiresAt),
      proof: responseProof,
    } satisfies RelayEnvironmentMintResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not issue cloud connection credential."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not issue cloud connection credential."),
  ),
);

export const connectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const dependencies = yield* cloudHttpDependencies;
    return handlers
      .handle("linkProof", ({ payload }) => cloudLinkProofHandler(dependencies, payload))
      .handle("relayConfig", ({ payload }) => cloudRelayConfigHandler(dependencies, payload))
      .handle("linkState", () => cloudLinkStateHandler(dependencies))
      .handle("unlink", () => cloudUnlinkHandler(dependencies))
      .handle("preferences", ({ payload }) => cloudPreferencesHandler(dependencies, payload))
      .handle("health", ({ payload }) => cloudEnvironmentHealthHandler(dependencies, payload))
      .handle("mintCredential", ({ payload }) => cloudMintCredentialHandler(dependencies, payload))
      .handle("lecturnMintCredential", ({ payload }) =>
        traceRelayRequest(cloudMintCredentialHandler(dependencies, payload)),
      );
  }),
);
