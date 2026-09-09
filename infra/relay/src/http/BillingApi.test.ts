import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createClerkClient, verifyToken } from "@clerk/backend";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { makeRelayCors } from "./Api.ts";
import { billingRoutes } from "./BillingApi.ts";
import { parseBillingConfig } from "../billing/BillingConfig.ts";
import { BillingService, type BillingServiceShape } from "../billing/BillingService.ts";
import { BillingError } from "../billing/BillingStore.ts";
import { RelayConfiguration } from "../Config.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));
const config = parseBillingConfig({});
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
const disabledStatus = {
  state: "disabled" as const,
  trialEligible: true,
  cancelAt: null,
  checkoutEnabled: false,
  portalEnabled: false,
  interval: null,
  currentPeriodEnd: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  hasAccess: false,
  features: { managedConnect: false, pushNotifications: false, liveActivities: false },
  quota: { limit: 3, used: 0 },
};
const makeService = (overrides: Partial<BillingServiceShape> = {}): BillingServiceShape => ({
  status: () => Effect.succeed(disabledStatus),
  checkout: () => Effect.succeed({ url: "https://checkout.stripe.com/test" }),
  portal: () => Effect.succeed({ url: "https://billing.stripe.com/test" }),
  reconcile: () => Effect.succeed(disabledStatus),
  receiveStripeWebhook: () => Effect.void,
  receiveClerkWebhook: () => Effect.void,
  processPending: () => Effect.void,
  ...overrides,
});
const run = (request: Request, service = makeService(), activeConfig = config) =>
  Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(
      Layer.merge(
        billingRoutes(activeConfig, "whsec_test"),
        makeRelayCors(activeConfig.appOrigin),
      ).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(BillingService, service),
            Layer.succeed(RelayConfiguration, settings),
          ),
        ),
      ),
    );
    const response = yield* handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
    );
    return HttpServerResponse.toWeb(response);
  });
const auth = () => {
  vi.mocked(verifyToken).mockResolvedValue({ sub: "user_verified", aud: "relay" } as never);
};
const post = (path: string, payload: unknown, origin = config.appOrigin) =>
  new Request("https://relay.test/v1/billing/" + path, {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json", origin },
    body: JSON.stringify(payload),
  });
describe("billing HTTP boundary", () => {
  it.effect("billing preflight only permits the account origin", () =>
    Effect.gen(function* () {
      const allowed = yield* run(
        new Request("https://relay.test/v1/billing/checkout", {
          method: "OPTIONS",
          headers: { origin: config.appOrigin },
        }),
      );
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-origin")).toBe(config.appOrigin);
      const denied = yield* run(
        new Request("https://relay.test/v1/billing/checkout", {
          method: "OPTIONS",
          headers: { origin: "https://attacker.test" },
        }),
      );
      expect(denied.status).toBe(403);
      expect(denied.headers.has("access-control-allow-origin")).toBe(false);
    }),
  );
  it.effect("requires Clerk identity even for status", () =>
    Effect.gen(function* () {
      const response = yield* run(new Request("https://relay.test/v1/billing/status"));
      expect(response.status).toBe(401);
    }),
  );
  it.effect("uses verified subject and disables caching", () =>
    Effect.gen(function* () {
      auth();
      const status = vi.fn(() => Effect.succeed(disabledStatus));
      const response = yield* run(
        new Request("https://relay.test/v1/billing/status", {
          headers: { authorization: "Bearer test" },
        }),
        makeService({ status }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(status).toHaveBeenCalledWith("user_verified");
    }),
  );
  it.effect("rejects cross-origin billing mutations", () =>
    Effect.gen(function* () {
      auth();
      const portal = vi.fn(() => Effect.succeed({ url: "https://billing.stripe.com/test" }));
      expect(
        (yield* run(post("portal", {}, "https://attacker.test"), makeService({ portal }))).status,
      ).toBe(403);
      expect(portal).not.toHaveBeenCalled();
    }),
  );
  it.effect("rejects malformed intervals before Checkout", () =>
    Effect.gen(function* () {
      auth();
      expect((yield* run(post("checkout", { interval: "day" }))).status).toBe(400);
    }),
  );
  it.effect("disabled checkout cannot create a session", () =>
    Effect.gen(function* () {
      auth();
      const checkout = vi.fn(() => Effect.succeed({ url: "https://checkout.stripe.com/test" }));
      expect(
        (yield* run(post("checkout", { interval: "month" }), makeService({ checkout }))).status,
      ).toBe(503);
      expect(checkout).not.toHaveBeenCalled();
    }),
  );
  it.effect("requires a verified email before enabled checkout", () =>
    Effect.gen(function* () {
      auth();
      vi.mocked(createClerkClient).mockReturnValue({
        users: {
          getUser: vi.fn().mockResolvedValue({ banned: false, locked: false, emailAddresses: [] }),
        },
      } as never);
      const checkout = vi.fn(() => Effect.succeed({ url: "https://checkout.stripe.com/test" }));
      expect(
        (yield* run(post("checkout", { interval: "month" }), makeService({ checkout }), {
          ...config,
          mode: "observe",
          checkoutEnabled: true,
        })).status,
      ).toBe(403);
      expect(checkout).not.toHaveBeenCalled();
    }),
  );
  it.effect("requires a Stripe signature without Clerk auth", () =>
    Effect.gen(function* () {
      expect(
        (yield* run(
          new Request("https://relay.test/v1/billing/webhooks/stripe", {
            method: "POST",
            body: "{}",
          }),
        )).status,
      ).toBe(400);
    }),
  );
  it.effect("passes exact raw bytes to durable webhook ingestion", () =>
    Effect.gen(function* () {
      const receipt = vi.fn(() => Effect.void);
      const raw = '{ "id" : "evt_test" }\n';
      const response = yield* run(
        new Request("https://relay.test/v1/billing/webhooks/stripe", {
          method: "POST",
          headers: { "stripe-signature": "signature" },
          body: raw,
        }),
        makeService({ receiveStripeWebhook: receipt }),
      );
      expect(response.status).toBe(200);
      expect(receipt).toHaveBeenCalledWith(new TextEncoder().encode(raw), "signature");
    }),
  );
  it.effect("never acknowledges failed persistence", () =>
    Effect.gen(function* () {
      const response = yield* run(
        new Request("https://relay.test/v1/billing/webhooks/stripe", {
          method: "POST",
          headers: { "stripe-signature": "signature" },
          body: "{}",
        }),
        makeService({
          receiveStripeWebhook: () =>
            Effect.fail(new BillingError({ code: "persistence", message: "Unavailable" })),
        }),
      );
      expect(response.status).toBe(503);
    }),
  );
});
