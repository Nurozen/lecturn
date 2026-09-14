import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
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
const secretStore = (get: ServerSecretStore["Service"]["get"]) =>
  Layer.succeed(ServerSecretStore, {
    get,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    remove: () => Effect.void,
  });
const entriesStore = (entries: Map<string, string>) =>
  secretStore((key) =>
    Effect.succeed(
      Option.fromNullishOr(entries.get(key)).pipe(
        Option.map((value) => new TextEncoder().encode(value)),
      ),
    ),
  );
describe("managed team provider policy", () => {
  it.effect("allows only permitted providers for the configured organization", () =>
    Effect.gen(function* () {
      yield* assertProviderPolicy("org", "codex", policy);
      expect(
        (yield* assertProviderPolicy("org", "claudeAgent", policy).pipe(Effect.flip)).message,
      ).toContain("disabled by your organization");
      expect(
        (yield* assertProviderPolicy("other", "codex", policy).pipe(Effect.flip)).message,
      ).toContain("no longer active");
    }),
  );
  it.effect("blocks revoked seats and missing company policies", () =>
    Effect.gen(function* () {
      expect(
        (yield* assertProviderPolicy("org", "codex", { ...policy, hasAccess: false }).pipe(
          Effect.flip,
        )).message,
      ).toContain("no longer active");
      expect(
        (yield* assertProviderPolicy("org", "codex", null).pipe(Effect.flip)).message,
      ).toContain("no longer active");
    }),
  );
  it.effect("distinguishes no allowed providers from unrestricted providers", () =>
    Effect.gen(function* () {
      expect(
        (yield* assertProviderPolicy("org", "codex", { ...policy, allowedProviders: [] }).pipe(
          Effect.flip,
        )).message,
      ).toContain("disabled");
      yield* assertProviderPolicy("org", "codex", { ...policy, allowedProviders: null });
    }),
  );
  it.effect("does not contact the relay for a personal environment", () => {
    const get = vi.fn(() => Effect.succeed(Option.none<Uint8Array>()));
    return Effect.gen(function* () {
      const service = yield* TeamPolicy;
      yield* service.checkProvider("codex");
      expect(get.mock.calls).toEqual([[CLOUD_LINKED_ORGANIZATION_ID]]);
    }).pipe(
      Effect.provide(
        TeamPolicyLive.pipe(Layer.provide(secretStore(get)), Layer.provide(FetchHttpClient.layer)),
      ),
    );
  });
  it.effect("fails closed when company credentials are missing", () => {
    const entries = new Map([
      [CLOUD_LINKED_ORGANIZATION_ID, "org"],
      [RELAY_URL_SECRET, "https://relay.example.com"],
    ]);
    return Effect.gen(function* () {
      const service = yield* TeamPolicy;
      expect((yield* service.checkProvider("codex").pipe(Effect.flip)).message).toContain(
        "Could not verify",
      );
      expect(entries.has(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBe(false);
    }).pipe(
      Effect.provide(
        TeamPolicyLive.pipe(
          Layer.provide(entriesStore(entries)),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    );
  });
  it.effect("rechecks live policy and fails closed when the relay becomes unavailable", () => {
    const entries = new Map([
      [CLOUD_LINKED_ORGANIZATION_ID, "org"],
      [RELAY_URL_SECRET, "https://relay.example.com"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-test-token"],
    ]);
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
    return Effect.gen(function* () {
      const service = yield* TeamPolicy;
      yield* service.checkProvider("codex");
      expect(yield* service.canPublishActivity).toBe(true);
      activityAllowed = false;
      expect(yield* service.canPublishActivity).toBe(false);
      status = 503;
      const result = yield* service.checkProvider("codex").pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(requests).toEqual(
        Array.from({ length: 4 }, () => "https://relay.example.com/v1/teams/environment-policy"),
      );
    }).pipe(
      Effect.provide(
        TeamPolicyLive.pipe(Layer.provide(entriesStore(entries)), Layer.provide(http)),
      ),
    );
  });
});
