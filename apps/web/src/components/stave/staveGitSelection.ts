import { selectStaveGitTarget } from "./staveGitSelection.logic";
import { useMemo } from "react";
import { create } from "zustand";
import { resolveProjectGitTargets } from "@lecturn/client-runtime/state/projectGit";
import type { EnvironmentId, OrchestrationProjectShell } from "@lecturn/contracts";

// UI selection never changes the thread's working directory or branch metadata.
const useSelection = create<{
  bySpace: Record<string, string>;
  select: (space: string, repo: string) => void;
}>((set) => ({
  bySpace: {},
  select: (space, repo) => set((state) => ({ bySpace: { ...state.bySpace, [space]: repo } })),
}));

export function useStaveGitSelection(
  environmentId: EnvironmentId | null | undefined,
  project: OrchestrationProjectShell | null | undefined,
) {
  const space = JSON.stringify([environmentId, project?.id, project?.workspaceRoot]);
  const key = useSelection((state) => state.bySpace[space]);
  const select = useSelection((state) => state.select);
  const targets = useMemo(
    () => (project?.stave ? resolveProjectGitTargets({ project, includeReferences: true }) : []),
    [project],
  );
  const selected = selectStaveGitTarget(targets, key);
  return { targets, selected, select: (repoKey: string) => select(space, repoKey) };
}
