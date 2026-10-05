import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ExtensionAllowance,
  ExtensionFundingApprovalRequest,
  ExtensionFundingObserveResult,
  ExtensionFundingAccountListResult,
  ExtensionFundingChallengeResult,
} from "./extensions.ts";

const allowance = {
  poolId: "pool-1",
  basis: "subscription",
  windowStart: "2026-09-01T00:00:00Z",
  windowEnd: "2026-10-01T00:00:00Z",
  limitInputTokens: 1000,
  usedInputTokens: 250,
  reservedInputTokens: 200,
  remainingInputTokens: 550,
  byFeature: [
    { featureId: "decisions", usedInputTokens: 150, reservedInputTokens: 200 },
    { featureId: "contextual", usedInputTokens: 100, reservedInputTokens: 0 },
  ],
};
const isAllowance = Schema.is(ExtensionAllowance);
const isObservation = Schema.is(ExtensionFundingObserveResult);
const isAccountList = Schema.is(ExtensionFundingAccountListResult);
const isChallenge = Schema.is(ExtensionFundingChallengeResult);
const strictApproval = Schema.decodeUnknownSync(ExtensionFundingApprovalRequest, {
  onExcessProperty: "error",
});

describe("extension paid contracts", () => {
  it("accounts for both features inside one pool and rejects inconsistent totals", () => {
    expect(isAllowance(allowance)).toBe(true);
    expect(isAllowance({ ...allowance, remainingInputTokens: 1000 })).toBe(false);
    expect(isAllowance({ ...allowance, byFeature: allowance.byFeature.slice(0, 1) })).toBe(false);
    expect(
      isAllowance({ ...allowance, byFeature: [allowance.byFeature[0], allowance.byFeature[0]] }),
    ).toBe(false);
    expect(isAllowance({ ...allowance, windowEnd: allowance.windowStart })).toBe(false);
    expect(isAllowance({ ...allowance, limitInputTokens: 100, remainingInputTokens: 0 })).toBe(
      true,
    );
  });
  it("does not accept wildcard consent, caller-selected payer or credentials", () => {
    expect(strictApproval({ featureId: "contextual", challengeId: "challenge" }).featureId).toBe(
      "contextual",
    );
    for (const invalid of [
      { featureId: "*", challengeId: "challenge" },
      { featureId: "contextual", challengeId: "challenge", payerId: "someone-else" },
      { featureId: "decisions", challengeId: "challenge", token: "secret" },
    ])
      expect(() => strictApproval(invalid)).toThrow();
  });
  it("keeps browser approval separate from host linking and hides an unapproved payer", () => {
    const result = {
      featureId: "contextual",
      environmentId: "env-fixture",
      challengeId: "challenge",
      generation: 2,
      expiresAt: "2026-10-01T00:00:00Z",
      state: "awaiting-approval",
      accountLabel: null,
    };
    expect(isObservation(result)).toBe(true);
    expect(isObservation({ ...result, accountLabel: "Unapproved account" })).toBe(false);
    expect(
      isObservation({ ...result, state: "approved-awaiting-host", accountLabel: "Selected payer" }),
    ).toBe(true);
    expect(isObservation({ ...result, state: "linked", accountLabel: "Selected payer" })).toBe(
      true,
    );
    expect(isObservation({ ...result, state: "approved" })).toBe(false);
  });
  it("prevents mixed-feature account listings and executable approval URLs", () => {
    const row = {
      featureId: "decisions",
      environmentId: "env-fixture",
      environmentLabel: "Host",
      generation: 1,
    };
    expect(isAccountList({ featureId: "decisions", environments: [row], nextCursor: null })).toBe(
      true,
    );
    expect(isAccountList({ featureId: "contextual", environments: [row], nextCursor: null })).toBe(
      false,
    );
    expect(
      isAccountList({ featureId: "decisions", environments: [row, row], nextCursor: null }),
    ).toBe(false);
    const challenge = {
      featureId: "decisions",
      environmentId: "env-fixture",
      challengeId: "challenge",
      generation: 1,
      expiresAt: "2026-10-01T00:00:00Z",
    };
    expect(
      isChallenge({ ...challenge, approvalUrl: "https://app.example/approval?id=challenge" }),
    ).toBe(true);
    expect(isChallenge({ ...challenge, approvalUrl: "javascript:alert(1)" })).toBe(false);
  });
});
