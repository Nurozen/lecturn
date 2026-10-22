// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
import * as Etag from "effect/http/Etag";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  RelayApi,
  RelayAccessTokenType,
  RelayDpopAccessTokenResponse,
  RelayDpopTokenExchangeGrantType,
  RelayJwtSubjectTokenType,
} from "@lecturn/contracts/relay";
import * as RelayConfiguration from "../Config.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import { layerTokenApi } from "./Api.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  clerkSecretKey: Redacted.make("test-clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "lecturn-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  apns: {
    teamId: "test",
    keyId: "test",
    privateKey: Redacted.make("test"),
    bundleId: "test",
    environment: "sandbox",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("test"),
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const configLayer = RelayConfiguration.layer(config);
const tokensLayer = RelayTokens.layer.pipe(Layer.provide(configLayer));
const decodeResponse = Schema.decodeUnknownEffect(RelayDpopAccessTokenResponse);
const exchangeUrl = `${config.relayIssuer}/v1/client/dpop-token`;

function oauthIdentity(userId: string | null = "user_oauth", isAuthenticated = true) {
  const authenticateRequest = vi.fn().mockResolvedValue({
    isAuthenticated,
    toAuth: () => ({ userId }),
  });
  vi.mocked(createClerkClient).mockReturnValue({ authenticateRequest } as never);
  return authenticateRequest;
}

function exchangeRequest(overrides: Record<string, string> = {}, proof: string | null = "proof") {
  return new Request(exchangeUrl, {
    method: "POST",
    headers: {
      host: "relay.example.test",
      "x-forwarded-proto": "https",
      "content-type": "application/x-www-form-urlencoded",
      ...(proof === null ? {} : { dpop: proof }),
    },
    body: new URLSearchParams({
      grant_type: RelayDpopTokenExchangeGrantType,
      subject_token: "opaque-oauth-access-token",
      subject_token_type: RelayAccessTokenType,
      requested_token_type: RelayAccessTokenType,
      resource: config.relayIssuer,
      scope: "environment:connect environment:status",
      client_id: "lecturn-web",
      ...overrides,
    }),
  });
}

function fixture(failure?: DpopProofs.DpopProofFailureCode) {
  const verifyAndConsume = vi.fn<DpopProofs.DpopProofReplay["Service"]["verifyAndConsume"]>(() =>
    failure
      ? Effect.fail(new DpopProofs.DpopProofRejected({ code: failure }))
      : Effect.succeed("verified-proof-thumbprint"),
  );
  const routes = HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.token)).pipe(
    Layer.provide(layerTokenApi),
    Layer.provide(
      Layer.mergeAll(
        configLayer,
        tokensLayer,
        NodeServices.layer,
        NodeHttpPlatform.layer,
        Etag.layerWeak,
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume,
          consume: () => Effect.die("unused consume"),
          pruneExpired: Effect.void,
        }),
      ),
    ),
  );
  const run = Effect.fn("test.exchangeDpopAccessToken")(function* (request: Request) {
    const handler = yield* HttpRouter.toHttpEffect(routes);
    let response = HttpServerResponse.empty({ status: 500 });
    yield* HttpEffect.toHandled(handler, (_request, result) =>
      Effect.sync(() => {
        response = result;
      }),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
    );
    return HttpServerResponse.toWeb(response);
  });
  return { run, verifyAndConsume };
}

const verifyIssuedToken = Effect.fn("test.verifyIssuedToken")(function* (
  response: Response,
  userId: string,
) {
  expect(response.status).toBe(200);
  const body = yield* Effect.promise(() => response.json()).pipe(Effect.flatMap(decodeResponse));
  expect(body).toMatchObject({
    token_type: "DPoP",
    issued_token_type: RelayAccessTokenType,
    expires_in: 1_800,
    scope: "environment:connect environment:status",
  });
  const tokens = yield* RelayTokens.RelayTokens;
  const now = yield* DateTime.now;
  expect(
    yield* tokens.verifyDpopAccessToken({
      token: body.access_token,
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
    }),
  ).toMatchObject({
    sub: userId,
    iss: config.relayIssuer,
    aud: config.relayIssuer,
    client_id: "lecturn-web",
    cnf: { jkt: "verified-proof-thumbprint" },
    scope: ["environment:connect", "environment:status"],
  });
});

describe("DPoP token exchange HTTP handler", () => {
  it.effect("exchanges a validated OAuth identity for a signed DPoP-bound token", () =>
    Effect.gen(function* () {
      const authenticate = oauthIdentity();
      const f = fixture();
      const response = yield* f.run(exchangeRequest());
      yield* verifyIssuedToken(response, "user_oauth");
      expect(verifyToken).not.toHaveBeenCalled();
      const [request, options] = authenticate.mock.calls[0]!;
      expect(request.headers.get("authorization")).toBe("Bearer opaque-oauth-access-token");
      expect(options).toEqual({ acceptsToken: "oauth_token" });
      expect(f.verifyAndConsume).toHaveBeenCalledWith(
        expect.objectContaining({
          proof: "proof",
          method: "POST",
          url: exchangeUrl,
        }),
      );
      expect(response.headers.get("cache-control")).toContain("no-store");
    }).pipe(Effect.provide(tokensLayer)),
  );

  it.effect.each([
    { name: "invalid", authenticated: false, userId: "user_oauth" },
    { name: "missing identity", authenticated: true, userId: null },
    { name: "empty identity", authenticated: true, userId: "" },
  ])("rejects $name OAuth credentials", ({ authenticated, userId }) =>
    Effect.gen(function* () {
      oauthIdentity(userId, authenticated);
      const f = fixture();
      const response = yield* f.run(exchangeRequest());
      expect(response.status).toBe(401);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "auth_invalid",
        reason: "invalid_bearer",
      });
      expect(verifyToken).not.toHaveBeenCalled();
      expect(f.verifyAndConsume).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects OAuth verifier errors without trying JWT verification", () =>
    Effect.gen(function* () {
      oauthIdentity().mockRejectedValue(new Error("invalid OAuth credential"));
      const f = fixture();
      expect((yield* f.run(exchangeRequest())).status).toBe(401);
      expect(verifyToken).not.toHaveBeenCalled();
      expect(f.verifyAndConsume).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["lecturn-relay", ["other", "lecturn-relay"]])(
    "preserves JWT audience verification (%j)",
    (aud) =>
      Effect.gen(function* () {
        vi.mocked(verifyToken).mockResolvedValue({ sub: "user_session", aud } as never);
        const response = yield* fixture().run(
          exchangeRequest({
            subject_token_type: RelayJwtSubjectTokenType,
            subject_token: "session-token",
          }),
        );
        yield* verifyIssuedToken(response, "user_session");
        expect(verifyToken).toHaveBeenCalledWith("session-token", {
          secretKey: "test-clerk-secret",
          audience: config.clerkJwtAudience,
        });
        expect(createClerkClient).not.toHaveBeenCalled();
      }).pipe(Effect.provide(tokensLayer)),
  );

  it.effect.each([
    { sub: "user_session", aud: "lecturn-relay-attacker" },
    { sub: "user_session", aud: ["other"] },
    { sub: "user_session" },
    { aud: "lecturn-relay" },
  ])("rejects JWT claims without the exact audience and identity (%j)", (claims) =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue(claims as never);
      oauthIdentity();
      const f = fixture();
      expect(
        (yield* f.run(exchangeRequest({ subject_token_type: RelayJwtSubjectTokenType }))).status,
      ).toBe(401);
      expect(createClerkClient).not.toHaveBeenCalled();
      expect(f.verifyAndConsume).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not fall back to OAuth when JWT verification fails", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("invalid JWT"));
      oauthIdentity();
      expect(
        (yield* fixture().run(exchangeRequest({ subject_token_type: RelayJwtSubjectTokenType })))
          .status,
      ).toBe(401);
      expect(createClerkClient).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    { override: { resource: "https://wrong.example.test" }, status: 401 },
    { override: { scope: "mobile:registration" }, status: 401 },
    { override: { scope: "unknown:scope" }, status: 401 },
  ])("rejects invalid exchange parameters (%j)", ({ override, status }) =>
    Effect.gen(function* () {
      oauthIdentity();
      const f = fixture();
      expect((yield* f.run(exchangeRequest(override))).status).toBe(status);
      expect(createClerkClient).not.toHaveBeenCalled();
      expect(f.verifyAndConsume).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["missing_proof", "invalid_signature", "replayed"] as const)(
    "preserves DPoP rejection: %s",
    (failure) =>
      Effect.gen(function* () {
        oauthIdentity();
        const f = fixture(failure);
        const response = yield* f.run(exchangeRequest());
        expect(response.status).toBe(401);
        expect(f.verifyAndConsume).toHaveBeenCalledOnce();
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          code: "auth_invalid",
          reason: "invalid_dpop",
        });
      }),
  );
});
