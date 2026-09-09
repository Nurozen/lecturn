import { describe, expect, it } from "vite-plus/test";
import type { BillingAccount } from "./BillingStore.ts";
import {
  effectiveAccountAccess,
  createTransitionGrant,
  validBillingGrant,
  type BillingGrant,
} from "./BillingGrants.ts";

const grant: BillingGrant = {
  id: "owner",
  start: 100,
  end: 300,
  limit: 3,
  operator: "operator",
  reason: "Approved owner access",
};
const account = (state: BillingAccount["state"]): BillingAccount => ({
  user_id: "owner",
  customer_id: null,
  deleted_at: null,
  updated_at: 200,
  generation: 1,
  lease_token: null,
  state,
});

describe("effective operator grants", () => {
  it("allows an active grant independently of expired or stale Stripe state", () => {
    expect(effectiveAccountAccess({ ...account({ grant }), updated_at: 1 }, 200)).toMatchObject({
      allowed: true,
      available: true,
      reason: "grant",
      validUntil: 300,
      windowStart: 100,
    });
    expect(effectiveAccountAccess(account({ grant }), 300).allowed).toBe(false);
    expect(effectiveAccountAccess(account({ grant }), 99).allowed).toBe(false);
  });
  it("does not refresh or overwrite canonical payment facts", () => {
    const value = account({ accessUntil: 50, accessWindowStart: 1, grant });
    const before = structuredClone(value);
    effectiveAccountAccess(value, 200);
    expect(value).toEqual(before);
  });
  it("never overrides deletion or financial suspension", () => {
    expect(effectiveAccountAccess({ ...account({ grant }), deleted_at: 150 }, 200)).toMatchObject({
      allowed: false,
      reason: "deleted",
    });
    expect(effectiveAccountAccess(account({ grant, suspended: true }), 200)).toMatchObject({
      allowed: false,
      reason: "suspended",
    });
  });
  it("unions overlapping grant and paid access without expanding the paid quota permanently", () => {
    const value = account({
      accessUntil: 400,
      accessWindowStart: 150,
      grant: { ...grant, limit: 5 },
    });
    expect(effectiveAccountAccess(value, 200)).toMatchObject({
      allowed: true,
      reason: "paid_and_grant",
      validUntil: 400,
      windowStart: 100,
      limit: 5,
    });
    expect(effectiveAccountAccess(value, 301)).toMatchObject({
      allowed: true,
      reason: "paid",
      validUntil: 400,
      windowStart: 100,
      limit: 3,
    });
  });
  it("retains a financial interruption fence and rejects malformed grants", () => {
    expect(
      effectiveAccountAccess(account({ grant, financialWindowStart: 190 }), 200).windowStart,
    ).toBe(190);
    expect(validBillingGrant(grant)).toBe(true);
    for (const invalid of [
      { ...grant, limit: 2 },
      { ...grant, end: 100 },
      { ...grant, reason: "" },
      { ...grant, operator: "" },
    ])
      expect(validBillingGrant(invalid)).toBe(false);
    expect(
      effectiveAccountAccess(account({ grant: { ...grant, end: Infinity } }), 200).allowed,
    ).toBe(false);
  });
});

it("transition preserves over-quota capacity for exactly thirty days", () => {
  expect(
    createTransitionGrant({
      id: "transition",
      operator: "operator",
      reason: "Approved existing-user transition",
      start: 100,
      enabledEnvironments: 5,
    }),
  ).toMatchObject({ start: 100, end: 100 + 30 * 86400, limit: 5 });
  expect(
    createTransitionGrant({
      id: "transition",
      operator: "operator",
      reason: "Approved existing-user transition",
      start: 100,
      enabledEnvironments: 1,
    }).limit,
  ).toBe(3);
});

it("continues only to the known paid boundary during provider outage", () => {
  const value = { ...account({ accessUntil: 2000, accessWindowStart: 1 }), updated_at: 1 };
  expect(effectiveAccountAccess(value, 1000)).toMatchObject({
    allowed: true,
    available: true,
    validUntil: 2000,
  });
  expect(effectiveAccountAccess(value, 2000)).toMatchObject({
    allowed: false,
    available: false,
    reason: "unavailable",
  });
  expect(effectiveAccountAccess({ ...value, updated_at: 1001 }, 1000).allowed).toBe(false);
  expect(effectiveAccountAccess({ ...value, updated_at: NaN }, 1000).allowed).toBe(false);
});

it("never invents an origin window for a legacy paid projection", () => {
  expect(effectiveAccountAccess(account({ accessUntil: 400 }), 200)).toMatchObject({
    allowed: true,
    windowStart: null,
  });
  expect(effectiveAccountAccess(account({ accessUntil: 400, grant }), 200)).toMatchObject({
    allowed: true,
    windowStart: 100,
  });
});

it("preserves continuous paid-to-grant windows but never bridges an access gap", () => {
  const value = account({
    accessUntil: 150,
    accessWindowStart: 50,
    grant: { ...grant, start: 150 },
  });
  expect(effectiveAccountAccess(value, 200).windowStart).toBe(50);
  expect(
    effectiveAccountAccess(
      { ...value, state: { ...value.state, grant: { ...grant, start: 151 } } },
      200,
    ).windowStart,
  ).toBe(151);
  expect(
    effectiveAccountAccess(account({ accessUntil: 400, accessWindowStart: 301, grant }), 350)
      .windowStart,
  ).toBe(301);
});
