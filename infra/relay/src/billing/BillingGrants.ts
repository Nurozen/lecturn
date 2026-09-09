import { Clock, Effect, Schema } from "effect";
import { RelayDb } from "../db.ts";
import { BillingError, type BillingAccount, type BillingState } from "./BillingStore.ts";

export type BillingGrant = NonNullable<BillingState["grant"]>;
export interface EffectiveAccountAccess {
  allowed: boolean;
  available: boolean;
  validUntil: number | null;
  windowStart: number | null;
  limit: number;
  reason: "paid" | "grant" | "paid_and_grant" | "expired" | "suspended" | "deleted" | "unavailable";
  grantId: string | null;
}

/** Operator grants are independent of Stripe state; deletion and financial holds override both. */
export function effectiveAccountAccess(
  account: BillingAccount | undefined,
  now: number,
): EffectiveAccountAccess {
  const denied = (
    reason: EffectiveAccountAccess["reason"],
    available = true,
  ): EffectiveAccountAccess => ({
    allowed: false,
    available,
    validUntil: null,
    windowStart: null,
    limit: 3,
    reason,
    grantId: null,
  });
  if (!Number.isFinite(now) || now < 0) return denied("unavailable", false);
  if (!account) return denied("expired");
  if (account.deleted_at !== null) return denied("deleted");
  if (account.state.suspended) return denied("suspended");
  const updated = Number(account.updated_at);
  const verifiedClock = Number.isFinite(updated) && updated >= 0 && updated <= now;
  const fresh = verifiedClock && now - updated < 900;
  const paidUntil = account.state.accessUntil;
  // Provider outages do not erase already verified access before its known boundary.
  const paid = verifiedClock && Number.isFinite(paidUntil) && (paidUntil ?? 0) > now;
  const grant = account.state.grant;
  const validGrant = grant !== undefined && validBillingGrant(grant);
  const granted = validGrant && grant.start <= now && now < grant.end;
  if (!paid && !granted) return denied(fresh ? "expired" : "unavailable", fresh);
  const paidStart =
    Number.isFinite(account.state.accessWindowStart) &&
    (account.state.accessWindowStart ?? Infinity) <= now
      ? account.state.accessWindowStart!
      : Infinity;
  // Keep the whole connected span when one overlapping interval has just ended.
  // Otherwise an ordinary transition from a grant to paid service drops old queued jobs.
  const overlapping =
    validGrant &&
    verifiedClock &&
    Number.isFinite(paidUntil) &&
    Math.max(paidStart, grant.start) <= Math.min(paidUntil ?? -Infinity, grant.end);
  const windowStart = Math.min(
    paid || (granted && overlapping) ? paidStart : Infinity,
    granted || (paid && overlapping) ? grant!.start : Infinity,
  );
  return {
    allowed: true,
    available: true,
    validUntil: Math.max(paid ? paidUntil! : 0, granted ? grant.end : 0),
    windowStart: Number.isFinite(windowStart)
      ? Math.max(windowStart, account.state.financialWindowStart ?? -Infinity)
      : null,
    limit: granted ? grant.limit : 3,
    reason: paid && granted ? "paid_and_grant" : granted ? "grant" : "paid",
    grantId: granted ? grant.id : null,
  };
}

const isBillingError = Schema.is(BillingError);
const invalid = (message: string) => new BillingError({ code: "invalid", message });
const unavailable = () =>
  new BillingError({ code: "persistence", message: "Grant operation could not be persisted" });
const boundedText = (value: string, min: number, max: number) =>
  value.trim().length >= min && value.length <= max;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const time = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));

export function validBillingGrant(grant: BillingGrant): boolean {
  return (
    boundedText(grant.id, 1, 128) &&
    boundedText(grant.operator, 1, 200) &&
    boundedText(grant.reason, 8, 500) &&
    Number.isSafeInteger(grant.start) &&
    grant.start >= 0 &&
    Number.isSafeInteger(grant.end) &&
    grant.end > grant.start &&
    Number.isSafeInteger(grant.limit) &&
    grant.limit >= 3 &&
    grant.limit <= 10000
  );
}

/** Preserve existing capacity during the approved transition; never choose a host to evict. */
export function createTransitionGrant(input: {
  id: string;
  operator: string;
  reason: string;
  start: number;
  enabledEnvironments: number;
}): BillingGrant {
  if (!Number.isSafeInteger(input.enabledEnvironments) || input.enabledEnvironments < 0)
    throw new Error("Transition inventory count is invalid");
  const grant = {
    id: input.id,
    operator: input.operator,
    reason: input.reason,
    start: input.start,
    end: input.start + 30 * 86400,
    limit: Math.max(3, input.enabledEnvironments),
  };
  if (!validBillingGrant(grant)) throw new Error("Transition grant is invalid");
  return grant;
}

/** Operator-only operations: deliberately not wired into normal user HTTP routes. */
export const makeBillingGrantOperations = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
  return {
    grant: Effect.fn("BillingGrants.grant")(function* (userId: string, grant: BillingGrant) {
      if (!boundedText(userId, 1, 200) || !validBillingGrant(grant))
        return yield* invalid(
          "A valid user, grant interval, limit, operator and reason are required",
        );
      const now = yield* time;
      if (grant.end <= now) return yield* invalid("Grant must end in the future");
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* query(
              sql`INSERT INTO relay_billing_accounts(user_id,updated_at) VALUES (${userId},${now}) ON CONFLICT DO NOTHING`,
            );
            const account = (yield* query(
              sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE user_id=${userId} FOR UPDATE`,
            ))[0]!;
            if (account.deleted_at !== null)
              return yield* invalid("Deleted accounts cannot receive grants");
            const prior = yield* query(
              sql<{
                user_id: string;
                grant_id: string;
                starts_at: number;
                ends_at: number;
                environment_limit: number;
                operator: string;
                reason: string;
              }>`SELECT * FROM relay_billing_grant_audit WHERE id=${`grant:${grant.id}`}`,
            );
            if (prior[0]) {
              const entry = prior[0];
              if (
                entry.user_id !== userId ||
                Number(entry.starts_at) !== grant.start ||
                Number(entry.ends_at) !== grant.end ||
                entry.environment_limit !== grant.limit ||
                entry.operator !== grant.operator ||
                entry.reason !== grant.reason
              )
                return yield* invalid("Grant id was already used for a different operation");
              return { applied: false };
            }
            const capacity =
              (yield* query(sql<{ count: number }>`SELECT count(*)::integer AS count FROM (
              SELECT environment_id FROM relay_managed_reservations WHERE user_id=${userId} AND enabled=true
              UNION SELECT environment_id FROM relay_managed_endpoint_allocations allocation WHERE user_id=${userId}
                AND NOT EXISTS (SELECT 1 FROM relay_managed_reservations reservation WHERE reservation.user_id=allocation.user_id AND reservation.environment_id=allocation.environment_id)
            ) capacity`))[0]?.count ?? 0;
            if (grant.limit < capacity)
              return yield* invalid(
                "Grant limit must preserve existing enabled environments; resolve the keep-set explicitly",
              );
            yield* query(
              sql`UPDATE relay_billing_accounts SET state=jsonb_set(state,'{grant}',${encodeJson(grant)}::jsonb),generation=generation+1,lease_until=0,lease_token=NULL WHERE user_id=${userId}`,
            );
            yield* query(
              sql`INSERT INTO relay_billing_grant_audit(id,user_id,operator,action,reason,grant_id,starts_at,ends_at,environment_limit,created_at) VALUES (${`grant:${grant.id}`},${userId},${grant.operator},'grant',${grant.reason},${grant.id},${grant.start},${grant.end},${grant.limit},${now})`,
            );
            return { applied: true };
          }),
        )
        .pipe(Effect.mapError((cause) => (isBillingError(cause) ? cause : unavailable())));
    }),
    revoke: Effect.fn("BillingGrants.revoke")(function* (input: {
      userId: string;
      grantId: string;
      operationId: string;
      operator: string;
      reason: string;
    }) {
      if (
        ![input.userId, input.grantId, input.operationId, input.operator].every((value) =>
          boundedText(value, 1, 200),
        ) ||
        !boundedText(input.reason, 8, 500)
      )
        return yield* invalid("A grant id, user, operation id, operator and reason are required");
      const now = yield* time;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const account = (yield* query(
              sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE user_id=${input.userId} FOR UPDATE`,
            ))[0];
            const prior = (yield* query(
              sql<{
                user_id: string;
                grant_id: string;
                operator: string;
                reason: string;
              }>`SELECT * FROM relay_billing_grant_audit WHERE id=${`revoke:${input.operationId}`}`,
            ))[0];
            if (prior) {
              if (
                prior.user_id !== input.userId ||
                prior.grant_id !== input.grantId ||
                prior.operator !== input.operator ||
                prior.reason !== input.reason
              )
                return yield* invalid("Revoke operation id was already used");
              return { applied: false };
            }
            if (!account || account.state.grant?.id !== input.grantId)
              return yield* invalid("Grant changed; refresh inventory before revoking");
            yield* query(
              sql`UPDATE relay_billing_accounts SET state=state-'grant',generation=generation+1,lease_until=0,lease_token=NULL WHERE user_id=${input.userId}`,
            );
            yield* query(
              sql`INSERT INTO relay_billing_grant_audit(id,user_id,operator,action,reason,grant_id,created_at) VALUES (${`revoke:${input.operationId}`},${input.userId},${input.operator},'revoke',${input.reason},${input.grantId},${now})`,
            );
            return { applied: true };
          }),
        )
        .pipe(Effect.mapError((cause) => (isBillingError(cause) ? cause : unavailable())));
    }),
    inventory: Effect.fn("BillingGrants.inventory")(function* (afterUserId = "", limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return yield* invalid("Inventory limit must be 1 through 100");
      return yield* query(sql<{
        user_id: string;
        deleted_at: number | null;
        grant: BillingGrant | null;
        enabled_environments: number;
      }>`WITH owners AS (
          SELECT user_id FROM relay_billing_accounts
          UNION SELECT user_id FROM relay_environment_links WHERE revoked_at IS NULL
          UNION SELECT user_id FROM relay_managed_endpoint_allocations
          UNION SELECT user_id FROM relay_managed_reservations WHERE enabled=true
        ) SELECT owner.user_id,account.deleted_at,account.state->'grant' AS grant,
        (SELECT count(*)::integer FROM (SELECT environment_id FROM relay_managed_reservations WHERE user_id=owner.user_id AND enabled=true UNION SELECT environment_id FROM relay_managed_endpoint_allocations allocation WHERE user_id=owner.user_id AND NOT EXISTS (SELECT 1 FROM relay_managed_reservations reservation WHERE reservation.user_id=allocation.user_id AND reservation.environment_id=allocation.environment_id)) capacity) AS enabled_environments
        FROM owners owner LEFT JOIN relay_billing_accounts account ON account.user_id=owner.user_id WHERE owner.user_id > ${afterUserId} ORDER BY owner.user_id LIMIT ${limit}`);
    }),
  };
});
