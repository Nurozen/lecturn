import { useAtomValue } from "@effect/atom-react";
import type { SagaProjectIndexEntry } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { environmentSupportsStave } from "@t3tools/client-runtime/state/stave";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom } from "./preferences";
import { serverEnvironment } from "./server";

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
