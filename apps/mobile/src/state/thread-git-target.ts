import {
  resolveProjectGitBranch,
  resolveProjectGitCwd,
  resolveProjectGitTargets,
  type ProjectGitTarget,
} from "@t3tools/client-runtime/state/projectGit";
import type { OrchestrationProjectShell } from "@t3tools/contracts";

export interface ThreadGitTarget {
  readonly cwd: string | null;
  readonly branch: string | null;
}

/** A stale selection falls back to an editable manifest checkout, then a reference. */
export function selectThreadGitRepository(
  targets: readonly ProjectGitTarget[],
  selectedKey?: string | null,
  requireExact = false,
): ProjectGitTarget | null {
  if (requireExact) return targets.find((target) => target.key === selectedKey) ?? null;
  return (
    targets.find((target) => target.key === selectedKey) ??
    targets.find((target) => target.mode === "edit") ??
    targets[0] ??
    null
  );
}

/** Git selection never changes the thread's space-wide working directory. */
export function resolveThreadGitTarget(input: {
  readonly project: Pick<OrchestrationProjectShell, "workspaceRoot" | "stave"> | null | undefined;
  readonly thread:
    | { readonly branch?: string | null; readonly worktreePath?: string | null }
    | null
    | undefined;
  readonly selectedRepoKey?: string | null;
}): ThreadGitTarget {
  if (input.project?.stave) {
    const target = selectThreadGitRepository(
      resolveProjectGitTargets({ project: input.project, includeReferences: true }),
      input.selectedRepoKey,
    );
    return { cwd: target?.cwd ?? null, branch: target?.branch ?? null };
  }
  return {
    cwd: resolveProjectGitCwd(input) ?? input.thread?.worktreePath ?? null,
    branch: resolveProjectGitBranch(input),
  };
}
