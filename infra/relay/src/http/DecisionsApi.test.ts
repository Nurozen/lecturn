import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DecisionsService } from "../decisions/DecisionsService.ts";
import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { RelayConfiguration } from "../Config.ts";
import { decisionsRoutes } from "./DecisionsApi.ts";
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
  const service = {
    status: () =>
      Effect.succeed({ enabled: true, eligible: true, reason: "eligible", allowance: null }),
    fundingStatus: () => Effect.succeed(status),
    evaluate,
    funding: {
      challenge,
      approve,
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
    },
    usage: { getAllowance: () => Effect.succeed(null) },
  } as unknown as DecisionsService["Service"];
  return { approve, challenge, evaluate, service, listByPayer, revokeByPayer };
}
const request = (
  path: string,
  body?: unknown,
  authorization = "Bearer environment-token",
  origin = "https://app.test",
) =>
  new Request(`https://relay.test/v1/decisions/${path}`, {
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
      decisionsRoutes({ appOrigin: "https://app.test" }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(DecisionsService, f.service),
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
describe("Decisions authenticated HTTP", () => {
  it.effect("permits desktop payer revocation without broadening approval origins", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({ sub: "user_sponsor", aud: "relay" } as never);
      const f = fixture();
      const revoke = request(
        "funding/account-revoke",
        { environmentId: "environment", expectedGeneration: 3 },
        "Bearer account-token",
        "lecturn://app",
      );
      expect((yield* run(revoke, f)).status).toBe(200);
      expect(f.revokeByPayer).toHaveBeenCalledWith("user_sponsor", "environment", 3);
      expect(
        (yield* run(
          request(
            "funding/approve",
            { challengeId: "challenge" },
            "Bearer account-token",
            "lecturn://app",
          ),
          f,
        )).status,
      ).toBe(403);
      expect(
        (yield* run(
          request(
            "funding/account-revoke",
            { environmentId: "environment", expectedGeneration: 3 },
            "Bearer account-token",
            "https://attacker.test",
          ),
          f,
        )).status,
      ).toBe(403);
      expect(
        (yield* run(
          request(
            "funding/account-revoke",
            { environmentId: "environment", expectedGeneration: 3 },
            "",
            "lecturn://app",
          ),
          f,
        )).status,
      ).toBe(401);
      expect(f.revokeByPayer).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("lists and revokes for the authenticated sponsor without a host-admin session", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({ sub: "user_sponsor", aud: "relay" } as never);
      const f = fixture();
      expect(
        (yield* run(
          request("funding/account-list?limit=1&cursor=host-a", undefined, "Bearer account-token"),
          f,
        )).status,
      ).toBe(200);
      expect(f.listByPayer).toHaveBeenCalledWith("user_sponsor", { limit: 1, cursor: "host-a" });
      expect(
        (yield* run(
          request("funding/account-list?payerId=user_victim", undefined, "Bearer account-token"),
          f,
        )).status,
      ).toBe(400);
      expect(
        (yield* run(request("funding/account-list?limit=51", undefined, "Bearer account-token"), f))
          .status,
      ).toBe(400);
      expect(f.listByPayer).toHaveBeenCalledTimes(1);
      expect(
        (yield* run(
          request(
            "funding/account-revoke",
            { environmentId: "environment", expectedGeneration: 7 },
            "Bearer account-token",
          ),
          f,
        )).status,
      ).toBe(200);
      expect(f.revokeByPayer).toHaveBeenCalledWith("user_sponsor", "environment", 7);
    }),
  );

  it.effect(
    "uses verified account identity for approval and rejects body payer impersonation",
    () =>
      Effect.gen(function* () {
        vi.mocked(verifyToken).mockResolvedValue({ sub: "user_verified", aud: "relay" } as never);
        const f = fixture();
        const response = yield* run(
          request("funding/approve", { challengeId: "challenge" }, "Bearer session-token"),
          f,
        );
        expect(response.status).toBe(200);
        expect(f.approve).toHaveBeenCalledWith(
          "user_verified",
          "challenge",
          "sponsor@example.test",
        );
        const forged = yield* run(
          request(
            "funding/approve",
            { challengeId: "challenge", userId: "user_victim" },
            "Bearer session-token",
          ),
          f,
        );
        expect(forged.status).toBe(400);
        expect(f.approve).toHaveBeenCalledTimes(1);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }),
  );
  it.effect("requires a server-verified sponsor identity before recording approval", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({ sub: "user_verified", aud: "relay" } as never);
      const f = fixture();
      vi.mocked(createClerkClient).mockReturnValue({
        users: {
          getUser: async () => ({
            id: "user_verified",
            emailAddresses: [
              { emailAddress: "unverified@example.test", verification: { status: "unverified" } },
            ],
          }),
        },
      } as never);
      const response = yield* run(
        request("funding/approve", { challengeId: "challenge" }, "Bearer session-token"),
        f,
      );
      expect(response.status).toBe(403);
      expect(f.approve).not.toHaveBeenCalled();
      const forged = yield* run(
        request(
          "funding/approve",
          { challengeId: "challenge", accountLabel: "attacker@example.test" },
          "Bearer session-token",
        ),
        f,
      );
      expect(forged.status).toBe(400);
    }),
  );
  it.effect("returns the stored approval target and requires a permitted origin", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({ sub: "user_verified", aud: "relay" } as never);
      const response = yield* run(
        request("funding/approval?challengeId=challenge", undefined, "Bearer session-token"),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        environmentLabel: "Test workstation",
        eligible: true,
      });
      expect(
        (yield* run(
          request(
            "funding/approve",
            { challengeId: "challenge" },
            "Bearer session-token",
            "https://untrusted.test",
          ),
        )).status,
      ).toBe(403);
    }),
  );
  it.effect("binds challenge and status to the authenticated environment and key", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(
        (yield* run(
          request("funding/challenge", {
            environmentId: "environment",
            publicKey: "public-key",
            expectedGeneration: 0,
          }),
          f,
        )).status,
      ).toBe(200);
      expect(f.challenge).toHaveBeenCalledWith(host, 0);
      expect(
        (yield* run(
          request("funding/challenge", {
            environmentId: "other",
            publicKey: "public-key",
            expectedGeneration: 0,
          }),
          f,
        )).status,
      ).toBe(403);
      expect(
        (yield* run(
          request("funding/challenge", {
            environmentId: "environment",
            publicKey: "wrong-key",
            expectedGeneration: 0,
          }),
          f,
        )).status,
      ).toBe(403);
      expect((yield* run(request("funding/status?environmentId=other"), f)).status).toBe(403);
      expect(
        (yield* run(
          request("funding/status?environmentId=environment", undefined, "Bearer invalid-token"),
          f,
        )).status,
      ).toBe(401);
      expect(f.challenge).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect(
    "validates fixed evaluation payloads, rejects missing credentials, and maps quota errors without content",
    () =>
      Effect.gen(function* () {
        const payload = {
          requestId: "request",
          runId: "run",
          fundingGeneration: 1,
          targets: [{ id: "a", text: "PRIVATE_CONVERSATION_MARKER" }],
          context: "",
          description: "",
          templateVersion: "decisions-v1",
        };
        const f = fixture();
        expect((yield* run(request("evaluate", payload, ""), f)).status).toBe(401);
        expect(
          (yield* run(request("evaluate", { ...payload, model: "attacker-model" }), f)).status,
        ).toBe(400);
        expect(f.evaluate).not.toHaveBeenCalled();
        const response = yield* run(request("evaluate", payload), f);
        expect(response.status).toBe(429);
        expect(yield* Effect.promise(() => response.text())).not.toContain(
          "PRIVATE_CONVERSATION_MARKER",
        );
        expect(f.evaluate).toHaveBeenCalledTimes(1);
      }),
  );
});
