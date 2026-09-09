import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Effect, Clock, Fiber } from "effect";
import type Stripe from "stripe";
import type { PaymentReviewRecorder } from "./PaymentReviews.ts";
import { TestClock } from "effect/testing";
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
  const save = vi.fn((next: BillingAccount, time: number) =>
    Effect.sync(() => {
      account = { ...structuredClone(next), updated_at: time };
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
    listInvoicePayments: vi.fn(async () => []),
    retrieveCharge: vi.fn(
      async () =>
        ({
          id: "ch_test",
          customer: "cus_test",
          currency: "usd",
          paid: true,
          status: "succeeded",
          amount: 1000,
          amount_refunded: 0,
          refunded: false,
        }) as Stripe.Charge,
    ),
    listDisputes: vi.fn(async () => []),
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
  const recordPaymentReview = vi.fn<PaymentReviewRecorder>(() => Effect.void);
  return {
    recordPaymentReview,
    service: makeBillingService(config, store, stripe, recordPaymentReview),
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
      const service = makeBillingService(
        parseBillingConfig({}),
        h.store,
        h.stripe,
        h.recordPaymentReview,
      );
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

function paidInvoice(id: string, start: number, end: number, paidAt = start) {
  return {
    id,
    customer: "cus_test",
    parent: { subscription_details: { subscription: "sub_test" } },
    status: "paid",
    amount_paid: 1000,
    currency: "usd",
    status_transitions: { paid_at: paidAt },
    lines: {
      has_more: false,
      data: [
        {
          period: { start, end },
          parent: { subscription_item_details: { subscription: "sub_test", proration: false } },
          pricing: { price_details: { price: "price_month" } },
        },
      ],
    },
  } as Stripe.Invoice;
}
function paidHarness(invoices: Stripe.Invoice[], overrides: Partial<StripeClient> = {}) {
  const active = subscription({ status: "active", trial_start: null, trial_end: null });
  return harness(
    { customer_id: "cus_test" },
    {
      listSubscriptions: async () => [active],
      retrieveSubscription: async () => active,
      listInvoices: async () => invoices,
      listInvoicePayments: async (invoice) => [
        {
          id: `ip_${invoice}`,
          invoice,
          status: "paid",
          amount_paid: 1000,
          payment: { type: "charge", charge: `ch_${invoice}` },
        } as Stripe.InvoicePayment,
      ],
      retrieveCharge: async (id) =>
        ({
          id,
          customer: "cus_test",
          currency: "usd",
          paid: true,
          status: "succeeded",
          amount: 1000,
          amount_refunded: 0,
          refunded: false,
        }) as Stripe.Charge,
      ...overrides,
    },
  );
}

describe("canonical payment lifecycle", () => {
  it.live("grants settled service and retains the paid term origin", () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)]);
      yield* h.service.processPending();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(true);
      expect(h.account().state.accessWindowStart).toBe(time - 100);
    }),
  );
  it.live("revokes a fully refunded current term and cancels renewal idempotently", () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)], {
        retrieveCharge: async (id) =>
          ({
            id,
            customer: "cus_test",
            currency: "usd",
            paid: true,
            status: "succeeded",
            amount: 1000,
            amount_refunded: 1000,
            refunded: true,
          }) as Stripe.Charge,
      });
      yield* h.service.processPending();
      yield* h.service.processPending();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(false);
      expect(h.stripe.cancelSubscription).toHaveBeenNthCalledWith(
        1,
        "sub_test",
        "refund:sub_test:in_current",
      );
      expect(h.stripe.cancelSubscription).toHaveBeenNthCalledWith(
        2,
        "sub_test",
        "refund:sub_test:in_current",
      );
    }),
  );
  it.live(
    "does not revoke the new paid term for a historical refund or a partial current refund",
    () =>
      Effect.gen(function* () {
        const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const h = paidHarness(
          [
            paidInvoice("in_old", time - 200, time - 100),
            paidInvoice("in_current", time - 100, time + 100),
          ],
          {
            retrieveCharge: async (id) =>
              ({
                id,
                customer: "cus_test",
                currency: "usd",
                paid: true,
                status: "succeeded",
                amount: 1000,
                amount_refunded: id === "ch_in_old" ? 1000 : 500,
                refunded: id === "ch_in_old",
              }) as Stripe.Charge,
          },
        );
        yield* h.service.processPending();
        expect((yield* h.service.status("user_test")).hasAccess).toBe(true);
        expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
      }),
  );
  it.live("suspends a disputed current term and restores future access when won", () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      let won = false;
      const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)], {
        listDisputes: async (charge) => [
          { charge, status: won ? "won" : "under_review" } as Stripe.Dispute,
        ],
      });
      yield* h.service.processPending();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(false);
      won = true;
      yield* h.service.processPending();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(true);
      expect(h.account().state.accessWindowStart).toBeGreaterThanOrEqual(time);
      expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
    }),
  );
  it.live("ignores historical dispute for the current paid term", () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const h = paidHarness(
        [
          paidInvoice("in_old", time - 200, time - 100),
          paidInvoice("in_current", time - 100, time + 100),
        ],
        {
          listDisputes: async (charge) =>
            charge === "ch_in_old" ? [{ charge, status: "lost" } as Stripe.Dispute] : [],
        },
      );
      yield* h.service.processPending();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(true);
    }),
  );
  it.live(
    "routes dispute receipts through the canonical charge without retaining payment data",
    () =>
      Effect.gen(function* () {
        const h = harness(
          {},
          {
            verifyWebhook: async () =>
              ({
                id: "evt_dispute",
                livemode: true,
                type: "charge.dispute.closed",
                data: { object: { charge: "ch_test", evidence: { secret: "private" } } },
              }) as unknown as Stripe.Event,
          },
        );
        yield* h.service.receiveStripeWebhook(new Uint8Array(), "signature");
        expect(h.receipt).toHaveBeenCalledWith(
          {
            id: "stripe:live:evt_dispute",
            customer_id: "cus_test",
            user_id: null,
            kind: "charge.dispute.closed",
            object_id: "ch_test",
          },
          expect.any(Number),
        );
      }),
  );
});

describe("financial revocation failure safety", () => {
  it.live("keeps a refund revoked when provider cancellation must retry", () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)], {
        retrieveCharge: async (id) =>
          ({
            id,
            customer: "cus_test",
            currency: "usd",
            paid: true,
            status: "succeeded",
            amount: 1000,
            amount_refunded: 1000,
            refunded: true,
          }) as Stripe.Charge,
        cancelSubscription: async () => {
          throw new Error("temporary failure");
        },
      });
      yield* h.service.processPending();
      expect(h.account().state.accessUntil).toBeNull();
      expect(h.account().state.accessWindowStart).toBeNull();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(false);
    }),
  );
  it.live("refuses a charge belonging to a different customer", () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)], {
        retrieveCharge: async (id) =>
          ({
            id,
            customer: "cus_other",
            currency: "usd",
            paid: true,
            status: "succeeded",
            amount: 1000,
            amount_refunded: 0,
            refunded: false,
          }) as Stripe.Charge,
      });
      yield* h.service.processPending();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(false);
      expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
    }),
  );
});

it.live("preserves the confirmed trial window through uninterrupted first payment", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const active = subscription({
      status: "active",
      trial_start: time - 200,
      trial_end: time - 100,
    });
    const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)], {
      listSubscriptions: async () => [active],
      retrieveSubscription: async () => active,
    });
    yield* h.service.processPending();
    expect((yield* h.service.status("user_test")).hasAccess).toBe(true);
    expect(h.account().state.accessWindowStart).toBe(time - 200);
  }),
);

it.live("does not fetch financial details for invoices outside the continuity horizon", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const h = paidHarness([
      paidInvoice("in_current", time - 100, time + 100),
      ...Array.from({ length: 99 }, (_, index) =>
        paidInvoice(`in_old_${index}`, time - 1000000 - index * 100, time - 900000 - index * 100),
      ),
    ]);
    const listPayments = vi.fn(h.stripe.listInvoicePayments);
    h.stripe.listInvoicePayments = listPayments;
    yield* h.service.processPending();
    expect((yield* h.service.status("user_test")).hasAccess).toBe(true);
    expect(listPayments).toHaveBeenCalledExactlyOnceWith("in_current");
  }),
);

it.live("rejects ambiguous shared charges instead of ignoring invoice-level refunds", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)], {
      retrieveCharge: async (id) =>
        ({
          id,
          customer: "cus_test",
          currency: "usd",
          paid: true,
          status: "succeeded",
          amount: 2000,
          amount_refunded: 1000,
          refunded: false,
        }) as Stripe.Charge,
    });
    expect(yield* failureCode(h.service.checkout("user_test", "month"))).toBe("recovery_required");
    expect(h.account().state.accessUntil).toBeUndefined();
  }),
);

function controlledPromise<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it.effect("ends reconciliation before lease expiry and ignores a late provider response", () =>
  Effect.gen(function* () {
    const entered = controlledPromise<void>();
    const response = controlledPromise<Stripe.Customer>();
    const h = harness(
      { customer_id: "cus_test" },
      {
        retrieveCustomer: () => {
          entered.resolve(undefined);
          return response.promise;
        },
      },
    );
    const release = vi.fn(h.store.release);
    h.store.release = release;
    const fiber = yield* h.service
      .checkout("user_test", "month")
      .pipe(Effect.result, Effect.forkChild);
    yield* Effect.promise(() => entered.promise);
    yield* TestClock.adjust("91 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("provider");
    expect(release).toHaveBeenCalledTimes(1);
    response.resolve({
      id: "cus_test",
      metadata: { clerk_user_id: "user_test" },
      invoice_settings: {},
    } as unknown as Stripe.Customer);
    yield* Effect.promise(() => response.promise);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.stripe.createCheckout).not.toHaveBeenCalled();
  }),
);

it.live("a historical dispute receipt does not truncate current notification access", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const h = paidHarness([
      paidInvoice("in_old", time - 200, time - 100),
      paidInvoice("in_current", time - 100, time + 100),
    ]);
    h.store.pending = () =>
      Effect.succeed([
        {
          id: "evt_historical",
          customer_id: "cus_test",
          user_id: null,
          kind: "charge.dispute.closed",
          object_id: "ch_in_old",
        },
      ]);
    yield* h.service.processPending();
    expect((yield* h.service.status("user_test")).hasAccess).toBe(true);
    expect(h.account().state.financialWindowStart).toBeUndefined();
    expect(h.account().state.accessWindowStart).toBe(time - 200);
  }),
);

it.live(
  "a current-term dispute resolved before reconciliation still fences its interrupted window",
  () =>
    Effect.gen(function* () {
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)], {
        listDisputes: async (charge) => [{ charge, status: "won" } as Stripe.Dispute],
      });
      h.store.pending = () =>
        Effect.succeed([
          {
            id: "evt_current",
            customer_id: "cus_test",
            user_id: null,
            kind: "charge.dispute.closed",
            object_id: "ch_in_current",
          },
        ]);
      yield* h.service.processPending();
      expect((yield* h.service.status("user_test")).hasAccess).toBe(true);
      expect(h.account().state.accessWindowStart).toBeGreaterThanOrEqual(time);
    }),
);

it.live("durably records post-deletion settlement even when cancellation requires retry", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const h = harness(
      { customer_id: "cus_test", deleted_at: time - 10 },
      {
        listSubscriptions: async () => [subscription()],
        cancelSubscription: async () => {
          throw new Error("provider unavailable");
        },
        listInvoices: async () => [
          paidInvoice("in_before", time - 100, time + 100, time - 20),
          paidInvoice("in_after", time - 100, time + 100, time - 5),
          { ...paidInvoice("in_trial", time - 100, time + 100, time - 5), amount_paid: 0 },
        ],
      },
    );
    yield* h.service.processPending();
    expect(h.recordPaymentReview).toHaveBeenCalledExactlyOnceWith({
      invoiceId: "in_after",
      userId: "user_test",
      customerId: "cus_test",
      subscriptionId: "sub_test",
      amountPaid: 1000,
      currency: "usd",
      paidAt: time - 5,
      deletedAt: time - 10,
    });
  }),
);

it.live("groups all account receipts and preserves every dispute charge fence", () =>
  Effect.gen(function* () {
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const h = paidHarness([paidInvoice("in_current", time - 100, time + 100)]);
    h.store.pending = () =>
      Effect.succeed([
        {
          id: "old",
          user_id: "user_test",
          customer_id: "cus_test",
          kind: "charge.dispute.closed",
          object_id: "ch_in_old",
        },
        {
          id: "current",
          user_id: null,
          customer_id: "cus_test",
          kind: "charge.dispute.closed",
          object_id: "ch_in_current",
        },
      ]);
    const complete = vi.fn(h.store.complete);
    h.store.complete = complete;
    yield* h.service.processPending();
    expect(h.stripe.retrieveCustomer).toHaveBeenCalledTimes(1);
    expect(h.account().state.accessWindowStart).toBeGreaterThanOrEqual(time);
    expect(complete.mock.calls.map(([id]) => id)).toEqual(["old", "current"]);
  }),
);

it.live("failed reconciliation keeps all grouped receipts pending", () =>
  Effect.gen(function* () {
    const h = harness(
      { customer_id: "cus_test" },
      {
        retrieveCustomer: async () => {
          throw new Error("unavailable");
        },
      },
    );
    h.store.pending = () =>
      Effect.succeed([
        { id: "first", user_id: "user_test", customer_id: null, kind: "invoice.paid" },
        {
          id: "second",
          user_id: "user_test",
          customer_id: null,
          kind: "customer.subscription.updated",
        },
      ]);
    const complete = vi.fn(h.store.complete);
    const attempted = vi.fn(h.store.attempted);
    h.store.complete = complete;
    h.store.attempted = attempted;
    yield* h.service.processPending();
    expect(attempted.mock.calls.map(([id]) => id)).toEqual(["first", "second"]);
    expect(complete).not.toHaveBeenCalled();
  }),
);

it.live("stalled event accounts leave independent sweep slots and untouched queued work", () =>
  Effect.gen(function* () {
    const h = harness();
    const ids = ["event1", "event2", "event3", "stale1", "stale2", "stale3"];
    const accounts = new Map(
      ids.map((id) => [id, { ...h.account(), user_id: id, customer_id: id }]),
    );
    const entered = controlledPromise<void>();
    const gate = controlledPromise<Stripe.Customer>();
    const running: string[] = [];
    h.store.load = (id) => Effect.succeed(accounts.get(id)!);
    h.store.acquire = (id) => Effect.succeed(accounts.get(id)!);
    h.store.pending = () =>
      Effect.succeed(
        ids.slice(0, 3).map((id) => ({ id, user_id: id, customer_id: id, kind: "invoice.paid" })),
      );
    h.store.stale = () => Effect.succeed([...accounts.values()]);
    const deferred = vi.fn(h.store.deferReconcile);
    const attempted = vi.fn(h.store.attempted);
    h.store.deferReconcile = deferred;
    h.store.attempted = attempted;
    h.stripe.retrieveCustomer = async (id) => {
      running.push(id);
      if (running.length === 4) entered.resolve(undefined);
      return gate.promise;
    };
    const fiber = yield* h.service.processPending(20).pipe(Effect.forkChild);
    yield* Effect.promise(() => entered.promise);
    expect(running.toSorted()).toEqual(["event1", "event2", "stale1", "stale2"]);
    expect(deferred.mock.calls.map(([id]) => id).toSorted()).toEqual(running.toSorted());
    expect(attempted.mock.calls.map(([id]) => id).toSorted()).toEqual(["event1", "event2"]);
    yield* Fiber.interrupt(fiber);
    expect(deferred).toHaveBeenCalledTimes(4);
  }),
);
