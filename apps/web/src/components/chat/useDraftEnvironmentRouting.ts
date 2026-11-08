import { useAtomValue } from "@effect/atom-react";
import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  type ProjectId,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ThreadContextRecord,
} from "@lecturn/contracts";
import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { accountByEnvironmentIdAtom } from "../../cloud/connectAccounts";
import {
  canAutomaticallyRetargetDraft,
  canAutomaticallyRouteToEnvironment,
} from "../../lib/automaticEnvironment";
import { toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { DraftSessionState } from "../../composerDraftStore";

const EMPTY_ENVIRONMENT_IDS: readonly EnvironmentId[] = [];

interface DraftEnvironmentRoutingInput {
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly composerRef: ComposerHandleRef;
  readonly envLocked: boolean;
  readonly automaticEnvironment: boolean;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly providersByEnvironment: ReturnType<typeof useEnvironmentProviders>;
  readonly loadBalancingSettings: {
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  };
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly activeProviderStatus: ServerProvider | null;
  readonly activeProjectId: ProjectId | null;
  readonly activeProjectKey: string | null;
  readonly activeProjectIsScratch: boolean;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly sendInFlightRef: { readonly current: boolean };
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const {
    environmentId,
    draftId,
    draftThread,
    composerRef,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    activeProviderStatus,
    activeProjectId,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  } = input;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const accountByEnvironmentId = useAtomValue(accountByEnvironmentIdAtom);
  const allProjects = useProjects();
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const eligibleLoadBalancingCandidates = logicalProjectEnvironments
    .filter((candidate) => {
      const environment = environmentById.get(candidate.environmentId);
      const environmentSettings = environment?.serverConfig?.settings;
      return (
        environment?.connection.phase === "connected" &&
        (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
        // A referenced thread's context only resolves on the environment that owns it.
        referencedThreadContexts.every(
          (record) => record.environmentId === candidate.environmentId,
        ) &&
        canAutomaticallyRouteToEnvironment({
          sourceEnvironmentId: environmentId,
          targetEnvironmentId: candidate.environmentId,
          accountByEnvironmentId,
          selectedProvider: activeProviderStatus,
          providers: (providersByEnvironment.get(candidate.environmentId) ?? []).map((provider) =>
            environmentSettings
              ? {
                  ...provider,
                  enabled: resolveProjectProviderInstanceEnabled(
                    environmentSettings,
                    candidate.projectId,
                    provider.instanceId,
                  ),
                }
              : provider,
          ),
        })
      );
    })
    .map((candidate) => candidate.environmentId);
  const loadBalancing = useLoadBalancedEnvironment(
    needsLoadBalancing ? eligibleLoadBalancingCandidates : EMPTY_ENVIRONMENT_IDS,
    loadBalancingSettings.loadBalancingWeights,
  );
  // The composer handle is context-provided, so the effect reads it through an event.
  const readComposerModelSelection = useEffectEvent(
    () => composerRef.current?.getSendContext().selectedModelSelection,
  );
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- writes the resolved load-balanced environment into the draft store once the async pick settles
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId || !eligibleLoadBalancingCandidates.includes(target.environmentId))
      return;
    const current = useComposerDraftStore.getState().getComposerDraft(draftId);
    if (
      !activeProjectId ||
      !canAutomaticallyRetargetDraft({ draftId, environmentId, projectId: activeProjectId })
    )
      return;
    if (target.environmentId !== environmentId) {
      const selection = readComposerModelSelection();
      if (!selection || selection.instanceId !== activeProviderInstanceId) return;
      // Keep the model shown before routing, even if the target has different defaults.
      setComposerDraftModelSelection(draftId, selection, {
        replaceOptions: true,
        explicit: current?.modelSelectionExplicit === true,
      });
    }
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    eligibleLoadBalancingCandidates,
    environmentId,
    activeProjectId,
    activeProviderInstanceId,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    setDraftThreadContext,
    setComposerDraftModelSelection,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    if (
      !activeProjectId ||
      !canAutomaticallyRetargetDraft({ draftId, environmentId, projectId: activeProjectId })
    ) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments and context on this machine",
        description:
          "Choose a machine manually to keep this draft's attachments and Contextual settings.",
      });
      return;
    }
    loadBalancing.refresh(eligibleLoadBalancingCandidates);
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  // A change in flight belongs to the draft and project it started on.
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  const environmentChangeRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const environmentChangeScopeRef = useRef("");
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- mirrors the current change scope into a ref that async environment switches compare against
  useLayoutEffect(() => {
    environmentChangeScopeRef.current = environmentChangeScope;
  });
  // Leaving the scope, or unmounting, abandons a change still in flight.
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- abandons an in-flight environment change when the draft or project scope changes or unmounts
  useLayoutEffect(
    () => () => {
      if (environmentChangeRef.current?.scope === environmentChangeScope) {
        environmentChangeRef.current = null;
      }
    },
    [environmentChangeScope],
  );
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = logicalProjectEnvironments.find(
      (env) => env.environmentId === nextEnvironmentId,
    );
    if (!target) return;
    const request = { environmentId: target.environmentId, scope: environmentChangeScope };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    const retarget = (project: (typeof allProjects)[number]) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return;
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
          projectRef,
          draftId,
          { environmentSelection: "manual", loadBalancedEnvironmentId: null },
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        });
      }
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    if (target.projectId !== null) {
      const project = allProjects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      );
      if (project) retarget(project);
      finish();
      return;
    }
    setBusyEnvironmentChange(request);
    void openScratchProject(target.environmentId, "Could not switch machine")
      .then((project) => {
        if (project) retarget(project);
      })
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  return {
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
