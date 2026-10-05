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
  type ScopedThreadRef,
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

interface ImportThreadInput {
  readonly session: ExternalSessionSummary;
  readonly project: Pick<Project, "environmentId" | "id" | "defaultModelSelection">;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

/** The new thread, or why the import did not land. An interrupted dispatch stays quiet. */
export type ThreadImportDispatchResult =
  | { readonly ok: true; readonly value: ScopedThreadRef }
  | {
      readonly ok: false;
      readonly message: string;
      readonly tone: "warning" | "error";
      readonly interrupted: boolean;
    };

/**
 * The single-session import path every web entry point shares, without toasts
 * or navigation: mint the thread id, dispatch `thread.import`, wait for the
 * new thread's shell row. Like a new thread, the import carries the viewed
 * thread's runtime and interaction mode, so importing from a restricted thread
 * never yields a full-access one. The server materializes nothing on a refused
 * import, so there is no client-side compensation.
 */
export function useDispatchThreadImport() {
  const importThreadCommand = useAtomCommand(threadEnvironment.import, { reportFailure: false });
  const router = useRouter();

  return useCallback(
    async (input: ImportThreadInput): Promise<ThreadImportDispatchResult> => {
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
        return {
          ok: false,
          message: threadImportFailureMessage("provider-unavailable"),
          tone: "warning",
          interrupted: false,
        };
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
        if (isAtomCommandInterrupted(importResult)) {
          return {
            ok: false,
            message: "The import was interrupted.",
            tone: "error",
            interrupted: true,
          };
        }
        const error = squashAtomCommandFailure(importResult);
        const reason = threadImportFailureReason(error);
        return {
          ok: false,
          message:
            reason !== null
              ? threadImportFailureMessage(reason)
              : (staveAdmissionErrorMessage(error) ??
                (error instanceof Error
                  ? error.message
                  : "An error occurred while importing the session.")),
          tone: "error",
          interrupted: false,
        };
      }
      // A timed-out wait still resolves: the thread route renders a loading
      // state until its shell arrives, matching the fork flow.
      await waitForThreadShell(threadRef);
      return { ok: true, value: threadRef };
    },
    [importThreadCommand, router],
  );
}

/**
 * The one dispatcher every single-session web entry point funnels through,
 * mirroring `useForkThread`: import, toast a refusal, navigate to the new
 * thread.
 */
export function useImportThread() {
  const dispatchImport = useDispatchThreadImport();
  const router = useRouter();

  return useCallback(
    async (input: ImportThreadInput): Promise<boolean> => {
      const result = await dispatchImport(input);
      if (!result.ok) {
        if (!result.interrupted) {
          toastManager.add(
            stackedThreadToast({
              type: result.tone,
              title: "Could not import session",
              description: result.message,
            }),
          );
        }
        return false;
      }
      const threadRef = result.value;
      const navigateResult = await settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
        }),
      );
      return navigateResult._tag === "Success";
    },
    [dispatchImport, router],
  );
}
