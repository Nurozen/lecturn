import { Clock, Context, Effect, Schema } from "effect";
import { operationId } from "../billing/BillingStore.ts";
import { RelayDb } from "../db.ts";
import { TeamError, type TeamAccount } from "./TeamStore.ts";
import {
  InvalidTeamWebhookError,
  type TeamBillingConfig,
  type TeamStripeClient,
} from "./TeamStripeClient.ts";
export interface TeamBillingOperation {
  id: string;
  kind: "checkout" | "preview" | "confirm";
  createdAt: number;
  quantity: number;
  interval: "month" | "year";
  prorationDate: number;
  baselineQuantity?: number;
  subscriptionId?: string;
  periodEnd?: number;
  action?: "increase" | "decrease" | "cancel_decrease";
  amountDue?: number;
  currency?: string;
  sessionId?: string;
  url?: string;
}
export interface TeamBillingState extends Record<string, unknown> {
  operation?: TeamBillingOperation;
}
export interface BillingTeam extends TeamAccount {
  billing_state: TeamBillingState;
}
const fail = (message: string) => new TeamError({ code: "conflict", message });
const unavailable = () =>
  new TeamError({ code: "unavailable", message: "Team billing is temporarily unavailable" });
const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
export interface TeamBillingRepository {
  acquire(org: string, time: number): Effect.Effect<BillingTeam, TeamError>;
  save(account: BillingTeam, time: number): Effect.Effect<void, TeamError>;
  release(account: BillingTeam): Effect.Effect<void, TeamError>;
  assigned(org: string): Effect.Effect<number, TeamError>;
  due(time: number): Effect.Effect<readonly string[], TeamError>;
  byCustomer(customer: string): Effect.Effect<string | null, TeamError>;
  audit(org: string, actor: string, action: string): Effect.Effect<void, TeamError>;
}
export const makeTeamBillingRepository = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const query = <A, E>(e: Effect.Effect<A, E>) => e.pipe(Effect.mapError(unavailable));
  return {
    acquire: (org: string, time: number) =>
      Effect.gen(function* () {
        const rows = yield* query(
          sql<BillingTeam>`UPDATE relay_team_accounts SET billing_lease_owner=${yield* operationId},billing_lease_expires_at=${time + 120},reconcile_after=${time + 300},generation=generation+1 WHERE organization_id=${org} AND billing_lease_expires_at<=${time} RETURNING *`,
        );
        if (!rows[0])
          return yield* fail(
            "Another billing operation is running or the organization does not exist",
          );
        return rows[0];
      }),
    save: (a: BillingTeam, time: number) =>
      Effect.gen(function* () {
        const rows = yield* query(
          sql`UPDATE relay_team_accounts SET customer_id=${a.customer_id},subscription_id=${a.subscription_id},purchased_seats=${a.purchased_seats},access_until=${a.access_until},access_window_start=${a.access_window_start},current_period_end=${a.current_period_end},interval=${a.interval},pending_seats=${a.pending_seats},billing_state=${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(a.billing_state).pipe(Effect.mapError(unavailable))}::jsonb,suspended=${a.suspended},status=${a.status},updated_at=${time} WHERE organization_id=${a.organization_id} AND generation=${a.generation} AND billing_lease_owner=${a.billing_lease_owner} AND billing_lease_expires_at>${time} RETURNING organization_id`,
        );
        if (!rows.length) return yield* fail("Team changed; refresh before continuing");
      }),
    release: (a: BillingTeam) =>
      query(
        sql`UPDATE relay_team_accounts SET billing_lease_owner=NULL,billing_lease_expires_at=0 WHERE organization_id=${a.organization_id} AND billing_lease_owner=${a.billing_lease_owner}`,
      ).pipe(Effect.asVoid),
    assigned: (org: string) =>
      query(
        sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM relay_team_seats WHERE organization_id=${org}`,
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    due: (time: number) =>
      query(
        sql<{
          organization_id: string;
        }>`SELECT organization_id FROM relay_team_accounts WHERE customer_id IS NOT NULL AND reconcile_after<=${time} AND updated_at<${time - 300} ORDER BY updated_at LIMIT 20`,
      ).pipe(Effect.map((rows) => rows.map((row) => row.organization_id))),
    byCustomer: (customer: string) =>
      query(
        sql<{
          organization_id: string;
        }>`SELECT organization_id FROM relay_team_accounts WHERE customer_id=${customer}`,
      ).pipe(Effect.map((rows) => rows[0]?.organization_id ?? null)),
    audit: (org: string, actor: string, action: string) =>
      Effect.gen(function* () {
        yield* query(
          sql`INSERT INTO relay_team_audit(id,organization_id,actor_user_id,action,created_at) VALUES (${yield* operationId},${org},${actor},${action},${yield* now})`,
        );
      }),
  } satisfies TeamBillingRepository;
});
export function makeTeamBillingService(
  config: TeamBillingConfig,
  store: TeamBillingRepository,
  stripe: TeamStripeClient,
  onAccessChanged: (organizationId: string) => Effect.Effect<void, TeamError> = () => Effect.void,
) {
  const provider = <A>(call: () => Promise<A>) =>
    Effect.tryPromise({ try: call, catch: unavailable });
  const save = (a: BillingTeam) => now.pipe(Effect.flatMap((time) => store.save(a, time)));
  const withAccount = <A>(org: string, run: (a: BillingTeam) => Effect.Effect<A, TeamError>) =>
    Effect.gen(function* () {
      const a = yield* store.acquire(org, yield* now);
      return yield* run(a).pipe(
        Effect.timeoutOrElse({ duration: "90 seconds", orElse: () => Effect.fail(unavailable()) }),
        Effect.ensuring(store.release(a).pipe(Effect.ignore)),
      );
    });
  const owner = (a: BillingTeam, actor: string) =>
    a.owner_user_id === actor && a.status !== "deleted"
      ? Effect.void
      : Effect.fail(
          new TeamError({ code: "forbidden", message: "Only the team owner can manage billing" }),
        );
  const quantity = (seats: number) =>
    Number.isSafeInteger(seats) &&
    seats >= (config.minimumSeats ?? 5) &&
    seats <= (config.maximumSeats ?? 20)
      ? Effect.void
      : Effect.fail(
          fail(`Choose ${config.minimumSeats ?? 5} through ${config.maximumSeats ?? 20} seats`),
        );
  const refresh = Effect.fn("TeamBilling.refresh")(function* (a: BillingTeam) {
    if (!a.customer_id) return a;
    const subscription = yield* provider(() => stripe.subscription(a.customer_id!));
    if (a.status === "deleted") {
      a.suspended = true;
      a.purchased_seats = 0;
      a.access_until = null;
      a.pending_seats = null;
      a.billing_state = {};
      yield* save(a);
      yield* onAccessChanged(a.organization_id);
      if (subscription)
        yield* provider(() =>
          stripe.cancelSubscription(
            subscription.id,
            `team-delete:${a.organization_id}:${subscription.id}`,
          ),
        );
      return a;
    }
    if (!subscription) {
      a.subscription_id = null;
      a.purchased_seats = 0;
      a.access_until = null;
      a.status = "free";
    } else {
      a.subscription_id = subscription.id;
      a.interval = subscription.interval;
      a.current_period_end = subscription.periodEnd;
      a.suspended = subscription.suspended;
      // Failed prorations preserve already-paid capacity until its original expiry.
      if (subscription.paid) {
        a.purchased_seats = subscription.quantity;
        a.access_until = subscription.periodEnd;
        a.access_window_start = subscription.periodStart;
        a.status = "active";
        a.pending_seats = subscription.pendingQuantity;
      } else if (subscription.suspended) {
        a.access_until = null;
        a.status = "suspended";
      } else a.status = "payment_pending";
    }
    const operation = a.billing_state.operation;
    if (
      subscription &&
      operation?.kind === "confirm" &&
      operation.action === "decrease" &&
      subscription.pendingQuantity !== operation.quantity &&
      subscription.quantity !== operation.quantity
    )
      a.pending_seats = Math.min(a.pending_seats ?? a.purchased_seats, operation.quantity);
    if (
      subscription &&
      operation &&
      (operation.kind === "checkout" ||
        (operation.kind === "confirm" &&
          ((operation.action === "cancel_decrease" && subscription.pendingQuantity === null) ||
            (operation.action === "decrease" &&
              subscription.pendingQuantity === operation.quantity) ||
            (operation.action !== "cancel_decrease" &&
              subscription.paid &&
              subscription.quantity === operation.quantity))))
    )
      a.billing_state = {};
    yield* save(a);
    yield* onAccessChanged(a.organization_id);
    return a;
  });
  const applyConfirmation = Effect.fn("TeamBilling.applyConfirmation")(function* (
    a: BillingTeam,
    op: TeamBillingOperation,
  ) {
    if (
      !a.subscription_id ||
      (op.subscriptionId !== undefined && op.subscriptionId !== a.subscription_id) ||
      (op.periodEnd !== undefined && op.periodEnd !== a.current_period_end)
    )
      return yield* fail("The subscription changed; this seat change requires support recovery");
    if (op.quantity < (yield* store.assigned(a.organization_id)))
      return yield* fail("Unassign seats before reducing capacity");
    const increase = op.quantity > (op.baselineQuantity ?? a.purchased_seats);
    if (increase || op.action === "cancel_decrease") {
      yield* provider(() =>
        stripe.cancelDecrease(a.subscription_id!, `team-schedule-release:${op.id}`),
      );
      a.pending_seats = null;
      yield* save(a);
    }
    if (increase)
      yield* provider(() =>
        stripe.increase(a.subscription_id!, op.quantity, op.prorationDate, `team-seats:${op.id}`),
      );
    else if (op.action !== "cancel_decrease")
      yield* provider(() =>
        stripe.decrease(a.subscription_id!, op.quantity, `team-seats:${op.id}`),
      );
  });
  const reconcileAccount = Effect.fn("TeamBilling.reconcileAccount")(function* (a: BillingTeam) {
    // Read canonical state first: a lost response may have already applied the change.
    yield* refresh(a);
    const op = a.billing_state.operation;
    if (op?.kind !== "confirm" || a.status === "deleted" || a.suspended) return a;
    // Never replay onto a replacement subscription, another term, or an expired Stripe key.
    if (
      (yield* now) - op.createdAt > 23 * 3600 ||
      op.subscriptionId !== a.subscription_id ||
      op.periodEnd !== a.current_period_end
    )
      return a;
    yield* applyConfirmation(a, op);
    yield* refresh(a);
    if (!a.billing_state.operation)
      yield* store.audit(a.organization_id, a.owner_user_id, "billing.seats.changed");
    return a;
  });
  const result = (a: BillingTeam) => ({
    purchasedSeats: a.purchased_seats,
    pendingSeats: a.pending_seats,
    accessUntil: a.access_until,
    status: a.status,
    interval: a.interval,
  });
  return {
    checkout: (org: string, actor: string, interval: "month" | "year", seats: number) =>
      withAccount(
        org,
        Effect.fn("TeamBilling.checkout")(function* (a) {
          yield* owner(a, actor);
          yield* quantity(seats);
          yield* refresh(a);
          if (a.subscription_id) return yield* fail("Manage the existing Teams subscription");
          let operation = a.billing_state.operation;
          if (operation && operation.kind !== "checkout")
            return yield* fail("Another billing change is pending");
          if (operation?.sessionId && a.customer_id) {
            let status = yield* provider(() =>
              stripe.checkoutStatus(operation!.sessionId!, a.customer_id!, org),
            );
            if (
              status === "open" &&
              (operation.quantity !== seats || operation.interval !== interval)
            ) {
              yield* provider(() =>
                stripe.expireCheckout(
                  operation!.sessionId!,
                  `team-checkout-expire:${operation!.id}`,
                ),
              );
              status = yield* provider(() =>
                stripe.checkoutStatus(operation!.sessionId!, a.customer_id!, org),
              );
            }
            if (status === "complete")
              return yield* fail("Checkout completed; refresh billing while payment is reconciled");
            if (status === "expired") {
              a.billing_state = {};
              yield* save(a);
              operation = undefined;
            }
          }
          if (operation && (operation.quantity !== seats || operation.interval !== interval))
            return yield* fail(
              "The previous checkout is being recovered; retry its original selection",
            );
          if (!operation) {
            operation = {
              id: yield* operationId,
              kind: "checkout",
              createdAt: yield* now,
              quantity: seats,
              interval,
              prorationDate: 0,
            };
            a.billing_state = { operation };
            yield* save(a);
          }
          if ((yield* now) - operation.createdAt > 23 * 3600)
            return yield* fail("Expired checkout requires support recovery");
          if (operation.url) return { url: operation.url };
          if (!a.customer_id) {
            a.customer_id = yield* provider(() =>
              stripe.customer(org, `team-customer:${operation.id}`),
            );
            yield* save(a);
          }
          const session = yield* provider(() =>
            stripe.checkout(a.customer_id!, org, interval, seats, `team-checkout:${operation.id}`),
          );
          operation.sessionId = session.id;
          operation.url = session.url;
          yield* save(a);
          yield* store.audit(org, actor, "billing.checkout");
          return { url: session.url };
        }),
      ),
    preview: (org: string, actor: string, seats: number) =>
      withAccount(
        org,
        Effect.fn("TeamBilling.preview")(function* (a) {
          yield* owner(a, actor);
          yield* quantity(seats);
          yield* refresh(a);
          if (!a.subscription_id || !a.interval)
            return yield* fail("Subscribe before changing seats");
          if (a.billing_state.operation?.kind === "confirm")
            return yield* fail("A seat change is awaiting payment or reconciliation");
          if (seats === a.purchased_seats && a.pending_seats === null)
            return yield* fail("Seat count is unchanged");
          if (seats < (yield* store.assigned(org)))
            return yield* fail("Unassign seats before reducing capacity");
          const date = yield* now;
          const cost =
            seats > a.purchased_seats
              ? yield* provider(() => stripe.preview(a.subscription_id!, seats, date))
              : { amountDue: 0, currency: "usd" };
          const operation: TeamBillingOperation = {
            id: yield* operationId,
            kind: "preview",
            createdAt: date,
            quantity: seats,
            interval: a.interval,
            prorationDate: date,
            baselineQuantity: a.purchased_seats,
            subscriptionId: a.subscription_id,
            ...(a.current_period_end !== null ? { periodEnd: a.current_period_end } : {}),
            action:
              seats > a.purchased_seats
                ? "increase"
                : seats === a.purchased_seats
                  ? "cancel_decrease"
                  : "decrease",
            ...cost,
          };
          a.billing_state = { operation };
          yield* save(a);
          return {
            id: operation.id,
            ...cost,
            quantity: seats,
            effectiveAt: seats >= a.purchased_seats ? date : a.current_period_end,
          };
        }),
      ),
    confirm: (org: string, actor: string, previewId: string) =>
      withAccount(
        org,
        Effect.fn("TeamBilling.confirm")(function* (a) {
          yield* owner(a, actor);
          const op = a.billing_state.operation;
          if (!op || op.id !== previewId || op.kind === "checkout" || !a.subscription_id)
            return yield* fail("Preview the seat change first");
          if (op.kind === "preview" && op.baselineQuantity !== a.purchased_seats)
            return yield* fail("Seat quantity changed; preview again");
          if (op.kind === "preview" && (yield* now) - op.createdAt > 600)
            return yield* fail("Preview expired; review the current price");
          if (op.kind === "confirm" && (yield* now) - op.createdAt > 23 * 3600)
            return yield* fail("Interrupted seat change requires support recovery");
          if (op.quantity < (yield* store.assigned(org)))
            return yield* fail("Unassign seats before reducing capacity");
          const increase = op.quantity > (op.baselineQuantity ?? a.purchased_seats);
          if (increase && op.kind === "preview") {
            const current = yield* provider(() =>
              stripe.preview(a.subscription_id!, op.quantity, op.prorationDate),
            );
            if (current.amountDue !== op.amountDue || current.currency !== op.currency)
              return yield* fail("The price changed; preview again before confirming");
          }
          op.kind = "confirm";
          // Reserve the smaller future capacity before contacting Stripe to prevent seat assignment races.
          if (!increase && op.action !== "cancel_decrease")
            a.pending_seats = Math.min(a.pending_seats ?? op.quantity, op.quantity);
          yield* save(a);
          yield* applyConfirmation(a, op);
          yield* refresh(a);
          if (!increase || a.purchased_seats === op.quantity) {
            a.billing_state = {};
            yield* save(a);
          }
          yield* store.audit(org, actor, "billing.seats.changed");
          return result(a);
        }),
      ),
    reconcile: (org: string) =>
      withAccount(
        org,
        Effect.fn("TeamBilling.reconcile")(function* (a) {
          yield* reconcileAccount(a);
          return result(a);
        }),
      ),
    portal: (org: string, actor: string) =>
      withAccount(
        org,
        Effect.fn("TeamBilling.portal")(function* (a) {
          yield* owner(a, actor);
          if (!a.customer_id) return yield* fail("No billing customer exists");
          const key = yield* operationId;
          return yield* provider(() => stripe.portal(a.customer_id!, `team-portal:${key}`));
        }),
      ),
    closeOrganization: (org: string) =>
      withAccount(
        org,
        Effect.fn("TeamBilling.closeOrganization")(function* (a) {
          a.status = "deleted";
          a.suspended = true;
          a.purchased_seats = 0;
          a.access_until = null;
          a.pending_seats = null;
          a.billing_state = {};
          yield* save(a);
          yield* onAccessChanged(org);
          yield* refresh(a);
        }),
      ),
    processPending: Effect.fn("TeamBilling.processPending")(function* () {
      const orgs = yield* store.due(yield* now);
      yield* Effect.forEach(
        orgs,
        (org) =>
          withAccount(org, reconcileAccount).pipe(
            Effect.catch(() => Effect.logWarning("Team billing reconciliation remains pending")),
          ),
        { concurrency: 2, discard: true },
      );
    }),
    receiveWebhook: Effect.fn("TeamBilling.webhook")(function* (
      raw: Uint8Array,
      signature: string,
    ) {
      const event = yield* Effect.tryPromise({
        try: () => stripe.webhook(raw, signature),
        catch: (cause) =>
          cause instanceof InvalidTeamWebhookError
            ? new TeamError({ code: "forbidden", message: "Invalid Teams webhook" })
            : unavailable(),
      });
      if (!event.customer) return;
      const org = yield* store.byCustomer(event.customer);
      if (!org) return;
      yield* withAccount(org, reconcileAccount);
    }),
  };
}
export class TeamBillingService extends Context.Service<
  TeamBillingService,
  ReturnType<typeof makeTeamBillingService>
>()("lecturn-relay/teams/TeamBillingService") {}
