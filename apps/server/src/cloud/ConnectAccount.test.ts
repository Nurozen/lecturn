import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { readConnectAuthorizeRequest } from "@lecturn/shared/connectAuth";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ConnectAccount from "./ConnectAccount.ts";

const environment = {
  LECTURN_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
  LECTURN_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
  LECTURN_HOSTED_APP_URL: "https://hosted.example.test",
  LECTURN_RELAY_URL: "https://relay.example.test",
};
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const owner = { sessionId: "phone-session", subject: "one-time-token" };
const codeFor = (url: string) =>
  `synthetic-code.${readConnectAuthorizeRequest(new URL(url))!.state}`;
const configured = Effect.provideService(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromEnv({ env: environment }),
);

const harness = Effect.gen(function* () {
  const values = new Map<string, Uint8Array>();
  const requests: Array<{
    path: string;
    grant: string | null;
    refresh: string | null;
    verifier: string | null;
  }> = [];
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const options = {
    failRefresh: false,
    failIdentity: false,
    identity: "account-1",
    blockExchange: false,
  };
  const secrets = ServerSecretStore.of({
    get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
    set: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      const params = new URLSearchParams(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      );
      const grant = params.get("grant_type");
      requests.push({
        path,
        grant,
        refresh: params.get("refresh_token"),
        verifier: params.get("code_verifier"),
      });
      if (options.blockExchange && grant === "authorization_code") {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }
      const status =
        (options.failRefresh && grant === "refresh_token") ||
        (options.failIdentity && path === "/oauth/userinfo")
          ? 401
          : 200;
      const body =
        path === "/oauth/userinfo"
          ? { sub: options.identity, email: "synthetic@example.test" }
          : {
              access_token: grant === "refresh_token" ? "synthetic-access-2" : "synthetic-access-1",
              refresh_token:
                grant === "refresh_token" ? "synthetic-refresh-2" : "synthetic-refresh-1",
              expires_in: 3600,
              token_type: "Bearer",
              // A deliberately untrusted ID token cannot become an account identity.
              id_token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciJ9.",
            };
      return HttpClientResponse.fromWeb(
        request,
        new Response(json(body), { status, headers: { "content-type": "application/json" } }),
      );
    }),
  );
  const create = ConnectAccount.make.pipe(
    Effect.provideService(ServerSecretStore, secrets),
    Effect.provideService(HttpClient.HttpClient, client),
  );
  return { service: yield* create, create, values, requests, options, entered, release };
});

it.layer(NodeServices.layer)("phone Connect account", (it) => {
  it.effect("has useful disabled status and never starts OAuth without configuration", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const status = yield* h.service.status;
      assert.equal(status.configured, false);
      assert.equal(status.state, "signed-out");
      assert.isString(status.error);
      assert.equal((yield* h.service.begin(owner).pipe(Effect.flip)).reason, "not_configured");
      assert.equal(h.requests.length, 0);
    }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
    ),
  );

  it.effect(
    "signs in with trusted userinfo, persists across service restart, refreshes and logs out",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        assert.equal((yield* h.service.status).state, "signed-out");
        const started = yield* h.service.begin(owner);
        assert.equal((yield* h.service.status).state, "authorizing");
        const signedIn = yield* h.service.complete(
          owner,
          started.requestId,
          codeFor(started.authorizationUrl),
        );
        assert.equal(signedIn.account?.id, "account-1");
        assert.equal(signedIn.state, "signed-in");
        assert.equal(h.requests.length, 2);
        assert.isString(h.requests[0]!.verifier);
        assert.notInclude(json(signedIn), "synthetic-access");
        assert.notInclude(json(signedIn), "synthetic-refresh");
        assert.equal(h.values.size, 1);
        const restarted = yield* h.create;
        assert.equal((yield* restarted.status).account?.id, "account-1");
        assert.equal((yield* restarted.token("account-1")).token, "synthetic-access-1");
        assert.equal(h.requests.length, 2);
        yield* TestClock.adjust("56 minutes");
        assert.equal((yield* restarted.token("account-1")).token, "synthetic-access-2");
        assert.equal(h.requests[2]!.grant, "refresh_token");
        assert.equal(h.requests[2]!.refresh, "synthetic-refresh-1");
        assert.equal((yield* restarted.logout).state, "signed-out");
        assert.equal(h.values.size, 0);
        assert.isNull((yield* restarted.token("account-1")).token);
        assert.equal(h.requests.length, 4);
      }).pipe(configured),
  );

  it.effect(
    "binds login to principal and session and rejects replay, wrong state and concurrent begin",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const started = yield* h.service.begin(owner);
        assert.equal((yield* h.service.begin(owner).pipe(Effect.flip)).reason, "login_in_progress");
        for (const other of [
          { ...owner, sessionId: "other" },
          { ...owner, subject: "other" },
        ]) {
          assert.equal(
            (yield* h.service
              .complete(other, started.requestId, codeFor(started.authorizationUrl))
              .pipe(Effect.flip)).reason,
            "invalid_request",
          );
          assert.equal(
            (yield* h.service.cancel(other, started.requestId).pipe(Effect.flip)).reason,
            "invalid_request",
          );
        }
        assert.equal(
          (yield* h.service
            .complete(owner, started.requestId, "synthetic-code.wrong-state")
            .pipe(Effect.flip)).reason,
          "authorization_failed",
        );
        assert.equal(h.requests.length, 0);
        assert.equal((yield* h.service.status).state, "error");
        assert.equal(
          (yield* h.service
            .complete(owner, started.requestId, codeFor(started.authorizationUrl))
            .pipe(Effect.flip)).reason,
          "invalid_request",
        );
        const next = yield* h.service.begin(owner);
        yield* h.service.complete(owner, next.requestId, codeFor(next.authorizationUrl));
        assert.equal(
          (yield* h.service
            .complete(owner, next.requestId, codeFor(next.authorizationUrl))
            .pipe(Effect.flip)).reason,
          "invalid_request",
        );
        assert.equal((yield* h.service.begin(owner).pipe(Effect.flip)).reason, "already_signed_in");
      }).pipe(configured),
  );

  it.effect("cancellation, logout and exact ten-minute expiry invalidate pending requests", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      for (const action of ["cancel", "logout", "expire"] as const) {
        const started = yield* h.service.begin(owner);
        if (action === "cancel") yield* h.service.cancel(owner, started.requestId);
        if (action === "logout") yield* h.service.logout;
        if (action === "expire") yield* TestClock.adjust("10 minutes");
        assert.equal(
          (yield* h.service
            .complete(owner, started.requestId, codeFor(started.authorizationUrl))
            .pipe(Effect.flip)).reason,
          "invalid_request",
        );
      }
      assert.equal(h.requests.length, 0);
      assert.equal(h.values.size, 0);
    }).pipe(configured),
  );

  for (const action of ["cancel", "logout"] as const) {
    it.effect(`${action} during exchange cannot resurrect a credential`, () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.options.blockExchange = true;
        const started = yield* h.service.begin(owner);
        const completing = yield* h.service
          .complete(owner, started.requestId, codeFor(started.authorizationUrl))
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(h.entered);
        assert.equal(
          (yield* h.service
            .complete(owner, started.requestId, codeFor(started.authorizationUrl))
            .pipe(Effect.flip)).reason,
          "invalid_request",
        );
        if (action === "cancel") yield* h.service.cancel(owner, started.requestId);
        else yield* h.service.logout;
        yield* Deferred.succeed(h.release, undefined);
        assert.equal((yield* Fiber.join(completing)).reason, "invalid_request");
        assert.equal(h.values.size, 0);
        assert.equal((yield* h.service.status).state, "signed-out");
      }).pipe(configured),
    );
  }

  it.effect("rejects unverified identity and account mismatches without returning a token", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.options.failIdentity = true;
      const first = yield* h.service.begin(owner);
      assert.equal(
        (yield* h.service
          .complete(owner, first.requestId, codeFor(first.authorizationUrl))
          .pipe(Effect.flip)).reason,
        "authorization_failed",
      );
      assert.equal(h.values.size, 0);
      h.options.failIdentity = false;
      const next = yield* h.service.begin(owner);
      yield* h.service.complete(owner, next.requestId, codeFor(next.authorizationUrl));
      const count = h.requests.length;
      assert.equal((yield* h.service.token("other").pipe(Effect.flip)).reason, "account_mismatch");
      assert.equal(h.requests.length, count);
      yield* TestClock.adjust("56 minutes");
      h.options.identity = "other";
      assert.equal(
        (yield* h.service.token("account-1").pipe(Effect.flip)).reason,
        "account_mismatch",
      );
      assert.equal((yield* h.service.status).account?.id, "account-1");
    }).pipe(configured),
  );

  it.effect(
    "refresh failure does not trigger login or return an expired token and logout still works",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const started = yield* h.service.begin(owner);
        yield* h.service.complete(owner, started.requestId, codeFor(started.authorizationUrl));
        yield* TestClock.adjust("61 minutes");
        h.options.failRefresh = true;
        const failure = yield* h.service.token("account-1").pipe(Effect.flip);
        assert.equal(failure.reason, "credential_unavailable");
        assert.notInclude(json(failure), "synthetic-refresh");
        assert.equal((yield* h.service.status).state, "error");
        assert.equal(h.requests.filter((r) => r.grant === "authorization_code").length, 1);
        assert.equal((yield* h.service.logout).state, "signed-out");
      }).pipe(configured),
  );
});
