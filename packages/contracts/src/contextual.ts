import * as Schema from "effect/Schema";
import { ExtensionAllowance } from "./extensions.ts";
import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  DecisionAttribution,
  DecisionId,
  DecisionLifecycle,
  DecisionReviewState,
  DecisionProvenance,
} from "./threadDecisions.ts";

export const CONTEXTUAL_LIMITS = {
  candidates: 24,
  targets: 8,
  requestCharacters: 48000,
  attempts: 6,
  comparisonPairs: 12,
  packetGroups: 2,
  packetTokens: 1500,
} as const;
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const ids = (max: number) =>
  Schema.Array(id).check(
    Schema.isMaxLength(max),
    Schema.makeFilter((values) => new Set(values).size === values.length),
  );
export const ContextualRevision = counter;
export const ContextualSourceKind = Schema.Literals(["slack", "lecturn-decision"]);
export const ContextualReason = Schema.Literals([
  "constraint",
  "decision",
  "explanation",
  "conflict",
]);
export const ContextualCoverage = Schema.Struct({
  complete: Schema.Boolean,
  missingAntecedents: Schema.Boolean,
  truncated: Schema.Boolean,
  unexaminedCount: counter,
});
export const ContextualSource = Schema.Struct({
  id,
  sourceKind: ContextualSourceKind,
  label: text(200),
  hostName: text(200),
  workspaceId: Schema.NullOr(id),
  channelId: Schema.NullOr(id),
  conversationType: Schema.Literals([
    "channel",
    "private-channel",
    "dm",
    "group-dm",
    "unknown",
    "decisions",
  ]),
  available: Schema.Boolean,
  selected: Schema.Boolean,
});
export const ContextualSourcePolicy = Schema.Struct({
  allowedSourceIds: ids(256),
  allowDirectMessages: Schema.Boolean,
  allowGroupDirectMessages: Schema.Boolean,
  unknownConversationPolicy: Schema.Literal("exclude"),
  draftsPolicy: Schema.Literal("exclude"),
  revision: counter,
});
export const ContextualSourceConfiguration = Schema.Struct({
  expectedRevision: counter,
  policy: ContextualSourcePolicy,
}).check(Schema.makeFilter((v) => v.policy.revision === v.expectedRevision + 1));
export const ContextualProjectSettings = Schema.Struct({
  projectId: ProjectId,
  defaultEnabled: Schema.Boolean,
  sourceIds: ids(256),
  revision: counter,
});
export const ContextualThreadSettings = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
  sourceIds: ids(256),
  revision: counter,
  exclusionRevision: counter,
});
export const ContextualEffectiveState = Schema.Struct({
  enabled: Schema.Boolean,
  effective: Schema.Boolean,
  reason: Schema.Literals([
    "ready",
    "off",
    "funding-required",
    "allowance-exhausted",
    "helper-unavailable",
    "source-unavailable",
    "unsupported-provider",
    "unavailable",
  ]),
  slackAvailable: Schema.Boolean,
  decisionsAvailable: Schema.Boolean,
  collectionState: Schema.Literals(["running", "paused", "unavailable"]),
}).check(
  Schema.makeFilter((v) =>
    v.effective ? v.enabled && v.reason === "ready" : v.reason !== "ready",
  ),
);
export const ContextualTaskSnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  submissionId: id,
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  providerInstanceId: id,
  providerContextEpoch: id,
  taskFingerprint: id,
  knownContextFingerprint: id,
  threadSettingsRevision: counter,
  projectSettingsRevision: counter,
  sourceScopeRevision: counter,
  threadExclusionRevision: counter,
  fundingGeneration: counter,
  purgeGeneration: counter,
  newestMessage: text(16000),
  projectDescription: text(2000),
  explicitReferences: Schema.Array(text(256)).check(Schema.isMaxLength(32)),
  recentContext: text(16000),
  trigger: Schema.Literals(["submission", "refresh", "confirmed-compaction", "correction"]),
});
/** Offsets are half-open JavaScript UTF-16 code units, never native byte offsets. */
export const ContextualSourceLocator = Schema.Union([
  Schema.Struct({
    sourceKind: Schema.Literal("slack"),
    workspaceId: id,
    channelId: id,
    messageTs: Schema.String.check(Schema.isPattern(/^\d+\.\d+$/)),
    threadTs: Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d+\.\d+$/))),
  }),
  Schema.Struct({
    sourceKind: Schema.Literal("lecturn-decision"),
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    messageId: MessageId,
    messageRole: Schema.Literals(["user", "assistant"]),
    decisionId: DecisionId,
    evidenceId: id,
  }),
]);
export const ContextualEvidence = Schema.Struct({
  locator: ContextualSourceLocator,
  id,
  sourceId: id,
  sourceKind: ContextualSourceKind,
  occurrenceId: id,
  sourceRevision: counter,
  sourceHash: id,
  canonicalVersion: id,
  coordinateSystem: Schema.Literal("utf16"),
  quote: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8000)),
  start: counter,
  end: counter,
  prefix: text(128),
  suffix: text(128),
  author: text(200),
  occurredAt: IsoDateTime,
  observedAt: IsoDateTime,
  sourceUrl: Schema.NullOr(text(2000)),
  availability: Schema.Literals(["available", "stored-only", "changed", "missing", "forgotten"]),
  lineageIds: ids(64),
}).check(
  Schema.makeFilter(
    (v) =>
      v.locator.sourceKind === v.sourceKind &&
      v.end > v.start &&
      v.end - v.start === v.quote.length,
  ),
);
const candidateFields = {
  id,
  sourceId: id,
  occurrenceId: id,
  recordRevision: counter,
  guidanceId: id,
  contentFingerprint: id,
  lineageIds: ids(64),
  coverage: ContextualCoverage,
  evidence: Schema.Array(ContextualEvidence).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
    Schema.makeFilter((v) => new Set(v.map((e) => e.id)).size === v.length),
  ),
  state: Schema.Literals([
    "not-yet-evaluated",
    "not-useful-for-this-task",
    "deferred-by-budget",
    "ready",
    "supplied",
    "suppressed",
  ]),
};
export const ContextualSlackCandidate = Schema.Struct({
  ...candidateFields,
  sourceKind: Schema.Literal("slack"),
  workspaceId: id,
  channelId: id,
  messageTs: Schema.String.check(Schema.isPattern(/^\d+\.\d+$/)),
  threadTs: Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d+\.\d+$/))),
}).check(
  Schema.makeFilter((v) =>
    v.evidence.every((e) => e.sourceKind === "slack" && e.sourceId === v.sourceId),
  ),
);
export const ContextualDecisionCandidate = Schema.Struct({
  ...candidateFields,
  sourceKind: Schema.Literal("lecturn-decision"),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  decisionId: DecisionId,
  decisionRevision: counter,
  attribution: DecisionAttribution,
  reviewState: DecisionReviewState,
  lifecycle: DecisionLifecycle,
  replacementIds: Schema.Array(DecisionId).check(Schema.isMaxLength(32)),
  derivedSummary: Schema.Struct({
    title: text(160),
    body: text(4000),
    rationale: Schema.NullOr(text(2000)),
    userEdited: Schema.Boolean,
  }),
});
export const ContextualCandidate = Schema.Union([
  ContextualSlackCandidate,
  ContextualDecisionCandidate,
]);
const candidates = Schema.Array(ContextualCandidate).check(
  Schema.isMaxLength(24),
  Schema.makeFilter((v) => new Set(v.map((c) => c.id)).size === v.length),
);
export const ContextualRetrieveRequest = Schema.Struct({
  task: ContextualTaskSnapshot,
  sourceIds: ids(256),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 })),
  includeHistorical: Schema.Boolean,
});
export const ContextualRetrieveResult = Schema.Struct({
  candidates,
  coverage: ContextualCoverage,
  sourceGeneration: counter,
  purgeGeneration: counter,
});
export const ContextualPolicyVersion = Schema.Literal("contextual-v1");
export const ContextualEvaluationRequest = Schema.Struct({
  featureId: Schema.Literal("contextual"),
  requestId: id,
  runId: id,
  fundingGeneration: counter,
  templateVersion: ContextualPolicyVersion,
  task: ContextualTaskSnapshot,
  targets: candidates.check(Schema.isMinLength(1), Schema.isMaxLength(8)),
}).check(
  Schema.makeFilter(
    (v) => v.fundingGeneration === v.task.fundingGeneration && JSON.stringify(v).length <= 48000,
  ),
);
const probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const ContextualJudgment = Schema.Struct({
  targetId: id,
  useful: probability,
  usableEvidence: probability,
  contradicts: probability,
  sufficientContext: probability,
  reasons: Schema.Array(ContextualReason).check(
    Schema.isMaxLength(4),
    Schema.makeFilter((v) => new Set(v).size === v.length),
  ),
  selectedEvidenceIds: ids(32),
  evaluationComplete: Schema.optional(Schema.Boolean),
  selectedEvidenceSpans: Schema.optional(
    Schema.Array(
      Schema.Struct({
        evidenceId: id,
        start: counter,
        end: counter,
      }).check(Schema.makeFilter((span) => span.end > span.start)),
    ).check(
      Schema.isMaxLength(32),
      Schema.makeFilter(
        (spans) => new Set(spans.map((span) => span.evidenceId)).size === spans.length,
      ),
    ),
  ),
});
export const ContextualEvaluationResult = Schema.Struct({
  requestId: id,
  runId: id,
  templateVersion: ContextualPolicyVersion,
  policyVersion: ContextualPolicyVersion,
  model: id,
  judgments: Schema.Array(ContextualJudgment).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
    Schema.makeFilter((v) => new Set(v.map((j) => j.targetId)).size === v.length),
  ),
  inputTokens: counter,
  allowance: ExtensionAllowance,
  replayed: Schema.Boolean,
});
export const ContextualLiveEvidence = Schema.Struct({
  id,
  sourceKind: Schema.Literal("thread-message"),
  threadId: ThreadId,
  messageId: MessageId,
  messageRole: Schema.Literals(["user", "assistant"]),
  sourceHash: id,
  sourceRevision: counter,
  quote: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8000)),
  start: counter,
  end: counter,
  coordinateSystem: Schema.Literal("utf16"),
}).check(Schema.makeFilter((v) => v.end > v.start && v.end - v.start === v.quote.length));
export const ContextualClaimEvidence = Schema.Union([ContextualEvidence, ContextualLiveEvidence]);
export const ContextualClaim = Schema.Struct({
  id,
  candidateId: id,
  occurrenceId: id,
  revision: counter,
  evidence: Schema.Array(ContextualClaimEvidence).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  attribution: Schema.NullOr(DecisionAttribution),
  derivedSummary: Schema.optional(Schema.NullOr(text(6000))),
  scope: text(2000),
  temporalApplicability: text(1000),
  acceptedReplacementIds: ids(32),
});
export const ContextualComparisonPair = Schema.Struct({
  id,
  left: ContextualClaim,
  right: ContextualClaim,
}).check(Schema.makeFilter((v) => v.left.id !== v.right.id));
export const ContextualConflictCheckRequest = Schema.Struct({
  featureId: Schema.Literals(["decisions", "contextual"]),
  requestId: id,
  runId: id,
  fundingGeneration: counter,
  templateVersion: ContextualPolicyVersion,
  task: ContextualTaskSnapshot,
  pairs: Schema.Array(ContextualComparisonPair).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
    Schema.makeFilter((v) => new Set(v.map((p) => p.id)).size === v.length),
  ),
}).check(
  Schema.makeFilter(
    (v) => v.fundingGeneration === v.task.fundingGeneration && JSON.stringify(v).length <= 48000,
  ),
);
export const ContextualConflictJudgment = Schema.Struct({
  pairId: id,
  relation: Schema.Literals([
    "compatible",
    "incompatible",
    "different-scope",
    "explicit-replacement",
    "insufficient-evidence",
  ]),
  materialToTask: probability,
  leftEvidenceIds: ids(8),
  rightEvidenceIds: ids(8),
  reasons: Schema.Array(ContextualReason).check(Schema.isMaxLength(4)),
});
export const ContextualConflictCheckResult = Schema.Struct({
  requestId: id,
  runId: id,
  policyVersion: ContextualPolicyVersion,
  model: id,
  judgments: Schema.Array(ContextualConflictJudgment).check(
    Schema.isMaxLength(8),
    Schema.makeFilter((v) => new Set(v.map((j) => j.pairId)).size === v.length),
  ),
  coverage: ContextualCoverage,
  inputTokens: counter,
  allowance: ExtensionAllowance,
  replayed: Schema.Boolean,
});
export const ContextualConflict = Schema.Struct({
  id,
  threadId: ThreadId,
  taskFingerprint: id,
  revision: counter,
  pair: ContextualComparisonPair,
  judgment: ContextualConflictJudgment,
  state: Schema.Literals(["possible", "awaiting-review", "resolved", "invalidated"]),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (v) =>
      v.pair.id === v.judgment.pairId &&
      v.judgment.leftEvidenceIds.every((id) => v.pair.left.evidence.some((e) => e.id === id)) &&
      v.judgment.rightEvidenceIds.every((id) => v.pair.right.evidence.some((e) => e.id === id)),
  ),
);
export const ContextualConflictResolution = Schema.Struct({
  actionId: id,
  conflictId: id,
  expectedRevision: counter,
  leftRevision: counter,
  rightRevision: counter,
  threadId: ThreadId,
  taskFingerprint: id,
  action: Schema.Literals([
    "use-left",
    "use-right",
    "different-scopes",
    "continue-unresolved",
    "skip-context",
    "cancel-turn",
  ]),
  clarification: Schema.NullOr(text(2000)),
}).check(
  Schema.makeFilter(
    (v) =>
      v.action !== "different-scopes" ||
      (v.clarification !== null && v.clarification.trim().length > 0),
  ),
);
export const ContextualEquivalenceTarget = Schema.Struct({
  id,
  left: ContextualDecisionCandidate,
  right: ContextualDecisionCandidate,
}).check(
  Schema.makeFilter(
    (v) =>
      v.left.decisionId !== v.right.decisionId &&
      v.left.environmentId === v.right.environmentId &&
      v.left.projectId === v.right.projectId,
  ),
);
export const ContextualEquivalenceCheckRequest = Schema.Struct({
  featureId: Schema.Literal("decisions"),
  requestId: id,
  runId: id,
  fundingGeneration: counter,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  templateVersion: Schema.Literal("decisions-equivalence-v1"),
  targets: Schema.Array(ContextualEquivalenceTarget).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
}).check(
  Schema.makeFilter(
    (v) =>
      new Set(v.targets.map((t) => t.id)).size === v.targets.length &&
      v.targets.every(
        (t) => t.left.environmentId === v.environmentId && t.left.projectId === v.projectId,
      ) &&
      JSON.stringify(v).length <= 48000,
  ),
);
export const ContextualEquivalenceJudgment = Schema.Struct({
  targetId: id,
  equivalentCommitment: probability,
  sameApplicability: probability,
  sufficientEvidence: probability,
  relation: Schema.Literals([
    "equivalent",
    "different-commitment",
    "different-scope",
    "insufficient-evidence",
  ]),
});
export const ContextualEquivalenceCheckResult = Schema.Struct({
  requestId: id,
  runId: id,
  policyVersion: Schema.Literal("decisions-equivalence-v1"),
  model: id,
  qualificationId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  judgments: Schema.Array(ContextualEquivalenceJudgment).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
    Schema.makeFilter((v) => new Set(v.map((j) => j.targetId)).size === v.length),
  ),
  inputTokens: counter,
  allowance: ExtensionAllowance,
  replayed: Schema.Boolean,
});
export const ContextualDecisionOccurrence = Schema.Struct({
  decisionId: DecisionId,
  threadId: ThreadId,
  revision: counter,
  provenance: DecisionProvenance,
  title: text(160),
  body: text(4000),
  rationale: Schema.NullOr(text(2000)),
  attribution: DecisionAttribution,
  reviewState: DecisionReviewState,
  lifecycle: DecisionLifecycle,
  comment: Schema.NullOr(text(8000)),
  userEdited: Schema.Boolean,
  evidenceIds: ids(32),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export const ContextualDecisionGroup = Schema.Struct({
  id,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  canonicalDecisionId: DecisionId,
  guidanceId: id,
  contentFingerprint: id,
  revision: counter,
  occurrenceCount: counter,
  occurrences: Schema.Array(ContextualDecisionOccurrence).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(id),
  aliases: Schema.Array(DecisionId).check(Schema.isMaxLength(50)),
}).check(
  Schema.makeFilter(
    (v) =>
      v.occurrenceCount >= v.occurrences.length &&
      new Set(v.occurrences.map((o) => o.decisionId)).size === v.occurrences.length &&
      new Set(v.aliases).size === v.aliases.length,
  ),
);
export const ContextualGroupMutationRequest = Schema.Struct({
  suggestionId: Schema.optionalKey(id),
  actionId: id,
  groupId: id,
  expectedRevision: counter,
  canonicalDecisionId: DecisionId,
  occurrenceId: DecisionId,
  expectedOccurrenceRevision: counter,
  action: Schema.Literals(["merge", "detach"]),
}).check(Schema.makeFilter((v) => v.canonicalDecisionId !== v.occurrenceId));
export const ContextualGroupUndoRequest = Schema.Struct({
  actionId: id,
  mergeId: id,
  groupId: id,
  expectedRevision: counter,
  expectedOccurrenceRevision: counter,
});
export const ContextualPacketGroup = Schema.Struct({
  candidateId: id,
  occurrenceId: id,
  guidanceId: id,
  contentFingerprint: id,
  recordRevision: counter,
  evidence: Schema.Array(ContextualEvidence).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  attribution: Schema.NullOr(DecisionAttribution),
  derivedSummary: Schema.NullOr(text(6000)),
  reasons: Schema.Array(ContextualReason).check(Schema.isMaxLength(4)),
});
const encodePacketEvidence = Schema.encodeSync(Schema.fromJsonString(ContextualEvidence));
export const ContextualPacket = Schema.Struct({
  id,
  preparationId: id,
  task: ContextualTaskSnapshot,
  groups: Schema.Array(ContextualPacketGroup).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  tokenCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1500 })),
  tokenCounting: Schema.Literals(["provider", "conservative-bound"]),
  payloadRef: id,
  createdAt: IsoDateTime,
  resolutionIds: ids(12),
  purpose: Schema.Literals(["new-context", "correction", "refresh", "restored-after-compaction"]),
}).check(
  Schema.makeFilter((v) => {
    if (new Set(v.groups.map((g) => g.guidanceId)).size !== v.groups.length) return false;
    const evidence = new Map<string, string>();
    for (const group of v.groups) {
      if (new Set(group.evidence.map((e) => e.id)).size !== group.evidence.length) return false;
      for (const item of group.evidence) {
        const encoded = encodePacketEvidence(item);
        const previous = evidence.get(item.id);
        if (previous !== undefined && previous !== encoded) return false;
        evidence.set(item.id, encoded);
      }
    }
    return true;
  }),
);
export const ContextualPreparationState = Schema.Literals([
  "requested",
  "retrieving",
  "evaluating",
  "checking-conflicts",
  "awaiting-conflict-review",
  "prepared",
  "dispatching",
  "delivered",
  "no-useful-context",
  "already-supplied",
  "skipped",
  "canceled",
  "failed",
  "delivery-unknown",
]);
export const ContextualPreparation = Schema.Struct({
  id,
  task: ContextualTaskSnapshot,
  revision: counter,
  state: ContextualPreparationState,
  // Optional for older stored preparations; absence must not imply a particular failure cause.
  skipReason: Schema.optionalKey(
    Schema.Literals([
      "user-requested",
      "funding-required",
      "allowance-exhausted",
      "source-unavailable",
      "evaluation-incomplete",
      "unavailable",
    ]),
  ),
  packetId: Schema.NullOr(id),
  dispatchId: Schema.NullOr(id),
  conflictIds: ids(12),
  attemptsUsed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  comparisonPairsChecked: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 12 })),
  coverage: ContextualCoverage,
  updatedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (v) =>
      (v.state !== "awaiting-conflict-review" || v.conflictIds.length > 0) &&
      (!["prepared", "dispatching", "delivered", "delivery-unknown"].includes(v.state) ||
        v.packetId !== null) &&
      (!["dispatching", "delivered", "delivery-unknown"].includes(v.state) ||
        v.dispatchId !== null),
  ),
);
export const ContextualDeliveryReceipt = Schema.Struct({
  id,
  preparationId: id,
  packetId: Schema.NullOr(id),
  dispatchId: id,
  threadId: ThreadId,
  submissionId: id,
  turnId: Schema.NullOr(TurnId),
  providerInstanceId: id,
  providerContextEpoch: id,
  providerReceiptId: Schema.NullOr(id),
  disposition: Schema.Literals(["fresh", "steered", "provider-queued", "skipped"]),
  acceptance: Schema.Literals(["accepted", "rejected", "unknown"]),
  evidenceIncluded: Schema.Boolean,
  suppliedEvidenceIds: ids(64),
  receivedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (v) =>
      (!v.evidenceIncluded ||
        (v.packetId !== null && v.disposition !== "skipped" && v.disposition !== "steered")) &&
      (v.suppliedEvidenceIds.length === 0 ||
        (v.evidenceIncluded &&
          v.acceptance === "accepted" &&
          v.turnId !== null &&
          v.providerReceiptId !== null)) &&
      (!(v.evidenceIncluded && v.acceptance === "accepted") || v.suppliedEvidenceIds.length > 0),
  ),
);
/** Side-table outbox events deliberately contain no purgeable source text. */
export const ContextualEvent = Schema.Struct({
  sequence: counter,
  // A null thread targets the project, or the whole host when projectId is also null.
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  revision: counter,
  kind: Schema.Literals([
    "settings-changed",
    "preparation-changed",
    "delivery-recorded",
    "conflict-changed",
    "group-changed",
    "data-forgotten",
    "source-policy-changed",
    "capture-changed",
    "funding-changed",
    "display-summary-ready",
  ]),
  entityId: id,
  occurredAt: IsoDateTime,
});
export const ContextualReadRequest = Schema.Struct({
  threadId: ThreadId,
  messageId: Schema.optionalKey(MessageId),
  cursor: Schema.optionalKey(id),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export const ContextualThreadSettingsUpdateRequest = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: counter,
  enabled: Schema.Boolean,
  sourceIds: ids(256),
});
export const ContextualProjectSettingsUpdateRequest = Schema.Struct({
  projectId: ProjectId,
  expectedRevision: counter,
  defaultEnabled: Schema.Boolean,
  sourceIds: ids(256),
});
export const ContextualRefreshRequest = Schema.Struct({
  actionId: id,
  threadId: ThreadId,
  expectedRevision: counter,
});
export const ContextualExclusionRequest = Schema.Struct({
  actionId: id,
  threadId: ThreadId,
  guidanceId: id,
  excluded: Schema.Boolean,
  expectedRevision: counter,
});
export const ContextualPreparationActionRequest = Schema.Struct({
  actionId: id,
  preparationId: id,
  expectedRevision: counter,
  action: Schema.Literals(["send-without-context", "cancel"]),
});
export const ContextualSubscribeRequest = Schema.Struct({
  afterSequence: counter,
  threadId: Schema.optionalKey(ThreadId),
});
export const ContextualDisclosure = Schema.Struct({
  displaySummary: Schema.optionalKey(
    Schema.Struct({
      state: Schema.Literal("ready"),
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(700)),
    }),
  ),
  coverage: Schema.optionalKey(ContextualCoverage),
  messageId: Schema.optionalKey(MessageId),
  inherited: Schema.optionalKey(Schema.Struct({ originThreadId: ThreadId, messageId: MessageId })),
  receipt: ContextualDeliveryReceipt,
  packet: Schema.NullOr(ContextualPacket),
  retention: Schema.Literals(["available", "forgotten", "expired", "source-deleted"]),
}).check(
  Schema.makeFilter(
    (v) =>
      (v.retention === "available") === (v.packet !== null) &&
      (v.packet === null || v.packet.id === v.receipt.packetId),
  ),
);
export class ContextualError extends Schema.TaggedErrorClass<ContextualError>()("ContextualError", {
  code: Schema.Literals([
    "invalid",
    "forbidden",
    "not-found",
    "stale-revision",
    "unsupported-version",
    "unavailable",
    "allowance-exhausted",
    "run-budget-exhausted",
    "canceled",
    "delivery-unknown",
  ]),
  message: text(1000),
}) {}

export type ContextualSourceLocator = typeof ContextualSourceLocator.Type;
export type ContextualLiveEvidence = typeof ContextualLiveEvidence.Type;
export type ContextualClaimEvidence = typeof ContextualClaimEvidence.Type;
export type ContextualRevision = typeof ContextualRevision.Type;
export type ContextualSourceKind = typeof ContextualSourceKind.Type;
export type ContextualReason = typeof ContextualReason.Type;
export type ContextualCoverage = typeof ContextualCoverage.Type;
export type ContextualSource = typeof ContextualSource.Type;
export type ContextualSourcePolicy = typeof ContextualSourcePolicy.Type;
export type ContextualSourceConfiguration = typeof ContextualSourceConfiguration.Type;
export type ContextualProjectSettings = typeof ContextualProjectSettings.Type;
export type ContextualThreadSettings = typeof ContextualThreadSettings.Type;
export type ContextualEffectiveState = typeof ContextualEffectiveState.Type;
export type ContextualTaskSnapshot = typeof ContextualTaskSnapshot.Type;
export type ContextualEvidence = typeof ContextualEvidence.Type;
export type ContextualSlackCandidate = typeof ContextualSlackCandidate.Type;
export type ContextualDecisionCandidate = typeof ContextualDecisionCandidate.Type;
export type ContextualCandidate = typeof ContextualCandidate.Type;
export type ContextualRetrieveRequest = typeof ContextualRetrieveRequest.Type;
export type ContextualRetrieveResult = typeof ContextualRetrieveResult.Type;
export type ContextualPolicyVersion = typeof ContextualPolicyVersion.Type;
export type ContextualEvaluationRequest = typeof ContextualEvaluationRequest.Type;
export type ContextualJudgment = typeof ContextualJudgment.Type;
export type ContextualEvaluationResult = typeof ContextualEvaluationResult.Type;
export type ContextualClaim = typeof ContextualClaim.Type;
export type ContextualComparisonPair = typeof ContextualComparisonPair.Type;
export type ContextualConflictCheckRequest = typeof ContextualConflictCheckRequest.Type;
export type ContextualConflictJudgment = typeof ContextualConflictJudgment.Type;
export type ContextualConflictCheckResult = typeof ContextualConflictCheckResult.Type;
export type ContextualConflict = typeof ContextualConflict.Type;
export type ContextualConflictResolution = typeof ContextualConflictResolution.Type;
export type ContextualDecisionOccurrence = typeof ContextualDecisionOccurrence.Type;
export type ContextualDecisionGroup = typeof ContextualDecisionGroup.Type;
export type ContextualGroupMutationRequest = typeof ContextualGroupMutationRequest.Type;
export type ContextualGroupUndoRequest = typeof ContextualGroupUndoRequest.Type;
export type ContextualPacketGroup = typeof ContextualPacketGroup.Type;
export type ContextualPacket = typeof ContextualPacket.Type;
export type ContextualPreparationState = typeof ContextualPreparationState.Type;
export type ContextualPreparation = typeof ContextualPreparation.Type;
export type ContextualDeliveryReceipt = typeof ContextualDeliveryReceipt.Type;
export type ContextualEvent = typeof ContextualEvent.Type;
export type ContextualReadRequest = typeof ContextualReadRequest.Type;
export type ContextualThreadSettingsUpdateRequest =
  typeof ContextualThreadSettingsUpdateRequest.Type;
export type ContextualProjectSettingsUpdateRequest =
  typeof ContextualProjectSettingsUpdateRequest.Type;
export type ContextualRefreshRequest = typeof ContextualRefreshRequest.Type;
export type ContextualExclusionRequest = typeof ContextualExclusionRequest.Type;
export type ContextualPreparationActionRequest = typeof ContextualPreparationActionRequest.Type;
export type ContextualSubscribeRequest = typeof ContextualSubscribeRequest.Type;
export type ContextualDisclosure = typeof ContextualDisclosure.Type;

export type ContextualEquivalenceTarget = typeof ContextualEquivalenceTarget.Type;
export type ContextualEquivalenceCheckRequest = typeof ContextualEquivalenceCheckRequest.Type;
export type ContextualEquivalenceJudgment = typeof ContextualEquivalenceJudgment.Type;
export type ContextualEquivalenceCheckResult = typeof ContextualEquivalenceCheckResult.Type;
