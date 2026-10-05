import { RelayApi } from "@lecturn/contracts/relay";
import { createClerkClient } from "@clerk/backend";
import { Effect, Option, Redacted, Schema } from "effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as FileSystem from "effect/FileSystem";
import * as Contracts from "@lecturn/contracts";
import { RelayConfiguration } from "../Config.ts";
import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { ExtensionsService } from "../extensions/ExtensionsService.ts";
import { decisionError } from "../decisions/DecisionsAccess.ts";
import { verifyRelayClientBearerToken } from "./Api.ts";
import { isBillingAppOrigin } from "../billing/BillingConfig.ts";
import { decisionsErrorStatus, type DecisionsRouteConfig } from "./DecisionsApi.ts";
const json = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
const invalid = () => decisionError("invalid", "Invalid extensions request");
const decoders = {
  approval: Schema.decodeUnknownEffect(Contracts.ExtensionFundingApprovalRequest),
  observe: Schema.decodeUnknownEffect(Contracts.ExtensionFundingObserveRequest),
  challenge: Schema.decodeUnknownEffect(Contracts.ExtensionFundingChallengeRequest),
  status: Schema.decodeUnknownEffect(Contracts.ExtensionFundingStatusRequest),
  revoke: Schema.decodeUnknownEffect(Contracts.ExtensionFundingRevokeRequest),
  list: Schema.decodeUnknownEffect(Contracts.ExtensionFundingAccountListRequest),
  evaluationStatus: Schema.decodeUnknownEffect(Contracts.ExtensionEvaluationStatusRequest),
};
/** Routes are in the generated HTTP catalog; authentication remains explicit for each principal kind. */
export const extensionsApi = (routeConfig: DecisionsRouteConfig) =>
  HttpApiBuilder.group(
    RelayApi,
    "extensions",
    Effect.fnUntraced(function* (handlers) {
      const service = yield* ExtensionsService;
      const credentials = yield* EnvironmentCredentials;
      const config = yield* RelayConfiguration;
      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, routeConfig.appOrigin);
        const path = url.pathname;
        const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
        if (!bearer) return json({ code: "forbidden", message: "Sign in to use extensions" }, 401);
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
              (request.method === "POST" && path === "/v1/extensions/funding/account-revoke"))
          )
        )
          return yield* decisionError("forbidden", "Use your Lecturn account to manage extensions");
        let payload: unknown;
        if (request.method === "POST") {
          if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
            return yield* invalid();
          payload = yield* request.json.pipe(Effect.mapError(invalid));
        } else {
          const query = Object.fromEntries(url.searchParams);
          payload = {
            ...query,
            ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
            ...(query.expectedGeneration === undefined
              ? {}
              : { expectedGeneration: Number(query.expectedGeneration) }),
            ...(query.fundingGeneration === undefined
              ? {}
              : { fundingGeneration: Number(query.fundingGeneration) }),
          };
        }
        const decode = <A>(
          parser: (
            v: unknown,
            options?: Parameters<typeof decoders.approval>[1],
          ) => Effect.Effect<A, Schema.SchemaError>,
        ) => parser(payload, { onExcessProperty: "error" }).pipe(Effect.mapError(invalid));
        const payerRoute = [
          "/v1/extensions/status",
          "/v1/extensions/funding/approval",
          "/v1/extensions/funding/approve",
          "/v1/extensions/funding/account-status",
          "/v1/extensions/funding/account-list",
          "/v1/extensions/funding/account-revoke",
        ].includes(path);
        if (payerRoute) {
          const verified = yield* verifyRelayClientBearerToken(config, bearer).pipe(
            Effect.mapError(() => decisionError("forbidden", "Sign in to manage extensions")),
          );
          const payerId = verified.sub;
          if (path === "/v1/extensions/status") return json(yield* service.status(payerId));
          if (
            path === "/v1/extensions/funding/approval" ||
            path === "/v1/extensions/funding/approve"
          ) {
            const body = yield* decode(decoders.approval);
            const funding = service.funding[body.featureId];
            if (request.method === "GET")
              return json(yield* funding.approvalInfo(payerId, body.challengeId));
            const user = yield* Effect.tryPromise({
              try: () =>
                createClerkClient({
                  secretKey: Redacted.value(config.clerkSecretKey),
                }).users.getUser(payerId),
              catch: () =>
                decisionError("unavailable", "Account verification is temporarily unavailable"),
            });
            const email =
              user.emailAddresses.find(
                (item) =>
                  item.id === user.primaryEmailAddressId &&
                  item.verification?.status === "verified",
              ) ?? user.emailAddresses.find((item) => item.verification?.status === "verified");
            if (user.id !== payerId || user.banned || user.locked || !email)
              return yield* decisionError(
                "forbidden",
                "Verify your account email before approving extensions",
              );
            return json(yield* funding.approve(payerId, body.challengeId, email.emailAddress));
          }
          if (path === "/v1/extensions/funding/account-list") {
            const body = yield* decode(decoders.list);
            return json(yield* service.funding[body.featureId].listByPayer(payerId, body));
          }
          if (path === "/v1/extensions/funding/account-status") {
            const body = yield* decode(decoders.status);
            return json(
              yield* service.funding[body.featureId].statusByPayer(payerId, body.environmentId),
            );
          }
          if (path === "/v1/extensions/funding/account-revoke") {
            const body = yield* decode(decoders.revoke);
            return json(
              yield* service.funding[body.featureId].revokeByPayer(
                payerId,
                body.environmentId,
                body.expectedGeneration,
              ),
            );
          }
        }
        const authenticated = yield* credentials
          .authenticate(bearer)
          .pipe(
            Effect.mapError(() =>
              decisionError("unavailable", "Environment authentication is unavailable"),
            ),
          );
        if (Option.isNone(authenticated))
          return json({ code: "forbidden", message: "Invalid environment credential" }, 401);
        const host = authenticated.value;
        const matches = (id: string) =>
          id === host.environmentId
            ? Effect.void
            : Effect.fail(
                decisionError("forbidden", "Environment identity does not match this credential"),
              );
        if (path === "/v1/extensions/funding/status") {
          const body = yield* decode(decoders.status);
          yield* matches(body.environmentId);
          return json(yield* service.funding[body.featureId].status(host));
        }
        if (path === "/v1/extensions/funding/challenge") {
          const body = yield* decode(decoders.challenge);
          yield* matches(body.environmentId);
          if (body.publicKey !== host.environmentPublicKey)
            return yield* decisionError(
              "forbidden",
              "Environment key does not match this credential",
            );
          return json(
            yield* service.funding[body.featureId].challenge(host, body.expectedGeneration),
          );
        }
        if (
          [
            "/v1/extensions/funding/observe",
            "/v1/extensions/funding/redeem",
            "/v1/extensions/funding/cancel",
          ].includes(path)
        ) {
          const body = yield* decode(decoders.observe);
          yield* matches(body.environmentId);
          const funding = service.funding[body.featureId];
          if (path.endsWith("/observe"))
            return json(yield* funding.observe(host, body.challengeId, body.expectedGeneration));
          if (path.endsWith("/cancel"))
            return json(yield* funding.cancel(host, body.challengeId, body.expectedGeneration));
          return json(yield* funding.redeem(host, body.challengeId, body.expectedGeneration));
        }
        if (path === "/v1/extensions/funding/revoke") {
          const body = yield* decode(decoders.revoke);
          yield* matches(body.environmentId);
          return json(
            yield* service.funding[body.featureId].revokeByHost(host, body.expectedGeneration),
          );
        }
        if (path === "/v1/extensions/evaluation/status")
          return json(
            yield* service.evaluationStatus(host, yield* decode(decoders.evaluationStatus)),
          );
        if (path === "/v1/extensions/evaluate")
          return json(yield* service.evaluate(host, payload, "relevance"));
        if (path === "/v1/extensions/conflicts")
          return json(yield* service.evaluate(host, payload, "conflicts"));
        if (path === "/v1/extensions/equivalence")
          return json(yield* service.evaluate(host, payload, "equivalence"));
        if (path === "/v1/extensions/decisions")
          return json(yield* service.evaluate(host, payload, "decisions"));
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
      return handlers
        .handleRaw("status", () => handler)
        .handleRaw("challenge", () => handler)
        .handleRaw("approvalInfo", () => handler)
        .handleRaw("approve", () => handler)
        .handleRaw("observe", () => handler)
        .handleRaw("cancel", () => handler)
        .handleRaw("redeem", () => handler)
        .handleRaw("fundingStatus", () => handler)
        .handleRaw("revoke", () => handler)
        .handleRaw("accountStatus", () => handler)
        .handleRaw("accountList", () => handler)
        .handleRaw("accountRevoke", () => handler)
        .handleRaw("evaluationStatus", () => handler)
        .handleRaw("evaluate", () => handler)
        .handleRaw("conflicts", () => handler)
        .handleRaw("equivalence", () => handler)
        .handleRaw("decisions", () => handler);
    }),
  );
