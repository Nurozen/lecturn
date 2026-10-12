import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as Etag from "effect/unstable/http/Etag";
import * as Headers from "effect/unstable/http/Headers";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  ConnectAccountError,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type EnvironmentSessionPrincipalShape,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ConnectAccount } from "./ConnectAccount.ts";
import {
  connectAccountHttpApiLayer,
  requireLocalConnectAccountOwner,
} from "./connectAccountHttp.ts";

const principal: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("phone-session"),
  subject: "one-time-token",
  method: "browser-session-cookie",
  scopes: new Set(AuthStandardClientScopes),
};
const origin = "http://127.0.0.1:3773";
const decodeAccountError = Schema.decodeUnknownSync(ConnectAccountError);
const headers = {
  host: "127.0.0.1:3773",
  origin,
  "x-lecturn-connect-account": "local-ui",
  "sec-fetch-site": "same-origin",
};
const request = (
  overrides: Record<string, string> = {},
  remoteAddress: string | null = "127.0.0.1",
  method = "POST",
) =>
  HttpServerRequest.fromWeb(
    new Request(`${origin}/api/connect/account/status`, {
      method,
      headers: { ...headers, ...overrides },
    }),
  ).modify({ remoteAddress: Option.fromNullishOr(remoteAddress) });

const withPhoneVmFlag = (flag?: string) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv({ env: flag === undefined ? {} : { LECTURN_PHONE_VM_CONNECT: flag } }),
  );

it.effect("only the exact opt-in admits the fixed NAT peer with all local UI protections", () =>
  Effect.gen(function* () {
    for (const address of ["10.0.2.2", "::ffff:10.0.2.2"]) {
      for (const flag of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
        const failure = yield* requireLocalConnectAccountOwner().pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
          Effect.provideService(HttpServerRequest.HttpServerRequest, request({}, address)),
          withPhoneVmFlag(flag),
          Effect.flip,
        );
        assert.equal(failure._tag, "ConnectAccountError");
      }
      const owner = yield* requireLocalConnectAccountOwner().pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request({}, address)),
        withPhoneVmFlag("1"),
      );
      assert.equal(owner.sessionId, principal.sessionId);
    }
    const cases = [
      ...["10.0.2.3", "10.0.0.1", "192.168.1.1", "172.16.0.1", "::ffff:10.0.2.3", null].map(
        (address) => ({ request: request({}, address), principal }),
      ),
      ...[
        { host: "127.0.0.1:3774", origin: "http://127.0.0.1:3774" },
        { host: "[::1]:3773", origin: "http://[::1]:3773" },
        { host: "localhost:3773", origin: "http://localhost:3773" },
        { origin: "https://remote.example.test" },
        { origin: "" },
        { origin: "null" },
        { "x-lecturn-connect-account": "" },
        { "sec-fetch-site": "cross-site" },
        { forwarded: "for=127.0.0.1" },
        { "x-forwarded-for": "127.0.0.1" },
        { "x-forwarded-host": "127.0.0.1:3773" },
        { "x-forwarded-proto": "http" },
        { "cf-connecting-ip": "127.0.0.1" },
      ].map((overrides) => ({ request: request(overrides, "10.0.2.2"), principal })),
      ...(["bearer-access-token", "dpop-access-token"] as const).map((method) => ({
        request: request({}, "10.0.2.2"),
        principal: { ...principal, method },
      })),
      { request: request({}, "10.0.2.2"), principal: { ...principal, subject: "cloud-connect" } },
    ];
    for (const test of cases) {
      const failure = yield* requireLocalConnectAccountOwner().pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, test.principal),
        Effect.provideService(HttpServerRequest.HttpServerRequest, test.request),
        withPhoneVmFlag("1"),
        Effect.flip,
      );
      assert.equal(failure._tag, "ConnectAccountError");
    }
  }),
);

it.effect("permits the native standard-scope cookie session with same-origin local intent", () =>
  Effect.gen(function* () {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const owner = yield* requireLocalConnectAccountOwner().pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request({}, address)),
      );
      assert.equal(owner.sessionId, principal.sessionId);
    }
    const get = request({}, "127.0.0.1", "GET");
    const browserHeaders = Headers.set(
      Headers.remove(get.headers, "origin"),
      "referer",
      `${origin}/settings`,
    );
    yield* requireLocalConnectAccountOwner().pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        get.modify({ headers: browserHeaders }),
      ),
    );
  }),
);

it.effect(
  "rejects remote, forwarded, bearer, cross-origin and missing-intent callers regardless of scope",
  () =>
    Effect.gen(function* () {
      const cases = [
        { request: request({}, "192.0.2.2"), principal },
        { request: request({}, null), principal },
        { request: request({ origin: "https://remote.example.test" }), principal },
        { request: request({ origin: "null" }), principal },
        { request: request({ origin: `${origin}/other` }), principal },
        { request: request({ host: "evil.example.test" }), principal },
        { request: request({ "x-lecturn-connect-account": "" }), principal },
        { request: request({ "sec-fetch-site": "cross-site" }), principal },
        { request: request({ "x-forwarded-for": "127.0.0.1" }), principal },
        { request: request({ forwarded: "for=127.0.0.1" }), principal },
        { request: request(), principal: { ...principal, method: "bearer-access-token" as const } },
        { request: request(), principal: { ...principal, method: "dpop-access-token" as const } },
        { request: request(), principal: { ...principal, subject: "cloud-connect" } },
      ];
      for (const test of cases) {
        const failure = yield* requireLocalConnectAccountOwner().pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, test.principal),
          Effect.provideService(HttpServerRequest.HttpServerRequest, test.request),
          Effect.flip,
        );
        assert.equal(failure._tag, "ConnectAccountError");
      }
      const failure = yield* requireLocalConnectAccountOwner().pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          ...principal,
          scopes: new Set(["relay:read"] as const),
        }),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request()),
        Effect.flip,
      );
      assert.equal(failure._tag, "EnvironmentScopeRequiredError");
    }),
);

it.each([
  { peer: "127.0.0.1", flag: undefined, permitted: true },
  { peer: "10.0.2.2", flag: undefined, permitted: false },
  { peer: "10.0.2.2", flag: "1", permitted: true },
  { peer: "::ffff:10.0.2.2", flag: "1", permitted: true },
  { peer: "10.0.2.3", flag: "1", permitted: false },
])(
  "all six routes enforce auth and transport ($peer, flag=$flag)",
  async ({ peer, flag, permitted }) => {
    let calls = 0;
    const status = {
      configured: true,
      state: "signed-out" as const,
      account: null,
      relayUrl: "https://relay.example.test",
    };
    const result = Effect.sync(() => {
      calls++;
      return status;
    });
    const service = ConnectAccount.of({
      status: result,
      begin: () =>
        Effect.sync(() => {
          calls++;
          return {
            authorizationUrl: "https://hosted.example.test/connect",
            requestId: "request",
            expiresAt: "2030-01-01T00:00:00Z",
          };
        }),
      complete: () => result,
      cancel: () => result,
      logout: result,
      token: () =>
        Effect.sync(() => {
          calls++;
          return { token: null };
        }),
    });
    const auth = environmentAuthenticatedAuthLayer.pipe(
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: (req) =>
            req.cookies.session === "synthetic-session"
              ? Effect.succeed({ ...principal, scopes: [...AuthStandardClientScopes] })
              : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
        }),
      ),
    );
    const api = HttpApi.make("environment").add(EnvironmentHttpApi.groups.connectAccount);
    const layer = HttpApiBuilder.layer(api).pipe(
      Layer.provide(connectAccountHttpApiLayer),
      Layer.provide(auth),
      Layer.provide(Layer.succeed(ConnectAccount, service)),
      Layer.provide(NodeHttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const localTransport = HttpRouter.middleware(
      (effect) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) =>
          effect.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              req.modify({ remoteAddress: Option.some(peer) }),
            ),
            withPhoneVmFlag(flag),
          ),
        ),
      { global: true },
    );
    const app = HttpRouter.toWebHandler(layer.pipe(Layer.provide(localTransport)), {
      disableLogger: true,
    });
    try {
      const routes = [
        ["status", undefined],
        ["begin", undefined],
        ["complete", { requestId: "request", code: "code.state" }],
        ["cancel", { requestId: "request" }],
        ["token", { accountId: "account" }],
        ["logout", undefined],
      ] as const;
      for (const [name, payload] of routes) {
        const init = {
          method: name === "status" ? "GET" : "POST",
          headers: { ...headers, "content-type": "application/json" },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        };
        const unauthenticated = await app.handler(
          new Request(`${origin}/api/connect/account/${name}`, init),
        );
        assert.equal(unauthenticated.status, 401);
        assert.equal(calls, 0);
      }
      for (const [name, payload] of routes) {
        const response = await app.handler(
          new Request(`${origin}/api/connect/account/${name}`, {
            method: name === "status" ? "GET" : "POST",
            headers: {
              ...headers,
              cookie: "session=synthetic-session",
              "content-type": "application/json",
            },
            ...(payload ? { body: JSON.stringify(payload) } : {}),
          }),
        );
        assert.equal(response.status, permitted ? 200 : 400);
        assert.equal(response.headers.get("cache-control"), "no-store");
        if (!permitted)
          assert.equal(decodeAccountError(await response.json()).reason, "local_ui_required");
      }
      if (!permitted) {
        assert.equal(calls, 0);
        return;
      }
      assert.equal(calls, 6);
      for (const body of [
        JSON.stringify({ requestId: "request", code: "synthetic-secret-".repeat(600) }),
        JSON.stringify({ requestId: "request" }),
        '{"code":"synthetic-secret-',
      ]) {
        const invalid = await app.handler(
          new Request(`${origin}/api/connect/account/complete`, {
            method: "POST",
            headers: {
              ...headers,
              cookie: "session=synthetic-session",
              "content-type": "application/json",
            },
            body,
          }),
        );
        assert.equal(invalid.status, 400);
        assert.equal(await invalid.text(), "");
        assert.equal(calls, 6);
      }
    } finally {
      await app.dispose();
    }
  },
);
