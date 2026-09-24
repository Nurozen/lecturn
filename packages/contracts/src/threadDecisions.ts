import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { DecisionFundingChallengeResult, DecisionFundingStatusResult } from "./relayDecisions.ts";

export const DEFAULT_DECISION_TRACKING_DESCRIPTION =
  "Track agreed changes to architecture, product behavior, scope, and constraints. Ignore exploratory suggestions and routine implementation steps.";

const boundedText = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const nonemptyText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));
const exactQuote = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(8000),
  Schema.makeFilter((value) => value.trim().length > 0),
);
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const DecisionId = nonemptyText(200).pipe(Schema.brand("DecisionId"));
export const DecisionEvidenceId = nonemptyText(200).pipe(Schema.brand("DecisionEvidenceId"));
export const DecisionRelationshipId = nonemptyText(200).pipe(
  Schema.brand("DecisionRelationshipId"),
);
export const DecisionScanId = nonemptyText(200).pipe(Schema.brand("DecisionScanId"));
export const DecisionJobId = nonemptyText(200).pipe(Schema.brand("DecisionJobId"));
export const DecisionRevision = counter;
export const DecisionReviewState = Schema.Literals(["unreviewed", "confirmed", "dismissed"]);
export const DecisionLifecycle = Schema.Literals(["current", "superseded"]);
export const DecisionAttribution = Schema.Literals([
  "user-directed",
  "user-accepted",
  "agent-chosen",
]);
export const DecisionSourceAvailability = Schema.Literals([
  "available",
  "message-missing",
  "thread-deleted",
  "thread-archived",
  "changed",
]);
export const DecisionEvidence = Schema.Struct({
  id: DecisionEvidenceId,
  threadId: ThreadId,
  messageId: MessageId,
  messageRole: Schema.Literals(["user", "assistant"]),
  sourceHash: nonemptyText(256),
  sourceGeneration: counter,
  canonicalVersion: nonemptyText(80),
  quote: exactQuote,
  /** Half-open offsets in canonical JavaScript UTF-16 code units. */
  start: counter,
  end: counter,
  prefix: boundedText(128),
  suffix: boundedText(128),
  occurrence: counter,
  availability: DecisionSourceAvailability,
}).check(
  Schema.makeFilter(
    (value) => value.end > value.start && value.end - value.start === value.quote.length,
  ),
);
export const DecisionProvenance = Schema.Struct({
  descriptionRevision: DecisionRevision,
  sourceFingerprint: nonemptyText(256),
  canonicalVersion: nonemptyText(80),
  templateVersion: nonemptyText(80),
  detectorModel: nonemptyText(200),
  writerSelection: Schema.toType(ModelSelection),
  writerConfigurationGeneration: nonemptyText(256),
  identityConfidence: Schema.Literals(["verified", "configuration-only"]),
});
export const DecisionRelationship = Schema.Struct({
  id: DecisionRelationshipId,
  predecessorId: DecisionId,
  successorId: DecisionId,
  state: Schema.Literals(["proposed", "accepted", "rejected", "undone"]),
  revision: DecisionRevision,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).check(Schema.makeFilter((value) => value.predecessorId !== value.successorId));
export const ThreadDecision = Schema.Struct({
  id: DecisionId,
  projectId: ProjectId,
  threadId: ThreadId,
  threadTitle: Schema.NullOr(boundedText(1000)),
  occurredAt: IsoDateTime,
  title: nonemptyText(160),
  body: nonemptyText(4000),
  rationale: Schema.NullOr(boundedText(2000)),
  comment: Schema.NullOr(boundedText(8000)),
  attribution: DecisionAttribution,
  reviewState: DecisionReviewState,
  lifecycle: DecisionLifecycle,
  userEdited: Schema.Boolean,
  revision: DecisionRevision,
  occurrence: counter,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  evidence: Schema.Array(DecisionEvidence).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  provenance: DecisionProvenance,
  relationships: Schema.Array(DecisionRelationship).check(Schema.isMaxLength(100)),
});
export const DecisionFundingState = Schema.Literals([
  "unfunded",
  "pending",
  "active",
  "revoked",
  "unavailable",
]);
export const DecisionProjectSettings = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
  description: boundedText(2000),
  revision: DecisionRevision,
  cancellationEpoch: counter,
  activatedAt: Schema.NullOr(IsoDateTime),
  activationSequence: Schema.NullOr(counter),
  fundingState: DecisionFundingState,
  fundingAccountLabel: Schema.NullOr(boundedText(200)),
});
export const DecisionJobState = Schema.Literals([
  "queued",
  "detecting",
  "localizing",
  "writing",
  "committed",
  "no_match",
  "waiting",
  "incomplete",
  "failed",
  "canceled",
]);
export const DecisionBlockedReason = Schema.Literals([
  "disabled",
  "unfunded",
  "access-expired",
  "allowance-exhausted",
  "provider-unsupported",
  "provider-unavailable",
  "detector-unavailable",
  "provider-foreground",
  "provider-changed",
  "host-policy",
  "paused",
  "source-changed",
  "budget",
  "error",
]);
export const DecisionProcessingStatus = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  paused: Schema.Boolean,
  pauseEpoch: counter,
  state: Schema.Literals(["idle", "running", "waiting", "incomplete", "failed"]),
  blockedReason: Schema.NullOr(DecisionBlockedReason),
  pendingCount: counter,
  incompleteCount: counter,
  unscannedMessageCount: counter,
  lastProcessedAt: Schema.NullOr(IsoDateTime),
  writerSupported: Schema.Boolean,
  writerSupportReason: Schema.NullOr(boundedText(1000)),
});
const filterFields = {
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  search: Schema.optionalKey(boundedText(500)),
  reviewState: Schema.optionalKey(Schema.Union([DecisionReviewState, Schema.Literal("all")])),
  lifecycle: Schema.optionalKey(Schema.Union([DecisionLifecycle, Schema.Literal("all")])),
};
export const ThreadDecisionListInput = Schema.Struct({
  ...filterFields,
  cursor: Schema.optionalKey(nonemptyText(2000)),
  /** Omitted means 50. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const ThreadDecisionListResult = Schema.Struct({
  decisions: Schema.Array(ThreadDecision).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(nonemptyText(2000)),
  projectRevision: DecisionRevision,
});
export const ThreadDecisionGetInput = Schema.Struct({ projectId: ProjectId, id: DecisionId });
const mutationFields = { projectId: ProjectId, id: DecisionId, expectedRevision: DecisionRevision };
const relationMutationFields = {
  projectId: ProjectId,
  relationshipId: DecisionRelationshipId,
  expectedRevision: DecisionRevision,
  expectedPredecessorRevision: DecisionRevision,
  expectedSuccessorRevision: DecisionRevision,
};
export const ThreadDecisionMutateInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("edit"),
    ...mutationFields,
    title: nonemptyText(160),
    body: nonemptyText(4000),
    rationale: Schema.NullOr(boundedText(2000)),
  }),
  Schema.Struct({
    operation: Schema.Literal("comment"),
    ...mutationFields,
    comment: Schema.NullOr(boundedText(8000)),
  }),
  Schema.Struct({
    operation: Schema.Literal("review"),
    ...mutationFields,
    reviewState: DecisionReviewState,
  }),
  Schema.Struct({ operation: Schema.Literal("delete"), ...mutationFields }),
  Schema.Struct({
    operation: Schema.Literal("propose-replacement"),
    projectId: ProjectId,
    predecessorId: DecisionId,
    successorId: DecisionId,
    expectedPredecessorRevision: DecisionRevision,
    expectedSuccessorRevision: DecisionRevision,
  }),
  Schema.Struct({ operation: Schema.Literal("accept-replacement"), ...relationMutationFields }),
  Schema.Struct({ operation: Schema.Literal("reject-replacement"), ...relationMutationFields }),
  Schema.Struct({ operation: Schema.Literal("undo-replacement"), ...relationMutationFields }),
]).check(
  Schema.makeFilter(
    (value) =>
      value.operation !== "propose-replacement" || value.predecessorId !== value.successorId,
  ),
);
export const ThreadDecisionMutateResult = Schema.Struct({
  projectRevision: DecisionRevision,
  decision: Schema.NullOr(ThreadDecision),
});
export const ThreadDecisionSettingsInput = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("get"), projectId: ProjectId }),
  Schema.Struct({
    operation: Schema.Literal("update"),
    projectId: ProjectId,
    expectedRevision: DecisionRevision,
    enabled: Schema.Boolean,
    description: boundedText(2000),
  }),
  Schema.Struct({
    operation: Schema.Literal("pause-thread"),
    projectId: ProjectId,
    threadId: ThreadId,
    paused: Schema.Boolean,
    expectedPauseEpoch: counter,
  }),
  Schema.Struct({
    operation: Schema.Literal("purge"),
    projectId: ProjectId,
    expectedRevision: DecisionRevision,
  }),
]);
export const ThreadDecisionSettingsResult = Schema.Struct({
  settings: DecisionProjectSettings,
  projectRevision: DecisionRevision,
});
export const ThreadDecisionStatusInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export const ThreadDecisionStatusResult = Schema.Struct({
  settings: DecisionProjectSettings,
  processing: DecisionProcessingStatus,
  projectRevision: DecisionRevision,
  incompleteJobs: Schema.Array(
    Schema.Struct({
      id: DecisionJobId,
      threadId: ThreadId,
      state: DecisionJobState,
      reason: Schema.NullOr(DecisionBlockedReason),
    }),
  ).check(Schema.isMaxLength(50)),
  activeScans: Schema.Array(
    Schema.Struct({
      scanId: DecisionScanId,
      state: Schema.Literals(["queued", "running", "incomplete"]),
      messageCount: counter,
    }),
  ).check(Schema.isMaxLength(20)),
});
export const ThreadDecisionSourceWindowInput = Schema.Struct({
  projectId: ProjectId,
  decisionId: DecisionId,
  evidenceId: DecisionEvidenceId,
});
export const DecisionSourceMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: boundedText(64000),
  createdAt: IsoDateTime,
});
export const ThreadDecisionSourceWindowResult = Schema.Struct({
  outcome: Schema.Literals(["exact", "message-only", "unavailable"]),
  threadId: ThreadId,
  messageId: MessageId,
  messages: Schema.Array(DecisionSourceMessage).check(Schema.isMaxLength(21)),
  start: Schema.NullOr(counter),
  end: Schema.NullOr(counter),
  reason: Schema.NullOr(DecisionSourceAvailability),
});
export const ThreadDecisionScanInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("preview"),
    projectId: ProjectId,
    threadId: Schema.optionalKey(ThreadId),
  }),
  Schema.Struct({
    operation: Schema.Literal("start"),
    projectId: ProjectId,
    threadId: Schema.optionalKey(ThreadId),
    expectedSettingsRevision: DecisionRevision,
    previewToken: nonemptyText(2000),
  }),
  Schema.Struct({
    operation: Schema.Literal("cancel"),
    projectId: ProjectId,
    scanId: DecisionScanId,
  }),
  Schema.Struct({ operation: Schema.Literal("retry"), projectId: ProjectId, jobId: DecisionJobId }),
]);
export const ThreadDecisionScanResult = Schema.Struct({
  scanId: Schema.NullOr(DecisionScanId),
  previewToken: Schema.NullOr(nonemptyText(2000)),
  messageCount: counter,
  estimatedInputTokens: counter,
  state: Schema.Literals(["preview", "queued", "running", "completed", "incomplete", "canceled"]),
  projectRevision: DecisionRevision,
});
export const ThreadDecisionExportInput = Schema.Struct({
  ...filterFields,
  format: Schema.Literals(["markdown", "json"]),
  expectedProjectRevision: DecisionRevision,
  cursor: Schema.optionalKey(nonemptyText(2000)),
});
export const ThreadDecisionExportResult = Schema.Struct({
  format: Schema.Literals(["markdown", "json"]),
  schemaVersion: Schema.Literal(1),
  projectRevision: DecisionRevision,
  content: boundedText(2000000),
  nextCursor: Schema.NullOr(nonemptyText(2000)),
});
/** Compact invalidation only; no conversation text is broadcast. */
export const ThreadDecisionChange = Schema.Struct({
  projectId: ProjectId,
  revision: DecisionRevision,
});
export const ThreadDecisionFundingInput = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("challenge"), expectedGeneration: counter }),
  Schema.Struct({
    operation: Schema.Literal("redeem"),
    challengeId: nonemptyText(256),
    expectedGeneration: counter,
  }),
  Schema.Struct({ operation: Schema.Literal("revoke"), expectedGeneration: counter }),
]);
export const ThreadDecisionFundingResult = Schema.Struct({
  status: DecisionFundingStatusResult,
  challenge: Schema.NullOr(DecisionFundingChallengeResult),
});
export type ThreadDecisionFundingInput = typeof ThreadDecisionFundingInput.Type;
export type ThreadDecisionFundingResult = typeof ThreadDecisionFundingResult.Type;

export const DecisionWriterEvidenceReference = Schema.Struct({
  evidenceId: DecisionEvidenceId,
  quote: exactQuote,
});
const writerEvidence = Schema.Array(DecisionWriterEvidenceReference).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
);
const writerNoteFields = {
  candidateId: nonemptyText(200),
  title: nonemptyText(160),
  body: nonemptyText(4000),
  rationale: Schema.NullOr(boundedText(2000)),
  attribution: DecisionAttribution,
  evidence: writerEvidence,
};
export const DecisionWriterAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("create"), ...writerNoteFields }),
  Schema.Struct({
    action: Schema.Literal("duplicate"),
    candidateId: nonemptyText(200),
    existingId: DecisionId,
    expectedRevision: DecisionRevision,
    evidence: writerEvidence,
  }),
  Schema.Struct({
    action: Schema.Literal("propose_replacement"),
    ...writerNoteFields,
    predecessorId: DecisionId,
    expectedRevision: DecisionRevision,
  }),
  Schema.Struct({
    action: Schema.Literal("skip"),
    candidateId: nonemptyText(200),
    reason: Schema.Literals([
      "proposal",
      "irrelevant",
      "insufficient_evidence",
      "already_represented",
    ]),
  }),
  Schema.Struct({
    action: Schema.Literal("needs_context"),
    candidateId: nonemptyText(200),
    reason: nonemptyText(1000),
  }),
]);
export const DecisionWriterOutput = Schema.Struct({
  actions: Schema.Array(DecisionWriterAction).check(Schema.isMaxLength(64)),
  complete: Schema.Boolean,
  unresolvedCandidateIds: Schema.Array(nonemptyText(200)).check(Schema.isMaxLength(64)),
}).check(
  Schema.makeFilter(
    (value) =>
      value.actions.filter(
        (action) => action.action === "create" || action.action === "propose_replacement",
      ).length <= 8 &&
      (value.complete
        ? value.unresolvedCandidateIds.length === 0
        : value.unresolvedCandidateIds.length > 0),
  ),
);
export const DecisionWriterInput = Schema.Struct({
  modelSelection: Schema.toType(ModelSelection),
  description: boundedText(2000),
  descriptionRevision: DecisionRevision,
  sourceFingerprint: nonemptyText(256),
  candidates: Schema.Array(
    Schema.Struct({
      id: nonemptyText(200),
      evidenceIds: Schema.Array(DecisionEvidenceId).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(32),
      ),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  evidence: Schema.Array(DecisionEvidence).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  context: boundedText(32000),
  existingDecisions: Schema.Array(
    Schema.Struct({
      id: DecisionId,
      revision: DecisionRevision,
      title: nonemptyText(160),
      body: nonemptyText(4000),
      reviewState: DecisionReviewState,
      userEdited: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(20)),
  resolvedCandidateIds: Schema.Array(nonemptyText(200)).check(Schema.isMaxLength(64)),
}).check(
  Schema.makeFilter(
    (value) =>
      value.context.length +
        value.evidence.reduce((total, evidence) => total + evidence.quote.length, 0) <=
      64000,
  ),
);
export class ThreadDecisionError extends Schema.TaggedErrorClass<ThreadDecisionError>()(
  "ThreadDecisionError",
  {
    code: Schema.Literals([
      "not-found",
      "invalid",
      "conflict",
      "unavailable",
      "forbidden",
      "unsupported",
      "stale-source",
      "allowance-exhausted",
    ]),
    message: Schema.String,
  },
) {}

export type DecisionId = typeof DecisionId.Type;
export type DecisionEvidenceId = typeof DecisionEvidenceId.Type;
export type DecisionRelationshipId = typeof DecisionRelationshipId.Type;
export type DecisionScanId = typeof DecisionScanId.Type;
export type DecisionJobId = typeof DecisionJobId.Type;
export type DecisionRevision = typeof DecisionRevision.Type;
export type DecisionReviewState = typeof DecisionReviewState.Type;
export type DecisionLifecycle = typeof DecisionLifecycle.Type;
export type DecisionAttribution = typeof DecisionAttribution.Type;
export type DecisionSourceAvailability = typeof DecisionSourceAvailability.Type;
export type DecisionEvidence = typeof DecisionEvidence.Type;
export type DecisionProvenance = typeof DecisionProvenance.Type;
export type DecisionRelationship = typeof DecisionRelationship.Type;
export type ThreadDecision = typeof ThreadDecision.Type;
export type DecisionFundingState = typeof DecisionFundingState.Type;
export type DecisionProjectSettings = typeof DecisionProjectSettings.Type;
export type DecisionJobState = typeof DecisionJobState.Type;
export type DecisionBlockedReason = typeof DecisionBlockedReason.Type;
export type DecisionProcessingStatus = typeof DecisionProcessingStatus.Type;
export type ThreadDecisionListInput = typeof ThreadDecisionListInput.Type;
export type ThreadDecisionListResult = typeof ThreadDecisionListResult.Type;
export type ThreadDecisionGetInput = typeof ThreadDecisionGetInput.Type;
export type ThreadDecisionMutateInput = typeof ThreadDecisionMutateInput.Type;
export type ThreadDecisionMutateResult = typeof ThreadDecisionMutateResult.Type;
export type ThreadDecisionSettingsInput = typeof ThreadDecisionSettingsInput.Type;
export type ThreadDecisionSettingsResult = typeof ThreadDecisionSettingsResult.Type;
export type ThreadDecisionStatusInput = typeof ThreadDecisionStatusInput.Type;
export type ThreadDecisionStatusResult = typeof ThreadDecisionStatusResult.Type;
export type ThreadDecisionSourceWindowInput = typeof ThreadDecisionSourceWindowInput.Type;
export type DecisionSourceMessage = typeof DecisionSourceMessage.Type;
export type ThreadDecisionSourceWindowResult = typeof ThreadDecisionSourceWindowResult.Type;
export type ThreadDecisionScanInput = typeof ThreadDecisionScanInput.Type;
export type ThreadDecisionScanResult = typeof ThreadDecisionScanResult.Type;
export type ThreadDecisionExportInput = typeof ThreadDecisionExportInput.Type;
export type ThreadDecisionExportResult = typeof ThreadDecisionExportResult.Type;
export type ThreadDecisionChange = typeof ThreadDecisionChange.Type;
export type DecisionWriterEvidenceReference = typeof DecisionWriterEvidenceReference.Type;
export type DecisionWriterAction = typeof DecisionWriterAction.Type;
export type DecisionWriterOutput = typeof DecisionWriterOutput.Type;
export type DecisionWriterInput = typeof DecisionWriterInput.Type;
