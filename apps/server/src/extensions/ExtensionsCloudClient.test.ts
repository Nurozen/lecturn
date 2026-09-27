import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ExtensionFundingStatusResult } from "@lecturn/contracts";
import { Effect, Fiber, Option, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { RELAY_URL_SECRET, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { make } from "./ExtensionsCloudClient.ts";
import { make as makeDecisions } from "../threadDecisions/DecisionCloudClient.ts";

const environmentId = EnvironmentId.make("extension-test");
const active: ExtensionFundingStatusResult = {
  featureId: "contextual",
  environmentId,
  state: "active",
  generation: 4,
  accountLabel: "Synthetic",
  eligible: true,
  reason: "eligible",
  allowance: null,
  remoteRevocationPending: false,
};
const challenge = {
  featureId: "contextual" as const,
  environmentId,
  challengeId: "exact-challenge",
  generation: 5,
  approvalUrl: "https://relay.test/approve",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const observe = {
  featureId: "contextual" as const,
  environmentId,
  challengeId: challenge.challengeId,
  generation: 5,
  state: "approved-awaiting-host",
  expiresAt: challenge.expiresAt,
  accountLabel: "Synthetic",
};
const setup = (handle: (url: string) => Response) =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>([
      [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.test")],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("synthetic-credential")],
      [
        "cloud-link-ed25519-key-pair",
        new TextEncoder().encode('{"privateKey":"synthetic","publicKey":"synthetic"}'),
      ],
    ]);
    const secrets: ServerSecretStore["Service"] = {
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    };
    const urls: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        urls.push(request.url);
        assert.equal(request.headers.authorization, "Bearer synthetic-credential");
        return HttpClientResponse.fromWeb(request, handle(request.url));
      }),
    );
    const create = make.pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const decisions = yield* makeDecisions.pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    return { client: yield* create, restart: create, decisions, urls, values };
  });
it.effect("auto-redeems only its exact durably pending approved challenge", () =>
  Effect.gen(function* () {
    const f = yield* setup((url) =>
      Response.json(
        url.includes("/challenge")
          ? challenge
          : url.includes("/observe")
            ? observe
            : { ...active, generation: 6 },
      ),
    );
    yield* f.client.funding({
      featureId: "contextual",
      operation: "create",
      expectedGeneration: 4,
    });
    const wrong = yield* f.client
      .funding({
        featureId: "contextual",
        operation: "observe",
        challengeId: "other",
        expectedGeneration: 5,
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(wrong));
    assert.equal(f.urls.length, 1);
    const restarted = yield* f.restart;
    const result = yield* restarted.funding({
      featureId: "contextual",
      operation: "observe",
      challengeId: challenge.challengeId,
      expectedGeneration: 5,
    });
    assert.isTrue("state" in result && result.state === "active");
    assert.equal(f.urls.filter((url) => url.includes("/redeem")).length, 1);
    assert.equal(yield* restarted.pending("contextual"), null);
  }),
);
it.effect("observation of an unapproved challenge never grants or redeems consent", () =>
  Effect.gen(function* () {
    const f = yield* setup((url) =>
      Response.json(
        url.includes("/challenge")
          ? challenge
          : { ...observe, state: "awaiting-approval", accountLabel: null },
      ),
    );
    yield* f.client.funding({
      featureId: "contextual",
      operation: "create",
      expectedGeneration: 4,
    });
    const result = yield* f.client.funding({
      featureId: "contextual",
      operation: "redeem",
      challengeId: challenge.challengeId,
      expectedGeneration: 5,
    });
    assert.isTrue("state" in result && result.state === "awaiting-approval");
    assert.isFalse(f.urls.some((url) => url.includes("/redeem")));
  }),
);
it.effect(
  "retains cancellation intent through failure and restart without replacing active funding",
  () =>
    Effect.gen(function* () {
      const f = yield* setup((url) =>
        url.includes("/cancel")
          ? new Response("PRIVATE_UPSTREAM", { status: 503 })
          : Response.json(
              url.includes("/challenge") ? challenge : url.includes("/observe") ? observe : active,
            ),
      );
      yield* f.client.status("contextual");
      yield* f.client.funding({
        featureId: "contextual",
        operation: "create",
        expectedGeneration: 4,
      });
      assert.isTrue(
        Result.isFailure(
          yield* f.client
            .funding({
              featureId: "contextual",
              operation: "cancel",
              challengeId: challenge.challengeId,
              expectedGeneration: 5,
            })
            .pipe(Effect.result),
        ),
      );
      const restarted = yield* f.restart;
      assert.equal((yield* restarted.pending("contextual"))?.intent, "cancel");
      yield* restarted
        .funding({
          featureId: "contextual",
          operation: "observe",
          challengeId: challenge.challengeId,
          expectedGeneration: 5,
        })
        .pipe(Effect.result);
      assert.isFalse(f.urls.some((url) => url.includes("/redeem")));
      assert.equal((yield* restarted.status("contextual")).generation, 4);
    }),
);
it.effect("preserves local revoke through stale active cloud responses and network failure", () =>
  Effect.gen(function* () {
    const f = yield* setup((url) =>
      url.includes("/revoke")
        ? new Response("PRIVATE_UPSTREAM", { status: 503 })
        : Response.json(active),
    );
    yield* f.client.status("contextual");
    yield* f.client.funding({
      featureId: "contextual",
      operation: "revoke",
      expectedGeneration: 4,
    });
    const restarted = yield* f.restart;
    const result = yield* restarted.status("contextual");
    assert.equal(result.state, "revoked");
    assert.isFalse(result.eligible);
    assert.isTrue(result.remoteRevocationPending);
  }),
);

it.effect(
  "startup reconciliation is idle without durable work and redeems pending consent after restart",
  () =>
    Effect.gen(function* () {
      const f = yield* setup((url) =>
        Response.json(
          url.includes("/challenge")
            ? challenge
            : url.includes("/observe")
              ? observe
              : { ...active, generation: 6 },
        ),
      );
      yield* f.client.reconcilePending;
      assert.deepEqual(f.urls, []);
      yield* f.client.funding({
        featureId: "contextual",
        operation: "create",
        expectedGeneration: 4,
      });
      const restarted = yield* f.restart;
      yield* restarted.reconcilePending;
      assert.isNull(yield* restarted.pending("contextual"));
      const count = f.urls.length;
      yield* restarted.reconcilePending;
      assert.equal(f.urls.length, count);
      assert.isTrue(f.urls.some((url) => url.includes("/observe")));
      assert.isTrue(f.urls.some((url) => url.includes("/redeem")));
    }),
);

it.effect("a funding response that stalls after headers releases the status lock on deadline", () =>
  Effect.gen(function* () {
    let requests = 0;
    const f = yield* setup(() =>
      ++requests === 1
        ? new Response(new ReadableStream({ start() {} }), {
            headers: { "content-type": "application/json" },
          })
        : Response.json(active),
    );
    const first = yield* f.client.status("contextual").pipe(Effect.forkChild);
    yield* TestClock.adjust("90 seconds");
    assert.isFalse((yield* Fiber.join(first)).eligible);
    assert.isTrue((yield* f.client.status("contextual")).eligible);
  }),
);

it.effect.each(["extensions", "legacy"] as const)(
  "shares a failed %s Decisions revocation across both funding clients and restart",
  (source) =>
    Effect.gen(function* () {
      const f = yield* setup((url) =>
        url.includes("/revoke")
          ? new Response("offline", { status: 503 })
          : Response.json({ ...active, featureId: "decisions" }),
      );
      yield* f.client.status("decisions");
      if (source === "extensions")
        yield* f.client.funding({
          featureId: "decisions",
          operation: "revoke",
          expectedGeneration: 4,
        });
      else yield* f.decisions.funding({ operation: "revoke", expectedGeneration: 4 });
      const restarted = yield* f.restart;
      assert.equal((yield* restarted.status("decisions")).state, "revoked");
      assert.isTrue((yield* restarted.status("decisions")).remoteRevocationPending);
      assert.equal((yield* f.decisions.fundingStatus).state, "revoked");
      assert.isTrue((yield* f.decisions.fundingStatus).remoteRevocationPending);
      assert.equal(
        (yield* f.decisions
          .evaluate({
            requestId: "r",
            runId: "run",
            fundingGeneration: 4,
            targets: [{ id: "t", text: "Use SQLite" }],
            context: "",
            description: "",
            templateVersion: "decisions-v1",
          })
          .pipe(Effect.flip)).code,
        "forbidden",
      );
      assert.isFalse(f.urls.some((url) => url.endsWith("/evaluate")));
    }),
);
it.effect.each(["extensions", "legacy"] as const)(
  "successful %s reapproval clears prior Decisions stops without later reconciliation revoking it",
  (source) =>
    Effect.gen(function* () {
      const f = yield* setup((url) =>
        Response.json(
          url.includes("/challenge")
            ? { ...challenge, featureId: "decisions" }
            : url.includes("/observe")
              ? { ...observe, featureId: "decisions" }
              : { ...active, featureId: "decisions", generation: 6 },
        ),
      );
      for (const name of ["decisions-funding-revoked", "extensions-decisions-revoked"])
        f.values.set(name, new TextEncoder().encode("true"));
      f.values.set(
        "decisions-funding-status",
        new TextEncoder().encode(
          yield* Schema.encodeEffect(Schema.fromJsonString(ExtensionFundingStatusResult))({
            ...active,
            featureId: "decisions",
            state: "revoked",
            eligible: false,
            remoteRevocationPending: true,
          }),
        ),
      );
      if (source === "extensions") {
        yield* f.client.funding({
          featureId: "decisions",
          operation: "create",
          expectedGeneration: 4,
        });
        yield* f.client.funding({
          featureId: "decisions",
          operation: "observe",
          challengeId: challenge.challengeId,
          expectedGeneration: 5,
        });
      } else
        yield* f.decisions.funding({
          operation: "redeem",
          challengeId: challenge.challengeId,
          expectedGeneration: 5,
        });
      yield* f.decisions.retryPendingRevocation;
      yield* f.client.reconcilePending;
      assert.equal((yield* f.decisions.fundingStatus).state, "active");
      assert.equal((yield* f.client.status("decisions")).state, "active");
      assert.isFalse(f.urls.some((url) => url.includes("/revoke")));
    }),
);

it.effect(
  "legacy revocation cancels a pending extension approval before background reconciliation",
  () =>
    Effect.gen(function* () {
      const f = yield* setup((url) =>
        url.includes("/revoke")
          ? new Response("offline", { status: 503 })
          : Response.json(
              url.includes("/challenge")
                ? { ...challenge, featureId: "decisions" }
                : url.includes("/observe")
                  ? { ...observe, featureId: "decisions" }
                  : { ...active, featureId: "decisions" },
            ),
      );
      yield* f.client.funding({
        featureId: "decisions",
        operation: "create",
        expectedGeneration: 4,
      });
      yield* f.decisions.funding({ operation: "revoke", expectedGeneration: 4 });
      yield* f.client.reconcilePending;
      assert.equal((yield* f.decisions.fundingStatus).state, "revoked");
      assert.equal(yield* f.client.pending("decisions"), null);
      assert.isFalse(f.urls.some((url) => url.includes("/redeem")));
    }),
);
