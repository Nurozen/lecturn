import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ExtensionFundingStatusResult,
  type SquireRoutingRequest,
  type SquireRoutingResult,
} from "@lecturn/contracts";
import { Effect, Fiber, Option, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { RELAY_URL_SECRET, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { make, type ExtensionsRouteError } from "./ExtensionsCloudClient.ts";
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
/** `"never"` models a relay that accepts the connection and never answers. */
const setup = (handle: (url: string) => Response | "never") =>
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
    const bodies: Array<{ readonly url: string; readonly body: unknown }> = [];
    const http = HttpClient.make((request) =>
      Effect.suspend(() => {
        urls.push(request.url);
        if (request.body._tag === "Uint8Array")
          bodies.push({
            url: request.url,
            body: JSON.parse(new TextDecoder().decode(request.body.body)),
          });
        assert.equal(request.headers.authorization, "Bearer synthetic-credential");
        const response = handle(request.url);
        return response === "never"
          ? Effect.never
          : Effect.succeed(HttpClientResponse.fromWeb(request, response));
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
    return { client: yield* create, restart: create, decisions, urls, bodies, values };
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
            reason: "unavailable",
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

const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(ExtensionFundingStatusResult));
const squiresActive: ExtensionFundingStatusResult = { ...active, featureId: "squires" };
const routing: SquireRoutingRequest = {
  featureId: "squires",
  requestId: "squire-route:post-1",
  runId: "squire-route:post-1",
  fundingGeneration: 4,
  templateVersion: "squire-routing-v1",
  members: [
    {
      squireId: "squire:research",
      name: "Research",
      brief: "Watches the web app.",
      scope: { containers: ["web-app"], threadTitles: ["Currency formatter"], pullRequests: [318] },
      recentActivity: ["Invoice rounding is off by a cent"],
    },
  ],
  post: { body: "Why does the checkout total drift?" },
};
const routed: SquireRoutingResult = {
  requestId: routing.requestId,
  runId: routing.runId,
  templateVersion: "squire-routing-v1",
  policyVersion: "squire-routing-v1",
  model: "extensions-v1",
  judgments: [{ choice: "squire:research", confidence: 0.9, noReplyConfidence: 0.1 }],
  inputTokens: 120,
  allowance: {
    poolId: "pool",
    basis: "subscription",
    windowStart: "2026-11-01T00:00:00.000Z",
    windowEnd: "2026-12-01T00:00:00.000Z",
    limitInputTokens: 1000,
    usedInputTokens: 120,
    reservedInputTokens: 0,
    remainingInputTokens: 880,
    byFeature: [{ featureId: "squires", usedInputTokens: 120, reservedInputTokens: 0 }],
  },
  replayed: false,
};
/** Squires funding is active at generation 4; `answer` serves the routing endpoint. */
const routingSetup = (answer: () => Response | "never", status = squiresActive) =>
  setup((url) => (url.includes("/squire-routing") ? answer() : Response.json(status)));
const routeFailure = (f: Effect.Success<ReturnType<typeof setup>>, input = routing) =>
  f.client.route(input).pipe(
    Effect.flip,
    Effect.map((error: ExtensionsRouteError) => error.reason),
  );

it.effect("routes a post with only the routing contract's fields", () =>
  Effect.gen(function* () {
    const f = yield* routingSetup(() => Response.json(routed));
    const smuggled = {
      ...routing,
      transcript: "TRANSCRIPT never leaves",
      summary: "SUMMARY never leaves",
      members: routing.members.map((member) => ({ ...member, diff: "DIFF never leaves" })),
      otherPost: { body: "OTHER POST never leaves" },
    };
    const result = yield* f.client.route(smuggled);
    assert.deepStrictEqual(result.judgments, routed.judgments);
    const sent = f.bodies.filter((entry) => entry.url.endsWith("/v1/extensions/squire-routing"));
    assert.equal(sent.length, 1);
    assert.deepStrictEqual(sent[0]!.body, routing);
    assert.notMatch(JSON.stringify(sent[0]!.body), /never leaves/);
  }),
);

it.effect.each([
  {
    label: "an older generation",
    input: { ...routing, fundingGeneration: 3 },
    status: squiresActive,
  },
  { label: "unfunded", input: routing, status: { ...squiresActive, state: "unfunded" as const } },
  { label: "pending", input: routing, status: { ...squiresActive, state: "pending" as const } },
  {
    label: "ineligible",
    input: routing,
    status: { ...squiresActive, eligible: false, reason: "not-paid" as const },
  },
])("refuses $label before sending the post", ({ input, status }) =>
  Effect.gen(function* () {
    const f = yield* routingSetup(() => Response.json(routed), status);
    assert.equal(yield* routeFailure(f, input), "error");
    assert.isFalse(f.urls.some((url) => url.includes("/squire-routing")));
  }),
);

it.effect("refuses after a local revoke without asking the relay", () =>
  Effect.gen(function* () {
    const f = yield* routingSetup(() => Response.json(routed));
    f.values.set("extensions-squires-revoked", new TextEncoder().encode("true"));
    assert.equal(yield* routeFailure(f), "error");
    assert.deepStrictEqual(f.urls, []);
  }),
);

it.effect.each([
  {
    label: "rate-limited",
    response: () => Response.json({ code: "rate-limited", message: "slow" }, { status: 429 }),
    reason: "rate-limited",
  },
  {
    label: "allowance-exhausted",
    response: () =>
      Response.json({ code: "allowance-exhausted", message: "spent" }, { status: 409 }),
    reason: "allowance",
  },
  {
    label: "invalid",
    response: () => Response.json({ code: "invalid", message: "bad" }, { status: 400 }),
    reason: "invalid",
  },
  {
    label: "a 500",
    response: () => new Response("PRIVATE_UPSTREAM", { status: 500 }),
    reason: "error",
  },
  {
    label: "a forbidden relay",
    response: () => Response.json({ code: "forbidden", message: "no" }, { status: 403 }),
    reason: "error",
  },
  {
    label: "an undecodable body",
    response: () => Response.json({ choice: "squire:research" }),
    reason: "invalid",
  },
  {
    label: "another request's answer",
    response: () => Response.json({ ...routed, requestId: "squire-route:other" }),
    reason: "invalid",
  },
  {
    label: "a choice outside the members",
    response: () =>
      Response.json({
        ...routed,
        judgments: [{ choice: "squire:ghost", confidence: 0.9, noReplyConfidence: 0 }],
      }),
    reason: "invalid",
  },
] as const)("maps $label to $reason", ({ response, reason }) =>
  Effect.gen(function* () {
    const f = yield* routingSetup(response);
    assert.equal(yield* routeFailure(f), reason);
  }),
);

it.effect("a relay that never answers fails at the 5 s routing deadline", () =>
  Effect.gen(function* () {
    const f = yield* routingSetup(() => "never");
    const fiber = yield* routeFailure(f).pipe(Effect.forkChild);
    yield* TestClock.adjust("4999 millis");
    assert.isUndefined(fiber.pollUnsafe());
    yield* TestClock.adjust("1 millis");
    assert.equal(yield* Fiber.join(fiber), "error");
  }),
);

it.effect("Squires funding has its own lock, beside a stalled Contextual status", () =>
  Effect.gen(function* () {
    const f = yield* setup((url) =>
      url.includes("featureId=contextual") ? "never" : Response.json(squiresActive),
    );
    yield* f.client.status("contextual").pipe(Effect.forkChild);
    const squires = yield* f.client.status("squires").pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const done = squires.pollUnsafe();
    assert.isTrue(done !== undefined && done._tag === "Success" && done.value.state === "active");
  }),
);

it.effect("stores Squires funding under its own keys and reads it without the network", () =>
  Effect.gen(function* () {
    const f = yield* setup(() => new Response("offline", { status: 503 }));
    assert.equal((yield* f.client.localStatus("squires")).state, "unfunded");
    f.values.set(
      "extensions-squires-status",
      new TextEncoder().encode(yield* encodeStatus(squiresActive)),
    );
    assert.equal((yield* f.client.localStatus("squires")).state, "active");
    assert.equal((yield* f.client.localStatus("contextual")).state, "unfunded");
    yield* f.client.funding({ featureId: "squires", operation: "revoke", expectedGeneration: 4 });
    assert.equal(new TextDecoder().decode(f.values.get("extensions-squires-revoked")), "true");
    assert.isFalse(f.values.has("extensions-contextual-revoked"));
    const count = f.urls.length;
    const local = yield* f.client.localStatus("squires");
    assert.equal(local.state, "revoked");
    assert.isFalse(local.eligible);
    assert.equal(f.urls.length, count);
  }),
);

it.effect("startup reconciliation redeems a pending Squires approval", () =>
  Effect.gen(function* () {
    const f = yield* setup((url) =>
      Response.json(
        url.includes("/challenge")
          ? { ...challenge, featureId: "squires" }
          : url.includes("/observe")
            ? { ...observe, featureId: "squires" }
            : { ...squiresActive, generation: 6 },
      ),
    );
    yield* f.client.funding({ featureId: "squires", operation: "create", expectedGeneration: 4 });
    assert.isTrue(f.values.has("extensions-squires-pending"));
    const restarted = yield* f.restart;
    yield* restarted.reconcilePending;
    assert.isNull(yield* restarted.pending("squires"));
    assert.isTrue(f.urls.some((url) => url.includes("/redeem")));
    assert.equal((yield* restarted.localStatus("squires")).generation, 6);
  }),
);
