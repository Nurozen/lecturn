import { useMemo } from "react";

import { resolveThreadGitTarget } from "./thread-git-target";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

/**
 * `selectedThreadCwd` is where files and terminals open (the thread's
 * worktree or the project root). `selectedThreadGitCwd`/`selectedThreadGitBranch`
 * are what git surfaces must use instead: identical for ordinary projects,
 * but a Stave space redirects git to its primary repo.
 */
export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();

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
        thread: { branch: selectedThreadBranch, worktreePath: selectedThreadWorktreePath },
      }),
    [selectedThreadBranch, selectedThreadProject, selectedThreadWorktreePath],
  );

  return {
    selectedThreadWorktreePath,
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
    selectedThreadGitCwd: gitTarget.cwd,
    selectedThreadGitBranch: gitTarget.branch,
  };
}
