import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MessageId, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  buildForkTitle,
  resolveForkDisabledReason,
  waitForThreadShell,
} from "../components/ChatView.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import {
  readEnvironmentProviders,
  readEnvironmentSupportsForking,
  readThreadShell,
} from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Fork availability for shell-only surfaces (header menu, sidebar rows,
 * command palette, keybinding, /fork). Snapshot read, not a subscription:
 * these surfaces evaluate at open/dispatch time, like the action menu does.
 *
 * `throughTurnId` is the latest completed turn — the only fork point a shell
 * exposes; `blockReason` explains an unavailable action (or null).
 */
export function readForkAtLatestTurn(threadRef: ScopedThreadRef): {
  throughTurnId: TurnId | null;
  blockReason: { title: string; description: string } | null;
} {
  const shell = readThreadShell(threadRef);
  const throughTurnId = shell?.latestTurn?.state === "completed" ? shell.latestTurn.turnId : null;
  const blockReason = resolveForkDisabledReason({
    providers: readEnvironmentProviders(threadRef.environmentId),
    modelSelection: shell?.modelSelection ?? null,
    sessionProviderInstanceId: shell?.session?.providerInstanceId,
    capability: readEnvironmentSupportsForking(threadRef.environmentId),
    hasCompletedTurn: throughTurnId !== null,
  });
  return { throughTurnId, blockReason };
}

/**
 * The one fork dispatcher every web entry point funnels through: mint the
 * child id, dispatch `thread.fork`, seed the composer draft (user-message
 * forks), wait for the child's shell row, navigate. Failure toasts;
 * no client-side compensation — the server cleans up a failed fork.
 */
export function useForkThread() {
  const forkThreadCommand = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const navigate = useNavigate();

  const forkThreadFrom = useCallback(
    async (input: {
      threadRef: ScopedThreadRef;
      throughTurnId: TurnId;
      sourceMessageId?: MessageId;
      parentTitle: string | null;
      seedPrompt?: string;
    }): Promise<boolean> => {
      const { threadRef } = input;
      const childThreadId = newThreadId();
      const childRef = scopeThreadRef(threadRef.environmentId, childThreadId);
      const forkResult = await forkThreadCommand({
        environmentId: threadRef.environmentId,
        input: {
          threadId: childThreadId,
          sourceThreadId: threadRef.threadId,
          throughTurnId: input.throughTurnId,
          ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
          title: buildForkTitle(input.parentTitle),
          workspace: "inherit",
          createdAt: new Date().toISOString(),
        },
      });
      if (forkResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(forkResult)) {
          const error = squashAtomCommandFailure(forkResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not fork thread",
              description:
                error instanceof Error
                  ? error.message
                  : "An error occurred while forking the thread.",
            }),
          );
        }
        return false;
      }
      // Seed only after the fork dispatched: a persisted draft for a child
      // that never came to exist would be orphaned in storage forever.
      const seedPrompt = input.seedPrompt?.trim();
      if (seedPrompt) {
        useComposerDraftStore.getState().setPrompt(childRef, input.seedPrompt ?? "");
      }
      // A timed-out wait still navigates: the child route renders a loading
      // state until its shell arrives, matching the implement-plan flow.
      await waitForThreadShell(childRef);
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: childRef.environmentId,
            threadId: childRef.threadId,
          },
        }),
      );
      return navigateResult._tag === "Success";
    },
    [forkThreadCommand, navigate],
  );

  /** Header menu / sidebar / palette / keybinding semantics: fork at the
      latest completed turn, toasting the block reason when unavailable. */
  const forkThreadAtLatestTurn = useCallback(
    async (threadRef: ScopedThreadRef): Promise<boolean> => {
      const shell = readThreadShell(threadRef);
      if (!shell) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Could not fork thread",
            description: "This thread is no longer available to fork.",
          }),
        );
        return false;
      }
      const { throughTurnId, blockReason } = readForkAtLatestTurn(threadRef);
      if (blockReason !== null || throughTurnId === null) {
        const reason = blockReason ?? {
          title: "Nothing to fork yet",
          description: "Forking becomes available once the thread has a completed turn.",
        };
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: reason.title,
            description: reason.description,
          }),
        );
        return false;
      }
      return await forkThreadFrom({
        threadRef,
        throughTurnId,
        parentTitle: shell.title,
      });
    },
    [forkThreadFrom],
  );

  return { forkThreadFrom, forkThreadAtLatestTurn };
}
