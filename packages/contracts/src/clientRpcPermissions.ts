import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [WS_METHODS.appsDecidePairing]: AuthAccessWriteScope,
  [WS_METHODS.appsRevoke]: AuthAccessWriteScope,
  [WS_METHODS.appsSetRuntimeCeiling]: AuthAccessWriteScope,
  [WS_METHODS.appsDelete]: AuthAccessWriteScope,
  // Lecturn: every Squire mutation operates this environment's agents.
  [WS_METHODS.squireCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireSetStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireTrack]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireUntrack]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireItemsAct]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireItemAsk]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireVoiceNote]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireLeadEnsure]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireLeadOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireControlRevert]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireItemsMarkOpened]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRuleCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRuleRemove]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireTriggerCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireTriggerUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireTriggerRotate]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireTriggerRevoke]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireTriggerTest]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireAutomationResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireLeadSweep]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRoomCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRoomUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRoomClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRoomReopen]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRoomPost]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRoomReroute]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireRoomMarkRead]: AuthOrchestrationOperateScope,
  [WS_METHODS.squireNotificationAlerted]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
