import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const ExtensionFeatureId = Schema.Literals(["decisions", "contextual"]);
export type ExtensionFeatureId = typeof ExtensionFeatureId.Type;
export const ExtensionEligibilityReason = Schema.Literals([
  "eligible",
  "disabled",
  "not-paid",
  "trial",
  "stale-billing",
  "cohort",
  "unavailable",
]);
export const ExtensionFeatureUsage = Schema.Struct({
  featureId: ExtensionFeatureId,
  usedInputTokens: counter,
  reservedInputTokens: counter,
});
/** Both features report against this one payer/window descriptor, never separate balances. */
export const ExtensionAllowance = Schema.Struct({
  poolId: id,
  basis: Schema.Literals(["subscription", "grant"]),
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  limitInputTokens: counter,
  usedInputTokens: counter,
  reservedInputTokens: counter,
  remainingInputTokens: counter,
  byFeature: Schema.Array(ExtensionFeatureUsage).check(Schema.isMaxLength(2)),
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
export type ExtensionAllowance = typeof ExtensionAllowance.Type;
export const ExtensionFeatureAvailability = Schema.Struct({
  featureId: ExtensionFeatureId,
  available: Schema.Boolean,
  enabled: Schema.Boolean,
  eligible: Schema.Boolean,
  reason: ExtensionEligibilityReason,
}).check(
  Schema.makeFilter((v) =>
    v.eligible ? v.enabled && v.reason === "eligible" : v.reason !== "eligible",
  ),
);
export const ExtensionServiceStatus = Schema.Struct({
  features: Schema.Array(ExtensionFeatureAvailability).check(
    Schema.isMaxLength(2),
    Schema.makeFilter((v) => new Set(v.map((f) => f.featureId)).size === v.length),
  ),
  allowance: Schema.NullOr(ExtensionAllowance),
});
export type ExtensionServiceStatus = typeof ExtensionServiceStatus.Type;

const featureEnvironment = { featureId: ExtensionFeatureId, environmentId: EnvironmentId };
const challengeIdentity = { ...featureEnvironment, challengeId: id, generation: counter };
export const ExtensionFundingChallengeRequest = Schema.Struct({
  ...featureEnvironment,
  publicKey: id,
  expectedGeneration: counter,
});
export const ExtensionFundingChallengeResult = Schema.Struct({
  ...challengeIdentity,
  approvalUrl: Schema.String.check(
    Schema.isMaxLength(2000),
    Schema.isPattern(/^https?:\/\/[^\s]+$/),
  ),
  expiresAt: IsoDateTime,
});
export const ExtensionFundingChallengeState = Schema.Literals([
  "awaiting-approval",
  "approved-awaiting-host",
  "linked",
  "expired",
  "revoked",
  "canceled",
]);
export const ExtensionFundingApprovalInfo = Schema.Struct({
  ...challengeIdentity,
  environmentLabel: text(200),
  expiresAt: IsoDateTime,
  state: ExtensionFundingChallengeState,
  eligible: Schema.Boolean,
  reason: ExtensionEligibilityReason,
}).check(Schema.makeFilter((v) => v.eligible === (v.reason === "eligible")));
/** The selected payer is authenticated by middleware, never supplied in a request body. */
export const ExtensionFundingApprovalRequest = Schema.Struct({
  featureId: ExtensionFeatureId,
  challengeId: id,
});
export const ExtensionFundingApprovalResult = Schema.Struct({
  ...challengeIdentity,
  state: Schema.Literal("approved-awaiting-host"),
  expiresAt: IsoDateTime,
});
export const ExtensionFundingObserveRequest = Schema.Struct({
  ...featureEnvironment,
  challengeId: id,
  expectedGeneration: counter,
});
export const ExtensionFundingObserveResult = Schema.Struct({
  ...challengeIdentity,
  state: ExtensionFundingChallengeState,
  expiresAt: IsoDateTime,
  accountLabel: Schema.NullOr(text(200)),
}).check(Schema.makeFilter((v) => v.state !== "awaiting-approval" || v.accountLabel === null));
export const ExtensionFundingRedeemRequest = ExtensionFundingObserveRequest;
export const ExtensionFundingStatusRequest = Schema.Struct(featureEnvironment);
export const ExtensionFundingStatusResult = Schema.Struct({
  ...featureEnvironment,
  state: Schema.Literals(["unfunded", "pending", "active", "revoked", "unavailable"]),
  generation: counter,
  accountLabel: Schema.NullOr(text(200)),
  eligible: Schema.Boolean,
  reason: ExtensionEligibilityReason,
  allowance: Schema.NullOr(ExtensionAllowance),
  remoteRevocationPending: Schema.Boolean,
}).check(Schema.makeFilter((v) => v.eligible === (v.reason === "eligible")));
export const ExtensionFundingRedeemResult = ExtensionFundingStatusResult;
export const ExtensionFundingCancelRequest = ExtensionFundingObserveRequest;
export const ExtensionFundingCancelResult = ExtensionFundingObserveResult;
export const ExtensionFundingAccountListRequest = Schema.Struct({
  featureId: ExtensionFeatureId,
  cursor: Schema.optionalKey(id),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export const ExtensionFundedEnvironment = Schema.Struct({
  ...featureEnvironment,
  environmentLabel: text(200),
  generation: counter,
});
export const ExtensionFundingAccountListResult = Schema.Struct({
  featureId: ExtensionFeatureId,
  environments: Schema.Array(ExtensionFundedEnvironment).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(id),
}).check(
  Schema.makeFilter(
    (v) =>
      v.environments.every((entry) => entry.featureId === v.featureId) &&
      new Set(v.environments.map((entry) => entry.environmentId)).size === v.environments.length,
  ),
);
export const ExtensionFundingRevokeRequest = Schema.Struct({
  ...featureEnvironment,
  expectedGeneration: counter,
});
export const ExtensionFundingRevokeResult = ExtensionFundingStatusResult;
export const ExtensionAttemptIdentity = Schema.Struct({
  featureId: ExtensionFeatureId,
  requestId: id,
  runId: id,
  fundingGeneration: counter,
});
export const ExtensionEvaluationStatusRequest = Schema.Struct({
  featureId: ExtensionFeatureId,
  requestId: id,
  fundingGeneration: counter,
});
export const ExtensionEvaluationStatusResult = Schema.Struct({
  featureId: ExtensionFeatureId,
  requestId: id,
  state: Schema.Literals(["pending", "succeeded", "unknown", "refused-before-dispatch", "expired"]),
  inputTokens: Schema.NullOr(counter),
  allowance: Schema.NullOr(ExtensionAllowance),
});
export class ExtensionEvaluationError extends Schema.TaggedErrorClass<ExtensionEvaluationError>()(
  "ExtensionEvaluationError",
  {
    code: Schema.Literals([
      "invalid",
      "forbidden",
      "unavailable",
      "conflict",
      "allowance-exhausted",
      "run-budget-exhausted",
      "rate-limited",
      "in-progress",
      "expired",
      "unsupported",
    ]),
    message: text(500),
  },
) {}

export type ExtensionFundingChallengeRequest = typeof ExtensionFundingChallengeRequest.Type;
export type ExtensionFundingChallengeResult = typeof ExtensionFundingChallengeResult.Type;
export type ExtensionFundingApprovalInfo = typeof ExtensionFundingApprovalInfo.Type;
export type ExtensionFundingApprovalRequest = typeof ExtensionFundingApprovalRequest.Type;
export type ExtensionFundingApprovalResult = typeof ExtensionFundingApprovalResult.Type;
export type ExtensionFundingObserveRequest = typeof ExtensionFundingObserveRequest.Type;
export type ExtensionFundingObserveResult = typeof ExtensionFundingObserveResult.Type;
export type ExtensionFundingRedeemRequest = typeof ExtensionFundingRedeemRequest.Type;
export type ExtensionFundingRedeemResult = typeof ExtensionFundingRedeemResult.Type;
export type ExtensionFundingCancelRequest = typeof ExtensionFundingCancelRequest.Type;
export type ExtensionFundingCancelResult = typeof ExtensionFundingCancelResult.Type;
export type ExtensionFundingStatusRequest = typeof ExtensionFundingStatusRequest.Type;
export type ExtensionFundingStatusResult = typeof ExtensionFundingStatusResult.Type;
export type ExtensionFundingAccountListRequest = typeof ExtensionFundingAccountListRequest.Type;
export type ExtensionFundingAccountListResult = typeof ExtensionFundingAccountListResult.Type;
export type ExtensionFundedEnvironment = typeof ExtensionFundedEnvironment.Type;
export type ExtensionFundingRevokeRequest = typeof ExtensionFundingRevokeRequest.Type;
export type ExtensionFundingRevokeResult = typeof ExtensionFundingRevokeResult.Type;
export type ExtensionAttemptIdentity = typeof ExtensionAttemptIdentity.Type;
export type ExtensionEvaluationStatusRequest = typeof ExtensionEvaluationStatusRequest.Type;
export type ExtensionEvaluationStatusResult = typeof ExtensionEvaluationStatusResult.Type;
