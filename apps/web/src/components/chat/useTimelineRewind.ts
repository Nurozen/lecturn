import type { EnvironmentThread } from "@lecturn/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@lecturn/contracts";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { resolveRevertTargetCheckpoint } from "@lecturn/client-runtime/state/thread-checkpoints";
import type { ThreadForkPoint } from "@lecturn/client-runtime/state/thread-fork-points";
import { useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { readThreadShell } from "../../state/entities";
import { useForkThread } from "../../hooks/useForkThread";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import { canRevertThreadFiles, makeThreadErrorSetter } from "../ChatView.logic";

/** Lecturn: the Edit-from-here dialog state; ChatView renders the dialog itself. */
export interface PendingRevert {
  readonly turnCount: number;
  readonly messageId: MessageId;
  readonly routeThreadKey: string;
  /** Untracked files "Revert files too" would permanently delete. */
  readonly removedPaths: ReadonlyArray<string>;
  readonly removedTruncated: boolean;
}

interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: EnvironmentThread["projection"] | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly isServerThread: boolean;
  readonly forkPointByUserMessageId: ReadonlyMap<MessageId, ThreadForkPoint>;
  readonly forkPointByRunlessReplyId: ReadonlyMap<MessageId, ThreadForkPoint>;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly paintOnlyDisplayedTimeline: boolean;
  readonly phase: SessionPhase;
  readonly isConnecting: boolean;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer), rolling back a provider checkpoint, and forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    activeThreadRef,
    isServerThread,
    forkPointByUserMessageId,
    forkPointByRunlessReplyId,
    timelineMessages,
    paintOnlyDisplayedTimeline,
    phase,
    isConnecting,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const previewCheckpointRevert = useAtomCommand(threadEnvironment.previewCheckpointRevert, {
    reportFailure: false,
  });
  const { forkThreadFrom } = useForkThread();

  const [pendingRevert, setPendingRevert] = useState<PendingRevert | null>(null);
  if (pendingRevert && pendingRevert.routeThreadKey !== routeThreadKey) {
    setPendingRevert(null);
  }
  const revertFilesAvailable = canRevertThreadFiles(activeThread);

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;

    if (!supportsConversationRollback) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    if (restoreFiles === undefined) {
      setPendingRevert({
        turnCount,
        messageId,
        routeThreadKey,
        removedPaths: [],
        removedTruncated: false,
      });
      // Reverting files runs `git clean`, which deletes untracked files the
      // target checkpoint cannot restore. Those have no git object behind
      // them, so the loss is permanent and has to be named before the user
      // picks "Revert files too". The preview targets the same checkpoint the
      // rollback restores (turn count 0 is the pre-run baseline).
      const targetCheckpoint =
        serverProjection === null
          ? undefined
          : resolveRevertTargetCheckpoint(serverProjection.checkpoints, turnCount);
      if (!targetCheckpoint) return;
      void previewCheckpointRevert({
        environmentId,
        input: {
          threadId: activeThread.id,
          scopeId: targetCheckpoint.scopeId,
          checkpointId: targetCheckpoint.id,
        },
      }).then((preview) => {
        if (preview._tag !== "Success") return;
        setPendingRevert((current) =>
          current !== null &&
          current.turnCount === turnCount &&
          current.messageId === messageId &&
          current.routeThreadKey === routeThreadKey
            ? {
                ...current,
                removedPaths: preview.value.removedPaths,
                removedTruncated: preview.value.truncated,
              }
            : current,
        );
      });
      return;
    }

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount,
      restoreFiles,
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      revertThreadCheckpoint,
    });
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    if (rewind.error !== null) {
      setThreadError(activeThread.id, rewind.error);
      return;
    }
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      const nextPrompt = rewind.prompt;
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);

  const onRollbackCheckpoint = async (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!activeThread || isRevertingCheckpoint) return;
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    const localApi = readLocalApi();
    const confirmed =
      localApi == null
        ? window.confirm("Roll back this thread to the selected checkpoint?")
        : await localApi.dialogs.confirm(
            "Roll back this thread to the selected checkpoint?\nThis action cannot be undone.",
          );
    if (!confirmed) return;

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const result = await revertThreadCheckpoint({
      environmentId,
      input: {
        threadId: activeThread.id,
        checkpointId: input.checkpointId,
        scopeId: input.scopeId,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to revert thread state.",
      );
    }
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
  };

  // Upstream's per-response fork goes through the Lecturn fork dispatcher so every
  // entry point mints the same "(fork)" title, seeds, admits and navigates alike.
  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const sourceThreadRef = scopeThreadRef(environmentId, input.sourceThreadId);
    await forkThreadFrom({
      threadRef: sourceThreadRef,
      point: { type: "run", runId: input.runId },
      parentTitle:
        input.sourceThreadId === activeThread.id
          ? activeThread.title
          : (readThreadShell(sourceThreadRef)?.title ?? activeThread.title),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onTimelineRollbackCheckpoint = (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!paintOnlyDisplayedTimeline) void onRollbackCheckpoint(input);
  };
  const onTimelineRollbackCheckpointStable = useStableCallback(onTimelineRollbackCheckpoint);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  // Lecturn edit-and-branch: a user message forks through the turn completed
  // before it, and its text is re-seeded into the child's composer.
  const forkFromMessage = async (messageId: MessageId, point: ThreadForkPoint) => {
    if (!activeThread || !activeThreadRef || !isServerThread) {
      return;
    }
    const message = timelineMessages.find((candidate) => candidate.id === messageId);
    const seedPrompt = message?.role === "user" && message.text.trim() ? message.text : undefined;
    const anchorMessageId =
      point.type === "run"
        ? serverProjection?.runs.find((run) => run.id === point.runId)?.userMessageId
        : undefined;
    await forkThreadFrom({
      threadRef: activeThreadRef,
      point,
      ...(anchorMessageId ? { sourceMessageId: anchorMessageId } : {}),
      parentTitle: activeThread.title,
      ...(seedPrompt !== undefined ? { seedPrompt } : {}),
    });
  };
  const onForkFromMessage = (messageId: MessageId) => {
    // A run-less reply forks through its own turn (no seed: not a user message).
    const point =
      forkPointByUserMessageId.get(messageId) ?? forkPointByRunlessReplyId.get(messageId);
    if (point === undefined) {
      return;
    }
    void forkFromMessage(messageId, point);
  };
  const onForkFromMessageStable = useStableCallback(onForkFromMessage);
  return {
    pendingRevert,
    setPendingRevert,
    revertFilesAvailable,
    onRevertToTurnCount,
    onForkFromMessageStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
    onTimelineRollbackCheckpointStable,
  };
}
