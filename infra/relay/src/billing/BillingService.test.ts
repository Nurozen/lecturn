import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Effect } from "effect";
import type Stripe from "stripe";
import { makeBillingService } from "./BillingService.ts";
import { parseBillingConfig } from "./BillingConfig.ts";
import { BillingError, type BillingAccount, type BillingStore } from "./BillingStore.ts";
import type { StripeClient } from "./StripeClient.ts";

const config = parseBillingConfig({
  BILLING_MODE: "observe",
  BILLING_CHECKOUT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  STRIPE_MONTHLY_PRICE_ID: "price_month",
  STRIPE_ANNUAL_PRICE_ID: "price_year",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_test",
});
const session = (overrides: Partial<Stripe.Checkout.Session> = {}) =>
  ({
    id: "cs_test",
    status: "open",
    url: "https://checkout.stripe.com/test",
    customer: "cus_test",
    client_reference_id: "user_test",
    ...overrides,
  }) as Stripe.Checkout.Session;
const subscription = (overrides: Partial<Stripe.Subscription> = {}) =>
  ({
    id: "sub_test",
    status: "trialing",
    created: 1,
    trial_start: 1,
    trial_end: 9999999999,
    ended_at: null,
    cancel_at: null,
    cancel_at_period_end: false,
    default_payment_method: { id: "pm_test", type: "card" },
    items: {
      data: [{ price: { id: "price_month" }, quantity: 1, current_period_end: 9999999999 }],
    },
    ...overrides,
  }) as Stripe.Subscription;
function harness(initial: Partial<BillingAccount> = {}, overrides: Partial<StripeClient> = {}) {
  let account: BillingAccount = {
    user_id: "user_test",
    customer_id: null,
    deleted_at: null,
    generation: 1,
    lease_token: "lease",
    updated_at: 9999999999,
    state: {},
    ...initial,
  };
  const load = vi.fn(() => Effect.succeed(structuredClone(account)));
  const save = vi.fn((next: BillingAccount) =>
    Effect.sync(() => {
      account = structuredClone(next);
      return undefined;
    }),
  );
  const receipt = vi.fn<BillingStore["receipt"]>(() => Effect.succeed([]));
  const store: BillingStore = {
    load,
    save,
    receipt,
    acquire: () => Effect.succeed(structuredClone(account)),
    release: () => Effect.succeed([]),
    quotaUsed: () => Effect.succeed(0),
    byCustomer: () => Effect.succeed(account),
    tombstone: () => Effect.void,
    pending: () => Effect.succeed([]),
    attempted: () => Effect.succeed([]),
    complete: () => Effect.succeed([]),
    stale: () => Effect.succeed([account]),
    deferReconcile: () => Effect.succeed([]),
  };
  const stripe: StripeClient = {
    createCustomer: vi.fn(
      async () =>
        ({
          id: "cus_test",
          metadata: { clerk_user_id: "user_test" },
        }) as unknown as Stripe.Customer,
    ),
    retrieveCustomer: vi.fn(
      async () =>
        ({
          id: "cus_test",
          metadata: { clerk_user_id: "user_test" },
          invoice_settings: {},
        }) as unknown as Stripe.Customer,
    ),
    listSubscriptions: vi.fn(async () => []),
    createCheckout: vi.fn(async () => session()),
    retrieveCheckout: vi.fn(async () => session()),
    expireCheckout: vi.fn(async () => session({ status: "expired" })),
    createPortal: vi.fn(
      async () => ({ url: "https://billing.stripe.com/test" }) as Stripe.BillingPortal.Session,
    ),
    retrieveSubscription: vi.fn(async () => subscription()),
    listInvoices: vi.fn(async () => []),
    hasSuccessfulCardSetup: vi.fn(async () => true),
    cancelSubscription: vi.fn(async () => subscription({ status: "canceled" })),
    verifyWebhook: vi.fn(
      async () =>
        ({
          id: "evt_test",
          type: "customer.subscription.updated",
          data: { object: { customer: "cus_test" } },
        }) as Stripe.Event,
    ),
    ...overrides,
  };
  return {
    service: makeBillingService(config, store, stripe),
    store,
    stripe,
    account: () => account,
    load,
    save,
    receipt,
  };
}
const failureCode = <A>(effect: Effect.Effect<A, BillingError>) =>
  Effect.flip(effect).pipe(Effect.map((failure) => failure.code));

describe("BillingService", () => {
  it.live("disabled status and cron never query storage or Stripe", () =>
    Effect.gen(function* () {
      const h = harness();
      const service = makeBillingService(parseBillingConfig({}), h.store, h.stripe);
      expect((yield* service.status("user_test")).state).toBe("disabled");
      yield* service.processPending();
      expect(h.load).not.toHaveBeenCalled();
      expect(h.stripe.listSubscriptions).not.toHaveBeenCalled();
      expect(yield* failureCode(service.checkout("user_test", "month"))).toBe("disabled");
    }),
  );
  it.live("resumes one durable Checkout and does not create a second on repeated clicks", () =>
    Effect.gen(function* () {
      const h = harness();
      const first = yield* h.service.checkout("user_test", "month");
      const second = yield* h.service.checkout("user_test", "month");
      expect(first).toEqual(second);
      expect(h.stripe.createCustomer).toHaveBeenCalledTimes(1);
      expect(h.stripe.createCheckout).toHaveBeenCalledTimes(1);
      expect(h.account().state.operation?.trialEligible).toBe(true);
      expect(h.account().state).not.toHaveProperty("sessionUrl");
    }),
  );
  it.live("retries ambiguous customer creation using the same persisted idempotency key", () =>
    Effect.gen(function* () {
      const createCustomer = vi
        .fn<StripeClient["createCustomer"]>()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue({ id: "cus_test" } as Stripe.Customer);
      const h = harness({}, { createCustomer });
      expect(yield* failureCode(h.service.checkout("user_test", "year"))).toBe("provider");
      yield* h.service.checkout("user_test", "year");
      expect(createCustomer.mock.calls[0]?.[1]).toBe(createCustomer.mock.calls[1]?.[1]);
    }),
  );
  it.live("blocks another purchase for a recoverable or scheduled-cancellation subscription", () =>
    Effect.gen(function* () {
      const h = harness(
        { customer_id: "cus_test" },
        {
          listSubscriptions: async () => [
            subscription({ status: "past_due", cancel_at_period_end: true }),
          ],
          retrieveSubscription: async () =>
            subscription({ status: "past_due", cancel_at_period_end: true }),
        },
      );
      expect(yield* failureCode(h.service.checkout("user_test", "year"))).toBe(
        "existing_subscription",
      );
      expect(h.stripe.createCheckout).not.toHaveBeenCalled();
    }),
  );
  it.live("permits resubscription after confirmed termination but never gives another trial", () =>
    Effect.gen(function* () {
      const canceled = subscription({ status: "canceled", ended_at: 2 });
      const h = harness(
        { customer_id: "cus_test", state: { sessionId: "cs_old" } },
        {
          listSubscriptions: async () => [canceled],
          retrieveSubscription: async () => canceled,
          retrieveCheckout: async () => session({ id: "cs_old", status: "complete" }),
        },
      );
      yield* h.service.checkout("user_test", "year");
      expect(h.stripe.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ trialEligible: false }),
        expect.any(String),
      );
    }),
  );
  it.live(
    "does not recreate an ambiguous operation after Stripe's idempotency retention window",
    () =>
      Effect.gen(function* () {
        const h = harness({
          state: { operation: { id: "old", createdAt: 1, interval: "month", trialEligible: true } },
        });
        expect(yield* failureCode(h.service.checkout("user_test", "month"))).toBe(
          "recovery_required",
        );
        expect(h.stripe.createCustomer).not.toHaveBeenCalled();
      }),
  );
  it.live("rejects a checkout belonging to another customer before refreshing it", () =>
    Effect.gen(function* () {
      const h = harness(
        { customer_id: "cus_test", state: { sessionId: "cs_test" } },
        { retrieveCheckout: async () => session({ customer: "cus_other" }) },
      );
      expect(yield* failureCode(h.service.reconcile("user_test", "cs_test"))).toBe("ownership");
      expect(h.stripe.listSubscriptions).not.toHaveBeenCalled();
    }),
  );
  it.live(
    "deletion sweeps cancel every newly discovered subscription and expire open checkout",
    () =>
      Effect.gen(function* () {
        const h = harness(
          { customer_id: "cus_test", deleted_at: 1, state: { sessionId: "cs_test" } },
          {
            listSubscriptions: async () => [
              subscription({ id: "sub_first" }),
              subscription({ id: "sub_late" }),
            ],
          },
        );
        yield* h.service.processPending();
        expect(h.stripe.cancelSubscription).toHaveBeenCalledTimes(2);
        expect(h.stripe.expireCheckout).toHaveBeenCalledTimes(1);
        expect((yield* h.service.status("user_test")).hasAccess).toBe(false);
        expect(yield* failureCode(h.service.checkout("user_test", "month"))).toBe("deleted");
      }),
  );
  it.live("does not acknowledge a webhook when durable receipt fails", () =>
    Effect.gen(function* () {
      const h = harness();
      h.receipt.mockReturnValue(
        Effect.fail(new BillingError({ code: "persistence", message: "database unavailable" })),
      );
      expect(
        yield* failureCode(h.service.receiveStripeWebhook(new Uint8Array(), "signature")),
      ).toBe("persistence");
    }),
  );
  it.live("still cancels known renewals when ambiguous checkout recovery is too old", () =>
    Effect.gen(function* () {
      const h = harness(
        {
          customer_id: "cus_test",
          deleted_at: 1,
          state: { operation: { id: "old", createdAt: 1, interval: "month", trialEligible: true } },
        },
        { listSubscriptions: async () => [subscription()] },
      );
      yield* h.service.processPending();
      expect(h.stripe.cancelSubscription).toHaveBeenCalledWith("sub_test", expect.any(String));
      expect(h.stripe.createCheckout).not.toHaveBeenCalled();
    }),
  );
  it.live("attempts all cancellations even when the first fails", () =>
    Effect.gen(function* () {
      const cancelSubscription = vi
        .fn<StripeClient["cancelSubscription"]>()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue(subscription({ status: "canceled" }));
      const h = harness(
        { customer_id: "cus_test", deleted_at: 1 },
        {
          listSubscriptions: async () => [
            subscription({ id: "sub_first" }),
            subscription({ id: "sub_second" }),
          ],
          cancelSubscription,
        },
      );
      yield* h.service.processPending();
      expect(cancelSubscription).toHaveBeenCalledTimes(2);
    }),
  );
  it.live("does not project trial access for a card without successful setup", () =>
    Effect.gen(function* () {
      const h = harness(
        { customer_id: "cus_test" },
        {
          listSubscriptions: async () => [subscription()],
          hasSuccessfulCardSetup: async () => false,
        },
      );
      yield* h.service.processPending();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(false);
    }),
  );
});
