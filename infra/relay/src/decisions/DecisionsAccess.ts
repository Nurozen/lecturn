import { Clock, DateTime, Effect } from "effect";
import { DecisionEvaluationError, type RelayDecisionsStatus } from "@lecturn/contracts";
import { RelayDb } from "../db.ts";
import { currentPersonalPaidFacts, type BillingAccount } from "../billing/BillingStore.ts";

export interface DecisionsAccessConfig {
  readonly enabled: boolean;
  readonly cohort?: readonly string[];
  readonly billingMaxAgeSeconds: number;
  readonly monthlyInputTokens: number;
}
export interface DecisionAccessSnapshot {
  readonly enabled: boolean;
  readonly eligible: boolean;
  readonly reason: RelayDecisionsStatus["reason"];
  readonly window: { readonly start: number; readonly end: number } | null;
  readonly limitInputTokens: number;
}

/** Add each month to the original anchor, so a February clamp does not shift March's anniversary. */
export function allowanceWindow(anchor: number, now: number): { start: number; end: number } {
  if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(now) || anchor <= 0 || now < anchor)
    throw new RangeError("Invalid allowance window");
  const origin = DateTime.makeUnsafe(anchor * 1000);
  const originParts = DateTime.toPartsUtc(origin);
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(now * 1000));
  let months = (parts.year - originParts.year) * 12 + parts.month - originParts.month;
  const at = (offset: number) =>
    DateTime.toEpochMillis(DateTime.add(origin, { months: offset })) / 1000;
  if (at(months) > now) months--;
  return { start: at(months), end: at(months + 1) };
}
export const decisionError = (code: DecisionEvaluationError["code"], message: string) =>
  new DecisionEvaluationError({ code, message });
export const decisionStorage = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.mapError(() =>
      decisionError("unavailable", "Decisions storage is temporarily unavailable"),
    ),
  );
const nowSeconds = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));

export const makeDecisionsAccess = (config: DecisionsAccessConfig) =>
  Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    const status = Effect.fn("DecisionsAccess.status")(function* (
      userId: string,
    ): Effect.fn.Return<DecisionAccessSnapshot, DecisionEvaluationError> {
      const denied = (reason: RelayDecisionsStatus["reason"]): DecisionAccessSnapshot => ({
        enabled: config.enabled,
        eligible: false,
        reason,
        window: null,
        limitInputTokens: config.monthlyInputTokens,
      });
      if (!config.enabled) return denied("disabled");
      if (config.cohort && !config.cohort.includes("*") && !config.cohort.includes(userId))
        return denied("cohort");
      const time = yield* nowSeconds;
      const accounts = yield* decisionStorage(
        sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE user_id=${userId}`,
      );
      const account = accounts[0];
      if (account?.deleted_at != null) return denied("not-paid");
      const facts = currentPersonalPaidFacts(account, time, config.billingMaxAgeSeconds);
      if (facts && facts.subscriptionAnniversary <= time)
        return {
          enabled: true,
          eligible: true,
          reason: "eligible",
          window: allowanceWindow(facts.subscriptionAnniversary, time),
          limitInputTokens: config.monthlyInputTokens,
        };
      const grants = yield* decisionStorage(sql<{
        starts_at: number;
        ends_at: number;
        monthly_input_tokens: number;
      }>`
      SELECT starts_at::float8,ends_at::float8,monthly_input_tokens::float8 FROM relay_decision_grants
      WHERE user_id=${userId} AND revoked_at IS NULL AND starts_at <= ${time} AND ends_at > ${time}
      ORDER BY starts_at DESC LIMIT 1`);
      const grant = grants[0];
      if (grant) {
        const window = allowanceWindow(grant.starts_at, time);
        return {
          enabled: true,
          eligible: true,
          reason: "eligible",
          window: { start: window.start, end: Math.min(window.end, grant.ends_at) },
          limitInputTokens: grant.monthly_input_tokens,
        };
      }
      return denied(
        account?.state.status === "trialing"
          ? "trial"
          : account?.paid_facts
            ? "stale-billing"
            : "not-paid",
      );
    });
    return { status };
  });
export type DecisionsAccess = Effect.Success<ReturnType<typeof makeDecisionsAccess>>;
