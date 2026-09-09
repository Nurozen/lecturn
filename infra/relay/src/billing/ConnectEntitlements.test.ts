import { describe, expect, it } from "vite-plus/test";
import {
  computeConnectEntitlement,
  connectedAccessWindowStart,
  type SubscriptionAccessFacts,
} from "./ConnectEntitlements.ts";
const base: SubscriptionAccessFacts = {
  status: "active",
  paidThrough: null,
  trialEnd: null,
  trialCardConfirmed: false,
  cancelAt: null,
  endedAt: null,
  suspended: false,
};
describe("Connect access policy", () => {
  it("does not grant from active status alone", () =>
    expect(computeConnectEntitlement(base, 100).allowed).toBe(false));
  it("requires card confirmation and trialing status", () => {
    expect(
      computeConnectEntitlement({ ...base, status: "trialing", trialEnd: 200 }, 100).allowed,
    ).toBe(false);
    expect(
      computeConnectEntitlement(
        { ...base, status: "trialing", trialEnd: 200, trialCardConfirmed: true },
        100,
      ).reason,
    ).toBe("trial");
    expect(
      computeConnectEntitlement({ ...base, trialEnd: 200, trialCardConfirmed: true }, 100).allowed,
    ).toBe(false);
  });
  it("uses explicit cancel_at even without a cancel_at_period_end flag", () => {
    const facts = { ...base, paidThrough: 300, cancelAt: 200 };
    expect(computeConnectEntitlement(facts, 199).validUntil).toBe(200);
    expect(computeConnectEntitlement(facts, 200).allowed).toBe(false);
  });
  it("never slides renewal grace or grants grace to an unpaid trial", () => {
    const facts = { ...base, status: "past_due", paidThrough: 200 };
    expect(computeConnectEntitlement(facts, 200).allowed).toBe(false);
    expect(computeConnectEntitlement(facts, 205, 10)).toMatchObject({
      reason: "grace",
      validUntil: 210,
    });
    expect(computeConnectEntitlement(facts, 210, 10).allowed).toBe(false);
    expect(
      computeConnectEntitlement({ ...facts, paidThrough: null, trialEnd: 200 }, 205, 10).allowed,
    ).toBe(false);
  });
  it("suspension and terminal timestamps override paid access", () => {
    expect(
      computeConnectEntitlement({ ...base, paidThrough: 300, suspended: true }, 100).reason,
    ).toBe("suspended");
    expect(
      computeConnectEntitlement({ ...base, paidThrough: 300, endedAt: 100 }, 100).allowed,
    ).toBe(false);
  });
  it("rejects invalid clocks and ignores non-finite provider boundaries", () => {
    expect(() => computeConnectEntitlement(base, NaN)).toThrow();
    expect(computeConnectEntitlement({ ...base, paidThrough: Infinity }, 100).allowed).toBe(false);
  });
});

describe("canonical access windows", () => {
  it("retains the original window through uninterrupted settled renewal", () => {
    expect(
      connectedAccessWindowStart(
        [
          { start: 100, end: 200, settledAt: 100 },
          { start: 200, end: 300, settledAt: 200 },
        ],
        null,
        250,
        0,
        false,
      ),
    ).toBe(100);
  });
  it("starts a new window after late settlement even if no cron ran during the gap", () => {
    const invoices = [
      { start: 100, end: 200, settledAt: 100 },
      { start: 200, end: 300, settledAt: 220 },
    ];
    expect(connectedAccessWindowStart(invoices, null, 250, 10, false)).toBe(220);
    expect(connectedAccessWindowStart(invoices, null, 215, 10, false)).toBeNull();
  });
  it("bridges renewal grace only from settled service and contiguous terms", () => {
    expect(
      connectedAccessWindowStart(
        [
          { start: 100, end: 200, settledAt: 100 },
          { start: 200, end: 300, settledAt: 205 },
        ],
        null,
        250,
        10,
        false,
      ),
    ).toBe(100);
    expect(
      connectedAccessWindowStart(
        [
          { start: 100, end: 200, settledAt: 100 },
          { start: 205, end: 300, settledAt: 205 },
        ],
        null,
        250,
        10,
        false,
      ),
    ).toBe(205);
    expect(connectedAccessWindowStart([], { start: 100, end: 200 }, 205, 10, true)).toBeNull();
  });
});
