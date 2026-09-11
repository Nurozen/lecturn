import type { RelayBillingStatus } from "@lecturn/contracts";

export function connectBillingSummary(status: RelayBillingStatus, now = Date.now()) {
  const expiry = status.accessUntil ? Date.parse(status.accessUntil) : NaN;
  const expired = Number.isFinite(expiry) && expiry <= now;
  const unavailable = status.state === "unavailable" || status.accessReason === "unavailable";
  const active =
    status.hasAccess &&
    !expired &&
    !unavailable &&
    status.state !== "disabled" &&
    status.accessReason !== "suspended";
  const label = unavailable
    ? "Connect status unavailable"
    : status.accessReason === "suspended"
      ? "Connect access suspended"
      : status.state === "disabled"
        ? "Connect status is not enabled"
        : active
          ? status.accessReason === "grant"
            ? "Complimentary Connect access active"
            : "Connect access active"
          : "Connect access is not active";
  return {
    label,
    quota: unavailable
      ? null
      : `${status.quota.used} of ${status.quota.limit} managed environments used`,
    expiry:
      active && Number.isFinite(expiry)
        ? `Access through ${new Date(expiry).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
        : expired
          ? "Your last confirmed access period has ended. Refresh to check your status."
          : null,
    features: active
      ? [
          status.features.managedConnect ? "Managed Connect" : null,
          status.features.pushNotifications ? "Push notifications" : null,
          status.features.liveActivities ? "Live Activities" : null,
        ]
          .filter(Boolean)
          .join(" · ") || "Managed features are not enabled for this account yet."
      : null,
  };
}
