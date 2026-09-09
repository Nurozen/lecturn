import { Effect, Schema, Random } from "effect";
import { RelayDb } from "../db.ts";

export class BillingError extends Schema.TaggedErrorClass<BillingError>()("BillingError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export const operationId = Effect.all(
  Array.from({ length: 4 }, () => Random.nextIntBetween(0, 0xffffffff)),
).pipe(Effect.map((parts) => parts.map((n) => n.toString(16).padStart(8, "0")).join("")));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface BillingState {
  trialConsumed?: boolean;
  status?: string;
  currentPeriodEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
  operation?: { id: string; createdAt: number; interval: "month" | "year"; trialEligible: boolean };
  sessionId?: string;
  sessionComplete?: boolean;
  interval?: "month" | "year";
  trialEnd?: number | null;
  cancelAt?: number | null;
  accessUntil?: number | null;
}
export interface BillingAccount {
  user_id: string;
  customer_id: string | null;
  deleted_at: number | null;
  generation: number;
  updated_at: number;
  lease_token: string | null;
  state: BillingState;
}
export interface BillingEvent {
  id: string;
  customer_id: string | null;
  user_id: string | null;
  kind: string;
}
export const makeBillingStore = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const query = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError(
        () =>
          new BillingError({
            code: "persistence",
            message: "Billing storage is temporarily unavailable",
          }),
      ),
    );
  const load = (userId: string) =>
    query(sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE user_id=${userId}`).pipe(
      Effect.map((rows) => rows[0]),
    );
  const acquire = Effect.fn("BillingStore.acquire")(function* (userId: string, now: number) {
    yield* query(
      sql`INSERT INTO relay_billing_accounts(user_id,updated_at) VALUES (${userId},${now}) ON CONFLICT DO NOTHING`,
    );
    const token = yield* operationId;
    const rows = yield* query(
      sql<BillingAccount>`UPDATE relay_billing_accounts SET lease_token=${token}, lease_until=${now + 120}, generation=generation+1 WHERE user_id=${userId} AND lease_until <= ${now} RETURNING *`,
    );
    if (!rows[0])
      return yield* new BillingError({
        code: "busy",
        message: "Another billing operation is running. Please retry.",
      });
    return rows[0];
  });
  const save = Effect.fn("BillingStore.save")(function* (account: BillingAccount, now: number) {
    const rows = yield* query(
      sql`UPDATE relay_billing_accounts SET customer_id=${account.customer_id},state=${encodeJson(account.state)}::jsonb,updated_at=${now} WHERE user_id=${account.user_id} AND generation=${account.generation} AND lease_token=${account.lease_token} AND lease_until > ${now} RETURNING user_id`,
    );
    if (!rows.length)
      return yield* new BillingError({
        code: "stale",
        message: "Billing state changed; retry to refresh it.",
      });
  });
  const release = (a: BillingAccount) =>
    query(
      sql`UPDATE relay_billing_accounts SET lease_until=0,lease_token=NULL WHERE user_id=${a.user_id} AND generation=${a.generation} AND lease_token=${a.lease_token}`,
    );
  const receipt = (event: BillingEvent, now: number) =>
    query(
      sql`INSERT INTO relay_billing_inbox(id,customer_id,user_id,kind,created_at) VALUES (${event.id},${event.customer_id},${event.user_id},${event.kind},${now}) ON CONFLICT DO NOTHING`,
    );
  const tombstone = (userId: string, now: number, eventId: string) =>
    query(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO relay_billing_accounts(user_id,deleted_at,updated_at) VALUES (${userId},${now},${now}) ON CONFLICT(user_id) DO UPDATE SET deleted_at=COALESCE(relay_billing_accounts.deleted_at,${now}),generation=relay_billing_accounts.generation+1,lease_until=0,lease_token=NULL`;
          yield* receipt(
            { id: eventId, user_id: userId, customer_id: null, kind: "user.deleted" },
            now,
          );
        }),
      ),
    );
  return {
    load,
    acquire,
    save,
    release,
    receipt,
    tombstone,
    quotaUsed: (userId: string) =>
      query(
        sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM (
          SELECT environment_id FROM relay_managed_reservations WHERE user_id=${userId} AND enabled=true
          UNION
          SELECT environment_id FROM relay_managed_endpoint_allocations AS allocation WHERE user_id=${userId} AND NOT EXISTS (SELECT 1 FROM relay_managed_reservations AS reservation WHERE reservation.user_id=allocation.user_id AND reservation.environment_id=allocation.environment_id)
        ) AS capacity`,
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    byCustomer: (id: string) =>
      query(sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE customer_id=${id}`).pipe(
        Effect.map((rows) => rows[0]),
      ),
    pending: (limit: number, now = Number.MAX_SAFE_INTEGER) =>
      query(
        sql<BillingEvent>`SELECT * FROM relay_billing_inbox WHERE processed_at IS NULL AND next_attempt_at <= ${now} ORDER BY next_attempt_at, created_at LIMIT ${limit}`,
      ),
    attempted: (id: string, now: number) =>
      query(
        sql`UPDATE relay_billing_inbox SET attempts=attempts+1,next_attempt_at=${now}+LEAST(3600,30 * power(2,LEAST(attempts,7)))::bigint WHERE id=${id}`,
      ),
    complete: (id: string, now: number) =>
      query(sql`UPDATE relay_billing_inbox SET processed_at=${now} WHERE id=${id}`),
    // Revisit tombstones and unsettled operations even when no webhook arrives.
    deferReconcile: (userId: string, now: number) =>
      query(
        sql`UPDATE relay_billing_accounts SET reconcile_after=${now + 300} WHERE user_id=${userId}`,
      ),
    stale: (now: number, limit: number) =>
      query(
        sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE updated_at < ${now - 300} AND reconcile_after <= ${now} ORDER BY reconcile_after,updated_at LIMIT ${limit}`,
      ),
  };
});
export type BillingStore = Effect.Success<typeof makeBillingStore>;
