import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  FACTORY_SOURCES,
  FACTORY_STAGES,
  parseFactoryBranch,
  readFactoryStage,
} from "@lecturn/client-runtime/providerFactory";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { randomUUID } from "../../lib/utils";
import { useQuickSteer } from "../pullRequest/useQuickSteer";
import { buildThreadTurnInterruptInput } from "../ChatView.logic";
import {
  FACTORY_LAUNCH_KEY,
  buildFactoryLaunch,
  factoryProviderReady,
  factoryPullRequest,
  factoryThreadStatus,
  readFactoryLaunch,
  releaseFactoryLaunch,
  sendFactoryLaunch,
  type FactoryLaunchIntent,
} from "./factoryLaunch";
import type {
  FactoryForm,
  FactoryRun,
  FactoryRunSummary,
  FactoryViewProps,
} from "./FactoryView.types";

const key = (environmentId: string, id: string) => JSON.stringify([environmentId, id]);
const initialForm: FactoryForm = {
  projectId: "",
  sourceId: "codex",
  executorId: "",
  modelId: "",
  baseBranch: "",
  constraints: "",
  runtimeMode: "full-access",
};
type Selection = { environmentId?: string; threadId?: string };
function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The Factory request failed.";
}

export function useProviderFactory({
  selection,
  onSelectionChange,
}: {
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
}): FactoryViewProps {
  const projects = useProjects();
  const configs = useServerConfigs();
  const shells = useThreadShells();
  const navigate = useNavigate();
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const refreshVcs = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const quickSteer = useQuickSteer();
  const [draft, setDraft] = useState(initialForm);
  const [launchPending, setLaunchPending] = useState(false);
  const launchInFlight = useRef(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [initialRecovery] = useState(() => {
    let rawRecord: string | null = null;
    try {
      rawRecord = window.localStorage.getItem(FACTORY_LAUNCH_KEY);
      return { intent: readFactoryLaunch(window.localStorage), error: null, rawRecord };
    } catch (error) {
      return { intent: null, error: errorText(error), rawRecord };
    }
  });
  const [recoveryRecord, setRecoveryRecord] = useState(initialRecovery.rawRecord);
  const [recovery, setRecovery] = useState<FactoryLaunchIntent | null>(initialRecovery.intent);
  const [storageError, setStorageError] = useState<string | null>(initialRecovery.error);
  const [actions, setActions] = useState<
    Record<
      string,
      {
        steerPending: boolean;
        interruptPending: boolean;
        error: string | null;
        notice: string | null;
      }
    >
  >({});
  const actionKey = key(selection.environmentId ?? "", selection.threadId ?? "");
  const action = actions[actionKey] ?? {
    steerPending: false,
    interruptPending: false,
    error: null,
    notice: null,
  };
  const { steerPending, interruptPending, error: actionError, notice: actionNotice } = action;
  const patchAction = (patch: Partial<typeof action>) =>
    setActions((current) => ({
      ...current,
      [actionKey]: {
        steerPending: false,
        interruptPending: false,
        error: null,
        notice: null,
        ...current[actionKey],
        ...patch,
      },
    }));
  const setSteerPending = (value: boolean) => patchAction({ steerPending: value });
  const setInterruptPending = (value: boolean) => patchAction({ interruptPending: value });
  const setActionError = (value: string | null) => patchAction({ error: value });
  const setActionNotice = (value: string | null) => patchAction({ notice: value });

  const project =
    projects.find((item) => key(item.environmentId, item.id) === draft.projectId) ??
    (draft.projectId === "" ? projects.find((item) => !item.stave) : undefined);
  const providers = project ? (configs.get(project.environmentId)?.providers ?? []) : [];
  const provider =
    providers.find((item) => item.instanceId === draft.executorId) ??
    (draft.executorId === "" ? providers.find(factoryProviderReady) : undefined);
  const modelId =
    draft.modelId ||
    (provider?.models.find((item) => item.isDefault)?.slug ?? provider?.models[0]?.slug ?? "");
  const form: FactoryForm = {
    ...draft,
    projectId: project ? key(project.environmentId, project.id) : draft.projectId,
    executorId: provider?.instanceId ?? draft.executorId,
    modelId,
  };
  const source = FACTORY_SOURCES.find((item) => item.id === form.sourceId);
  const projectEnvironment = useEnvironment(project?.environmentId ?? null);
  const projectGit = useEnvironmentQuery(
    project && !project.stave
      ? vcsEnvironment.status({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  );
  const selected = shells.find(
    (item) =>
      item.environmentId === selection.environmentId &&
      item.id === selection.threadId &&
      (parseFactoryBranch(item.branch) !== null ||
        (recovery?.environmentId === item.environmentId && recovery.command.threadId === item.id)),
  );
  const selectedRef = selected ? scopeThreadRef(selected.environmentId, selected.id) : null;
  const threadState = useEnvironmentThread(
    selectedRef?.environmentId ?? null,
    selectedRef?.threadId ?? null,
  );
  const detail = Option.getOrNull(threadState.data);
  const selectedEnvironment = useEnvironment(selected?.environmentId ?? null);
  const git = useEnvironmentQuery(
    selected?.worktreePath
      ? vcsEnvironment.status({
          environmentId: selected.environmentId,
          input: { cwd: selected.worktreePath },
        })
      : null,
  );
  const refreshEnvironmentId = selected?.environmentId;
  const refreshThreadId = selected?.id;
  const refreshCwd = selected?.worktreePath;
  const refreshCompletedAt = selected?.latestTurn?.completedAt;
  useEffect(() => {
    if (!refreshEnvironmentId || !refreshThreadId || !refreshCwd) return;
    // Completion invalidates the remote PR lookup even when the worktree is unchanged.
    void refreshVcs({ environmentId: refreshEnvironmentId, input: { cwd: refreshCwd } }).catch(
      () => undefined,
    );
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- completion explicitly refreshes the remote PR lookup
  }, [refreshEnvironmentId, refreshThreadId, refreshCwd, refreshCompletedAt, refreshVcs]);
  /* oxlint-disable react/set-state-in-effect -- reconcile the persisted browser intent with server observations */
  useEffect(() => {
    if (!recovery || launchPending) return;
    const found = shells.find(
      (item) =>
        item.environmentId === recovery.environmentId &&
        item.id === recovery.command.threadId &&
        item.branch === recovery.command.bootstrap?.prepareWorktree?.branch &&
        item.worktreePath !== null &&
        item.latestTurn !== null,
    );
    if (!found) return;
    try {
      const current = readFactoryLaunch(window.localStorage);
      if (
        current?.environmentId !== recovery.environmentId ||
        current?.command.commandId !== recovery.command.commandId ||
        current?.command.threadId !== recovery.command.threadId
      ) {
        // Another tab may have retired this intent and started a different run.
        setRecovery(current);
        return;
      }
      window.localStorage.removeItem(FACTORY_LAUNCH_KEY);
      // Server observations reconcile the browser's persisted pending intent.
      setRecovery(null);
    } catch (error) {
      setStorageError(errorText(error));
    }
  }, [recovery, shells, launchPending]);
  /* oxlint-enable react/set-state-in-effect */

  const summarize = (thread: (typeof shells)[number]): FactoryRunSummary => {
    const parsed = parseFactoryBranch(thread.branch);
    const owner = projects.find(
      (item) => item.id === thread.projectId && item.environmentId === thread.environmentId,
    );
    return {
      id: key(thread.environmentId, thread.id),
      title: thread.title,
      sourceLabel:
        FACTORY_SOURCES.find((item) => item.id === parsed?.sourceId)?.name ?? "Provider update",
      projectLabel: owner?.title ?? "Project unavailable",
      ...factoryThreadStatus(thread),
    };
  };
  const runs = shells
    .filter((thread) => !thread.archivedAt && parseFactoryBranch(thread.branch))
    .map(summarize)
    .toReversed();
  const reportedPhase = readFactoryStage(detail?.messages ?? []);
  const live =
    selectedEnvironment?.connection.phase === "connected" && threadState.status === "live";
  const run: FactoryRun | null = selected
    ? {
        ...summarize(selected),
        branch: selected.branch,
        worktreePath: selected.worktreePath,
        reportedPhase,
        ...(reportedPhase
          ? {
              phaseDetail:
                FACTORY_STAGES.find((stage) => stage.id === reportedPhase)?.description ??
                "Agent-reported progress",
            }
          : {}),
        statusDescription:
          selected.session?.lastError ??
          (selected.hasPendingApprovals || selected.hasPendingUserInput
            ? "Open the conversation to answer the agent or review its request."
            : selected.latestTurn?.state === "completed"
              ? "The agent turn ended. Inspect its evidence and PR; completion does not certify the update."
              : "A real agent follows the provider-update recipe. Stages are agent-reported; checks and review are in the conversation."),
        connectionLabel: live
          ? "Live environment"
          : `Last known state · ${selectedEnvironment?.connection.phase ?? threadState.status}`,
        pullRequest: factoryPullRequest(selected, git.data),
        evidence: detail
          ? [
              ...detail.activities.slice(-6).map((activity) => ({
                id: activity.id,
                label: activity.kind,
                text: activity.summary,
                at: activity.createdAt,
              })),
              ...detail.messages
                .filter((message) => message.role === "assistant" && message.text.trim())
                .slice(-3)
                .map((message) => ({
                  id: message.id,
                  label: "Agent report",
                  text: message.text.slice(0, 1800),
                  at: message.createdAt,
                })),
            ]
              .sort((a, b) => a.at.localeCompare(b.at))
              .slice(-7)
          : [],
        canSteer:
          live &&
          !selected.archivedAt &&
          selected.worktreePath !== null &&
          parseFactoryBranch(selected.branch) !== null &&
          selected.latestTurn !== null,
        canInterrupt:
          live &&
          (selected.session?.status === "starting" ||
            selected.session?.status === "running" ||
            selected.latestTurn?.state === "running" ||
            selected.backgroundLiveness === "working" ||
            selected.backgroundLiveness === "monitoring"),
      }
    : null;
  const launchDisabledReason =
    storageError ??
    (recovery
      ? "Inspect the launch awaiting confirmation before starting another run."
      : !project
        ? "Choose a repository project."
        : project.stave
          ? "Select an editable repository project rather than a Stave space."
          : projectEnvironment?.connection.phase !== "connected"
            ? "Connect this project's environment to launch."
            : (projectGit.error ??
              (projectGit.data === null
                ? "Checking the project repository…"
                : !projectGit.data.isRepo
                  ? "This project is not a Git repository."
                  : !provider || !factoryProviderReady(provider)
                    ? "Choose an installed, ready execution provider."
                    : !provider.models.some((model) => model.slug === form.modelId)
                      ? "Choose an available model."
                      : !source
                        ? "Choose an upstream source."
                        : !form.baseBranch.trim()
                          ? "Enter a base branch, such as main."
                          : null)));

  const launch = async () => {
    if (launchInFlight.current || launchDisabledReason || !project || !provider || !source) return;
    launchInFlight.current = true;
    setLaunchPending(true);
    setLaunchError(null);
    try {
      const intent = buildFactoryLaunch({
        environmentId: project.environmentId,
        project,
        provider,
        form,
        sourceId: source.id,
        uuid: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      await sendFactoryLaunch({
        storage: window.localStorage,
        intent,
        send: async (pending) => {
          setRecovery(pending);
          onSelectionChange({
            environmentId: pending.environmentId,
            threadId: pending.command.threadId,
          });
          const result = await start({
            environmentId: pending.environmentId,
            input: pending.command,
          });
          if (result._tag === "Failure") {
            const failure = Cause.squash(result.cause);
            throw failure;
          }
        },
      });
      setRecovery(readFactoryLaunch(window.localStorage));
    } catch (error) {
      setLaunchError(errorText(error));
      try {
        setRecovery(readFactoryLaunch(window.localStorage));
      } catch (storageFailure) {
        setStorageError(errorText(storageFailure));
      }
    } finally {
      launchInFlight.current = false;
      setLaunchPending(false);
    }
  };

  return {
    form,
    projects: projects.map((item) => ({
      id: key(item.environmentId, item.id),
      label: `${item.title} · ${item.environmentId}`,
      description: item.stave
        ? "Stave space — select an editable repository project"
        : item.workspaceRoot,
    })),
    sources: FACTORY_SOURCES.map((item) => ({
      id: item.id,
      label: item.name,
      url: item.url,
      description: item.description,
    })),
    executors: providers.map((item) => ({
      id: item.instanceId,
      label: item.displayName ?? item.driver,
      disabled: !factoryProviderReady(item),
      description: item.message ?? item.status,
    })),
    models: provider?.models.map((item) => ({ id: item.slug, label: item.name })) ?? [],
    launchPending,
    launchDisabledReason,
    launchError,
    recovery: recovery
      ? {
          message:
            "Launch awaiting confirmation. Inspect its saved conversation; this launch will never be replayed.",
          canInspect: true,
        }
      : storageError
        ? {
            message:
              "A saved launch could not be read. Preserve its raw record and release the lock to start over.",
            canInspect: false,
          }
        : null,
    run,
    runs,
    steerPending,
    interruptPending,
    actionError:
      actionError ??
      Option.getOrNull(threadState.error) ??
      git.error ??
      (selection.threadId && !selected && !recovery
        ? "This run is not available in the connected environment."
        : null),
    actionNotice,
    onFormChange: (patch) =>
      setDraft({
        ...form,
        ...patch,
        ...(patch.projectId !== undefined
          ? { executorId: "", modelId: "" }
          : patch.executorId !== undefined
            ? { modelId: "" }
            : {}),
      }),
    onLaunch: () => {
      void launch();
    },
    onSelectRun: (id) => {
      const thread = shells.find((item) => key(item.environmentId, item.id) === id);
      if (thread) {
        setActionError(null);
        setActionNotice(null);
        onSelectionChange({ environmentId: thread.environmentId, threadId: thread.id });
      }
    },
    onNewRun: () => {
      setActionError(null);
      setActionNotice(null);
      onSelectionChange({});
    },
    onReleaseRecovery: () => {
      try {
        const currentRecord = window.localStorage.getItem(FACTORY_LAUNCH_KEY);
        let current: FactoryLaunchIntent | null = null;
        let decodeError: string | null = null;
        try {
          current = readFactoryLaunch(window.localStorage);
        } catch (error) {
          decodeError = errorText(error);
        }
        const changed = recovery
          ? current?.environmentId !== recovery.environmentId ||
            current?.command.commandId !== recovery.command.commandId ||
            current?.command.threadId !== recovery.command.threadId
          : currentRecord !== recoveryRecord;
        if (changed && currentRecord !== null) {
          setRecovery(current);
          setRecoveryRecord(currentRecord);
          setStorageError(decodeError);
          setLaunchError(
            "The saved launch changed in another tab. Inspect the current record before releasing its lock.",
          );
          return;
        }
        releaseFactoryLaunch(window.localStorage, currentRecord);
        setRecovery(null);
        setStorageError(null);
        setLaunchError(null);
        setActionNotice(
          "Launch lock released. The original run was not stopped or resent; its reference is retained in this browser.",
        );
      } catch (error) {
        setLaunchError(errorText(error));
      }
    },
    onInspectRecovery: () => {
      if (!recovery) return;
      onSelectionChange({
        environmentId: recovery.environmentId,
        threadId: recovery.command.threadId,
      });
      if (
        !shells.some(
          (thread) =>
            thread.environmentId === recovery.environmentId &&
            thread.id === recovery.command.threadId,
        )
      )
        setLaunchError(
          "The environment has not confirmed this run. Its launch will not be resent. Reconnect the environment to inspect its state.",
        );
    },
    onOpenConversation: () => {
      if (selectedRef) void navigate({ to: "/$environmentId/$threadId", params: selectedRef });
    },
    onSteer: async (text) => {
      if (!selected || !run?.canSteer || steerPending) return false;
      setSteerPending(true);
      setActionError(null);
      setActionNotice(null);
      try {
        await quickSteer(selected.environmentId, selected.id, text);
        setActionNotice(
          "Steering message received. Follow the conversation to see how the agent responds.",
        );
        return true;
      } catch (error) {
        setActionError(errorText(error));
        return false;
      } finally {
        setSteerPending(false);
      }
    },
    onInterrupt: () => {
      if (!selected || !run?.canInterrupt || interruptPending) return;
      setInterruptPending(true);
      setActionError(null);
      setActionNotice(null);
      void interrupt({
        environmentId: selected.environmentId,
        input: buildThreadTurnInterruptInput(selected),
      })
        .then((result) => {
          if (result._tag === "Failure") setActionError(formatEnvironmentQueryError(result.cause));
          else setActionNotice("Interrupt requested. Waiting for the provider to stop.");
        })
        .catch((error: unknown) => setActionError(errorText(error)))
        .finally(() => setInterruptPending(false));
    },
  };
}
