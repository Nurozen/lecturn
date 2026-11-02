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
import { ExtensionAllowance, ExtensionFeatureId } from "./extensions.ts";
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const ExtensionEvaluatorPolicyVersion = Schema.Literals([
  "decisions-v1",
  "contextual-v1",
  "contextual-localization-v1",
  "contextual-conflict-v1",
  "decisions-equivalence-v1",
  "squire-routing-v1",
]);

/**
 * Squire room routing (P19.4). Only names, briefs, scopes, recent activity
 * titles and the post itself cross the wire. The hosted `squire-routing-v1`
 * policy asks Jev one `choice` over the member ids plus `lead` ("needs the
 * Lead"), at most 7 options, and one `noul` "does this post need no reply".
 */
export const SQUIRE_ROUTING_LEAD_CHOICE = "lead";
export const SQUIRE_ROUTING_MAX_MEMBERS = 6;
export const SQUIRE_ROUTING_BRIEF_MAX_CHARS = 500;
export const SQUIRE_ROUTING_THREAD_TITLES_MAX = 20;
const squireText = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const squireMemberId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((v) => v !== SQUIRE_ROUTING_LEAD_CHOICE),
);
export const SquireRoutingMember = Schema.Struct({
  squireId: squireMemberId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  brief: squireText(SQUIRE_ROUTING_BRIEF_MAX_CHARS),
  scope: Schema.Struct({
    containers: Schema.Array(squireText(200)).check(Schema.isMaxLength(20)),
    threadTitles: Schema.Array(squireText(500)).check(
      Schema.isMaxLength(SQUIRE_ROUTING_THREAD_TITLES_MAX),
    ),
    pullRequests: Schema.Array(NonNegativeInt).check(Schema.isMaxLength(100)),
  }),
  recentActivity: Schema.Array(squireText(200)).check(Schema.isMaxLength(10)),
});
export const SquireRoutingRequest = Schema.Struct({
  featureId: Schema.Literal("squires"),
  requestId: id,
  runId: id,
  fundingGeneration: counter,
  templateVersion: Schema.Literal("squire-routing-v1"),
  members: Schema.Array(SquireRoutingMember).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SQUIRE_ROUTING_MAX_MEMBERS),
    Schema.makeFilter((v) => new Set(v.map((m) => m.squireId)).size === v.length),
  ),
  post: Schema.Struct({ body: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)) }),
});
const probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
/** Jev's `choice` (a member id or `lead`), its spread-based confidence, and the `noul`. */
export const SquireRoutingJudgment = Schema.Struct({
  choice: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  confidence: probability,
  noReplyConfidence: probability,
});
/** True when the judgment names one of the request's members or the Lead. */
export const squireRoutingJudgmentMatches = (
  request: Pick<SquireRoutingRequest, "members">,
  judgment: Pick<SquireRoutingJudgment, "choice">,
) =>
  judgment.choice === SQUIRE_ROUTING_LEAD_CHOICE ||
  request.members.some((member) => member.squireId === judgment.choice);
export const SquireRoutingResult = Schema.Struct({
  requestId: id,
  runId: id,
  templateVersion: Schema.Literal("squire-routing-v1"),
  policyVersion: Schema.Literal("squire-routing-v1"),
  model: id,
  judgments: Schema.Array(SquireRoutingJudgment).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1),
  ),
  inputTokens: counter,
  allowance: ExtensionAllowance,
  replayed: Schema.Boolean,
});
export type SquireRoutingMember = typeof SquireRoutingMember.Type;
export type SquireRoutingRequest = typeof SquireRoutingRequest.Type;
export type SquireRoutingJudgment = typeof SquireRoutingJudgment.Type;
export type SquireRoutingResult = typeof SquireRoutingResult.Type;

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
  Schema.Struct({
    ...identityFields,
    featureId: Schema.Literal("squires"),
    policyVersion: Schema.Literal("squire-routing-v1"),
    request: SquireRoutingRequest,
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
  Schema.Struct({
    ...resultFields,
    policyVersion: Schema.Literal("squire-routing-v1"),
    judgments: Schema.Array(SquireRoutingJudgment).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1),
    ),
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
