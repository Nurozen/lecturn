import { Clock, Effect } from "effect";
import { RelayDb } from "../db.ts";
import { BillingError, type BillingStore } from "./BillingStore.ts";

export const billingOperationsMigration = `CREATE TABLE IF NOT EXISTS relay_billing_identity_checks (
  user_id text PRIMARY KEY REFERENCES relay_billing_accounts(user_id),
  next_check_at bigint NOT NULL DEFAULT 0, checked_at bigint, outcome text
);
CREATE TABLE IF NOT EXISTS relay_billing_operator_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation text NOT NULL, target text, reason text NOT NULL, created_at bigint NOT NULL
)`;

const unavailable = () =>
  new BillingError({
    code: "unavailable",
    message: "Billing operations are temporarily unavailable",
  });
const time = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
const boundedLimit = (limit: number) => Number.isSafeInteger(limit) && limit > 0 && limit <= 100;
export type IdentityLookup = (userId: string) => Effect.Effect<"present" | "missing", BillingError>;

/** Only the authenticated Clerk user endpoint may establish absence. Outages are uncertainty. */
export const clerkIdentityLookup =
  (secretKey: string, fetch: typeof globalThis.fetch = globalThis.fetch): IdentityLookup =>
  (userId) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(
          `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`,
          {
            headers: { Authorization: `Bearer ${secretKey}` },
            signal: AbortSignal.timeout(5_000),
            redirect: "error",
          },
        );
        if (response.ok) {
          const body = (await response.json()) as { id?: unknown };
          if (body.id !== userId) throw new Error("Identity response mismatch");
          return "present" as const;
        }
        if (response.status === 404) {
          const body = (await response.json()) as { errors?: Array<{ code?: unknown }> };
          if (body.errors?.some((error) => error.code === "resource_not_found"))
            return "missing" as const;
        }
        throw new Error("Identity service unavailable");
      },
      catch: unavailable,
    });

export const reconcileIdentity = (
  userId: string,
  now: number,
  lookup: IdentityLookup,
  tombstone: BillingStore["tombstone"],
) =>
  Effect.gen(function* () {
    const result = yield* lookup(userId);
    if (result === "missing") yield* tombstone(userId, now, `identity-reconcile:${userId}`);
    return result;
  });

export interface BillingHealth {
  pending_events: number;
  pending_payment_reviews: number;
  oldest_pending_seconds: number;
  quarantined_events: number;
  stale_accounts: number;
  deleted_renewals: number;
  pending_suspensions: number;
  oldest_suspension_seconds: number;
  identity_checks_overdue: number;
  identity_check_failures: number;
}

export const makeBillingOperations = (config: {
  readonly store: Pick<BillingStore, "tombstone">;
  readonly identity: IdentityLookup;
}) =>
  Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
    const audit = (operation: string, target: string | null, reason: string, now: number) =>
      sql`INSERT INTO relay_billing_operator_audit(operation,target,reason,created_at) VALUES (${operation},${target},${reason},${now})`;
    const reasonValid = (reason: string) => reason.trim().length >= 8 && reason.length <= 500;
    return {
      reconcileIdentities: Effect.fn("BillingOperations.reconcileIdentities")(function* (
        limit = 20,
      ) {
        if (!boundedLimit(limit))
          return yield* new BillingError({
            code: "invalid",
            message: "Identity scan limit must be 1 through 100",
          });
        const now = yield* time;
        // Durable due times prevent the first page from starving later retained accounts.
        const users = yield* query(sql<{
          user_id: string;
        }>`SELECT account.user_id FROM relay_billing_accounts account
        LEFT JOIN relay_billing_identity_checks identity_check ON identity_check.user_id=account.user_id
        WHERE account.deleted_at IS NULL AND COALESCE(identity_check.next_check_at,0)<=${now}
        ORDER BY COALESCE(identity_check.next_check_at,0),account.user_id LIMIT ${limit}`);
        let missing = 0;
        let failed = 0;
        for (const user of users) {
          const claimed =
            yield* query(sql`INSERT INTO relay_billing_identity_checks(user_id,next_check_at) VALUES (${user.user_id},${now + 300})
          ON CONFLICT(user_id) DO UPDATE SET next_check_at=${now + 300}
          WHERE relay_billing_identity_checks.next_check_at<=${now} RETURNING user_id`);
          if (!claimed.length) continue;
          const outcome = yield* reconcileIdentity(
            user.user_id,
            now,
            config.identity,
            config.store.tombstone,
          ).pipe(Effect.result);
          if (outcome._tag === "Failure") failed++;
          else if (outcome.success === "missing") missing++;
          yield* query(sql`UPDATE relay_billing_identity_checks SET checked_at=${now},
          next_check_at=${now + (outcome._tag === "Failure" ? 900 : 21600)},
          outcome=${outcome._tag === "Failure" ? "unavailable" : outcome.success} WHERE user_id=${user.user_id}`);
        }
        return { checked: users.length, missing, failed };
      }),
      health: Effect.fn("BillingOperations.health")(function* () {
        const now = yield* time;
        const rows = yield* query(sql<BillingHealth>`SELECT
        (SELECT count(*)::integer FROM relay_billing_payment_reviews WHERE status='pending') AS pending_payment_reviews,
        (SELECT count(*)::integer FROM relay_billing_inbox WHERE processed_at IS NULL) AS pending_events,
        (SELECT COALESCE(${now}-min(created_at),0)::integer FROM relay_billing_inbox WHERE processed_at IS NULL) AS oldest_pending_seconds,
        (SELECT count(*)::integer FROM relay_billing_inbox event WHERE processed_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM relay_billing_accounts account WHERE account.user_id=event.user_id OR account.customer_id=event.customer_id)) AS quarantined_events,
        (SELECT count(*)::integer FROM relay_billing_accounts WHERE updated_at<=${now - 900} AND deleted_at IS NULL) AS stale_accounts,
        (SELECT count(*)::integer FROM relay_billing_accounts WHERE deleted_at IS NOT NULL AND customer_id IS NOT NULL
          AND COALESCE(state->>'status','unknown') NOT IN ('canceled','free','incomplete_expired')) AS deleted_renewals,
        (SELECT count(*)::integer FROM relay_managed_suspensions WHERE completed_at IS NULL) AS pending_suspensions,
        (SELECT COALESCE(${now}-min(created_at),0)::integer FROM relay_managed_suspensions WHERE completed_at IS NULL) AS oldest_suspension_seconds,
        (SELECT count(*)::integer FROM relay_billing_accounts account LEFT JOIN relay_billing_identity_checks identity_check ON identity_check.user_id=account.user_id
          WHERE account.deleted_at IS NULL AND COALESCE(identity_check.next_check_at,0)<=${now}) AS identity_checks_overdue,
        (SELECT count(*)::integer FROM relay_billing_identity_checks WHERE outcome='unavailable') AS identity_check_failures`);
        return rows[0]!;
      }),
      suspensionControl: Effect.fn("BillingOperations.suspensionControl")(function* (
        enabled: boolean,
        reason: string,
      ) {
        if (!reasonValid(reason))
          return yield* new BillingError({
            code: "invalid",
            message: "Provide an audit reason between 8 and 500 characters",
          });
        const now = yield* time;
        return yield* query(
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                enabled: boolean;
                epoch: number;
              }>`UPDATE relay_billing_enforcement_control
          SET enabled=${enabled},epoch=epoch+1 WHERE id=1 RETURNING enabled,epoch`;
              if (!rows[0])
                return yield* new BillingError({
                  code: "missing",
                  message: "Suspension control migration is not applied",
                });
              yield* audit("suspension-control", enabled ? "on" : "off", reason, now);
              return rows[0];
            }),
          ),
        );
      }),
      replay: Effect.fn("BillingOperations.replay")(function* (eventId: string, reason: string) {
        if (!reasonValid(reason))
          return yield* new BillingError({
            code: "invalid",
            message: "Provide an audit reason between 8 and 500 characters",
          });
        const now = yield* time;
        return yield* query(
          sql.withTransaction(
            Effect.gen(function* () {
              const rows =
                yield* sql`UPDATE relay_billing_inbox SET processed_at=NULL,next_attempt_at=0 WHERE id=${eventId} RETURNING id`;
              if (!rows.length)
                return yield* new BillingError({
                  code: "missing",
                  message: "Billing event not found",
                });
              yield* audit("replay", eventId, reason, now);
              return { replayed: eventId };
            }),
          ),
        );
      }),
      pruneProcessedInbox: Effect.fn("BillingOperations.pruneProcessedInbox")(function* (
        input: {
          readonly enabled?: boolean;
          readonly retentionDays?: number;
          readonly limit?: number;
          readonly reason?: string;
        } = {},
      ) {
        if (!input.enabled) return { removed: 0 };
        const days = input.retentionDays ?? 90;
        const limit = input.limit ?? 100;
        if (
          !Number.isSafeInteger(days) ||
          days < 90 ||
          !boundedLimit(limit) ||
          !reasonValid(input.reason ?? "")
        )
          return yield* new BillingError({
            code: "invalid",
            message:
              "Retention requires at least 90 days, a limit of 1 through 100, and an audit reason",
          });
        const now = yield* time;
        return yield* query(
          sql.withTransaction(
            Effect.gen(function* () {
              // Financial/customer identity references, unresolved events and deletion evidence are retained.
              const rows = yield* sql`DELETE FROM relay_billing_inbox WHERE id IN (
          SELECT id FROM relay_billing_inbox WHERE processed_at<${now - days * 86400}
          AND customer_id IS NULL AND user_id IS NULL AND kind<>'user.deleted' ORDER BY processed_at LIMIT ${limit}) RETURNING id`;
              yield* audit("prune-nonfinancial-receipts", null, input.reason!, now);
              return { removed: rows.length };
            }),
          ),
        );
      }),
    };
  });
