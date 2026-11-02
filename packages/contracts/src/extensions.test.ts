import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExtensionHostFundingRequest } from "./contextualRpc.ts";
import {
  ExtensionAllowance,
  ExtensionFeatureId,
  ExtensionFundingStatusResult,
  extensionFundingFor,
  ExtensionFundingApprovalRequest,
  ExtensionFundingObserveResult,
  ExtensionFundingAccountListResult,
  ExtensionFundingChallengeResult,
  ExtensionServiceStatus,
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
/** The funding status released clients decode, copied verbatim from before Squires existed. */
const LegacyFundingStatusResult = (() => {
  const id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
  const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
  const featureId = Schema.Literals(["decisions", "contextual"]);
  const reason = Schema.Literals([
    "eligible",
    "disabled",
    "not-paid",
    "trial",
    "stale-billing",
    "cohort",
    "unavailable",
  ]);
  const allowance = Schema.Struct({
    poolId: id,
    basis: Schema.Literals(["subscription", "grant"]),
    windowStart: Schema.String,
    windowEnd: Schema.String,
    limitInputTokens: counter,
    usedInputTokens: counter,
    reservedInputTokens: counter,
    remainingInputTokens: counter,
    byFeature: Schema.Array(
      Schema.Struct({ featureId, usedInputTokens: counter, reservedInputTokens: counter }),
    ).check(Schema.isMaxLength(2)),
  }).check(
    Schema.makeFilter(
      (v) =>
        Date.parse(v.windowStart) < Date.parse(v.windowEnd) &&
        new Set(v.byFeature.map((entry) => entry.featureId)).size === v.byFeature.length &&
        v.byFeature.reduce((sum, entry) => sum + entry.usedInputTokens, 0) === v.usedInputTokens &&
        v.byFeature.reduce((sum, entry) => sum + entry.reservedInputTokens, 0) ===
          v.reservedInputTokens &&
        Number.isSafeInteger(v.usedInputTokens + v.reservedInputTokens) &&
        v.remainingInputTokens ===
          Math.max(0, v.limitInputTokens - v.usedInputTokens - v.reservedInputTokens),
    ),
  );
  return Schema.Struct({
    featureId,
    environmentId: EnvironmentId,
    state: Schema.Literals(["unfunded", "pending", "active", "revoked", "unavailable"]),
    generation: counter,
    accountLabel: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
    eligible: Schema.Boolean,
    reason,
    allowance: Schema.NullOr(allowance),
    remoteRevocationPending: Schema.Boolean,
  }).check(Schema.makeFilter((v) => v.eligible === (v.reason === "eligible")));
})();
const decodeLegacyFundingStatus = Schema.decodeUnknownSync(LegacyFundingStatusResult);
const encodeFundingStatus = Schema.encodeSync(ExtensionFundingStatusResult);
const decodeFundingStatus = Schema.decodeUnknownSync(ExtensionFundingStatusResult);
const decodeHostFundingRequest = Schema.decodeUnknownSync(ExtensionHostFundingRequest, {
  onExcessProperty: "error",
});
const isAllowance = Schema.is(ExtensionAllowance);
const decodeAllowance = Schema.decodeUnknownSync(ExtensionAllowance);
const encodeAllowance = Schema.encodeSync(ExtensionAllowance);
const decodeServiceStatus = Schema.decodeUnknownSync(ExtensionServiceStatus);
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
  it("accounts for Squires as a third feature while two-feature payloads still decode", () => {
    const decode = decodeAllowance;
    expect(decode(allowance).byFeature).toHaveLength(2);
    const three = {
      ...allowance,
      usedInputTokens: 260,
      remainingInputTokens: 540,
      byFeature: [
        ...allowance.byFeature,
        { featureId: "squires", usedInputTokens: 10, reservedInputTokens: 0 },
      ],
    };
    const encoded = encodeAllowance(decode(three));
    expect(decode(encoded)).toEqual(three);
    expect(
      isAllowance({
        ...three,
        byFeature: [
          ...three.byFeature,
          { featureId: "squires", usedInputTokens: 0, reservedInputTokens: 0 },
        ],
      }),
    ).toBe(false);
    const feature = (featureId: string) => ({
      featureId,
      available: true,
      enabled: false,
      eligible: false,
      reason: "disabled",
    });
    expect(
      decodeServiceStatus({
        features: [feature("decisions"), feature("contextual")],
        allowance: null,
      }).features,
    ).toHaveLength(2);
    expect(
      decodeServiceStatus({
        features: [feature("decisions"), feature("contextual"), feature("squires")],
        allowance: null,
      }).features.map((entry) => entry.featureId),
    ).toEqual(["decisions", "contextual", "squires"]);
    expect(strictApproval({ featureId: "squires", challengeId: "challenge" }).featureId).toBe(
      "squires",
    );
  });
  it("folds a feature this build does not know out of the pool instead of failing", () => {
    const future = {
      ...allowance,
      usedInputTokens: 280,
      reservedInputTokens: 210,
      remainingInputTokens: 510,
      byFeature: [
        ...allowance.byFeature,
        { featureId: "future-feature", usedInputTokens: 30, reservedInputTokens: 10 },
      ],
    };
    const decoded = decodeAllowance(future);
    expect(decoded).toEqual({ ...allowance, limitInputTokens: 960, remainingInputTokens: 510 });
    expect(decodeAllowance(encodeAllowance(decoded))).toEqual(decoded);
    // Unknown entries are still held to the wire totals, and known entries still fail loudly.
    expect(() => decodeAllowance({ ...future, usedInputTokens: 300 })).toThrow();
    expect(() =>
      decodeAllowance({
        ...future,
        byFeature: [
          { ...allowance.byFeature[0], usedInputTokens: -1 },
          ...future.byFeature.slice(1),
        ],
      }),
    ).toThrow();
    const feature = (featureId: string) => ({
      featureId,
      available: true,
      enabled: true,
      eligible: true,
      reason: "eligible",
    });
    expect(
      decodeServiceStatus({
        features: [feature("decisions"), feature("future-feature"), feature("squires")],
        allowance: future,
      }),
    ).toEqual({
      features: [feature("decisions"), feature("squires")],
      allowance: decoded,
    });
  });
  it("serves clients that predate Squires an allowance they can decode", () => {
    const withSquires = decodeFundingStatus({
      featureId: "contextual",
      environmentId: "env-fixture",
      state: "active",
      generation: 1,
      accountLabel: "Lecturn account",
      eligible: true,
      reason: "eligible",
      remoteRevocationPending: false,
      allowance: {
        ...allowance,
        usedInputTokens: 290,
        reservedInputTokens: 220,
        remainingInputTokens: 490,
        byFeature: [
          ...allowance.byFeature,
          { featureId: "squires", usedInputTokens: 40, reservedInputTokens: 20 },
        ],
      },
    });
    expect(() => decodeLegacyFundingStatus(encodeFundingStatus(withSquires))).toThrow();
    // A request without `features` came from an older client: Squires is folded out.
    const legacy = decodeLegacyFundingStatus(
      encodeFundingStatus(extensionFundingFor(withSquires, undefined)),
    );
    expect(legacy.allowance).toEqual({
      ...allowance,
      limitInputTokens: 940,
      remainingInputTokens: 490,
    });
    const current = extensionFundingFor(withSquires, ExtensionFeatureId.literals);
    expect(current).toEqual(withSquires);
    // Old payloads still decode, and a newer client's unknown feature names are ignored.
    const create = { featureId: "contextual", operation: "create", expectedGeneration: 0 };
    expect(decodeHostFundingRequest(create)).toEqual(create);
    expect(
      decodeHostFundingRequest({ ...create, features: ["contextual", "future-feature"] }).features,
    ).toEqual(["contextual", "future-feature"]);
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
