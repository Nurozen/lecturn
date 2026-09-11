import type { OrchestrationProjectShell } from "@lecturn/contracts";
import {
  isStaveProject,
  resolveProjectGitBranch,
  resolveProjectGitCwd,
} from "@lecturn/client-runtime/state/projectGit";

type ProjectLike = Pick<OrchestrationProjectShell, "workspaceRoot"> & {
  readonly stave?: OrchestrationProjectShell["stave"];
  readonly repositoryIdentity?: OrchestrationProjectShell["repositoryIdentity"];
};

interface ThreadLike {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export interface ThreadGitTarget {
  /** Directory git status / PR lookups run in; null when nothing can be targeted. */
  readonly cwd: string | null;
  /** Branch PR detection compares against (thread branch, else the Stave primary branch). */
  readonly branch: string | null;
  readonly isStave: boolean;
  /**
   * Whether a status query is worth issuing for the row: an ordinary thread
   * needs a branch or its own worktree (a fresh local thread without either
   * stays suppressed); a Stave space always targets its primary repo.
   */
  readonly statusEnabled: boolean;
}

/**
 * Where a thread's git surfaces should look. Wraps the shared client-runtime
 * resolvers so every web call site derives cwd, branch and the "issue a status
 * query at all" gate from one place. `fallbackCwd` covers rows that only know
 * the project's workspace root (the pre-Stave `projectCwd` prop) when the
 * project itself is unavailable; ordinary projects resolve identically either way.
 */
export function resolveThreadGitTarget(input: {
  readonly project: ProjectLike | null | undefined;
  readonly thread: ThreadLike | null | undefined;
  readonly fallbackCwd?: string | null;
}): ThreadGitTarget {
  const { project, thread } = input;
  const isStave = isStaveProject(project);
  const resolvedCwd = resolveProjectGitCwd({ project, thread });
  const cwd = isStave
    ? resolvedCwd
    : (resolvedCwd ?? thread?.worktreePath ?? input.fallbackCwd ?? null);
  const branch = resolveProjectGitBranch({ project, thread });
  const statusEnabled =
    cwd !== null && (branch != null || (thread?.worktreePath ?? null) !== null || isStave);
  return { cwd, branch, isStave, statusEnabled };
}

/**
 * Repository root that diff-file editor links resolve against for the thread's
 * git target: the primary repo's identity for a Stave space, the project's own
 * identity for a local thread, and nothing for a worktree thread (its paths
 * already live under the worktree, which is the git cwd).
 */
export function resolveThreadGitRepositoryRoot(input: {
  readonly project: ProjectLike | null | undefined;
  readonly thread: ThreadLike | null | undefined;
}): string | undefined {
  const { project, thread } = input;
  if (isStaveProject(project)) {
    return project?.stave?.primaryRepositoryIdentity?.rootPath;
  }
  if (thread?.worktreePath) return undefined;
  return project?.repositoryIdentity?.rootPath;
}

export const STAVE_CHECKPOINTS_UNAVAILABLE_REASON = "Checkpoints are unavailable for Stave spaces";

/**
 * Checkpoint diffs and reverts need the thread root to be a git repository; a
 * Stave space root is a directory of worktrees, so the server never records
 * checkpoints there. Returns the reason to show (and to gate checkpoint UI on)
 * or null when checkpoints work as usual.
 */
export function resolveCheckpointsUnavailableReason(
  project: ProjectLike | null | undefined,
): string | null {
  return isStaveProject(project) ? STAVE_CHECKPOINTS_UNAVAILABLE_REASON : null;
}
