/** Inspect structured wrappers without mistaking network failures for an unpaid account. */
export function isConnectSubscriptionRequired(error: unknown): boolean {
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && seen.size < 32) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      record._tag === "RelayConnectSubscriptionRequiredError" ||
      record.code === "connect_subscription_required"
    )
      return true;
    for (const key of ["cause", "error", "relayError", "data", "details"]) {
      pending.push(record[key]);
    }
  }
  return false;
}
