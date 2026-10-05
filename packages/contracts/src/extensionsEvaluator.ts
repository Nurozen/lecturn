import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { DecisionEvaluationJudgment, DecisionEvaluationRequest } from "./relayDecisions.ts";
import {
  ContextualConflictCheckRequest,
  ContextualConflictJudgment,
  ContextualEquivalenceCheckRequest,
  ContextualEquivalenceJudgment,
  ContextualEvaluationRequest,
  ContextualJudgment,
} from "./contextual.ts";
import { ExtensionFeatureId } from "./extensions.ts";
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const ExtensionEvaluatorPolicyVersion = Schema.Literals([
  "decisions-v1",
  "contextual-v1",
  "contextual-localization-v1",
  "contextual-conflict-v1",
  "decisions-equivalence-v1",
]);
const identityFields = {
  environmentId: EnvironmentId,
  attemptId: id,
  featureId: ExtensionFeatureId,
  policyVersion: ExtensionEvaluatorPolicyVersion,
  model: Schema.Literal("extensions-v1"),
  requestFingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  admissibilityEpoch: counter,
};
/** Binding-only relay/evaluator seam. This is not a caller-selectable public inference API. */
export const ExtensionEvaluatorIdentity = Schema.Struct(identityFields).check(
  Schema.makeFilter(
    (v) =>
      v.attemptId.startsWith(`${v.admissibilityEpoch}:`) &&
      v.attemptId.length > String(v.admissibilityEpoch).length + 1,
  ),
);
export const ExtensionEvaluatorRequest = Schema.Union([
  Schema.Struct({
    ...identityFields,
    featureId: Schema.Literal("decisions"),
    policyVersion: Schema.Literal("decisions-v1"),
    request: DecisionEvaluationRequest,
  }),
  Schema.Struct({
    ...identityFields,
    featureId: Schema.Literal("contextual"),
    policyVersion: Schema.Literals(["contextual-v1", "contextual-localization-v1"]),
    request: ContextualEvaluationRequest,
  }),
  Schema.Struct({
    ...identityFields,
    policyVersion: Schema.Literal("contextual-conflict-v1"),
    request: ContextualConflictCheckRequest,
  }).check(Schema.makeFilter((v) => v.featureId === v.request.featureId)),
  Schema.Struct({
    ...identityFields,
    featureId: Schema.Literal("decisions"),
    policyVersion: Schema.Literal("decisions-equivalence-v1"),
    request: ContextualEquivalenceCheckRequest,
  }),
]).check(
  Schema.makeFilter(
    (v) =>
      v.attemptId.startsWith(`${v.admissibilityEpoch}:`) &&
      v.attemptId.length > String(v.admissibilityEpoch).length + 1,
  ),
);
const resultFields = {
  inputTokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  model: Schema.Literal("extensions-v1"),
};
export const ExtensionEvaluatorResult = Schema.Union([
  Schema.Struct({
    ...resultFields,
    policyVersion: Schema.Literal("decisions-v1"),
    judgments: Schema.Array(DecisionEvaluationJudgment).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
  }),
  Schema.Struct({
    ...resultFields,
    policyVersion: Schema.Literals(["contextual-v1", "contextual-localization-v1"]),
    judgments: Schema.Array(ContextualJudgment).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  Schema.Struct({
    ...resultFields,
    policyVersion: Schema.Literal("contextual-conflict-v1"),
    judgments: Schema.Array(ContextualConflictJudgment).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
  }),
  Schema.Struct({
    ...resultFields,
    policyVersion: Schema.Literal("decisions-equivalence-v1"),
    judgments: Schema.Array(ContextualEquivalenceJudgment).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
    qualificationId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  }),
]);
export const ExtensionEvaluatorResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    attemptId: id,
    result: ExtensionEvaluatorResult,
    replayed: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    attemptId: id,
    dispatched: Schema.Literal(false),
    reason: Schema.Literals(["invalid", "disabled", "unqualified-policy"]),
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    attemptId: id,
    reason: Schema.Literals(["dispatch-unresolved", "identity-conflict", "upstream-unknown"]),
  }),
  Schema.Struct({
    status: Schema.Literals(["in-progress", "expired", "not-found"]),
    attemptId: id,
  }),
]);
export const ExtensionEvaluatorCleanupRequest = Schema.Struct({
  environmentId: EnvironmentId,
  minimumAdmissibilityEpoch: counter,
  expireResultsBefore: IsoDateTime,
});
export const ExtensionEvaluatorCleanupResult = Schema.Struct({ status: Schema.Literal("cleaned") });
export type ExtensionEvaluatorPolicyVersion = typeof ExtensionEvaluatorPolicyVersion.Type;
export type ExtensionEvaluatorIdentity = typeof ExtensionEvaluatorIdentity.Type;
export type ExtensionEvaluatorRequest = typeof ExtensionEvaluatorRequest.Type;
export type ExtensionEvaluatorResult = typeof ExtensionEvaluatorResult.Type;
export type ExtensionEvaluatorResponse = typeof ExtensionEvaluatorResponse.Type;
export type ExtensionEvaluatorCleanupRequest = typeof ExtensionEvaluatorCleanupRequest.Type;
export type ExtensionEvaluatorCleanupResult = typeof ExtensionEvaluatorCleanupResult.Type;
