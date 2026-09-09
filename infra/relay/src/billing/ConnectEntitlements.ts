/** Canonical, reconciled facts; timestamps are Unix seconds. Status alone grants nothing. */
export interface SubscriptionAccessFacts {
  readonly status: string;
  readonly paidThrough: number | null;
  readonly trialEnd: number | null;
  readonly trialCardConfirmed: boolean;
  readonly cancelAt: number | null;
  readonly endedAt: number | null;
  readonly suspended: boolean;
}
export interface ConnectEntitlement {
  readonly allowed: boolean;
  readonly reason: "paid" | "trial" | "grace" | "expired" | "suspended";
  readonly validUntil: number | null;
  readonly environmentLimit: 3;
  readonly managedPush: boolean;
  readonly liveActivities: boolean;
}
export function computeConnectEntitlement(
  facts: SubscriptionAccessFacts,
  now: number,
  renewalGraceSeconds = 0,
): ConnectEntitlement {
  const result = (
    reason: ConnectEntitlement["reason"],
    validUntil: number | null,
  ): ConnectEntitlement => {
    const allowed = reason === "paid" || reason === "trial" || reason === "grace";
    return {
      allowed,
      reason,
      validUntil,
      environmentLimit: 3,
      managedPush: allowed,
      liveActivities: allowed,
    };
  };
  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(renewalGraceSeconds) ||
    renewalGraceSeconds < 0
  )
    throw new Error("Invalid entitlement clock or grace");
  if (facts.suspended) return result("suspended", null);
  const finite = (value: number | null) =>
    value !== null && Number.isFinite(value) && value > 0 ? value : null;
  const stop = Math.min(finite(facts.cancelAt) ?? Infinity, finite(facts.endedAt) ?? Infinity);
  const paidThrough = finite(facts.paidThrough);
  if (paidThrough !== null && now < Math.min(paidThrough, stop))
    return result("paid", Math.min(paidThrough, stop));
  const trialEnd = finite(facts.trialEnd);
  if (
    facts.status === "trialing" &&
    facts.trialCardConfirmed &&
    trialEnd !== null &&
    now < Math.min(trialEnd, stop)
  )
    return result("trial", Math.min(trialEnd, stop));
  // Grace is anchored to previously settled service, never to a failure event or an unpaid trial.
  if (
    facts.status === "past_due" &&
    paidThrough !== null &&
    renewalGraceSeconds > 0 &&
    now < Math.min(paidThrough + renewalGraceSeconds, stop)
  )
    return result("grace", Math.min(paidThrough + renewalGraceSeconds, stop));
  return result("expired", null);
}
