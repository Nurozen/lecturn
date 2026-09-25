import { useAtomValue } from "@effect/atom-react";
import type { SagaProjectIndexEntry } from "@lecturn/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import { availableAddProjectStaveSources } from "@lecturn/client-runtime/operations/projects";
import {
  createEnvironmentRpcQueryAtomFamily,
  createRuntimeCommand,
} from "@lecturn/client-runtime/state/runtime";
import { waitForProjectVisible } from "@lecturn/client-runtime/state/shell";
import {
  environmentSupportsStave,
  staveFeatureAvailable,
} from "@lecturn/client-runtime/state/stave";
import { createStaveOperationManager } from "@lecturn/client-runtime/state/stave-operation";
import { EnvironmentId, type ProjectId, WS_METHODS } from "@lecturn/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentServerConfig } from "./entities";
import { mobilePreferencesAtom } from "./preferences";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { environmentShell } from "./shell";

const sagaStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:stave:saga-status",
  tag: WS_METHODS.staveSagaStatus,
  staleTimeMs: 15_000,
});
const sagaIndex = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as Array<{ environmentId: string; sagaRoot: string }>;
    const entries: SagaProjectIndexEntry[] = [];
    for (const target of targets) {
      const environmentId = EnvironmentId.make(target.environmentId);
      const config = get(serverEnvironment.configValueAtom(environmentId));
      if (!environmentSupportsStave(config) || !config?.settings.stave.enabled) continue;
      const result = get(sagaStatus({ environmentId, input: { sagaRoot: target.sagaRoot } }));
      if (AsyncResult.isSuccess(result))
        entries.push({ environmentId, sagaRoot: target.sagaRoot, status: result.value });
    }
    return entries;
  }),
);

export function useSidebarNestSagas(): boolean {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return !AsyncResult.isSuccess(preferences) || preferences.value.sidebarNestSagas !== false;
}

/** Only mounted saga views subscribe. Unavailable/older environments stay flat. */
export function useMobileSagaIndex(projects: ReadonlyArray<EnvironmentProject>, enabled: boolean) {
  const key = useMemo(
    () =>
      JSON.stringify(
        enabled
          ? projects
              .filter((project) => project.stave?.isSaga && project.stave.state !== "archived")
              .map((project) => ({
                environmentId: project.environmentId,
                sagaRoot: project.workspaceRoot,
              }))
          : [],
      ),
    [projects, enabled],
  );
  const entries = useAtomValue(sagaIndex(key));
  useEffect(() => {
    const targets = JSON.parse(key) as Array<{ environmentId: string; sagaRoot: string }>;
    if (targets.length === 0) return;
    const refresh = () => {
      if (AppState.currentState !== "active") return;
      for (const target of targets) {
        const environmentId = EnvironmentId.make(target.environmentId);
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
        if (environmentSupportsStave(config) && config?.settings.stave.enabled)
          appAtomRegistry.refresh(
            sagaStatus({ environmentId, input: { sagaRoot: target.sagaRoot } }),
          );
      }
    };
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [key]);
  return entries;
}

// ── Creating spaces and sagas ─────────────────────────────────
// The reads and the streamed operation behind "New Stave space" / "New Stave
// saga" in Add Project, bound to the same RPCs the web wizard uses.

const staveStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:stave:status",
  tag: WS_METHODS.staveGetStatus,
  staleTimeMs: 15_000,
});

export const staveRepos = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:stave:repos",
  tag: WS_METHODS.staveListRepos,
  staleTimeMs: 15_000,
});

export const staveSpaces = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:stave:spaces",
  tag: WS_METHODS.staveListSpaces,
  staleTimeMs: 15_000,
});

export const staveSagas = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:stave:sagas",
  tag: WS_METHODS.staveListSagas,
  staleTimeMs: 15_000,
});

/** One state atom per operation id plus start-or-resume `run`, as on web. */
export const staveOperations = createStaveOperationManager(connectionAtomRuntime);

/** `createSpace`/`createSaga` report the shell sequence that makes their project visible. */
export const waitForStaveProjectVisible = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:stave:wait-for-project",
  execute: (
    input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly sequence: number;
    },
    registry,
  ) =>
    waitForProjectVisible({
      registry,
      stateAtom: environmentShell.stateValueAtom(input.environmentId),
      projectId: input.projectId,
      sequence: input.sequence,
    }),
});

/**
 * The Stave sources Add Project offers for an environment, gated like web:
 * the build supports Stave, the user enabled it, a binary is runnable, and
 * the binary supports the create.
 */
export function useStaveCreateSources(environmentId: EnvironmentId | null) {
  const config = useEnvironmentServerConfig(environmentId);
  const supported = environmentSupportsStave(config);
  const status = useEnvironmentQuery(
    environmentId !== null && supported && config?.settings.stave.enabled === true
      ? staveStatus({ environmentId, input: {} })
      : null,
  );
  return availableAddProjectStaveSources({
    available: staveFeatureAvailable({ config, settings: config?.settings, status: status.data }),
    unsupportedOperations: status.data?.features?.unsupportedOperations,
  });
}
