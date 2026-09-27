import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as C from "./contextual.ts";
import * as H from "./extensionsHelper.ts";
import * as E from "./extensions.ts";
import {
  EnvironmentAuthorizationError,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayWriteScope,
} from "./auth.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString, NonNegativeInt } from "./baseSchemas.ts";

const id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const error = Schema.Union([C.ContextualError, EnvironmentAuthorizationError]);
export const ContextualStatusResult = Schema.Struct({
  permittedSources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id,
        label: Schema.String.check(Schema.isMaxLength(200)),
        hostName: Schema.String.check(Schema.isMaxLength(200)),
      }),
    ).check(Schema.isMaxLength(256)),
  ),
  thread: C.ContextualThreadSettings,
  project: C.ContextualProjectSettings,
  effective: C.ContextualEffectiveState,
  hostName: Schema.String.check(Schema.isMaxLength(200)),
  preparation: Schema.NullOr(C.ContextualPreparation),
});
export const ContextualArchiveInspectRequest = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(1000)),
  sourceIds: Schema.Array(id).check(Schema.isMaxLength(256)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 })),
});
export const ContextualConflictListRequest = Schema.Struct({
  ...C.ContextualReadRequest.fields,
  preparationId: Schema.optionalKey(id),
});
export type ContextualConflictListRequest = typeof ContextualConflictListRequest.Type;
export const ContextualGroupReadRequest = Schema.Struct({
  projectId: ProjectId,
  groupId: id,
  cursor: Schema.optionalKey(id),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
export const ExtensionHostFundingRequest = Schema.Union([
  Schema.Struct({
    featureId: E.ExtensionFeatureId,
    operation: Schema.Literal("create"),
    expectedGeneration: NonNegativeInt,
  }),
  Schema.Struct({
    featureId: E.ExtensionFeatureId,
    operation: Schema.Literals(["observe", "redeem", "cancel"]),
    challengeId: id,
    expectedGeneration: NonNegativeInt,
  }),
  Schema.Struct({
    featureId: E.ExtensionFeatureId,
    operation: Schema.Literal("revoke"),
    expectedGeneration: NonNegativeInt,
  }),
]);
export const ExtensionHostFundingResult = Schema.Union([
  E.ExtensionFundingChallengeResult,
  E.ExtensionFundingObserveResult,
  E.ExtensionFundingStatusResult,
]);
export const ContextualHostCaptureRequest = Schema.Struct({
  state: Schema.Literals(["running", "paused"]),
  expectedGeneration: NonNegativeInt,
});

export const CONTEXTUAL_WS_METHODS = {
  contextualStatus: "contextual.status",
  contextualProjectSettings: "contextual.projectSettings",
  contextualUpdateProjectSettings: "contextual.updateProjectSettings",
  contextualUpdateThreadSettings: "contextual.updateThreadSettings",
  contextualRefresh: "contextual.refresh",
  contextualExclude: "contextual.exclude",
  contextualPreparationAction: "contextual.preparationAction",
  contextualDisclosures: "contextual.disclosures",
  contextualConflicts: "contextual.conflicts",
  contextualResolveConflict: "contextual.resolveConflict",
  contextualGroup: "contextual.group",
  contextualMutateGroup: "contextual.mutateGroup",
  contextualUndoGroup: "contextual.undoGroup",
  contextualSources: "contextual.sources",
  contextualConfigureSources: "contextual.configureSources",
  contextualCaptureStatus: "contextual.captureStatus",
  contextualSetCapture: "contextual.setCapture",
  contextualInspect: "contextual.inspect",
  contextualEvidence: "contextual.evidence",
  contextualExport: "contextual.export",
  contextualForget: "contextual.forget",
  contextualSubscribe: "contextual.subscribe",
  extensionsFundingStatus: "extensions.fundingStatus",
  extensionsFunding: "extensions.funding",
} as const;
const M = CONTEXTUAL_WS_METHODS;
/** Explicit operations prevent raw helper passthrough and separate admin archive access. */
export const ContextualRpcs = [
  Rpc.make(M.contextualStatus, {
    payload: { threadId: ThreadId },
    success: ContextualStatusResult,
    error,
  }),
  Rpc.make(M.contextualProjectSettings, {
    payload: { projectId: ProjectId },
    success: C.ContextualProjectSettings,
    error,
  }),
  Rpc.make(M.contextualUpdateProjectSettings, {
    payload: C.ContextualProjectSettingsUpdateRequest,
    success: C.ContextualProjectSettings,
    error,
  }),
  Rpc.make(M.contextualUpdateThreadSettings, {
    payload: C.ContextualThreadSettingsUpdateRequest,
    success: C.ContextualThreadSettings,
    error,
  }),
  Rpc.make(M.contextualRefresh, {
    payload: C.ContextualRefreshRequest,
    success: C.ContextualThreadSettings,
    error,
  }),
  Rpc.make(M.contextualExclude, {
    payload: C.ContextualExclusionRequest,
    success: C.ContextualThreadSettings,
    error,
  }),
  Rpc.make(M.contextualPreparationAction, {
    payload: C.ContextualPreparationActionRequest,
    success: C.ContextualPreparation,
    error,
  }),
  Rpc.make(M.contextualDisclosures, {
    payload: C.ContextualReadRequest,
    success: Schema.Struct({
      items: Schema.Array(C.ContextualDisclosure).check(Schema.isMaxLength(50)),
      preparation: Schema.optionalKey(Schema.NullOr(C.ContextualPreparation)),
      nextCursor: Schema.NullOr(id),
    }),
    error,
  }),
  Rpc.make(M.contextualConflicts, {
    payload: ContextualConflictListRequest,
    success: Schema.Struct({
      items: Schema.Array(C.ContextualConflict).check(Schema.isMaxLength(50)),
      nextCursor: Schema.NullOr(id),
    }),
    error,
  }),
  Rpc.make(M.contextualResolveConflict, {
    payload: C.ContextualConflictResolution,
    success: C.ContextualConflict,
    error,
  }),
  Rpc.make(M.contextualGroup, {
    payload: ContextualGroupReadRequest,
    success: C.ContextualDecisionGroup,
    error,
  }),
  Rpc.make(M.contextualMutateGroup, {
    payload: C.ContextualGroupMutationRequest,
    success: C.ContextualDecisionGroup,
    error,
  }),
  Rpc.make(M.contextualUndoGroup, {
    payload: C.ContextualGroupUndoRequest,
    success: C.ContextualDecisionGroup,
    error,
  }),
  Rpc.make(M.contextualSources, {
    payload: H.ContextualSourcesListRequest,
    success: H.ContextualSourcesListResult,
    error,
  }),
  Rpc.make(M.contextualConfigureSources, {
    payload: H.ContextualSourcesConfigureRequest,
    success: H.ContextualSourcesConfigureResult,
    error,
  }),
  Rpc.make(M.contextualCaptureStatus, {
    payload: {},
    success: H.ContextualCaptureStatusResult,
    error,
  }),
  Rpc.make(M.contextualSetCapture, {
    payload: ContextualHostCaptureRequest,
    success: H.ContextualCaptureStatusResult,
    error,
  }),
  Rpc.make(M.contextualInspect, {
    payload: ContextualArchiveInspectRequest,
    success: C.ContextualRetrieveResult,
    error,
  }),
  Rpc.make(M.contextualEvidence, {
    payload: H.ContextualEvidenceReadRequest,
    success: H.ContextualEvidenceReadResult,
    error,
  }),
  Rpc.make(M.contextualExport, {
    payload: H.ContextualDataExportRequest,
    success: H.ContextualDataJobReceipt,
    error,
  }),
  Rpc.make(M.contextualForget, {
    payload: H.ContextualDataForgetRequest,
    success: H.ContextualDataJobReceipt,
    error,
  }),
  Rpc.make(M.contextualSubscribe, {
    payload: C.ContextualSubscribeRequest,
    success: C.ContextualEvent,
    error,
    stream: true,
  }),
  Rpc.make(M.extensionsFundingStatus, {
    payload: { featureId: E.ExtensionFeatureId },
    success: E.ExtensionFundingStatusResult,
    error,
  }),
  Rpc.make(M.extensionsFunding, {
    payload: ExtensionHostFundingRequest,
    success: ExtensionHostFundingResult,
    error,
  }),
] as const;

export const CONTEXTUAL_RPC_SCOPES = {
  [M.contextualStatus]: AuthOrchestrationReadScope,
  [M.contextualProjectSettings]: AuthOrchestrationReadScope,
  [M.contextualUpdateProjectSettings]: AuthOrchestrationOperateScope,
  [M.contextualUpdateThreadSettings]: AuthOrchestrationOperateScope,
  [M.contextualRefresh]: AuthOrchestrationOperateScope,
  [M.contextualExclude]: AuthOrchestrationOperateScope,
  [M.contextualPreparationAction]: AuthOrchestrationOperateScope,
  [M.contextualDisclosures]: AuthOrchestrationReadScope,
  [M.contextualConflicts]: AuthOrchestrationReadScope,
  [M.contextualResolveConflict]: AuthOrchestrationOperateScope,
  [M.contextualGroup]: AuthOrchestrationReadScope,
  [M.contextualMutateGroup]: AuthOrchestrationOperateScope,
  [M.contextualUndoGroup]: AuthOrchestrationOperateScope,
  [M.contextualSources]: AuthAccessWriteScope,
  [M.contextualConfigureSources]: AuthAccessWriteScope,
  [M.contextualCaptureStatus]: AuthOrchestrationReadScope,
  [M.contextualSetCapture]: AuthAccessWriteScope,
  [M.contextualInspect]: AuthAccessWriteScope,
  [M.contextualEvidence]: AuthAccessWriteScope,
  [M.contextualExport]: AuthAccessWriteScope,
  [M.contextualForget]: AuthAccessWriteScope,
  [M.contextualSubscribe]: AuthOrchestrationReadScope,
  [M.extensionsFundingStatus]: AuthOrchestrationReadScope,
  [M.extensionsFunding]: AuthRelayWriteScope,
} as const;

export type ContextualStatusResult = typeof ContextualStatusResult.Type;
export type ContextualArchiveInspectRequest = typeof ContextualArchiveInspectRequest.Type;
export type ContextualGroupReadRequest = typeof ContextualGroupReadRequest.Type;
export type ExtensionHostFundingRequest = typeof ExtensionHostFundingRequest.Type;
export type ExtensionHostFundingResult = typeof ExtensionHostFundingResult.Type;
export type ContextualHostCaptureRequest = typeof ContextualHostCaptureRequest.Type;
