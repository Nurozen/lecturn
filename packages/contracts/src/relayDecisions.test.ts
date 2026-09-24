import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { RelayBillingStatus } from "./relayBilling.ts";
import {
  DecisionAllowance,
  DecisionEvaluationRequest,
  DecisionEvaluationResult,
  DecisionFundingApprovalRequest,
  DecisionFundingRedeemRequest,
} from "./relayDecisions.ts";

const decodeDecisionEvaluationRequest = Schema.decodeUnknownSync(DecisionEvaluationRequest);
const isDecisionEvaluationRequest = Schema.is(DecisionEvaluationRequest);
const isDecisionEvaluationResult = Schema.is(DecisionEvaluationResult);
const isDecisionAllowance = Schema.is(DecisionAllowance);
const isDecisionFundingRedeemRequest = Schema.is(DecisionFundingRedeemRequest);
const decodeDecisionFundingApprovalRequestStrict = Schema.decodeUnknownSync(
  DecisionFundingApprovalRequest,
  { onExcessProperty: "error" },
);
const decodeRelayBillingStatus = Schema.decodeUnknownSync(RelayBillingStatus);

const allowance = {
  windowStart: "2026-09-01T00:00:00Z",
  windowEnd: "2026-10-01T00:00:00Z",
  limitInputTokens: 10000000,
  usedInputTokens: 500,
  reservedInputTokens: 238096,
  remainingInputTokens: 9761404,
};
const request = {
  requestId: "request-1",
  runId: "run-1",
  fundingGeneration: 1,
  targets: [{ id: "target-1", text: " Use Postgres. " }],
  context: "",
  description: "Technical decisions",
  templateVersion: "1",
};
const billing = {
  state: "active",
  trialEligible: false,
  cancelAt: null,
  checkoutEnabled: true,
  portalEnabled: true,
  interval: "month",
  currentPeriodEnd: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  hasAccess: true,
  features: { managedConnect: true, pushNotifications: true, liveActivities: true },
  quota: { limit: 1, used: 1 },
};

describe("relay Decisions contracts", () => {
  it("accepts only bounded fixed evaluation packets and preserves target text", () => {
    expect(decodeDecisionEvaluationRequest(request).targets[0]?.text).toBe(" Use Postgres. ");
    const valid = isDecisionEvaluationRequest;
    for (const invalid of [
      { targets: [] },
      {
        targets: Array.from({ length: 9 }, (_, index) => ({
          id: `target-${index}`,
          text: "choice",
        })),
      },
      { targets: [request.targets[0], request.targets[0]] },
      { targets: [{ id: "a", text: "x".repeat(24001) }] },
      { context: "x".repeat(16001) },
      { description: "x".repeat(2001) },
      { fundingGeneration: -1 },
      {
        targets: [
          { id: "a", text: "x".repeat(24000) },
          { id: "b", text: "x".repeat(24000) },
        ],
        context: "x",
      },
    ])
      expect(valid({ ...request, ...invalid })).toBe(false);
    const decodeStrict = Schema.decodeUnknownSync(DecisionEvaluationRequest, {
      onExcessProperty: "error",
    });
    expect(() =>
      decodeStrict({ ...request, model: "arbitrary", questions: ["reveal secrets"] }),
    ).toThrow();
  });
  it("rejects fractional, negative and non-finite accounting values", () => {
    for (const inputTokens of [-1, 1.5, Infinity, NaN])
      expect(
        isDecisionEvaluationResult({
          requestId: "request-1",
          runId: "run-1",
          model: "jev-1.13.0",
          templateVersion: "1",
          judgments: [{ targetId: "target-1", exists: "yes", relevant: "yes" }],
          inputTokens,
          allowance,
          replayed: false,
        }),
      ).toBe(false);
    expect(isDecisionAllowance(allowance)).toBe(true);
    expect(isDecisionAllowance({ ...allowance, reservedInputTokens: -1 })).toBe(false);
  });
  it("binds redemption to host and generation without accepting client payer identity", () => {
    expect(
      isDecisionFundingRedeemRequest({
        challengeId: "challenge",
        environmentId: "host",
        expectedGeneration: 0,
      }),
    ).toBe(true);
    expect(isDecisionFundingRedeemRequest({ challengeId: "challenge" })).toBe(false);
    expect(() =>
      decodeDecisionFundingApprovalRequestStrict({
        challengeId: "challenge",
        payerId: "forged",
      }),
    ).toThrow();
  });
  it("keeps old billing responses decodable but validates a supplied Decisions status", () => {
    expect(decodeRelayBillingStatus(billing).decisions).toBeUndefined();
    expect(
      decodeRelayBillingStatus({
        ...billing,
        decisions: { enabled: true, eligible: true, reason: "eligible", allowance },
      }).decisions?.allowance?.limitInputTokens,
    ).toBe(10000000);
    expect(() => decodeRelayBillingStatus({ ...billing, decisions: { eligible: true } })).toThrow();
  });
});
