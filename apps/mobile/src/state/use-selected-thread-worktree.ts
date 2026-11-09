import type { ScopedThreadRef } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";
import { resolveProjectGitTargets } from "@lecturn/client-runtime/state/projectGit";
import { useThreadGitSelection } from "./thread-git-selection";

import { useProject, useQuietThreadShell } from "./entities";
import { resolveThreadGitTarget, selectThreadGitRepository } from "./thread-git-target";
import { useEnvironmentThread } from "./threads";
import { useSelectedThreadWorktreePath, useThreadWorktreePath } from "./use-thread-detail";
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
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: selectedThread?.worktreePath ?? null,
    threadDetailWorktreePath: detailWorktreePath,
  });
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

/**
 * Resolves a thread's cwd the way the selected thread's does, for a thread that is not the
 * current route's: the shell, or the loaded detail when the shell is missing, picks the project.
 */
export function useThreadCwd(ref: ScopedThreadRef | null): string | null {
  const shell = useQuietThreadShell(ref);
  const detailState = useEnvironmentThread(
    shell === null ? (ref?.environmentId ?? null) : null,
    shell === null ? (ref?.threadId ?? null) : null,
  );
  const detailThread = Option.getOrNull(detailState.data)?.thread ?? null;
  const detailWorktreePath = useThreadWorktreePath(ref);
  const projectId = shell?.projectId ?? detailThread?.projectId ?? null;
  const project = useProject(
    ref === null || projectId === null ? null : { environmentId: ref.environmentId, projectId },
  );
  return (
    resolvePreferredThreadWorktreePath({
      threadShellWorktreePath: shell?.worktreePath ?? null,
      threadDetailWorktreePath: detailWorktreePath,
    }) ??
    project?.workspaceRoot ??
    null
  );
}
