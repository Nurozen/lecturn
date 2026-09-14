import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { TeamPolicy, TeamPolicyLive, assertProviderPolicy } from "./TeamPolicy.ts";
import {
  CLOUD_LINKED_ORGANIZATION_ID,
  RELAY_URL_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
} from "./config.ts";

const policy = {
  organizationId: "org",
  hasAccess: true,
  allowedProviders: ["codex"],
  publishAgentActivity: true,
};
describe("managed team provider policy", () => {
  it("allows only permitted providers for the configured organization", async () => {
    await expect(
      Effect.runPromise(assertProviderPolicy("org", "codex", policy)),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(assertProviderPolicy("org", "claudeAgent", policy)),
    ).rejects.toThrow("disabled by your organization");
    await expect(Effect.runPromise(assertProviderPolicy("other", "codex", policy))).rejects.toThrow(
      "no longer active",
    );
  });
  it("blocks revoked seats and missing company policies", async () => {
    await expect(
      Effect.runPromise(assertProviderPolicy("org", "codex", { ...policy, hasAccess: false })),
    ).rejects.toThrow("no longer active");
    await expect(Effect.runPromise(assertProviderPolicy("org", "codex", null))).rejects.toThrow(
      "no longer active",
    );
  });
  it("distinguishes no allowed providers from unrestricted providers", async () => {
    await expect(
      Effect.runPromise(assertProviderPolicy("org", "codex", { ...policy, allowedProviders: [] })),
    ).rejects.toThrow("disabled");
    await expect(
      Effect.runPromise(
        assertProviderPolicy("org", "codex", { ...policy, allowedProviders: null }),
      ),
    ).resolves.toBeUndefined();
  });
  it("does not contact the relay for a personal environment", async () => {
    const get = vi.fn(() => Effect.succeed(Option.none<Uint8Array>()));
    const store = Layer.succeed(ServerSecretStore, {
      get,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TeamPolicy;
        yield* service.checkProvider("codex");
      }).pipe(
        Effect.provide(
          TeamPolicyLive.pipe(Layer.provide(store), Layer.provide(FetchHttpClient.layer)),
        ),
      ),
    );
    expect(get.mock.calls).toEqual([[CLOUD_LINKED_ORGANIZATION_ID]]);
  });
  it("fails closed when company credentials are missing", async () => {
    const entries = new Map([
      [CLOUD_LINKED_ORGANIZATION_ID, "org"],
      [RELAY_URL_SECRET, "https://relay.example.com"],
    ]);
    const store = Layer.succeed(ServerSecretStore, {
      get: (key) =>
        Effect.succeed(
          Option.fromNullishOr(entries.get(key)).pipe(
            Option.map((value) => new TextEncoder().encode(value)),
          ),
        ),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    });
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* TeamPolicy;
          yield* service.checkProvider("codex");
        }).pipe(
          Effect.provide(
            TeamPolicyLive.pipe(Layer.provide(store), Layer.provide(FetchHttpClient.layer)),
          ),
        ),
      ),
    ).rejects.toThrow("Could not verify");
    expect(entries.has(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBe(false);
  });
  it("rechecks live policy and fails closed when the relay becomes unavailable", async () => {
    const entries = new Map([
      [CLOUD_LINKED_ORGANIZATION_ID, "org"],
      [RELAY_URL_SECRET, "https://relay.example.com"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-test-token"],
    ]);
    const store = Layer.succeed(ServerSecretStore, {
      get: (key) =>
        Effect.succeed(
          Option.fromNullishOr(entries.get(key)).pipe(
            Option.map((value) => new TextEncoder().encode(value)),
          ),
        ),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    });
    let status = 200;
    let activityAllowed = true;
    const requests: string[] = [];
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ ...policy, publishAgentActivity: activityAllowed }, { status }),
          );
        }),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TeamPolicy;
        yield* service.checkProvider("codex");
        expect(yield* service.canPublishActivity).toBe(true);
        activityAllowed = false;
        expect(yield* service.canPublishActivity).toBe(false);
        status = 503;
        const result = yield* service.checkProvider("codex").pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(TeamPolicyLive.pipe(Layer.provide(store), Layer.provide(http)))),
    );
    expect(requests).toEqual([
      "https://relay.example.com/v1/teams/environment-policy",
      "https://relay.example.com/v1/teams/environment-policy",
      "https://relay.example.com/v1/teams/environment-policy",
      "https://relay.example.com/v1/teams/environment-policy",
    ]);
  });
});
