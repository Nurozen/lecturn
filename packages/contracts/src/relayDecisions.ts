import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const DecisionAllowance = Schema.Struct({
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  limitInputTokens: counter,
  usedInputTokens: counter,
  reservedInputTokens: counter,
  remainingInputTokens: counter,
});
export const RelayDecisionsStatus = Schema.Struct({
  enabled: Schema.Boolean,
  eligible: Schema.Boolean,
  reason: Schema.Literals([
    "eligible",
    "disabled",
    "not-paid",
    "trial",
    "stale-billing",
    "cohort",
    "unavailable",
  ]),
  allowance: Schema.NullOr(DecisionAllowance),
});
export const DecisionEvaluationTarget = Schema.Struct({
  id: identifier,
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(24000)),
});
/** The service owns model and questions; neither can be selected by callers. */
export const DecisionEvaluationRequest = Schema.Struct({
  explicitRetry: Schema.optionalKey(Schema.Boolean),
  requestId: identifier,
  runId: identifier,
  fundingGeneration: counter,
  targets: Schema.Array(DecisionEvaluationTarget).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  context: text(16000),
  description: text(2000),
  templateVersion: identifier,
}).check(
  Schema.makeFilter(
    (value) =>
      new Set(value.targets.map((target) => target.id)).size === value.targets.length &&
      value.targets.reduce(
        (total, target) => total + target.text.length,
        value.context.length + value.description.length,
      ) <= 48000,
  ),
);
export const DecisionEvaluationJudgment = Schema.Struct({
  targetId: identifier,
  exists: Schema.Literals(["yes", "no", "uncertain"]),
  relevant: Schema.Literals(["yes", "no", "uncertain"]),
});
export const DecisionEvaluationResult = Schema.Struct({
  requestId: identifier,
  runId: identifier,
  model: identifier,
  templateVersion: identifier,
  judgments: Schema.Array(DecisionEvaluationJudgment).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  inputTokens: counter,
  allowance: DecisionAllowance,
  replayed: Schema.Boolean,
});
export const DecisionFundingChallengeRequest = Schema.Struct({
  environmentId: EnvironmentId,
  publicKey: identifier,
  expectedGeneration: counter,
});
export const DecisionFundingChallengeResult = Schema.Struct({
  challengeId: identifier,
  generation: counter,
  approvalUrl: Schema.String.check(Schema.isMaxLength(2000)),
  expiresAt: IsoDateTime,
});
/** Payer identity comes from authenticated account middleware, never this body. */
export const DecisionFundingApprovalInfo = Schema.Struct({
  challengeId: identifier,
  environmentId: EnvironmentId,
  environmentLabel: text(200),
  expiresAt: IsoDateTime,
  approved: Schema.Boolean,
  eligible: Schema.Boolean,
});
export type DecisionFundingApprovalInfo = typeof DecisionFundingApprovalInfo.Type;
export const DecisionFundingApprovalRequest = Schema.Struct({ challengeId: identifier });
export const DecisionFundingApprovalResult = Schema.Struct({
  challengeId: identifier,
  approved: Schema.Boolean,
  expiresAt: IsoDateTime,
});
export const DecisionFundingRedeemRequest = Schema.Struct({
  challengeId: identifier,
  environmentId: EnvironmentId,
  expectedGeneration: counter,
});
export const DecisionFundingStatusRequest = Schema.Struct({ environmentId: EnvironmentId });
export const DecisionFundingStatusResult = Schema.Struct({
  environmentId: EnvironmentId,
  state: Schema.Literals(["unfunded", "pending", "active", "revoked", "unavailable"]),
  generation: counter,
  accountLabel: Schema.NullOr(text(200)),
  eligible: Schema.Boolean,
  allowance: Schema.NullOr(DecisionAllowance),
  remoteRevocationPending: Schema.Boolean,
});
export const DecisionFundingRedeemResult = DecisionFundingStatusResult;
export const DecisionFundingAccountListRequest = Schema.Struct({
  cursor: Schema.optionalKey(identifier),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export const DecisionFundedEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: text(200),
  generation: counter,
});
export const DecisionFundingAccountListResult = Schema.Struct({
  environments: Schema.Array(DecisionFundedEnvironment).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(identifier),
});
export type DecisionFundingAccountListRequest = typeof DecisionFundingAccountListRequest.Type;
export type DecisionFundingAccountListResult = typeof DecisionFundingAccountListResult.Type;
export type DecisionFundedEnvironment = typeof DecisionFundedEnvironment.Type;
export const DecisionFundingRevokeRequest = Schema.Struct({
  environmentId: EnvironmentId,
  expectedGeneration: counter,
});
export const DecisionFundingRevokeResult = DecisionFundingStatusResult;
export class DecisionEvaluationError extends Schema.TaggedErrorClass<DecisionEvaluationError>()(
  "DecisionEvaluationError",
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
    ]),
    message: Schema.String,
  },
) {}

export type DecisionAllowance = typeof DecisionAllowance.Type;
export type RelayDecisionsStatus = typeof RelayDecisionsStatus.Type;
export type DecisionEvaluationTarget = typeof DecisionEvaluationTarget.Type;
export type DecisionEvaluationRequest = typeof DecisionEvaluationRequest.Type;
export type DecisionEvaluationJudgment = typeof DecisionEvaluationJudgment.Type;
export type DecisionEvaluationResult = typeof DecisionEvaluationResult.Type;
export type DecisionFundingChallengeRequest = typeof DecisionFundingChallengeRequest.Type;
export type DecisionFundingChallengeResult = typeof DecisionFundingChallengeResult.Type;
export type DecisionFundingApprovalRequest = typeof DecisionFundingApprovalRequest.Type;
export type DecisionFundingApprovalResult = typeof DecisionFundingApprovalResult.Type;
export type DecisionFundingRedeemRequest = typeof DecisionFundingRedeemRequest.Type;
export type DecisionFundingStatusRequest = typeof DecisionFundingStatusRequest.Type;
export type DecisionFundingStatusResult = typeof DecisionFundingStatusResult.Type;
export type DecisionFundingRedeemResult = typeof DecisionFundingRedeemResult.Type;
export type DecisionFundingRevokeRequest = typeof DecisionFundingRevokeRequest.Type;
export type DecisionFundingRevokeResult = typeof DecisionFundingRevokeResult.Type;
