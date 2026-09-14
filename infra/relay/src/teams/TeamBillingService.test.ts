import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeTeamBillingService,
  type BillingTeam,
  type TeamBillingRepository,
} from "./TeamBillingService.ts";
import { InvalidTeamWebhookError, type TeamStripeClient } from "./TeamStripeClient.ts";
import { TeamError } from "./TeamStore.ts";
const config = {
  secretKey: "unused",
  webhookSecret: "unused",
  livemode: false,
  appOrigin: "https://example.com",
  monthlyPriceId: "month",
  annualPriceId: "year",
  portalConfigurationId: "portal",
};
function harness() {
  let account = {
    organization_id: "org_one",
    owner_user_id: "owner",
    customer_id: "cus_one",
    subscription_id: "sub_one",
    purchased_seats: 5,
    access_until: 9999999999,
    access_window_start: 1,
    current_period_end: 9999999999,
    interval: "month",
    pending_seats: null,
    billing_state: {},
    status: "active",
    suspended: false,
    generation: 0,
    billing_lease_owner: null,
    billing_lease_expires_at: 0,
    created_at: 1,
    updated_at: 1,
    policy: {},
    reconcile_after: 0,
  } as BillingTeam;
  let assigned = 3,
    locked = false,
    paid = true,
    capacity = 5;
  let pending: number | null = null;
  const calls: string[] = [];
  const repo: TeamBillingRepository = {
    acquire: () =>
      Effect.suspend(() => {
        if (locked) return Effect.fail(new TeamError({ code: "conflict", message: "busy" }));
        locked = true;
        return Effect.succeed(structuredClone(account));
      }),
    save: (a) =>
      Effect.sync(() => {
        account = structuredClone(a);
      }),
    release: () =>
      Effect.sync(() => {
        locked = false;
      }),
    assigned: () => Effect.succeed(assigned),
    due: () => Effect.succeed(["org_one"]),
    byCustomer: (customer) => Effect.succeed(customer === "cus_one" ? "org_one" : null),
    audit: () => Effect.void,
  };
  const stripe: TeamStripeClient = {
    customer: async () => "new",
    checkout: async () => ({ id: "cs_one", url: "https://checkout.example.com" }),
    checkoutStatus: async () => "open",
    expireCheckout: async () => {},
    subscription: async () => ({
      id: "sub_one",
      quantity: capacity,
      interval: "month",
      periodStart: 1,
      periodEnd: 9999999999,
      paid,
      suspended: false,
      pendingQuantity: pending,
    }),
    preview: async () => ({ amountDue: 1234, currency: "usd" }),
    increase: async () => {
      calls.push("increase");
    },
    decrease: async (_subscription, quantity) => {
      pending = quantity;
      calls.push("decrease");
    },
    cancelDecrease: async () => {
      if (pending !== null) calls.push("cancel_decrease");
      pending = null;
    },
    cancelSubscription: async () => {
      calls.push("cancel_subscription");
    },
    portal: async () => ({ url: "https://portal.example.com" }),
    webhook: async () => ({ id: "event", customer: "personal", kind: "invoice.paid" }),
  };
  return {
    service: makeTeamBillingService(config, repo, stripe),
    restart: () => makeTeamBillingService(config, repo, stripe),
    account: () => account,
    calls,
    setAssigned: (n: number) => {
      assigned = n;
    },
    settle: (n: number) => {
      capacity = n;
      paid = true;
    },
    unpaid: () => {
      paid = false;
    },
    stripe,
  };
}
describe("Teams seat billing", () => {
  for (const invalid of [true, false]) {
    it.effect(`classifies webhook ${invalid ? "validation" : "provider"} errors separately`, () =>
      Effect.gen(function* () {
        const h = harness();
        h.stripe.webhook = async () => {
          throw invalid
            ? new InvalidTeamWebhookError("Invalid signature")
            : new Error("Stripe unavailable");
        };
        const error = yield* Effect.flip(h.service.receiveWebhook(new Uint8Array(), "signature"));
        expect(error.code).toBe(invalid ? "forbidden" : "unavailable");
        expect(h.calls).toEqual([]);
      }),
    );
  }
  it.effect("failed prorated payment preserves old capacity until canonical payment settles", () =>
    Effect.gen(function* () {
      const h = harness();
      const preview = yield* h.service.preview("org_one", "owner", 8);
      h.unpaid();
      yield* h.service.confirm("org_one", "owner", preview.id);
      expect(h.account().purchased_seats).toBe(5);
      expect(h.calls).toEqual(["increase"]);
      h.settle(8);
      yield* h.service.reconcile("org_one");
      expect(h.account().purchased_seats).toBe(8);
      expect(h.account().billing_state.operation).toBeUndefined();
    }),
  );
  it.effect("rechecks assignments before confirming a reduction", () =>
    Effect.gen(function* () {
      const h = harness();
      h.settle(10);
      const preview = yield* h.service.preview("org_one", "owner", 5);
      h.setAssigned(6);
      const result = yield* Effect.result(h.service.confirm("org_one", "owner", preview.id));
      expect(result._tag).toBe("Failure");
      expect(h.calls).toEqual([]);
    }),
  );
  it.effect("reserves scheduled capacity without reducing current paid seats", () =>
    Effect.gen(function* () {
      const h = harness();
      h.settle(10);
      const preview = yield* h.service.preview("org_one", "owner", 5);
      yield* h.service.confirm("org_one", "owner", preview.id);
      expect(h.account().pending_seats).toBe(5);
      expect(h.account().purchased_seats).toBe(10);
      expect(h.calls).toEqual(["decrease"]);
    }),
  );
  it.effect("member cannot start checkout or edit seats", () =>
    Effect.gen(function* () {
      const h = harness();
      expect((yield* Effect.result(h.service.preview("org_one", "member", 8)))._tag).toBe(
        "Failure",
      );
      expect((yield* Effect.result(h.service.checkout("org_one", "member", "month", 5)))._tag).toBe(
        "Failure",
      );
    }),
  );
  it.effect("ignores personal customer webhooks", () =>
    Effect.gen(function* () {
      const h = harness();
      h.settle(9);
      yield* h.service.receiveWebhook(new Uint8Array(), "signature");
      expect(h.account().purchased_seats).toBe(5);
    }),
  );
  it.effect("rejects stale preview IDs and below-minimum purchases", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.service.preview("org_one", "owner", 7);
      expect((yield* Effect.result(h.service.confirm("org_one", "owner", "wrong")))._tag).toBe(
        "Failure",
      );
      expect((yield* Effect.result(h.service.checkout("org_one", "owner", "year", 2)))._tag).toBe(
        "Failure",
      );
    }),
  );
  it.effect("webhook completion clears a delayed operation and permits another preview", () =>
    Effect.gen(function* () {
      const h = harness();
      const preview = yield* h.service.preview("org_one", "owner", 8);
      h.unpaid();
      yield* h.service.confirm("org_one", "owner", preview.id);
      h.settle(8);
      h.stripe.webhook = async () => ({ id: "paid", customer: "cus_one", kind: "invoice.paid" });
      yield* h.service.receiveWebhook(new Uint8Array(), "signature");
      yield* h.service.receiveWebhook(new Uint8Array(), "signature");
      expect(h.account().billing_state.operation).toBeUndefined();
      expect((yield* h.service.preview("org_one", "owner", 9)).quantity).toBe(9);
    }),
  );
  it.effect("scheduled reconciliation clears a paid pending increase", () =>
    Effect.gen(function* () {
      const h = harness();
      const p = yield* h.service.preview("org_one", "owner", 8);
      h.unpaid();
      yield* h.service.confirm("org_one", "owner", p.id);
      h.settle(8);
      yield* h.service.processPending();
      expect((yield* h.service.preview("org_one", "owner", 9)).quantity).toBe(9);
    }),
  );
  it.effect("a restarted worker retries an unapplied increase with the original payment key", () =>
    Effect.gen(function* () {
      const h = harness();
      const p = yield* h.service.preview("org_one", "owner", 8);
      const attempts: { subscription: string; quantity: number; date: number; key: string }[] = [];
      h.stripe.increase = async (subscription, quantity, date, key) => {
        attempts.push({ subscription, quantity, date, key });
        if (attempts.length === 1) throw new Error("Stripe connection failed");
        h.settle(quantity);
      };
      expect((yield* Effect.result(h.service.confirm("org_one", "owner", p.id)))._tag).toBe(
        "Failure",
      );
      expect(h.account().billing_state.operation?.kind).toBe("confirm");
      yield* h.restart().processPending();
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(attempts[0]);
      expect(h.account().purchased_seats).toBe(8);
      expect(h.account().billing_state.operation).toBeUndefined();
      expect((yield* h.restart().preview("org_one", "owner", 9)).quantity).toBe(9);
    }),
  );
  it.effect("a restarted worker finishes an unapplied scheduled decrease", () =>
    Effect.gen(function* () {
      const h = harness();
      h.settle(10);
      const p = yield* h.service.preview("org_one", "owner", 5);
      const decrease = h.stripe.decrease;
      let attempts = 0;
      const keys: string[] = [];
      h.stripe.decrease = async (subscription, quantity, key) => {
        keys.push(key);
        if (++attempts === 1) throw new Error("Stripe connection failed");
        await decrease(subscription, quantity, key);
      };
      expect((yield* Effect.result(h.service.confirm("org_one", "owner", p.id)))._tag).toBe(
        "Failure",
      );
      expect(h.account().pending_seats).toBe(5);
      yield* h.restart().processPending();
      expect(keys).toEqual([`team-seats:${p.id}`, `team-seats:${p.id}`]);
      expect(h.calls).toEqual(["decrease"]);
      expect(h.account().billing_state.operation).toBeUndefined();
      expect(h.account().purchased_seats).toBe(10);
      expect(h.account().pending_seats).toBe(5);
    }),
  );
  it.effect("reconciliation retries failed schedule cancellation without purchasing seats", () =>
    Effect.gen(function* () {
      const h = harness();
      h.settle(10);
      const decrease = yield* h.service.preview("org_one", "owner", 5);
      yield* h.service.confirm("org_one", "owner", decrease.id);
      const cancel = yield* h.service.preview("org_one", "owner", 10);
      const cancelDecrease = h.stripe.cancelDecrease;
      let attempts = 0;
      h.stripe.cancelDecrease = async (subscription, key) => {
        if (++attempts === 1) throw new Error("Stripe connection failed");
        await cancelDecrease(subscription, key);
      };
      expect((yield* Effect.result(h.service.confirm("org_one", "owner", cancel.id)))._tag).toBe(
        "Failure",
      );
      yield* h.restart().processPending();
      expect(h.calls).toEqual(["decrease", "cancel_decrease"]);
      expect(h.account().pending_seats).toBeNull();
      expect(h.account().billing_state.operation).toBeUndefined();
    }),
  );
  it.effect("recovery reconciles an applied increase before attempting another payment", () =>
    Effect.gen(function* () {
      const h = harness();
      const p = yield* h.service.preview("org_one", "owner", 8);
      let attempts = 0;
      h.stripe.increase = async (_subscription, quantity) => {
        attempts++;
        h.settle(quantity);
        throw new Error("Response lost after Stripe applied the increase");
      };
      yield* Effect.result(h.service.confirm("org_one", "owner", p.id));
      h.account().billing_state.operation!.createdAt = -100000;
      yield* h.restart().processPending();
      expect(attempts).toBe(1);
      expect(h.account().purchased_seats).toBe(8);
      expect(h.account().billing_state.operation).toBeUndefined();
    }),
  );
  for (const scenario of ["expired", "replacement", "renewed", "suspended"] as const) {
    it.effect(`does not replay a confirmation when its subscription is ${scenario}`, () =>
      Effect.gen(function* () {
        const h = harness();
        const p = yield* h.service.preview("org_one", "owner", 8);
        let attempts = 0;
        h.stripe.increase = async () => {
          attempts++;
          throw new Error("Stripe connection failed");
        };
        yield* Effect.result(h.service.confirm("org_one", "owner", p.id));
        if (scenario === "expired") h.account().billing_state.operation!.createdAt = -100000;
        const subscription = h.stripe.subscription;
        h.stripe.subscription = async (customer) => {
          const value = (await subscription(customer))!;
          return {
            ...value,
            ...(scenario === "replacement" ? { id: "sub_replacement" } : {}),
            ...(scenario === "renewed" ? { periodEnd: value.periodEnd + 1000 } : {}),
            ...(scenario === "suspended" ? { paid: false, suspended: true } : {}),
          };
        };
        yield* h.restart().processPending();
        expect(attempts).toBe(1);
        expect(h.account().billing_state.operation?.id).toBe(p.id);
        expect(h.account().purchased_seats).toBe(5);
      }),
    );
  }
  it.effect("a scheduled decrease can be canceled while retaining the paid seats", () =>
    Effect.gen(function* () {
      const h = harness();
      h.settle(10);
      let p = yield* h.service.preview("org_one", "owner", 5);
      yield* h.service.confirm("org_one", "owner", p.id);
      p = yield* h.service.preview("org_one", "owner", 10);
      expect(p.amountDue).toBe(0);
      yield* h.service.confirm("org_one", "owner", p.id);
      expect(h.account().pending_seats).toBeNull();
      expect(h.account().purchased_seats).toBe(10);
      expect(h.calls).toEqual(["decrease", "cancel_decrease"]);
    }),
  );
  it.effect("increasing seats releases a previous decrease before initiating payment", () =>
    Effect.gen(function* () {
      const h = harness();
      h.settle(10);
      let p = yield* h.service.preview("org_one", "owner", 5);
      yield* h.service.confirm("org_one", "owner", p.id);
      p = yield* h.service.preview("org_one", "owner", 12);
      h.unpaid();
      yield* h.service.confirm("org_one", "owner", p.id);
      expect(h.calls).toEqual(["decrease", "cancel_decrease", "increase"]);
      expect(h.account().purchased_seats).toBe(10);
      expect(h.account().pending_seats).toBeNull();
    }),
  );
  it.effect("rejects purchases beyond the configured organization capacity", () =>
    Effect.gen(function* () {
      const h = harness();
      expect((yield* Effect.result(h.service.preview("org_one", "owner", 21)))._tag).toBe(
        "Failure",
      );
      expect((yield* Effect.result(h.service.checkout("org_one", "owner", "month", 21)))._tag).toBe(
        "Failure",
      );
    }),
  );
  it.effect("deleted organizations cancel Stripe and can never regain access", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.service.closeOrganization("org_one");
      expect(h.calls).toContain("cancel_subscription");
      expect(h.account().status).toBe("deleted");
      h.settle(20);
      yield* h.service.processPending();
      expect(h.account().purchased_seats).toBe(0);
      expect(h.account().access_until).toBeNull();
      expect((yield* Effect.result(h.service.preview("org_one", "owner", 6)))._tag).toBe("Failure");
    }),
  );
  it.effect("an expired checkout is replaced even after its idempotency horizon", () =>
    Effect.gen(function* () {
      const h = harness();
      h.stripe.subscription = async () => null;
      yield* h.service.checkout("org_one", "owner", "month", 5);
      const old = h.account().billing_state.operation!.id;
      h.account().billing_state.operation!.createdAt = -100000;
      h.stripe.checkoutStatus = async () => "expired";
      yield* h.service.checkout("org_one", "owner", "year", 7);
      expect(h.account().billing_state.operation!.id).not.toBe(old);
      expect(h.account().billing_state.operation!.quantity).toBe(7);
      expect(h.account().billing_state.operation!.interval).toBe("year");
    }),
  );
  it.effect("changing checkout selection expires and verifies the previous session", () =>
    Effect.gen(function* () {
      const h = harness();
      h.stripe.subscription = async () => null;
      let state: "open" | "expired" = "open";
      h.stripe.checkoutStatus = async () => state;
      h.stripe.expireCheckout = async () => {
        state = "expired";
        h.calls.push("expire_checkout");
      };
      yield* h.service.checkout("org_one", "owner", "month", 5);
      yield* h.service.checkout("org_one", "owner", "month", 8);
      expect(h.calls).toEqual(["expire_checkout"]);
      expect(h.account().billing_state.operation!.quantity).toBe(8);
    }),
  );
});
