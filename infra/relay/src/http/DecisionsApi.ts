import { createClerkClient } from "@clerk/backend";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as FileSystem from "effect/FileSystem";
import {
  DecisionEvaluationRequest,
  DecisionFundingApprovalRequest,
  DecisionFundingAccountListRequest,
  DecisionFundingChallengeRequest,
  DecisionFundingRedeemRequest,
  DecisionFundingRevokeRequest,
  DecisionFundingStatusRequest,
  type DecisionEvaluationError,
} from "@lecturn/contracts";
import { RelayConfiguration } from "../Config.ts";
import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { DecisionsService } from "../decisions/DecisionsService.ts";
import { decisionError } from "../decisions/DecisionsAccess.ts";
import { verifyRelayClientBearerToken } from "./Api.ts";
import { isBillingAppOrigin } from "../billing/BillingConfig.ts";

export interface DecisionsRouteConfig {
  readonly appOrigin: string;
  readonly additionalAppOrigins?: readonly string[];
}
export const decisionsErrorStatus = (code: DecisionEvaluationError["code"]) => {
  switch (code) {
    case "invalid":
      return 400;
    case "forbidden":
      return 403;
    case "expired":
      return 410;
    case "unavailable":
      return 503;
    case "conflict":
    case "in-progress":
      return 409;
    default:
      return 429;
  }
};
const json = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
const invalid = () => decisionError("invalid", "Invalid Decisions request");
/** Explicit environment credentials authorize host calls; Clerk account identity authorizes payer calls. */
export function decisionsRoutes(routeConfig: DecisionsRouteConfig) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const service = yield* DecisionsService;
      const credentials = yield* EnvironmentCredentials;
      const config = yield* RelayConfiguration;
      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, routeConfig.appOrigin);
        const path = url.pathname;
        const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
        if (!bearer) return json({ code: "forbidden", message: "Sign in to use Decisions" }, 401);
        const payerRoute = [
          "/v1/decisions/status",
          "/v1/decisions/funding/approve",
          "/v1/decisions/funding/approval",
          "/v1/decisions/funding/account-status",
          "/v1/decisions/funding/account-list",
          "/v1/decisions/funding/account-revoke",
        ].includes(path);
        if (
          request.headers.origin &&
          !isBillingAppOrigin(
            request.headers.origin,
            routeConfig.appOrigin,
            routeConfig.additionalAppOrigins,
          ) &&
          !(
            request.headers.origin === "lecturn://app" &&
            (request.method === "GET" ||
              (request.method === "POST" && path === "/v1/decisions/funding/account-revoke"))
          )
        )
          return yield* decisionError("forbidden", "Use your Lecturn account to manage Decisions");
        const decode = <S extends Schema.Top>(schema: S, payload: unknown) =>
          Schema.decodeUnknownEffect(schema)(payload, { onExcessProperty: "error" }).pipe(
            Effect.mapError(invalid),
          );
        const payload =
          request.method === "POST"
            ? yield* Effect.gen(function* () {
                if (
                  !(request.headers["content-type"] ?? "")
                    .toLowerCase()
                    .startsWith("application/json")
                )
                  return yield* invalid();
                return yield* request.json.pipe(Effect.mapError(invalid));
              })
            : undefined;
        if (payerRoute) {
          const verified = yield* verifyRelayClientBearerToken(config, bearer).pipe(
            Effect.mapError(() => decisionError("forbidden", "Sign in to manage Decisions")),
          );
          const userId = verified.sub;
          if (path === "/v1/decisions/status" && request.method === "GET")
            return json(yield* service.status(userId));
          if (path === "/v1/decisions/funding/approval" && request.method === "GET") {
            const query = yield* decode(DecisionFundingApprovalRequest, {
              challengeId: url.searchParams.get("challengeId"),
            });
            return json(yield* service.funding.approvalInfo(userId, query.challengeId));
          }
          if (path === "/v1/decisions/funding/approve" && request.method === "POST") {
            const body = yield* decode(DecisionFundingApprovalRequest, payload);
            const user = yield* Effect.tryPromise({
              try: () =>
                createClerkClient({
                  secretKey: Redacted.value(config.clerkSecretKey),
                }).users.getUser(userId),
              catch: () =>
                decisionError("unavailable", "Account verification is temporarily unavailable"),
            });
            const email =
              user.emailAddresses.find(
                (item) =>
                  item.id === user.primaryEmailAddressId &&
                  item.verification?.status === "verified",
              ) ?? user.emailAddresses.find((item) => item.verification?.status === "verified");
            if (user.id !== userId || user.banned || user.locked || !email)
              return yield* decisionError(
                "forbidden",
                "Verify your account email before approving Decisions",
              );
            return json(
              yield* service.funding.approve(userId, body.challengeId, email.emailAddress),
            );
          }
          if (path === "/v1/decisions/funding/account-revoke" && request.method === "POST") {
            const body = yield* decode(DecisionFundingRevokeRequest, payload);
            return json(
              yield* service.funding.revokeByPayer(
                userId,
                body.environmentId,
                body.expectedGeneration,
              ),
            );
          }
          if (path === "/v1/decisions/funding/account-list" && request.method === "GET") {
            const raw = Object.fromEntries(url.searchParams);
            const query = yield* decode(DecisionFundingAccountListRequest, {
              ...raw,
              ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
            });
            return json(yield* service.funding.listByPayer(userId, query));
          }
          if (path === "/v1/decisions/funding/account-status" && request.method === "GET") {
            const query = yield* decode(DecisionFundingStatusRequest, {
              environmentId: url.searchParams.get("environmentId"),
            });
            const result = yield* service.funding.statusByPayer(userId, query.environmentId);
            return json({
              ...result,
              allowance: result.eligible ? yield* service.usage.getAllowance(userId) : null,
            });
          }
          return json({ message: "Not found" }, 404);
        }
        const principal = yield* credentials
          .authenticate(bearer)
          .pipe(
            Effect.mapError(() =>
              decisionError("unavailable", "Environment authentication is unavailable"),
            ),
          );
        if (Option.isNone(principal))
          return json({ code: "forbidden", message: "Invalid environment credential" }, 401);
        const host = principal.value;
        const matches = (environmentId: string) =>
          environmentId === host.environmentId
            ? Effect.void
            : Effect.fail(
                decisionError("forbidden", "Environment identity does not match this credential"),
              );
        if (path === "/v1/decisions/funding/status" && request.method === "GET") {
          const query = yield* decode(DecisionFundingStatusRequest, {
            environmentId: url.searchParams.get("environmentId"),
          });
          yield* matches(query.environmentId);
          return json(yield* service.fundingStatus(host));
        }
        if (request.method !== "POST") return json({ message: "Not found" }, 404);
        if (path === "/v1/decisions/evaluate")
          return json(
            yield* service.evaluate(host, yield* decode(DecisionEvaluationRequest, payload)),
          );
        if (path === "/v1/decisions/funding/challenge") {
          const body = yield* decode(DecisionFundingChallengeRequest, payload);
          yield* matches(body.environmentId);
          if (body.publicKey !== host.environmentPublicKey)
            return yield* decisionError(
              "forbidden",
              "Environment key does not match this credential",
            );
          return json(yield* service.funding.challenge(host, body.expectedGeneration));
        }
        if (path === "/v1/decisions/funding/redeem") {
          const body = yield* decode(DecisionFundingRedeemRequest, payload);
          yield* matches(body.environmentId);
          yield* service.funding.redeem(host, body.challengeId, body.expectedGeneration);
          return json(yield* service.fundingStatus(host));
        }
        if (path === "/v1/decisions/funding/revoke") {
          const body = yield* decode(DecisionFundingRevokeRequest, payload);
          yield* matches(body.environmentId);
          return json(yield* service.funding.revokeByHost(host, body.expectedGeneration));
        }
        return json({ message: "Not found" }, 404);
      }).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(256 * 1024)),
        Effect.withTracerEnabled(false),
        Effect.catchTag("DecisionEvaluationError", (error) =>
          Effect.succeed(
            json({ code: error.code, message: error.message }, decisionsErrorStatus(error.code)),
          ),
        ),
      );
      return Layer.mergeAll(
        HttpRouter.add("GET", "/v1/decisions/*", handler),
        HttpRouter.add("POST", "/v1/decisions/*", handler),
      );
    }),
  );
}
