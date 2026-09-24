import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  staveAdmissionErrorMessage,
  threadImportFailureReason,
} from "@lecturn/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ExternalSessionSummary,
} from "@lecturn/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { waitForThreadShell } from "../components/ChatView.logic";
import {
  resolveImportModelSelection,
  threadImportFailureMessage,
} from "../components/ImportSessionPalette.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveCarriedThreadModes } from "../lib/chatThreadActions";
import { newThreadId } from "../lib/utils";
import { readEnvironmentProviders } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { Project } from "../types";
import { useAtomCommand } from "../state/use-atom-command";
import { readThreadCarrySources } from "./useHandleNewThread";

/**
 * The one import dispatcher every web entry point funnels through, mirroring
 * `useForkThread`: mint the thread id, dispatch `thread.import`, wait for the
 * new thread's shell row, navigate. Like a new thread, the import carries the
 * viewed thread's runtime and interaction mode, so importing from a restricted
 * thread never yields a full-access one. Failure toasts; the server
 * materializes nothing on a refused import, so there is no client-side
 * compensation.
 */
export function useImportThread() {
  const importThreadCommand = useAtomCommand(threadEnvironment.import, { reportFailure: false });
  const router = useRouter();

  return useCallback(
    async (input: {
      session: ExternalSessionSummary;
      project: Pick<Project, "environmentId" | "id" | "defaultModelSelection">;
      worktreePath: string | null;
      branch: string | null;
    }): Promise<boolean> => {
      const { project, session } = input;
      const modelSelection = resolveImportModelSelection({
        instanceId: session.providerInstanceId,
        providers: readEnvironmentProviders(project.environmentId),
        projectDefault: project.defaultModelSelection,
        stickySelection:
          useComposerDraftStore.getState().stickyModelSelectionByProvider[
            session.providerInstanceId
          ],
      });
      if (modelSelection === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Could not import session",
            description: threadImportFailureMessage("provider-unavailable"),
          }),
        );
        return false;
      }
      const carried = resolveCarriedThreadModes(
        readThreadCarrySources(resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {})),
      );
      const threadId = newThreadId();
      const threadRef = scopeThreadRef(project.environmentId, threadId);
      const importResult = await importThreadCommand({
        environmentId: project.environmentId,
        input: {
          threadId,
          projectId: project.id,
          providerInstanceId: session.providerInstanceId,
          sessionId: session.sessionId,
          modelSelection,
          runtimeMode: carried.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: carried.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt: new Date().toISOString(),
        },
      });
      if (importResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(importResult)) {
          const error = squashAtomCommandFailure(importResult);
          const reason = threadImportFailureReason(error);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not import session",
              description:
                reason !== null
                  ? threadImportFailureMessage(reason)
                  : (staveAdmissionErrorMessage(error) ??
                    (error instanceof Error
                      ? error.message
                      : "An error occurred while importing the session.")),
            }),
          );
        }
        return false;
      }
      // A timed-out wait still navigates: the thread route renders a loading
      // state until its shell arrives, matching the fork flow.
      await waitForThreadShell(threadRef);
      const navigateResult = await settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
        }),
      );
      return navigateResult._tag === "Success";
    },
    [importThreadCommand, router],
  );
}
