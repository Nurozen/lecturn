import { assert, it } from "@effect/vitest";
import { EnvironmentId, type DecisionFundingStatusResult } from "@lecturn/contracts";
import { Effect, Option, Result, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { RELAY_URL_SECRET, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { make } from "./DecisionCloudClient.ts";

const environmentId = EnvironmentId.make("qa-environment");
const active: DecisionFundingStatusResult = {
  environmentId,
  state: "active",
  generation: 4,
  accountLabel: "Lecturn account",
  eligible: true,
  allowance: null,
  remoteRevocationPending: false,
};
const setup = (handle: (url: string) => Response) =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>([
      [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.test")],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("secret-test-credential")],
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
        assert.equal(request.headers.authorization, "Bearer secret-test-credential");
        return HttpClientResponse.fromWeb(request, handle(request.url));
      }),
    );
    const client = yield* make.pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    return { client, urls, values };
  });
it.effect("keeps durable local revocation across failed remote calls and stale cloud status", () =>
  Effect.gen(function* () {
    const { client, urls } = yield* setup((url) =>
      url.includes("funding/revoke")
        ? new Response("UPSTREAM_SECRET", { status: 503 })
        : Response.json(active),
    );
    assert.equal((yield* client.fundingStatus).state, "active");
    const revoked = yield* client.funding({ operation: "revoke", expectedGeneration: 4 });
    assert.isTrue(revoked.status.remoteRevocationPending);
    assert.isFalse(revoked.status.eligible);
    const before = urls.length;
    assert.equal((yield* client.fundingStatus).state, "revoked");
    assert.equal(urls.length, before);
    const result = yield* client
      .evaluate({
        requestId: "r",
        runId: "run",
        fundingGeneration: 4,
        targets: [{ id: "t", text: "Use Postgres" }],
        context: "",
        description: "",
        templateVersion: "decisions-v1",
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.equal(urls.length, before);
  }),
);
it.effect(
  "requires successful redeem to clear local revoke and refuses a stale funding generation",
  () =>
    Effect.gen(function* () {
      const { client, urls } = yield* setup(() => Response.json(active));
      yield* client.funding({ operation: "revoke", expectedGeneration: 4 });
      yield* client.funding({
        operation: "redeem",
        challengeId: "approved",
        expectedGeneration: 4,
      });
      assert.equal((yield* client.fundingStatus).state, "active");
      const result = yield* client
        .evaluate({
          requestId: "r",
          runId: "run",
          fundingGeneration: 3,
          targets: [{ id: "t", text: "Use Postgres" }],
          context: "",
          description: "",
          templateVersion: "decisions-v1",
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.isFalse(urls.some((url) => url.endsWith("/evaluate")));
    }),
);
it.effect("reads saved data status when unlinked without sending an unauthenticated request", () =>
  Effect.gen(function* () {
    const { client, urls, values } = yield* setup(() => Response.json(active));
    values.delete(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
    const status = yield* client.fundingStatus;
    assert.equal(status.state, "unfunded");
    assert.isFalse(status.eligible);
    assert.deepEqual(urls, []);
  }),
);
it.effect(
  "emits bounded recovery wakes only when authoritative funding or allowance improves",
  () =>
    Effect.gen(function* () {
      let status: DecisionFundingStatusResult = {
        ...active,
        allowance: {
          windowStart: "2026-09-01",
          windowEnd: "2026-10-01",
          limitInputTokens: 1000,
          usedInputTokens: 900,
          reservedInputTokens: 0,
          remainingInputTokens: 100,
        },
      };
      const { client } = yield* setup(() => Response.json(status));
      const changes = yield* client.subscribeFundingChanges;
      yield* client.fundingStatus;
      yield* client.refreshFunding;
      status = {
        ...status,
        allowance: { ...status.allowance!, usedInputTokens: 1000, remainingInputTokens: 0 },
      };
      yield* client.refreshFunding;
      status = {
        ...status,
        allowance: {
          ...status.allowance!,
          windowStart: "2026-10-01",
          windowEnd: "2026-11-01",
          usedInputTokens: 0,
          remainingInputTokens: 1000,
        },
      };
      yield* client.refreshFunding;
      const observed = yield* changes.pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        observed.map((value) => value.allowance?.windowStart),
        ["2026-09-01", "2026-10-01"],
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "retries a durable remote revoke using the current generation without re-enabling local work",
  () =>
    Effect.gen(function* () {
      let reachable = false;
      const { client, urls } = yield* setup((url) => {
        if (url.includes("funding/revoke"))
          return reachable
            ? Response.json({ ...active, state: "revoked", eligible: false, generation: 5 })
            : new Response("unavailable", { status: 503 });
        return Response.json(active);
      });
      yield* client.funding({ operation: "revoke", expectedGeneration: 4 });
      yield* client.retryPendingRevocation;
      assert.isTrue((yield* client.fundingStatus).remoteRevocationPending);
      reachable = true;
      yield* client.retryPendingRevocation;
      const status = yield* client.fundingStatus;
      assert.equal(status.state, "revoked");
      assert.isFalse(status.eligible);
      assert.isFalse(status.remoteRevocationPending);
      assert.equal(status.generation, 5);
      const before = urls.length;
      yield* client.retryPendingRevocation;
      assert.equal(urls.length, before);
    }),
);
it.effect("does not accept an active reply as confirmation of remote revocation", () =>
  Effect.gen(function* () {
    const { client } = yield* setup(() => Response.json(active));
    const result = yield* client.funding({ operation: "revoke", expectedGeneration: 4 });
    assert.equal(result.status.state, "revoked");
    assert.isFalse(result.status.eligible);
    assert.isTrue(result.status.remoteRevocationPending);
  }),
);
