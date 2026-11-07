import type { WorktreeSetupSnapshot } from "@lecturn/contracts";
import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type RunId,
  ThreadId,
} from "@lecturn/contracts";
import type { WorkflowOpening } from "@lecturn/client-runtime/state/subagentRuntime";
import { createContext, type MouseEvent } from "react";
import { type LegendListRef } from "@legendapp/list/react";
import type { CodexArtifactTemplate } from "@lecturn/shared/codexArtifactTemplates";
import { type ChatFileAttachment } from "../../types";
import { ExpandedImagePreview } from "./ExpandedImagePreview";
import { type AssistantCitationTarget } from "./AssistantCitationSource";
import { type MessagesTimelineRow, type WorkGroupScrollAnchor } from "./MessagesTimeline.logic";
import { type TimestampFormat } from "@lecturn/contracts/settings";
import { type HandoffTimelineRun } from "./V2LifecycleRow";
import type { ThreadForkPoint } from "@lecturn/client-runtime/state/thread-fork-points";
import type { ThreadNoteHighlightSelector } from "~/lib/threadNoteHighlights";

export interface TimelineRowSharedState {
  citationRequest: AssistantCitationTarget | null;
  noteHighlights: ReadonlyMap<string, readonly ThreadNoteHighlightSelector[]>;
  notesViewport: HTMLElement | null;
  expandedUserMessages: ReadonlySet<MessageId>;
  onToggleUserMessage: (messageId: MessageId) => void;
  listRef: React.RefObject<LegendListRef | null>;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  runs: ReadonlyArray<HandoffTimelineRun>;
  activeThreadEnvironmentId: EnvironmentId;
  onForkFromMessage: (messageId: MessageId) => void;
  forkPointByRunlessReplyId: ReadonlyMap<MessageId, ThreadForkPoint>;
  forkFromRunEnabled: boolean;
  forkWarning: string | null;
  revertDisabledReason: string | null;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  onUseArtifactTemplate: (template: CodexArtifactTemplate) => void;
  onSendAppMessage: ((text: string) => Promise<void>) | undefined;
  onAppFullscreenChange: (rowId: string, fullscreen: boolean) => void;
  onRunShellCommand: ((command: string) => void) | undefined;
  findActive: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  displayThreadKey?: string;
  onOpenTurnDiff: ((runId: RunId, filePath?: string) => void) | undefined;
  onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
  workflowOpening: WorkflowOpening | null;
  onForkFromRun: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
  onRollbackCheckpoint:
    | ((input: { readonly checkpointId: string; readonly scopeId: string }) => void)
    | undefined;
  onToggleTurnFold: (runId: RunId) => void;
  onToggleAttemptFold: (attemptId: RunAttemptId) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
  onFileDownload: (attachment: ChatFileAttachment) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  onToggleWorkEntry: (anchorKey: string, collapsed: boolean) => void;
  onCancelWorktreeSetup: (() => void) | null;
  retryableWorkspacePreparationRunIds: ReadonlySet<RunId>;
  onRetryWorkspacePreparation: ((runId: RunId) => void) | null;
  onWorktreeSetupWorkLocally: (() => void) | null;
  onOpenWorktreeSetupTerminal: ((terminalId: string) => void) | null;
  workGroupViewState: WorkGroupViewState;
}

export interface TimelineRowActivityState {
  isWorking: boolean;
  isCompacting: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
  awaitingUser: boolean;
  isPreparingWorktree: boolean;
  latestRunId: RunId | null;
  backgroundWorktreeSetup: WorktreeSetupSnapshot | null;
}

export const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);

export const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);

export interface WorkGroupViewState {
  scrollPositions: Map<string, WorkGroupScrollAnchor>;
  expandedEntries: Set<string>;
}

export const WorkGroupViewCtx = createContext<{
  state: WorkGroupViewState;
  onToggleEntry: (collapsed: boolean) => void;
} | null>(null);

export type TimelineWorkEntry = Extract<
  MessagesTimelineRow,
  { kind: "work" }
>["groupedEntries"][number];

export type TimelineRow = MessagesTimelineRow;
