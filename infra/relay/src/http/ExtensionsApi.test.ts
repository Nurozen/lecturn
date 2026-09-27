import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as Etag from "effect/unstable/http/Etag";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ExtensionsService } from "../extensions/ExtensionsService.ts";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayExtensionsGroup } from "@lecturn/contracts/relay";
import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { RelayConfiguration } from "../Config.ts";
import { extensionsApi } from "./ExtensionsApi.ts";
import { decisionError } from "../decisions/DecisionsAccess.ts";
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn(), createClerkClient: vi.fn() }));
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
    revokeByHost: () => Effect.succeed({ ...status, state: "revoked" }),
    listByPayer,
    statusByPayer: () => Effect.succeed(status),
    revokeByPayer,
  };
  const service = {
    evaluate,
    funding: { contextual: feature, decisions: feature },
    status: () => Effect.succeed({ features: [], allowance: null }),
  } as unknown as ExtensionsService["Service"];
  return { approve, challenge, evaluate, service, listByPayer, revokeByPayer };
}
const request = (
  path: string,
  body?: unknown,
  authorization = "Bearer environment-token",
  origin = "https://app.test",
) =>
  new Request(`https://relay.test/v1/extensions/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
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
});
