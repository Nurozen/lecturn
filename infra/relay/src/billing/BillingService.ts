import { Context, Effect, Layer, Clock, DateTime } from "effect";
import type { RelayBillingStatus } from "@lecturn/contracts";
import type Stripe from "stripe";
import { canStartBillingCheckout, type BillingConfig } from "./BillingConfig.ts";
import {
  BillingError,
  makeBillingStore,
  operationId,
  type BillingAccount,
  type BillingEvent,
  type BillingStore,
} from "./BillingStore.ts";
import { createStripeClient, type StripeClient } from "./StripeClient.ts";
import {
  computeConnectEntitlement,
  connectedAccessWindowStart,
  type SettledServiceInterval,
} from "./ConnectEntitlements.ts";
import { stripeEventReceipt } from "./BillingWebhook.ts";
import { makePaymentReviews, type PaymentReviewRecorder } from "./PaymentReviews.ts";
import { effectiveAccountAccess } from "./BillingGrants.ts";
import { verifyAccountDeletion } from "./AccountDeletion.ts";

export { BillingError } from "./BillingStore.ts";
const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
const provider = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: () =>
      new BillingError({
        code: "provider",
        message: "Billing provider is temporarily unavailable",
      }),
  });
const error = (code: string, message: string) => new BillingError({ code, message });
const terminal = (s: Stripe.Subscription) =>
  s.status === "canceled" || s.status === "incomplete_expired";
const referenceId = (value: string | { id: string } | null) =>
  typeof value === "string" ? value : value?.id;
const iso = (seconds: number | null | undefined) =>
  seconds ? DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)) : null;

export interface BillingServiceShape {
  status(userId: string): Effect.Effect<RelayBillingStatus, BillingError>;
  checkout(
    userId: string,
    interval: "month" | "year",
  ): Effect.Effect<{ url: string }, BillingError>;
  portal(userId: string): Effect.Effect<{ url: string }, BillingError>;
  reconcile(userId: string, sessionId: string): Effect.Effect<RelayBillingStatus, BillingError>;
  receiveStripeWebhook(raw: Uint8Array, signature: string): Effect.Effect<void, BillingError>;
  receiveClerkWebhook(request: Request, signingSecret: string): Effect.Effect<void, BillingError>;
  processPending(limit?: number): Effect.Effect<void, BillingError>;
}
export class BillingService extends Context.Service<BillingService, BillingServiceShape>()(
  "lecturn-relay/billing/BillingService",
) {}

export function makeBillingService(
  config: BillingConfig,
  store: BillingStore,
  stripe: StripeClient,
  recordPaymentReview: PaymentReviewRecorder,
): BillingServiceShape {
  const enabled = () => config.mode !== "disabled";
  const assertEnabled = () =>
    enabled() ? Effect.void : Effect.fail(error("disabled", "Billing is not enabled"));
  const withAccount = <A>(
    userId: string,
    run: (account: BillingAccount) => Effect.Effect<A, BillingError>,
  ) =>
    Effect.gen(function* () {
      yield* assertEnabled();
      const account = yield* store.acquire(userId, yield* now);
      return yield* run(account).pipe(
        // Leave room to release the 120-second lease. Interrupted provider results cannot save later.
        Effect.timeoutOrElse({
          duration: "90 seconds",
          orElse: () =>
            Effect.fail(
              error("provider", "Billing reconciliation exceeded its budget and will retry"),
            ),
        }),
        Effect.ensuring(store.release(account).pipe(Effect.ignore)),
      );
    });
  const save = (a: BillingAccount) => now.pipe(Effect.flatMap((time) => store.save(a, time)));
  const ensureCustomer = Effect.fn("Billing.ensureCustomer")(function* (a: BillingAccount) {
    if (a.customer_id) return a.customer_id;
    if (!a.state.operation) return yield* error("state", "No durable customer operation exists");
    // Stripe removes idempotency keys after 24h. Ambiguous older writes require operator recovery.
    if ((yield* now) - a.state.operation.createdAt > 23 * 3600)
      return yield* error(
        "recovery_required",
        "Billing setup requires support to recover an interrupted operation",
      );
    const customer = yield* provider(() =>
      stripe.createCustomer({ ownerId: a.user_id }, `customer:${a.state.operation!.id}`),
    );
    a.customer_id = customer.id;
    yield* save(a);
    return customer.id;
  });
  const refresh = Effect.fn("Billing.refresh")(function* (
    a: BillingAccount,
    disputeChargeIds: readonly string[] = [],
  ) {
    if (!a.customer_id && a.deleted_at && a.state.operation) yield* ensureCustomer(a);
    if (!a.customer_id) {
      yield* save(a);
      return;
    }
    const customer = yield* provider(() => stripe.retrieveCustomer(a.customer_id!));
    if (customer.deleted || customer.metadata.clerk_user_id !== a.user_id)
      return yield* error("ownership", "Billing customer ownership could not be verified");
    const subscriptions = yield* provider(() => stripe.listSubscriptions(a.customer_id!));
    if (subscriptions.some((s) => s.trial_start !== null)) a.state.trialConsumed = true;
    if (a.deleted_at) {
      // Cancellation of known renewals is independent from uncertain Checkout recovery.
      let cancellationError: BillingError | undefined;
      for (const sub of subscriptions.filter((s) => !terminal(s))) {
        const result = yield* Effect.result(
          provider(() => stripe.cancelSubscription(sub.id, `delete:${a.user_id}:${sub.id}`)),
        );
        if (result._tag === "Failure") cancellationError = result.failure;
      }
      const compensation = yield* Effect.result(
        Effect.gen(function* () {
          if (!a.state.sessionId && a.state.operation) yield* createSession(a);
          if (a.state.sessionId) {
            const session = yield* provider(() => stripe.retrieveCheckout(a.state.sessionId!));
            if (session.status === "open")
              yield* provider(() =>
                stripe.expireCheckout(session.id, `delete:${a.user_id}:${session.id}`),
              );
          }
        }),
      );
      // A charge may settle after deletion raced Checkout or renewal. Preserve it for an
      // explicit operator refund review even when cancellation/Checkout recovery must retry.
      for (const sub of subscriptions) {
        const invoices = yield* provider(() => stripe.listInvoices(sub.id));
        for (const invoice of invoices) {
          const paidAt = invoice.status_transitions.paid_at;
          if (
            invoice.status !== "paid" ||
            invoice.amount_paid <= 0 ||
            paidAt === null ||
            paidAt < a.deleted_at
          )
            continue;
          if (
            referenceId(invoice.customer) !== a.customer_id ||
            referenceId(invoice.parent?.subscription_details?.subscription ?? null) !== sub.id
          )
            return yield* error(
              "ownership",
              "Post-deletion invoice ownership could not be verified",
            );
          yield* recordPaymentReview({
            invoiceId: invoice.id,
            userId: a.user_id,
            customerId: a.customer_id!,
            subscriptionId: sub.id,
            amountPaid: invoice.amount_paid,
            currency: invoice.currency,
            paidAt,
            deletedAt: a.deleted_at,
          });
        }
      }
      if (cancellationError) return yield* cancellationError;
      if (compensation._tag === "Failure") return yield* compensation.failure;
      a.state.status = "canceled";
      a.state.accessUntil = null;
      a.state.accessWindowStart = null;
      yield* save(a);
      return;
    }
    const current = subscriptions.filter((s) => !terminal(s));
    if (current.length > 1)
      return yield* error("recovery_required", "Multiple subscriptions require support review");
    const selected = current[0] ?? subscriptions.toSorted((a, b) => b.created - a.created)[0];
    if (!selected) {
      if (a.state.sessionId) {
        const pendingSession = yield* provider(() => stripe.retrieveCheckout(a.state.sessionId!));
        a.state.sessionComplete = pendingSession.status === "complete";
      }
      a.state.status = "free";
      a.state.accessUntil = null;
      a.state.accessWindowStart = null;
      yield* save(a);
      return;
    }
    const sub = yield* provider(() => stripe.retrieveSubscription(selected.id));
    if (
      sub.items.data.length !== 1 ||
      ![config.monthlyPriceId, config.annualPriceId].includes(sub.items.data[0]!.price.id) ||
      sub.items.data[0]!.quantity !== 1
    )
      return yield* error("recovery_required", "Subscription plan requires support review");
    const invoices = yield* provider(() => stripe.listInvoices(sub.id));
    const time = yield* now;
    const settled: SettledServiceInterval[] = [];
    // Only recent continuity can authorize a queued notification (maximum age ten minutes).
    const financialHorizon = time - 600 - config.renewalGraceSeconds;
    let suspended = false;
    let currentTermDisputeReceipt = false;
    let refundedCurrentTerm: string | undefined;
    for (const invoice of invoices) {
      if (invoice.status !== "paid" || invoice.amount_paid <= 0) continue;
      if (invoice.lines.has_more)
        return yield* error("recovery_required", "Invoice lines require support review");
      const terms = invoice.lines.data.filter(
        (line) =>
          line.parent?.subscription_item_details?.subscription === sub.id &&
          !line.parent.subscription_item_details.proration &&
          line.pricing?.price_details?.price === sub.items.data[0]!.price.id &&
          line.period.start <= time &&
          line.period.end > financialHorizon,
      );
      if (!terms.length) continue;
      const payments = yield* provider(() => stripe.listInvoicePayments(invoice.id));
      let captured = 0;
      let refunded = 0;
      let disputed = false;
      const seenCharges = new Set<string>();
      for (const payment of payments) {
        if (referenceId(payment.invoice) !== invoice.id || payment.status !== "paid")
          return yield* error("ownership", "Invoice payment ownership could not be verified");
        const intent = payment.payment.payment_intent;
        const chargeRef =
          payment.payment.charge ?? (typeof intent === "object" ? intent.latest_charge : undefined);
        const chargeId = chargeRef ? referenceId(chargeRef) : undefined;
        if (!chargeId)
          return yield* error("recovery_required", "Invoice payment requires support review");
        if (
          disputeChargeIds.includes(chargeId) &&
          terms.some((line) => line.period.start <= time && time < line.period.end)
        )
          currentTermDisputeReceipt = true;
        if (seenCharges.has(chargeId)) continue;
        seenCharges.add(chargeId);
        const charge = yield* provider(() => stripe.retrieveCharge(chargeId));
        if (referenceId(charge.customer) !== a.customer_id || charge.currency !== invoice.currency)
          return yield* error("ownership", "Invoice charge ownership could not be verified");
        if (charge.amount !== payment.amount_paid)
          return yield* error(
            "recovery_required",
            "Shared invoice charge allocation requires support review",
          );
        if (!charge.paid || charge.status !== "succeeded") continue;
        captured += Math.min(payment.amount_paid ?? 0, charge.amount);
        // Only a completely refunded charge removes its allocation. Partial refunds keep service.
        if (charge.refunded && charge.amount_refunded >= charge.amount)
          refunded += Math.min(payment.amount_paid ?? 0, charge.amount);
        const disputes = yield* provider(() => stripe.listDisputes(charge.id));
        if (disputes.some((dispute) => referenceId(dispute.charge) !== charge.id))
          return yield* error("ownership", "Dispute ownership could not be verified");
        disputed ||= disputes.some(
          (dispute) => !["won", "warning_closed", "prevented"].includes(dispute.status),
        );
      }
      if (captured < invoice.amount_paid)
        return yield* error("recovery_required", "Invoice settlement requires support review");
      const fullyRefunded = captured > 0 && refunded >= captured;
      const currentTerm = terms.some((line) => line.period.start <= time && time < line.period.end);
      if (currentTerm && fullyRefunded) refundedCurrentTerm = invoice.id;
      if (currentTerm && disputed) suspended = true;
      if (fullyRefunded || disputed) continue;
      const paidAt = invoice.status_transitions.paid_at;
      if (paidAt === null)
        return yield* error("recovery_required", "Invoice settlement time is missing");
      settled.push(...terms.map((line) => ({ ...line.period, settledAt: paidAt })));
    }
    const paidThrough =
      Math.max(
        0,
        ...settled
          .filter((period) => Math.max(period.start, period.settledAt) <= time)
          .map((period) => period.end),
      ) || null;
    if (refundedCurrentTerm && !terminal(sub)) {
      // Persist revocation before attempting provider cancellation; retries never restore refunded access.
      a.state.accessUntil = null;
      a.state.accessWindowStart = null;
      yield* save(a);
      yield* provider(() =>
        stripe.cancelSubscription(sub.id, `refund:${sub.id}:${refundedCurrentTerm}`),
      );
    }
    const payment = sub.default_payment_method;
    const customerPayment = customer.invoice_settings.default_payment_method;
    const card =
      typeof payment === "object" && payment?.type === "card"
        ? payment
        : typeof customerPayment === "object" && customerPayment?.type === "card"
          ? customerPayment
          : null;
    const trialCardConfirmed =
      sub.trial_start !== null && card !== null
        ? yield* provider(() => stripe.hasSuccessfulCardSetup(a.customer_id!, card.id))
        : false;
    const access = computeConnectEntitlement(
      {
        status: sub.status,
        paidThrough,
        trialEnd: sub.trial_end,
        trialCardConfirmed,
        cancelAt: sub.cancel_at,
        endedAt: sub.ended_at,
        suspended: suspended || !!refundedCurrentTerm,
      },
      time,
      config.renewalGraceSeconds,
    );
    a.state.status = sub.status;
    a.state.sessionComplete = !terminal(sub);
    a.state.interval = sub.items.data[0]!.price.id === config.monthlyPriceId ? "month" : "year";
    a.state.currentPeriodEnd = sub.items.data[0]!.current_period_end;
    a.state.trialEnd = sub.trial_end;
    a.state.cancelAtPeriodEnd = sub.cancel_at_period_end;
    a.state.cancelAt = sub.cancel_at;
    const windowStart = connectedAccessWindowStart(
      settled,
      trialCardConfirmed && sub.trial_start !== null && sub.trial_end !== null
        ? { start: sub.trial_start, end: sub.trial_end }
        : null,
      time,
      config.renewalGraceSeconds,
      access.reason === "grace",
    );
    if (currentTermDisputeReceipt || (a.state.suspended && !suspended))
      a.state.financialWindowStart = time;
    a.state.suspended = suspended;
    a.state.accessWindowStart =
      access.allowed && windowStart !== null
        ? Math.max(windowStart, a.state.financialWindowStart ?? 0)
        : null;
    a.state.accessUntil =
      access.allowed && a.state.accessWindowStart !== null ? access.validUntil : null;
    yield* save(a);
  });
  const createSession = Effect.fn("Billing.createSession")(function* (a: BillingAccount) {
    const operation = a.state.operation;
    if (!operation || !a.customer_id) return yield* error("state", "No pending checkout exists");
    if ((yield* now) - operation.createdAt > 23 * 3600)
      return yield* error(
        "recovery_required",
        "Checkout requires support to recover an interrupted operation",
      );
    const session = yield* provider(() =>
      stripe.createCheckout(
        {
          customerId: a.customer_id!,
          ownerId: a.user_id,
          priceId: operation.interval === "month" ? config.monthlyPriceId : config.annualPriceId,
          successUrl: `${config.appOrigin}/account/billing?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${config.appOrigin}/account/billing`,
          trialEligible: operation.trialEligible,
        },
        `checkout:${operation.id}`,
      ),
    );
    a.state.sessionId = session.id;
    yield* save(a);
    return session;
  });
  const status = Effect.fn("Billing.status")(function* (
    userId: string,
  ): Effect.fn.Return<RelayBillingStatus, BillingError> {
    const account = enabled() ? yield* store.load(userId) : undefined;
    const state = account?.state;
    const rawState = !enabled()
      ? "disabled"
      : account?.deleted_at
        ? "canceled"
        : (state?.status ?? "free");
    const publicState = ["disabled", "free", "trialing", "active", "past_due", "canceled"].includes(
      rawState,
    )
      ? (rawState as RelayBillingStatus["state"])
      : "unavailable";
    const access = effectiveAccountAccess(account, yield* now);
    const hasAccess = enabled() && access.allowed;
    return {
      trialEligible: !state?.trialConsumed,
      cancelAt: iso(state?.cancelAt),
      state: publicState,
      checkoutEnabled:
        canStartBillingCheckout(config, userId) &&
        !account?.deleted_at &&
        !state?.sessionComplete &&
        ["free", "canceled", "incomplete_expired"].includes(state?.status ?? "free"),
      portalEnabled: enabled() && !!account?.customer_id && !account?.deleted_at,
      interval: state?.interval ?? null,
      currentPeriodEnd: iso(state?.currentPeriodEnd),
      trialEnd: iso(state?.trialEnd),
      cancelAtPeriodEnd: state?.cancelAtPeriodEnd ?? false,
      hasAccess,
      accessReason: access.reason,
      accessUntil: iso(access.validUntil),
      features: {
        managedConnect: hasAccess,
        pushNotifications: hasAccess,
        liveActivities: hasAccess,
      },
      quota: { limit: access.limit, used: enabled() ? yield* store.quotaUsed(userId) : 0 },
    };
  });
  return {
    status,
    checkout: (userId, interval) => {
      if (!canStartBillingCheckout(config, userId))
        return Effect.fail(error("disabled", "Checkout is not enabled for this account"));
      return withAccount(
        userId,
        Effect.fn("Billing.checkout")(function* (a) {
          if (!config.checkoutEnabled) return yield* error("disabled", "Checkout is not enabled");
          if (a.deleted_at) return yield* error("deleted", "This account was deleted");
          yield* refresh(a);
          if (
            a.state.status &&
            !["free", "canceled", "incomplete_expired"].includes(a.state.status)
          )
            return yield* error(
              "existing_subscription",
              "Manage your existing subscription in the billing portal",
            );
          if (a.state.sessionId) {
            const existing = yield* provider(() => stripe.retrieveCheckout(a.state.sessionId!));
            if (
              existing.status === "complete" &&
              !["canceled", "incomplete_expired"].includes(a.state.status ?? "")
            )
              return yield* error(
                "pending",
                "Your completed checkout is being reconciled. Please refresh.",
              );
            if (
              existing.status === "open" &&
              a.state.operation?.interval === interval &&
              existing.url
            )
              return { url: existing.url };
            if (existing.status === "open")
              yield* provider(() => stripe.expireCheckout(existing.id, `expire:${existing.id}`));
            delete a.state.operation;
            delete a.state.sessionId;
            delete a.state.sessionComplete;
          }
          if (!a.state.operation) {
            a.state.operation = {
              id: yield* operationId,
              createdAt: yield* now,
              interval,
              trialEligible: !a.state.trialConsumed,
            };
            yield* save(a);
          }
          if (a.state.operation.interval !== interval)
            return yield* error(
              "pending",
              "Resume the pending checkout before changing its interval",
            );
          yield* ensureCustomer(a);
          const session = yield* createSession(a);
          if (!session.url || session.status !== "open")
            return yield* error("pending", "Checkout is being reconciled. Please refresh.");
          return { url: session.url };
        }),
      );
    },
    portal: (userId) =>
      withAccount(
        userId,
        Effect.fn("Billing.portal")(function* (a) {
          if (a.deleted_at || !a.customer_id)
            return yield* error("unavailable", "No billing account is available");
          const portalId = yield* operationId;
          const session = yield* provider(() =>
            stripe.createPortal(
              {
                customerId: a.customer_id!,
                returnUrl: `${config.appOrigin}/account/billing`,
                configurationId: config.portalConfigurationId,
              },
              `portal:${portalId}`,
            ),
          );
          return { url: session.url };
        }),
      ),
    reconcile: (userId, sessionId) =>
      withAccount(
        userId,
        Effect.fn("Billing.reconcile")(function* (a) {
          if (!a.customer_id || a.state.sessionId !== sessionId)
            return yield* error("ownership", "Checkout does not belong to this account");
          const session = yield* provider(() => stripe.retrieveCheckout(sessionId));
          if (
            referenceId(session.customer) !== a.customer_id ||
            session.client_reference_id !== userId
          )
            return yield* error("ownership", "Checkout does not belong to this account");
          yield* refresh(a);
          return yield* status(userId);
        }),
      ),
    receiveStripeWebhook: Effect.fn("Billing.receiveStripeWebhook")(function* (raw, signature) {
      yield* assertEnabled();
      const event = yield* Effect.tryPromise({
        try: () => stripe.verifyWebhook(raw, signature),
        catch: () => error("signature", "Stripe webhook signature or event scope is invalid"),
      });
      let routingCustomer: string | undefined;
      let routingObjectId: string | undefined;
      if (/^(refund\.|charge\.dispute\.)/.test(event.type)) {
        const object = event.data.object as Stripe.Refund | Stripe.Dispute;
        const chargeId = referenceId(object.charge);
        if (chargeId) {
          const charge = yield* provider(() => stripe.retrieveCharge(chargeId));
          routingCustomer = referenceId(charge.customer);
          routingObjectId = charge.id;
        }
      }
      const receipt = stripeEventReceipt(event, routingCustomer, routingObjectId);
      if (receipt) yield* store.receipt(receipt, yield* now);
    }),
    receiveClerkWebhook: Effect.fn("Billing.receiveClerkWebhook")(
      function* (request, signingSecret) {
        yield* assertEnabled();
        const event = yield* Effect.tryPromise({
          try: () => verifyAccountDeletion(request, signingSecret),
          catch: () => error("signature", "Clerk webhook signature is invalid"),
        });
        if (event) yield* store.tombstone(event.userId, yield* now, event.eventId);
      },
    ),
    processPending: Effect.fn("Billing.processPending")(function* (limit = 20) {
      if (!enabled()) return;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return yield* error("invalid", "Billing reconciliation batch must be 1 through 100");
      const time = yield* now;
      const [events, stale] = yield* Effect.all(
        [store.pending(limit, time), store.stale(time, limit)],
        { concurrency: 2 },
      );
      const groups = new Map<string, BillingEvent[]>();
      // Routing is bounded database work; provider calls start only after the per-user grouping.
      yield* Effect.forEach(
        events,
        (event) =>
          Effect.gen(function* () {
            const account = event.user_id
              ? yield* store.load(event.user_id)
              : event.customer_id
                ? yield* store.byCustomer(event.customer_id)
                : undefined;
            if (!account) {
              // Quarantine unknown customers with durable backoff, never grant from metadata.
              yield* store.attempted(event.id, yield* now);
              return;
            }
            const existing = groups.get(account.user_id);
            if (existing) existing.push(event);
            else groups.set(account.user_id, [event]);
          }),
        { concurrency: 4, discard: true },
      );
      const refreshGroup = (userId: string, receipts: readonly BillingEvent[]) =>
        Effect.gen(function* () {
          // Only started work is deferred. An interrupted batch leaves unscheduled users due.
          const startedAt = yield* now;
          yield* store.deferReconcile(userId, startedAt);
          for (const event of receipts) yield* store.attempted(event.id, startedAt);
          const disputeCharges = [
            ...new Set(
              receipts
                .filter((event) => event.kind.startsWith("charge.dispute.") && event.object_id)
                .map((event) => event.object_id!),
            ),
          ];
          yield* withAccount(userId, (account) => refresh(account, disputeCharges));
          for (const event of receipts) yield* store.complete(event.id, yield* now);
        }).pipe(
          Effect.catch(() => Effect.logWarning("Billing account reconciliation remains pending")),
        );
      const staleUsers = [...new Set(stale.map((account) => account.user_id))].filter(
        (userId) => !groups.has(userId),
      );
      // Separate lanes ensure two stalled event accounts cannot starve ordinary sweeps.
      // Each lane has two account slots: no more than four provider flows in flight.
      yield* Effect.all(
        [
          Effect.forEach([...groups], ([userId, receipts]) => refreshGroup(userId, receipts), {
            concurrency: 2,
            discard: true,
          }),
          Effect.forEach(staleUsers, (userId) => refreshGroup(userId, []), {
            concurrency: 2,
            discard: true,
          }),
        ],
        { concurrency: 2, discard: true },
      );
    }),
  };
}
export const layer = (config: BillingConfig) =>
  Layer.effect(
    BillingService,
    Effect.gen(function* () {
      const store = yield* makeBillingStore;
      // Disabled mode never calls the adapter or persistence; defer SDK construction until enabled.
      const stripe =
        config.mode === "disabled"
          ? ({} as StripeClient)
          : createStripeClient({
              secretKey: config.secretKey,
              webhookSecret: config.webhookSecret,
              livemode: config.livemode,
              ...(config.accountId ? { expectedAccountId: config.accountId } : {}),
              automaticTax: config.automaticTax ?? false,
              allowedPriceIds: [config.monthlyPriceId, config.annualPriceId],
            });
      const reviews = yield* makePaymentReviews;
      return BillingService.of(makeBillingService(config, store, stripe, reviews.record));
    }),
  );
