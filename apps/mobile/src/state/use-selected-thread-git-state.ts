import { useMemo } from "react";

import { resolveProjectGitCwd } from "@t3tools/client-runtime/state/projectGit";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

import { useBranches } from "./queries";
import { useEnvironmentQuery } from "./query";
import { sourceControlEnvironment } from "./sourceControl";
import { useVcsActionState } from "./use-vcs-action-state";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";

export function useSelectedThreadGitState(repoKey?: string) {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadGitCwd } = useSelectedThreadWorktree(repoKey);

  const selectedThreadGitTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadGitCwd,
    }),
    [selectedThread?.environmentId, selectedThreadGitCwd],
  );
  const gitActionState = useVcsActionState(selectedThreadGitTarget);
  const sourceControlDiscovery = useEnvironmentQuery(
    selectedThread === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: selectedThread.environmentId,
          input: {},
        }),
  );

  // Ordinary projects list branches from their root; Stave uses the selected checkout.
  const selectedThreadGitRootCwd = selectedThreadProject?.stave
    ? selectedThreadGitCwd
    : resolveProjectGitCwd({ project: selectedThreadProject });
  const selectedThreadBranchTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadGitRootCwd,
      query: null,
    }),
    [selectedThread?.environmentId, selectedThreadGitRootCwd],
  );
  const selectedThreadBranchState = useBranches(selectedThreadBranchTarget);
  const selectedThreadBranches = useMemo(
    () =>
      dedupeRemoteBranchesWithLocalMatches(selectedThreadBranchState.data?.refs ?? []).filter(
        (branch) => !branch.isRemote,
      ),
    [selectedThreadBranchState.data?.refs],
  );

  return {
    gitOperationLabel: gitActionState.currentLabel,
    sourceControlDiscovery,
    selectedThreadBranches,
    selectedThreadBranchesLoading: selectedThreadBranchState.isPending,
  };
}
