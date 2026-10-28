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
  const renewing = facts.status === "active" || facts.status === "past_due";
  const renewalUntil =
    paidThrough === null
      ? null
      : Math.min(paidThrough + (renewing ? renewalGraceSeconds : 0), stop);
  // Persist the renewal deadline before the paid boundary so a saved projection cannot
  // retire a tunnel while the next invoice is still settling.
  if (paidThrough !== null && now < Math.min(paidThrough, stop))
    return result("paid", renewalUntil);
  const trialEnd = finite(facts.trialEnd);
  if (
    facts.status === "trialing" &&
    facts.trialCardConfirmed &&
    trialEnd !== null &&
    now < Math.min(trialEnd, stop)
  )
    return result("trial", Math.min(trialEnd, stop));
  // Grace is anchored to previously settled service, never to a failure event or an unpaid trial.
  if (renewing && renewalUntil !== null && now < renewalUntil) return result("grace", renewalUntil);
  return result("expired", null);
}

export interface SettledServiceInterval {
  readonly start: number;
  readonly end: number;
  /** Service is not granted retroactively when an invoice is settled late. */
  readonly settledAt: number;
}

/** Reconstruct continuity from canonical payment times, including gaps missed by the cron. */
export function connectedAccessWindowStart(
  paid: readonly SettledServiceInterval[],
  trial: { start: number; end: number } | null,
  now: number,
  renewalGraceSeconds: number,
  inGrace: boolean,
): number | null {
  const intervals = paid.map((period) => ({
    serviceStart: period.start,
    start: Math.max(period.start, period.settledAt),
    end: period.end,
    paid: true,
  }));
  if (trial) intervals.push({ serviceStart: trial.start, ...trial, paid: false });
  const valid = intervals
    .filter(
      (period) =>
        Number.isFinite(period.start) &&
        Number.isFinite(period.end) &&
        period.start > 0 &&
        period.start < period.end,
    )
    .toSorted((a, b) => a.start - b.start);
  const windows: { start: number; end: number; paid: boolean }[] = [];
  for (const period of valid) {
    const previous = windows.at(-1);
    if (
      previous &&
      (period.start <= previous.end ||
        (previous.paid &&
          period.serviceStart <= previous.end &&
          period.start <= previous.end + renewalGraceSeconds))
    ) {
      previous.end = Math.max(previous.end, period.end);
      previous.paid = period.paid;
    } else windows.push({ start: period.start, end: period.end, paid: period.paid });
  }
  return (
    windows.findLast(
      (period) =>
        period.start <= now &&
        now < period.end + (inGrace && period.paid ? renewalGraceSeconds : 0),
    )?.start ?? null
  );
}
