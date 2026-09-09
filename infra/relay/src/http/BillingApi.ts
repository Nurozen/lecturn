import { createClerkClient } from "@clerk/backend";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as FileSystem from "effect/FileSystem";
import { RelayBillingCheckoutRequest, RelayBillingReconcileRequest } from "@t3tools/contracts";
import { BillingService } from "../billing/BillingService.ts";
import { BillingError } from "../billing/BillingStore.ts";
import type { BillingConfig } from "../billing/BillingConfig.ts";
import { RelayConfiguration } from "../Config.ts";
import { verifyRelayClientBearerToken } from "./Api.ts";

const badRequest = () =>
  new BillingError({ code: "invalid_request", message: "Invalid billing request." });
const statusForCode = (code: string) => {
  if (code === "unauthorized") return 401;
  if (["origin", "unverified", "deleted", "ownership"].includes(code)) return 403;
  if (["invalid_request", "signature", "invalid_signature"].includes(code)) return 400;
  if (["busy", "stale", "existing_subscription", "pending", "recovery_required"].includes(code))
    return 409;
  return 503;
};
const json = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
export const requireBillingOrigin = (origin: string | undefined, expected: string) =>
  origin !== undefined && origin !== expected
    ? Effect.fail(
        new BillingError({
          code: "origin",
          message: "Billing must be managed from the Lecturn account page.",
        }),
      )
    : Effect.void;
const billingPrincipal = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  if (!token)
    return yield* new BillingError({ code: "unauthorized", message: "Sign in to manage billing." });
  const config = yield* RelayConfiguration;
  const verified = yield* verifyRelayClientBearerToken(config, token).pipe(
    Effect.mapError(
      () => new BillingError({ code: "unauthorized", message: "Sign in to manage billing." }),
    ),
  );
  return verified.sub;
});
const requireVerifiedEmail = Effect.fn("billing.require_verified_identity")(function* (
  userId: string,
) {
  const config = yield* RelayConfiguration;
  const user = yield* Effect.tryPromise({
    try: () =>
      createClerkClient({ secretKey: Redacted.value(config.clerkSecretKey) }).users.getUser(userId),
    catch: () =>
      new BillingError({
        code: "unavailable",
        message: "Account verification is temporarily unavailable.",
      }),
  });
  if (
    user.banned ||
    user.locked ||
    !user.emailAddresses.some((email) => email.verification?.status === "verified")
  ) {
    return yield* new BillingError({
      code: "unverified",
      message: "Verify your account email before starting a subscription.",
    });
  }
});
export function billingRoutes(config: BillingConfig, clerkWebhookSecret = "") {
  const accountRoute = (action: "status" | "checkout" | "portal" | "reconcile") =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const userId = yield* billingPrincipal;
      const service = yield* BillingService;
      if (action === "status") return json(yield* service.status(userId));
      yield* requireBillingOrigin(request.headers.origin, config.appOrigin);
      if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
        return yield* badRequest();
      if (action === "checkout") {
        const payload = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RelayBillingCheckoutRequest)),
          Effect.mapError(badRequest),
        );
        if (config.mode !== "observe" || !config.checkoutEnabled)
          return yield* new BillingError({
            code: "disabled",
            message: "Subscription checkout is not available.",
          });
        yield* requireVerifiedEmail(userId);
        return json(yield* service.checkout(userId, payload.interval));
      }
      if (action === "reconcile") {
        const payload = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RelayBillingReconcileRequest)),
          Effect.mapError(badRequest),
        );
        if (!/^cs_test_[A-Za-z0-9]+$/.test(payload.sessionId)) return yield* badRequest();
        return json(yield* service.reconcile(userId, payload.sessionId));
      }
      return json(yield* service.portal(userId));
    }).pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(16 * 1024)),
      Effect.catchTag("BillingError", (error) =>
        Effect.succeed(
          json({ code: error.code, message: error.message }, statusForCode(error.code)),
        ),
      ),
    );
  const stripeWebhook = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const signature = request.headers["stripe-signature"];
    if (!signature)
      return yield* new BillingError({ code: "signature", message: "Missing webhook signature." });
    const body = yield* request.arrayBuffer.pipe(Effect.mapError(badRequest));
    const service = yield* BillingService;
    yield* service.receiveStripeWebhook(new Uint8Array(body), signature);
    return json({ received: true });
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(512 * 1024)),
    Effect.catchTag("BillingError", (error) =>
      Effect.succeed(json({ code: error.code, message: error.message }, statusForCode(error.code))),
    ),
  );
  const clerkWebhook = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.arrayBuffer.pipe(Effect.mapError(badRequest));
    const service = yield* BillingService;
    const web = new Request(`${config.appOrigin}/v1/billing/webhooks/clerk`, {
      method: "POST",
      headers: request.headers,
      body,
    });
    yield* service.receiveClerkWebhook(web, clerkWebhookSecret);
    return json({ received: true });
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(512 * 1024)),
    Effect.catchTag("BillingError", (error) =>
      Effect.succeed(json({ code: error.code, message: error.message }, statusForCode(error.code))),
    ),
  );
  return Layer.unwrap(
    Effect.gen(function* () {
      const service = yield* BillingService;
      const settings = yield* RelayConfiguration;
      const provide = <A, E>(
        handler: Effect.Effect<
          A,
          E,
          BillingService | RelayConfiguration | HttpServerRequest.HttpServerRequest
        >,
      ) =>
        handler.pipe(
          Effect.provideService(BillingService, service),
          Effect.provideService(RelayConfiguration, settings),
        );
      return Layer.mergeAll(
        HttpRouter.add("GET", "/v1/billing/status", provide(accountRoute("status"))),
        HttpRouter.add("POST", "/v1/billing/checkout", provide(accountRoute("checkout"))),
        HttpRouter.add("POST", "/v1/billing/portal", provide(accountRoute("portal"))),
        HttpRouter.add(
          "POST",
          "/v1/billing/checkout/reconcile",
          provide(accountRoute("reconcile")),
        ),
        HttpRouter.add("POST", "/v1/billing/webhooks/stripe", provide(stripeWebhook)),
        HttpRouter.add("POST", "/v1/billing/webhooks/clerk", provide(clerkWebhook)),
      );
    }),
  );
}
