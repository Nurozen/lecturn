import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  staveAdmissionErrorMessage,
  threadImportFailureReason,
} from "@lecturn/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import {
  ThreadId,
  type EnvironmentId,
  type ExternalSessionSummary,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@lecturn/contracts";
import { useCallback, useMemo, useRef } from "react";
import { Alert } from "react-native";

import { buildModelOptions, resolveDefaultableModelSelection } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { stickyComposerModelSelectionAtom } from "../../state/use-composer-drafts";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { resolveProviderInteractionMode } from "./legacy-plan-mode";
import {
  resolveImportModelSelection,
  resolveThreadImportAvailability,
  threadImportFailureMessage,
  type ThreadImportAvailability,
} from "./thread-import";

const ALERT_TITLE = "Could not import session";

/**
 * The gate every import entry point shares: a live connection, a server that
 * can fork, and at least one instance that lists its outside sessions.
 */
export function useThreadImportAvailability(
  environmentId: EnvironmentId | null,
): ThreadImportAvailability {
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const connected = connectedEnvironments.some(
    (environment) =>
      environment.environmentId === environmentId && environment.connectionState === "connected",
  );
  return useMemo(
    () =>
      resolveThreadImportAvailability({
        connected,
        serverSupportsForking: serverConfig?.environment.capabilities.threadForking === true,
        providers: serverConfig?.providers ?? [],
      }),
    [connected, serverConfig],
  );
}

/**
 * Imports an external provider session as a new thread and resolves to its ref
 * (null when the import was refused or failed, after alerting). Mirrors
 * `useForkThread`: mint the thread id, dispatch once per session, alert from a
 * message table. The session fixes the provider instance, so the thread starts
 * on that instance's model, while the caller supplies the modes its entry
 * point offers (see `resolveImportThreadModes`) and the instance clamps the
 * interaction mode it cannot honor. A refused import materializes nothing
 * server-side, so there is nothing to compensate.
 */
export function useImportThread(): (input: {
  readonly session: ExternalSessionSummary;
  readonly project: EnvironmentProject;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) => Promise<ScopedThreadRef | null> {
  const importMutation = useAtomCommand(threadEnvironment.import, { reportFailure: false });
  const inFlightSessionKeys = useRef(new Set<string>());

  return useCallback(
    async ({ branch, interactionMode, project, runtimeMode, session, worktreePath }) => {
      const key = `${project.environmentId}:${session.providerInstanceId}:${session.sessionId}`;
      if (inFlightSessionKeys.current.has(key)) {
        return null;
      }
      const serverConfig = appAtomRegistry.get(
        serverEnvironment.configValueAtom(project.environmentId),
      );
      const modelSelection = resolveImportModelSelection({
        instanceId: session.providerInstanceId,
        modelOptions: buildModelOptions(serverConfig, null),
        projectDefault: resolveDefaultableModelSelection(
          serverConfig,
          project.defaultModelSelection,
        ),
        stickySelection: resolveDefaultableModelSelection(
          serverConfig,
          appAtomRegistry.get(stickyComposerModelSelectionAtom),
        ),
      });
      if (modelSelection === null) {
        Alert.alert(ALERT_TITLE, threadImportFailureMessage("provider-unavailable"));
        return null;
      }

      inFlightSessionKeys.current.add(key);
      try {
        const threadId = ThreadId.make(uuidv4());
        const result = await importMutation({
          environmentId: project.environmentId,
          input: {
            threadId,
            projectId: project.id,
            providerInstanceId: session.providerInstanceId,
            sessionId: session.sessionId,
            modelSelection,
            runtimeMode,
            interactionMode: resolveProviderInteractionMode(
              serverConfig?.providers.find(
                (candidate) => candidate.instanceId === session.providerInstanceId,
              ),
              interactionMode,
            ),
            branch,
            worktreePath,
            createdAt: new Date().toISOString(),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            const reason = threadImportFailureReason(error);
            Alert.alert(
              ALERT_TITLE,
              reason !== null
                ? threadImportFailureMessage(reason)
                : (staveAdmissionErrorMessage(error) ??
                    (error instanceof Error && error.message.trim().length > 0
                      ? error.message
                      : "The session could not be imported.")),
            );
          }
          return null;
        }
        return scopeThreadRef(project.environmentId, threadId);
      } finally {
        inFlightSessionKeys.current.delete(key);
      }
    },
    [importMutation],
  );
}
