import {
  resolveProjectGitBranch,
  resolveProjectGitCwd,
} from "@t3tools/client-runtime/state/projectGit";
import type { OrchestrationProjectShell } from "@t3tools/contracts";

export interface ThreadGitTarget {
  readonly cwd: string | null;
  readonly branch: string | null;
}

/**
 * Where git surfaces (status, PR lookup, branches, actions) for a thread run
 * and which branch they assume. Files and terminals keep using the thread
 * cwd; this is only for git. Stave projects answer with their primary repo
 * because the space root is not a repository. While the project shell is
 * still loading the thread's own worktree keeps pre-Stave behaviour intact
 * (a Stave thread never has one, so the fallback cannot point at the root).
 */
export function resolveThreadGitTarget(input: {
  readonly project: Pick<OrchestrationProjectShell, "workspaceRoot" | "stave"> | null | undefined;
  readonly thread:
    | { readonly branch?: string | null; readonly worktreePath?: string | null }
    | null
    | undefined;
}): ThreadGitTarget {
  return {
    cwd: input.project?.stave
      ? resolveProjectGitCwd(input)
      : (resolveProjectGitCwd(input) ?? input.thread?.worktreePath ?? null),
    branch: resolveProjectGitBranch(input),
  };
}
