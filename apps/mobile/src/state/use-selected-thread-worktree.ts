import { useMemo } from "react";
import { resolveProjectGitTargets } from "@t3tools/client-runtime/state/projectGit";
import { useThreadGitSelection } from "./thread-git-selection";

import { resolveThreadGitTarget, selectThreadGitRepository } from "./thread-git-target";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

/**
 * `selectedThreadCwd` is where files and terminals open (the thread's
 * worktree or the project root). `selectedThreadGitCwd`/`selectedThreadGitBranch`
 * are what git surfaces must use instead: identical for ordinary projects,
 * but a Stave space selects a manifest checkout independently of the thread.
 */
export function useSelectedThreadWorktree(repoKey?: string) {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const { selectedRepoKey, selectRepository } = useThreadGitSelection(
    selectedThread ? JSON.stringify([selectedThread.environmentId, selectedThread.id]) : null,
  );
  const selectedThreadGitTargets = useMemo(
    () => resolveProjectGitTargets({ project: selectedThreadProject, includeReferences: true }),
    [selectedThreadProject],
  );
  const selectedThreadGitRepository = selectThreadGitRepository(
    selectedThreadGitTargets,
    repoKey ?? selectedRepoKey,
    repoKey !== undefined,
  );
  const pinnedRepositoryMissing = repoKey !== undefined && selectedThreadGitRepository === null;

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
      }),
    [selectedThread?.worktreePath, selectedThreadDetail?.worktreePath],
  );
  const selectedThreadBranch = selectedThread?.branch ?? null;
  const gitTarget = useMemo(
    () =>
      resolveThreadGitTarget({
        project: selectedThreadProject,
        selectedRepoKey: repoKey ?? selectedRepoKey,
        thread: { branch: selectedThreadBranch, worktreePath: selectedThreadWorktreePath },
      }),
    [
      repoKey,
      selectedRepoKey,
      selectedThreadBranch,
      selectedThreadProject,
      selectedThreadWorktreePath,
    ],
  );

  return {
    selectedThreadGitTargets,
    selectedThreadGitRepository,
    selectGitRepository: selectRepository,
    selectedThreadWorktreePath,
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
    selectedThreadGitCwd: pinnedRepositoryMissing ? null : gitTarget.cwd,
    selectedThreadGitBranch: pinnedRepositoryMissing ? null : gitTarget.branch,
  };
}
