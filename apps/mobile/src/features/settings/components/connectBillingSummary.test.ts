import { describe, expect, it } from "vite-plus/test";
import type { RelayBillingStatus } from "@lecturn/contracts";
import { connectBillingSummary } from "./connectBillingSummary";
const now = Date.parse("2026-09-09T00:00:00Z");
const status: RelayBillingStatus = {
  state: "free",
  trialEligible: true,
  cancelAt: null,
  checkoutEnabled: false,
  portalEnabled: false,
  interval: null,
  currentPeriodEnd: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  hasAccess: true,
  accessReason: "grant",
  accessUntil: "2027-09-09T18:07:25Z",
  quota: { used: 2, limit: 3 },
  features: { managedConnect: true, pushNotifications: true, liveActivities: true },
};
describe("Connect companion status", () => {
  it("shows effective complimentary access despite free Stripe state", () => {
    const result = connectBillingSummary(status, now);
    expect(result.label).toBe("Complimentary Connect access active");
    expect(result.quota).toBe("2 of 3 managed environments used");
    expect(result.expiry).toContain("2027");
    expect(result.features).toContain("Live Activities");
  });
  it("does not present expired cached access as active", () => {
    const result = connectBillingSummary(
      { ...status, accessUntil: new Date(now).toISOString() },
      now,
    );
    expect(result.label).toBe("Connect access is not active");
    expect(result.features).toBeNull();
    expect(result.expiry).toContain("Refresh");
  });
  it("distinguishes rollout availability from granted access", () => {
    expect(
      connectBillingSummary(
        {
          ...status,
          features: { managedConnect: false, pushNotifications: false, liveActivities: false },
        },
        now,
      ).features,
    ).toBe("Managed features are not enabled for this account yet.");
  });
  it("handles uncertainty and suspension without advertising active features", () => {
    const unavailable = connectBillingSummary({ ...status, state: "unavailable" }, now);
    expect(unavailable.quota).toBeNull();
    expect(unavailable.features).toBeNull();
    const suspended = connectBillingSummary({ ...status, accessReason: "suspended" }, now);
    expect(suspended.label).toBe("Connect access suspended");
    expect(suspended.features).toBeNull();
  });
});
