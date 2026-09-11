import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const SagaWorkbenchIdentity = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  spaceId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type SagaWorkbenchIdentity = typeof SagaWorkbenchIdentity.Type;
export const SagaWorkbenchStage = Schema.Literals(["spec", "plan", "build", "review", "accept"]);
export type SagaWorkbenchStage = typeof SagaWorkbenchStage.Type;
const NullableText = Schema.NullOr(TrimmedNonEmptyString);
export const SagaWorkbenchRequirement = Schema.Struct({
  key: TrimmedNonEmptyString,
  kind: Schema.Literals(["pull-request", "no-changes", "unknown"]),
  provider: Schema.NullOr(SourceControlProviderKind),
  repoName: TrimmedNonEmptyString,
  checkoutPath: TrimmedNonEmptyString,
  host: NullableText,
  repository: NullableText,
  number: Schema.NullOr(PositiveInt),
  url: NullableText,
  headRevision: NullableText,
  localHeadRevision: NullableText,
  baseRevision: NullableText,
  localChanges: Schema.Literals(["clean", "dirty", "unknown"]),
  localHeadMatches: Schema.NullOr(Schema.Boolean),
  requiredChecks: Schema.Literals(["passing", "pending", "failing", "none", "unknown"]),
  checksRevision: NullableText,
  merged: Schema.NullOr(Schema.Boolean),
  mergedSourceRevision: NullableText,
  blockers: Schema.Array(Schema.String),
});
export type SagaWorkbenchRequirement = typeof SagaWorkbenchRequirement.Type;
export const SagaWorkbenchEvidence = Schema.Struct({
  sourceRevision: TrimmedNonEmptyString,
  manifestRevision: TrimmedNonEmptyString,
  observedAt: IsoDateTime,
  requirements: Schema.Array(SagaWorkbenchRequirement),
  complete: Schema.Boolean,
  blockers: Schema.Array(Schema.String),
});
export type SagaWorkbenchEvidence = typeof SagaWorkbenchEvidence.Type;
export const SagaWorkbenchSource = Schema.Struct({
  label: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export const SagaWorkbenchAcceptance = Schema.Struct({
  at: IsoDateTime,
  subject: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  evidenceRevision: TrimmedNonEmptyString,
  manifestRevision: TrimmedNonEmptyString,
  requirements: Schema.Array(SagaWorkbenchRequirement),
});
export const SagaWorkbenchInferenceResult = Schema.Struct({
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(1200)),
  stage: SagaWorkbenchStage,
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type SagaWorkbenchInferenceResult = typeof SagaWorkbenchInferenceResult.Type;
export const SagaWorkbenchSummary = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(1200)),
  inferredStage: Schema.optionalKey(SagaWorkbenchStage),
  confidence: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  sourceRevision: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  sources: Schema.Array(SagaWorkbenchSource),
});
export const SagaWorkbenchWorkflow = Schema.Struct({
  identity: SagaWorkbenchIdentity,
  revision: NonNegativeInt,
  stage: SagaWorkbenchStage,
  /** Absent on older rows means enabled. */
  automaticStage: Schema.optionalKey(Schema.Boolean),
  /** Pins block both inferred and manual phase changes, while summaries still refresh. */
  stagePinned: Schema.optionalKey(Schema.Boolean),
  lastInferenceSequence: Schema.optionalKey(NonNegativeInt),
  evidenceState: Schema.optionalKey(Schema.Literals(["unverified", "stale"])),
  accepted: Schema.NullOr(SagaWorkbenchAcceptance),
  completedAt: Schema.NullOr(IsoDateTime),
  summary: Schema.NullOr(SagaWorkbenchSummary),
});
export type SagaWorkbenchWorkflow = typeof SagaWorkbenchWorkflow.Type;
export const SagaWorkbenchMember = Schema.Struct({
  id: TrimmedNonEmptyString,
  after: Schema.Array(Schema.String),
  state: Schema.String,
  identity: Schema.NullOr(SagaWorkbenchIdentity),
  workflow: Schema.NullOr(SagaWorkbenchWorkflow),
});
export const SagaWorkbenchSnapshot = Schema.Struct({
  identity: SagaWorkbenchIdentity,
  workflow: SagaWorkbenchWorkflow,
  members: Schema.Array(SagaWorkbenchMember),
});
export type SagaWorkbenchSnapshot = typeof SagaWorkbenchSnapshot.Type;
export const SagaWorkbenchActivity = Schema.Struct({
  revision: NonNegativeInt,
  at: IsoDateTime,
  action: TrimmedNonEmptyString,
  subject: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  detail: Schema.String,
});
export type SagaWorkbenchActivity = typeof SagaWorkbenchActivity.Type;
export class SagaWorkbenchError extends Schema.TaggedErrorClass<SagaWorkbenchError>()(
  "SagaWorkbenchError",
  {
    code: Schema.Literals([
      "unavailable",
      "identity",
      "conflict",
      "blocked",
      "generation",
      "storage",
    ]),
    message: Schema.String,
    blockers: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {}
export const SagaWorkbenchSnapshotInput = Schema.Struct({ projectId: ProjectId });
export const SagaWorkbenchIdentityInput = Schema.Struct({ identity: SagaWorkbenchIdentity });
export const SagaWorkbenchMutationInput = Schema.Struct({
  identity: SagaWorkbenchIdentity,
  expectedRevision: NonNegativeInt,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type SagaWorkbenchMutationInput = typeof SagaWorkbenchMutationInput.Type;
export const SagaWorkbenchStageInput = Schema.Struct({
  ...SagaWorkbenchMutationInput.fields,
  stage: SagaWorkbenchStage,
});
export type SagaWorkbenchStageInput = typeof SagaWorkbenchStageInput.Type;
export const SagaWorkbenchApproveInput = Schema.Struct({
  ...SagaWorkbenchMutationInput.fields,
  expectedEvidenceRevision: TrimmedNonEmptyString,
});
export type SagaWorkbenchApproveInput = typeof SagaWorkbenchApproveInput.Type;

export const SagaWorkbenchConfigureInput = Schema.Struct({
  ...SagaWorkbenchMutationInput.fields,
  automaticStage: Schema.optionalKey(Schema.Boolean),
  stagePinned: Schema.optionalKey(Schema.Boolean),
});
export type SagaWorkbenchConfigureInput = typeof SagaWorkbenchConfigureInput.Type;
