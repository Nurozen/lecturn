import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@lecturn/contracts";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSidebar } from "../ui/sidebar";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The thread actions Apps-mode rows offer. They live once in the tree, not per row, and
 * report their own failures the way the Projects tree does.
 */
export function useAppThreadActions() {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const actions = useThreadActions();
  const confirmThreadArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);

  const run = (title: string, execute: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    void execute().then((result) => reportFailure(title, result));
  };

  return {
    renamingThreadKey,
    open: (threadRef: ScopedThreadRef) => {
      // A Projects-mode multi-selection would otherwise act on rows this tree cannot show.
      clearSelection();
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    pin: (threadRef: ScopedThreadRef) =>
      run("Failed to pin thread", () => actions.pinThread(threadRef)),
    unpin: (threadRef: ScopedThreadRef) =>
      run("Failed to unpin thread", () => actions.confirmAndUnpinThread(threadRef)),
    settle: (threadRef: ScopedThreadRef) =>
      run("Failed to settle thread", () => actions.settleThread(threadRef)),
    unsettle: (threadRef: ScopedThreadRef) =>
      run("Failed to un-settle thread", () => actions.unsettleThread(threadRef)),
    archive: async (thread: EnvironmentThreadShell) => {
      if (confirmThreadArchive) {
        const confirmed = await settlePromise(
          async () =>
            (await readLocalApi()?.dialogs.confirm(`Archive thread "${thread.title}"?`)) ?? false,
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      run("Failed to archive thread", () =>
        actions.archiveThread(scopeThreadRef(thread.environmentId, thread.id)),
      );
    },
    startRename: (threadRef: ScopedThreadRef) => setRenamingThreadKey(scopedThreadKey(threadRef)),
    cancelRename: () => setRenamingThreadKey(null),
    commitRename: (thread: EnvironmentThreadShell, title: string) => {
      setRenamingThreadKey(null);
      const trimmed = title.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (trimmed === thread.title) return;
      run("Failed to rename thread", () =>
        updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, title: trimmed },
        }),
      );
    },
  };
}

export type AppThreadActions = ReturnType<typeof useAppThreadActions>;
