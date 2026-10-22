// Lecturn-only CloudLink behavior: managed endpoint origin sync, the device
// relay reservation, and manual linking over an authenticated client socket.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer, type HttpClientRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ManualCloudLinkProofInput,
} from "@lecturn/contracts";
import { RelayManagedEndpointOriginSyncRequest } from "@lecturn/contracts/relay";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfigModule from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import { shouldRetryCloudLink, validateManualCloudLinkEndpoint } from "./CloudLink.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import {
  setDeviceRelayConflict,
  setDeviceRelayPublicationActive,
} from "./DeviceRelayReservation.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const unused = () => Effect.die("unused operation");

const cliToken: CliTokenManager.PersistedToken = {
  accessToken: "cli-access-token",
  refreshToken: "cli-refresh-token",
  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
};

function makeMemorySecretStore(initial: Iterable<readonly [string, string]> = []) {
  const values = new Map<string, Uint8Array>(
    Array.from(initial, ([name, value]) => [name, new TextEncoder().encode(value)] as const),
  );
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    getOrCreateRandom: unused,
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  };
  return { store, values };
}

interface Harness {
  readonly store: ServerSecretStore.ServerSecretStore["Service"];
  readonly applyConfigCalls: Array<unknown>;
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
  readonly respond?: () => Response;
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

const provideHarness =
  (harness: Harness) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(CloudLink.layer),
      Effect.provideService(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3774),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Effect.provideService(ServerSecretStore.ServerSecretStore, harness.store),
      Effect.provideService(
        AgentAwarenessRelay.AgentAwarenessRelay,
        AgentAwarenessRelay.AgentAwarenessRelay.of({
          publishThread: () => Effect.void,
          drain: Effect.void,
          requestCatchUp: () => Effect.void,
          start: () => Effect.void,
        }),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env_123")),
          getDescriptor: harness.descriptor
            ? Effect.succeed(harness.descriptor)
            : Effect.die("unused"),
        }),
      ),
      Effect.provideService(
        ManagedEndpointRuntime.CloudManagedEndpointRuntime,
        ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
          applyConfig: (config) =>
            Effect.sync(() => {
              harness.applyConfigCalls.push(config);
              return { status: "disabled" } as const;
            }),
          recoveryRequests: Stream.empty,
          requestRecovery: () => Effect.void,
          tunnelConnected: Stream.empty,
          withLinkStateLock: (effect) => effect,
        }),
      ),
      Effect.provideService(
        EnvironmentAuth.EnvironmentAuth,
        EnvironmentAuth.EnvironmentAuth.of({} as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Effect.provideService(
        CliTokenManager.CloudCliTokenManager,
        CliTokenManager.CloudCliTokenManager.of({
          get: unused(),
          getExisting: Effect.succeedSome(cliToken),
          hasCredential: unused(),
          store: () => unused(),
          clear: unused(),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            harness.requests.push(request);
            return HttpClientResponse.fromWeb(
              request,
              (harness.respond ?? (() => Response.json({ ok: true })))(),
            );
          }),
        ),
      ),
      Effect.provide(
        ServerConfigModule.layerTest("/", { prefix: "lecturn-cloud-link-fork-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    );

const decodeOriginSyncRequestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayManagedEndpointOriginSyncRequest),
);

describe("syncManagedEndpointOrigin", () => {
  // A managed link installed from a web/mobile client: no CLI-desired flag.
  const clientInstalledLinkSecrets = [
    [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
    [RELAY_URL_SECRET, "https://relay.example.test"],
    [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
  ] as const;
  const sync = (localOrigin: string) =>
    CloudLink.CloudLink.use((link) => link.syncManagedEndpointOrigin(localOrigin));

  it.effect("repoints the tunnel at the current port using the environment credential", () => {
    const { store } = makeMemorySecretStore(clientInstalledLinkSecrets);
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      expect(yield* sync("http://127.0.0.1:3774")).toBe(true);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.method).toBe("PUT");
      expect(request.url).toBe(
        "https://relay.example.test/v1/environments/env_123/managed-endpoint-origin",
      );
      expect(request.headers.authorization).toBe("Bearer environment-credential");
      expect(request.body._tag).toBe("Uint8Array");
      if (request.body._tag !== "Uint8Array") return;
      const payload = yield* decodeOriginSyncRequestJson(
        new TextDecoder().decode(request.body.body),
      );
      expect(payload).toEqual({ origin: { localHttpHost: "127.0.0.1", localHttpPort: 3774 } });
    }).pipe(
      provideHarness({
        store,
        applyConfigCalls: [],
        requests,
        respond: () => Response.json({ ok: true, updatedTunnels: 1 }),
      }),
    );
  });

  it.effect("reports no update when the relay has no tunnel to repoint", () => {
    const { store } = makeMemorySecretStore(clientInstalledLinkSecrets);
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      expect(yield* sync("http://127.0.0.1:3774")).toBe(false);
      expect(requests).toHaveLength(1);
    }).pipe(
      provideHarness({
        store,
        applyConfigCalls: [],
        requests,
        respond: () => Response.json({ ok: true, updatedTunnels: 0 }),
      }),
    );
  });

  it.effect("makes no request without a stored managed link and credential", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const incompleteLinks = [
      clientInstalledLinkSecrets.filter(([name]) => name !== CLOUD_ENDPOINT_RUNTIME_CONFIG),
      clientInstalledLinkSecrets.filter(([name]) => name !== RELAY_URL_SECRET),
      clientInstalledLinkSecrets.filter(([name]) => name !== RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ];

    return Effect.forEach(incompleteLinks, (secrets) =>
      sync("http://127.0.0.1:3774").pipe(
        provideHarness({
          store: makeMemorySecretStore(secrets).store,
          applyConfigCalls: [],
          requests,
        }),
      ),
    ).pipe(
      Effect.map((results) => {
        expect(results).toEqual([false, false, false]);
        expect(requests).toEqual([]);
      }),
    );
  });

  it.effect("resolves without error against an older relay that lacks the endpoint", () => {
    const { store } = makeMemorySecretStore(clientInstalledLinkSecrets);
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      expect(yield* sync("http://127.0.0.1:3774")).toBe(false);
      expect(requests).toHaveLength(1);
    }).pipe(
      provideHarness({
        store,
        applyConfigCalls: [],
        requests,
        respond: () => new Response("Not Found", { status: 404 }),
      }),
    );
  });

  it.effect("fails with a non-retryable error when the relay rejects the credential", () => {
    const { store } = makeMemorySecretStore(clientInstalledLinkSecrets);

    return Effect.gen(function* () {
      const error = yield* Effect.flip(sync("http://127.0.0.1:3774"));
      expect(shouldRetryCloudLink(error)).toBe(false);
    }).pipe(
      provideHarness({
        store,
        applyConfigCalls: [],
        requests: [],
        respond: () => new Response("Unauthorized", { status: 401 }),
      }),
    );
  });
});

it.effect("a losing installation cannot repoint or delete the winning relay", () => {
  const { store } = makeMemorySecretStore([
    [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
    [RELAY_URL_SECRET, "https://relay.example.test"],
    [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
    [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "credential"],
    [CLOUD_LINKED_USER_ID, "owner"],
  ]);
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const applyConfigCalls: Array<unknown> = [];
  setDeviceRelayPublicationActive(store, false);
  setDeviceRelayConflict(store, "Other installation owns this device");
  const origin = "http://127.0.0.1:3774";
  return Effect.gen(function* () {
    const link = yield* CloudLink.CloudLink;
    expect(yield* link.syncManagedEndpointOrigin(origin)).toBe(false);
    expect(yield* link.releaseManagedTunnelOnShutdown()).toBe(false);
    expect(yield* link.registerManagedTunnelRecovery(origin)).toEqual({ status: "not_linked" });
    expect(yield* link.startManagedTunnelIfOriginConfirmed(origin)).toBe(false);
    expect(yield* link.recoverManagedTunnel(origin)).toBe(false);
    const reconcile = yield* Effect.flip(link.reconcileDesiredLink(origin));
    expect(reconcile._tag).toBe("CloudLinkDeviceRelayConflictError");
    const unlink = yield* Effect.flip(link.unlink());
    expect(unlink._tag).toBe("CloudLinkDeviceRelayConflictError");
    const preferences = yield* Effect.flip(link.updatePreferences({ publishAgentActivity: true }));
    expect(preferences._tag).toBe("CloudLinkDeviceRelayConflictError");
    expect((yield* link.linkState()).deviceRelayConflict).toBe(
      "Other installation owns this device",
    );
    expect(requests).toHaveLength(0);
    expect(applyConfigCalls).toHaveLength(0);
  }).pipe(provideHarness({ store, requests, applyConfigCalls }));
});

it("surfaces the connector's own reason when the managed endpoint runtime failed", () => {
  const error = new CloudLink.CloudLinkEndpointUnavailableError({
    reason: "runtime-not-started",
    endpointRuntimeStatus: {
      status: "failed",
      providerKind: "cloudflare_tunnel",
      reason: "cloudflared is not installed.",
    },
  });
  expect(error.message).toBe("cloudflared is not installed.");
});

const manualInput: ManualCloudLinkProofInput = {
  environmentId: EnvironmentId.make("env_123"),
  challenge: "challenge",
  relayIssuer: "https://relay.example.test",
  endpoint: {
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test/ws",
    providerKind: "manual",
  },
};
const manualDescriptor: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("env_123"),
  label: "Remote host",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: false },
};
const decodeSignedManualProof = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      environmentId: Schema.String,
      origin: Schema.Struct({ localHttpHost: Schema.String, localHttpPort: Schema.Number }),
      endpoint: Schema.Struct({ providerKind: Schema.String, httpBaseUrl: Schema.String }),
    }),
  ),
);

describe("authenticated manual socket cloud linking", () => {
  it("rejects cross-origin endpoints, embedded credentials, tickets, invalid relays and managed tunnels", () => {
    expect(validateManualCloudLinkEndpoint(manualInput)).toBe(true);
    for (const endpoint of [
      { ...manualInput.endpoint, wsBaseUrl: "wss://other.test/ws" },
      { ...manualInput.endpoint, httpBaseUrl: "https://user:secret@remote.example.test" },
      { ...manualInput.endpoint, wsBaseUrl: "wss://remote.example.test/ws?ticket=secret" },
      { ...manualInput.endpoint, httpBaseUrl: "file:///tmp/host" },
    ])
      expect(validateManualCloudLinkEndpoint({ ...manualInput, endpoint })).toBe(false);
    expect(
      validateManualCloudLinkEndpoint({
        ...manualInput,
        relayIssuer: "http://public.example.test",
      }),
    ).toBe(false);
  });

  it.effect("signs only this server's own loopback listener", () => {
    const { store } = makeMemorySecretStore();
    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const result = yield* link.createManualLinkProof(manualInput);
      expect(result.environmentId).toBe("env_123");
      expect(result.proof).not.toBeNull();
      const payload = decodeSignedManualProof(
        Buffer.from(result.proof!.split(".")[1]!, "base64url").toString("utf8"),
      );
      expect(payload.environmentId).toBe("env_123");
      expect(payload.origin).toEqual({ localHttpHost: "127.0.0.1", localHttpPort: 3774 });
      expect(payload.endpoint).toMatchObject({
        providerKind: "manual",
        httpBaseUrl: manualInput.endpoint.httpBaseUrl,
      });
      const mismatch = yield* Effect.flip(
        link.createManualLinkProof({
          ...manualInput,
          environmentId: EnvironmentId.make("other"),
        }),
      );
      expect(mismatch._tag).toBe("ManualCloudLinkError");
    }).pipe(
      provideHarness({ store, applyConfigCalls: [], requests: [], descriptor: manualDescriptor }),
    );
  });

  it.effect("does not replace an already linked host or apply credentials to another host", () => {
    const { store, values } = makeMemorySecretStore([[CLOUD_LINKED_USER_ID, "owner"]]);
    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const before = new Map(values);
      const result = yield* link.createManualLinkProof(manualInput);
      expect(result.proof).toBeNull();
      const error = yield* Effect.flip(
        link.applyManualRelayConfig({
          environmentId: EnvironmentId.make("other"),
          relayUrl: "https://relay.example.test",
          cloudUserId: "owner",
          environmentCredential: "sentinel-secret",
          cloudMintPublicKey: "bad",
          endpointRuntime: null,
        }),
      );
      expect(error._tag).toBe("ManualCloudLinkError");
      expect(values).toEqual(before);
      expect(error.message).not.toContain("sentinel-secret");
    }).pipe(
      provideHarness({ store, applyConfigCalls: [], requests: [], descriptor: manualDescriptor }),
    );
  });
});
