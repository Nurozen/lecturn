import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as Etag from "effect/http/Etag";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ExtensionsService } from "../extensions/ExtensionsService.ts";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { RelayExtensionsGroup } from "@lecturn/contracts/relay";
import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { RelayConfiguration } from "../Config.ts";
import { extensionsApi } from "./ExtensionsApi.ts";
import { decisionError } from "../decisions/DecisionsAccess.ts";
import {
  EXTENSION_FEATURES_HEADER,
  EnvironmentId,
  ExtensionFeatureId,
  ExtensionFundingStatusResult,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@lecturn/contracts";
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn(), createClerkClient: vi.fn() }));
/** The contract released hosts decode with, copied verbatim from before Squires existed. */
const Legacy = (() => {
  const id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
  const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
  const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
  const ExtensionFeatureId = Schema.Literals(["decisions", "contextual"]);
  const ExtensionEligibilityReason = Schema.Literals([
    "eligible",
    "disabled",
    "not-paid",
    "trial",
    "stale-billing",
    "cohort",
    "unavailable",
  ]);
  const ExtensionFeatureUsage = Schema.Struct({
    featureId: ExtensionFeatureId,
    usedInputTokens: counter,
    reservedInputTokens: counter,
  });
  const ExtensionAllowance = Schema.Struct({
    poolId: id,
    basis: Schema.Literals(["subscription", "grant"]),
    windowStart: Schema.String,
    windowEnd: Schema.String,
    limitInputTokens: counter,
    usedInputTokens: counter,
    reservedInputTokens: counter,
    remainingInputTokens: counter,
    byFeature: Schema.Array(ExtensionFeatureUsage).check(Schema.isMaxLength(2)),
  }).check(
    Schema.makeFilter(
      (v) =>
        Date.parse(v.windowStart) < Date.parse(v.windowEnd) &&
        new Set(v.byFeature.map((entry) => entry.featureId)).size === v.byFeature.length &&
        v.byFeature.reduce((sum, entry) => sum + entry.usedInputTokens, 0) === v.usedInputTokens &&
        v.byFeature.reduce((sum, entry) => sum + entry.reservedInputTokens, 0) ===
          v.reservedInputTokens &&
        Number.isSafeInteger(v.usedInputTokens + v.reservedInputTokens) &&
        v.remainingInputTokens ===
          Math.max(0, v.limitInputTokens - v.usedInputTokens - v.reservedInputTokens),
    ),
  );
  const ExtensionFeatureAvailability = Schema.Struct({
    featureId: ExtensionFeatureId,
    available: Schema.Boolean,
    enabled: Schema.Boolean,
    eligible: Schema.Boolean,
    reason: ExtensionEligibilityReason,
  }).check(
    Schema.makeFilter((v) =>
      v.eligible ? v.enabled && v.reason === "eligible" : v.reason !== "eligible",
    ),
  );
  return {
    ExtensionServiceStatus: Schema.Struct({
      features: Schema.Array(ExtensionFeatureAvailability).check(
        Schema.isMaxLength(2),
        Schema.makeFilter((v) => new Set(v.map((f) => f.featureId)).size === v.length),
      ),
      allowance: Schema.NullOr(ExtensionAllowance),
    }),
    ExtensionFundingStatusResult: Schema.Struct({
      featureId: ExtensionFeatureId,
      environmentId: EnvironmentId,
      state: Schema.Literals(["unfunded", "pending", "active", "revoked", "unavailable"]),
      generation: counter,
      accountLabel: Schema.NullOr(text(200)),
      eligible: Schema.Boolean,
      reason: ExtensionEligibilityReason,
      allowance: Schema.NullOr(ExtensionAllowance),
      remoteRevocationPending: Schema.Boolean,
    }).check(Schema.makeFilter((v) => v.eligible === (v.reason === "eligible"))),
  };
})();
const decodeLegacyStatus = Schema.decodeUnknownEffect(Legacy.ExtensionFundingStatusResult);
const decodeLegacyService = Schema.decodeUnknownEffect(Legacy.ExtensionServiceStatus);
const decodeStatus = Schema.decodeUnknownEffect(ExtensionFundingStatusResult);
/** A payer whose Squires routing shares the pool with Decisions and Contextual. */
const squiresAllowance = {
  poolId: "extensions:pool",
  basis: "subscription",
  windowStart: "2026-10-01T00:00:00.000Z",
  windowEnd: "2026-11-01T00:00:00.000Z",
  limitInputTokens: 1000,
  usedInputTokens: 290,
  reservedInputTokens: 220,
  remainingInputTokens: 490,
  byFeature: [
    { featureId: "decisions", usedInputTokens: 150, reservedInputTokens: 200 },
    { featureId: "contextual", usedInputTokens: 100, reservedInputTokens: 0 },
    { featureId: "squires", usedInputTokens: 40, reservedInputTokens: 20 },
  ],
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const settings: RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.test",
  apns: {
    teamId: "test",
    keyId: "test",
    privateKey: Redacted.make("test"),
    bundleId: "test",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("test"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "relay",
  apnsDeliveryJobSigningSecret: Redacted.make("test"),
  cloudMintPrivateKey: Redacted.make("test"),
  cloudMintPublicKey: "test",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};
const host = {
  credentialId: "credential",
  environmentId: "environment",
  environmentPublicKey: "public-key",
};
const status = {
  featureId: "contextual",
  reason: "eligible",
  environmentId: "environment",
  state: "active",
  generation: 1,
  accountLabel: "Lecturn account",
  eligible: true,
  allowance: null,
  remoteRevocationPending: false,
};
function fixture() {
  vi.mocked(createClerkClient).mockReturnValue({
    users: {
      getUser: async (id: string) => ({
        id,
        primaryEmailAddressId: "email",
        emailAddresses: [
          {
            id: "email",
            emailAddress: "sponsor@example.test",
            verification: { status: "verified" },
          },
        ],
      }),
    },
  } as never);
  const approve = vi.fn(() =>
    Effect.succeed({ challengeId: "challenge", approved: true, expiresAt: "2026-10-01T00:00:00Z" }),
  );
  const challenge = vi.fn(() =>
    Effect.succeed({
      challengeId: "challenge",
      generation: 0,
      approvalUrl: "https://app.test/decisions/funding/approve?challengeId=challenge",
      expiresAt: "2026-10-01T00:00:00Z",
    }),
  );
  const evaluate = vi.fn(() =>
    Effect.fail(decisionError("allowance-exhausted", "Your Decisions allowance is exhausted")),
  );
  const listByPayer = vi.fn(() => Effect.succeed({ environments: [], nextCursor: null }));
  const revokeByPayer = vi.fn(() => Effect.succeed({ ...status, state: "revoked" }));
  const feature = {
    challenge,
    approve,
    observe: () =>
      Effect.succeed({
        state: "approved-awaiting-host",
        generation: 0,
        featureId: "contextual",
        environmentId: "environment",
        challengeId: "challenge",
        expiresAt: "2026-10-01T00:00:00Z",
        accountLabel: "Fixture",
      }),
    cancel: () => Effect.succeed({ state: "canceled" }),
    approvalInfo: () =>
      Effect.succeed({
        challengeId: "challenge",
        environmentId: "environment",
        environmentLabel: "Test workstation",
        expiresAt: "2026-10-01T00:00:00Z",
        approved: false,
        eligible: true,
      }),
    redeem: () => Effect.succeed(status),
    status: () => Effect.succeed({ ...status, allowance: squiresAllowance }),
    revokeByHost: () => Effect.succeed({ ...status, state: "revoked" }),
    listByPayer,
    statusByPayer: () => Effect.succeed(status),
    revokeByPayer,
  };
  const service = {
    evaluate,
    funding: { contextual: feature, decisions: feature },
    status: () =>
      Effect.succeed({
        features: ExtensionFeatureId.literals.map((featureId) => ({
          featureId,
          available: true,
          enabled: true,
          eligible: true,
          reason: "eligible",
        })),
        allowance: squiresAllowance,
      }),
  } as unknown as ExtensionsService["Service"];
  return { approve, challenge, evaluate, service, listByPayer, revokeByPayer };
}
const request = (
  path: string,
  body?: unknown,
  authorization = "Bearer environment-token",
  origin = "https://app.test",
  extraHeaders: Record<string, string> = {},
) =>
  new Request(`https://relay.test/v1/extensions/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...extraHeaders,
      ...(authorization ? { authorization } : {}),
      origin,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: encodeJson(body) }),
  });
function run(req: Request, f = fixture()) {
  return Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayExtensionsGroup)).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak)),
        Layer.provide(extensionsApi({ appOrigin: "https://app.test" })),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ExtensionsService, f.service),
            Layer.succeed(RelayConfiguration, settings),
            Layer.succeed(EnvironmentCredentials, {
              create: () => Effect.succeed("credential"),
              authenticate: (token) =>
                Effect.succeed(token === "environment-token" ? Option.some(host) : Option.none()),
              revokeForEnvironmentPublicKey: () => Effect.succeed(false),
            }),
          ),
        ),
      ),
    );
    return HttpServerResponse.toWeb(
      yield* handler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(req)),
      ),
    );
  });
}

describe("Extensions authenticated HTTP", () => {
  it.effect("rejects forged payer fields and host mismatches before funding mutation", () =>
    Effect.gen(function* () {
      const f = fixture();
      const forged = yield* run(
        request("funding/challenge", {
          featureId: "contextual",
          environmentId: "environment",
          publicKey: "public-key",
          expectedGeneration: 0,
          payerId: "attacker",
        }),
        f,
      );
      expect(forged.status).toBe(400);
      expect(f.challenge).not.toHaveBeenCalled();
      const foreign = yield* run(
        request("funding/challenge", {
          featureId: "contextual",
          environmentId: "other-host",
          publicKey: "public-key",
          expectedGeneration: 0,
        }),
        f,
      );
      expect(foreign.status).toBe(403);
      expect(f.challenge).not.toHaveBeenCalled();
    }),
  );
  it.effect("uses the authenticated selected account and rejects desktop-origin consent", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({ sub: "user_selected", aud: "relay" } as never);
      const f = fixture();
      const good = yield* run(
        request(
          "funding/approve",
          { featureId: "contextual", challengeId: "challenge" },
          "Bearer selected-token",
        ),
        f,
      );
      expect(good.status).toBe(200);
      expect(f.approve).toHaveBeenCalledWith("user_selected", "challenge", "sponsor@example.test");
      f.approve.mockClear();
      const bad = yield* run(
        request(
          "funding/approve",
          { featureId: "contextual", challengeId: "challenge" },
          "Bearer selected-token",
          "lecturn://app",
        ),
        f,
      );
      expect(bad.status).toBe(403);
      expect(f.approve).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    "observes an exact approved challenge without converting observation into approval",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const response = yield* run(
          request(
            "funding/observe?featureId=contextual&environmentId=environment&challengeId=challenge&expectedGeneration=0",
          ),
          f,
        );
        expect(response.status).toBe(200);
        expect(f.approve).not.toHaveBeenCalled();
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          state: "approved-awaiting-host",
        });
      }),
  );
  it.effect("routes a Squires post to the evaluator only for an authenticated environment", () =>
    Effect.gen(function* () {
      const f = fixture();
      const payload = {
        featureId: "squires",
        requestId: "post",
        runId: "post",
        fundingGeneration: 1,
        templateVersion: "squire-routing-v1",
        members: [
          {
            squireId: "squire-api",
            name: "API",
            brief: "",
            scope: { containers: [], threadTitles: [], pullRequests: [] },
            recentActivity: [],
          },
        ],
        post: { body: "Who owns the relay?" },
      };
      const routed = {
        requestId: "post",
        runId: "post",
        templateVersion: "squire-routing-v1",
        policyVersion: "squire-routing-v1",
        model: "extensions-v1",
        judgments: [{ choice: "squire-api", confidence: 0.7, noReplyConfidence: 0.2 }],
        inputTokens: 40,
        replayed: false,
      };
      f.evaluate.mockReturnValueOnce(Effect.succeed(routed) as never);
      const response = yield* run(request("squire-routing", payload), f);
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual(routed);
      expect(f.evaluate).toHaveBeenCalledWith(host, payload, "squire-routing");
      f.evaluate.mockClear();
      expect(
        (yield* run(request("squire-routing", payload, "Bearer forged-token"), f)).status,
      ).toBe(401);
      expect(f.evaluate).not.toHaveBeenCalled();
      f.evaluate.mockReturnValueOnce(
        Effect.fail(decisionError("unavailable", "This extension is unavailable")) as never,
      );
      expect((yield* run(request("squire-routing", payload), f)).status).toBe(503);
    }),
  );
  it.effect("folds Squires usage out for hosts released before Squires existed", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({ sub: "user_selected", aud: "relay" } as never);
      const statusPath = "funding/status?featureId=contextual&environmentId=environment";
      const legacy = yield* run(request(statusPath));
      const legacyStatus = yield* decodeLegacyStatus(yield* Effect.promise(() => legacy.json()));
      expect(legacyStatus.allowance).toEqual({
        ...squiresAllowance,
        limitInputTokens: 940,
        usedInputTokens: 250,
        reservedInputTokens: 200,
        remainingInputTokens: 490,
        byFeature: squiresAllowance.byFeature.slice(0, 2),
      });
      const payerStatus = yield* run(request("status", undefined, "Bearer selected-token"));
      const legacyService = yield* decodeLegacyService(
        yield* Effect.promise(() => payerStatus.json()),
      );
      expect(legacyService.features.map((f) => f.featureId)).toEqual(["decisions", "contextual"]);
      expect(legacyService.allowance?.remainingInputTokens).toBe(490);
      // A current host declares Squires and sees the pool exactly as the ledger reports it.
      const current = yield* run(
        request(statusPath, undefined, undefined, undefined, {
          [EXTENSION_FEATURES_HEADER]: ExtensionFeatureId.literals.join(","),
        }),
      );
      const currentStatus = yield* decodeStatus(yield* Effect.promise(() => current.json()));
      expect(currentStatus.allowance).toEqual(squiresAllowance);
    }),
  );
});
