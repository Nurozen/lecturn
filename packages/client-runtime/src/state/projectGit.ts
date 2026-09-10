import type { OrchestrationProjectShell, ThreadEnvMode } from "@t3tools/contracts";

/**
 * Git targeting for a project that may be a Stave space.
 *
 * A Stave space's workspace root is not itself a git repository — it is a
 * directory of repo worktrees described by `.stave.yaml`. Git surfaces
 * (status, PR lookup, branch pickers, commit/push) must therefore address
 * the space's primary repo, while files and terminals keep using the space
 * root. These resolvers are the single place that choice is made so web and
 * mobile cannot disagree.
 */

type ProjectLike = Pick<OrchestrationProjectShell, "workspaceRoot"> & {
  readonly stave?: OrchestrationProjectShell["stave"];
  readonly repositoryIdentity?: OrchestrationProjectShell["repositoryIdentity"];
};

interface ThreadLike {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export function isStaveProject(project: ProjectLike | null | undefined): boolean {
  return project?.stave != null;
}

export function staveThreadStartMessage(project: ProjectLike | null | undefined): string | null {
  return project?.stave?.state === "archived"
    ? "Unarchive this Stave space in project settings to start a thread."
    : null;
}

/**
 * Directory git commands should run in for a thread on this project.
 * Stave spaces always target the primary repo (threads never get their own
 * worktree there); otherwise the thread's worktree wins over the project
 * root, matching the pre-Stave behaviour exactly.
 */
export function resolveProjectGitCwd(input: {
  readonly project: ProjectLike | null | undefined;
  readonly thread?: ThreadLike | null | undefined;
}): string | null {
  const { project, thread } = input;
  if (!project) return null;
  if (project.stave) return project.stave.primaryRepoPath ?? null;
  return thread?.worktreePath ?? project.workspaceRoot;
}

/**
 * Branch that status/PR lookups should assume for a thread. New local
 * threads carry `branch: null`, which suppresses PR lookup today; a Stave
 * space fills that gap with the manifest branch of its primary repo.
 */
export function resolveProjectGitBranch(input: {
  readonly project: ProjectLike | null | undefined;
  readonly thread?: ThreadLike | null | undefined;
}): string | null {
  if (input.project?.stave && !input.project.stave.primaryRepoPath) return null;
  return input.thread?.branch ?? input.project?.stave?.primaryBranch ?? null;
}

/**
 * Env mode a project's environment dictates, if any. Stave spaces always run
 * threads in the space root, so the default-mode resolver receives `local`
 * as its top-priority `forcedMode`; for every other project the resolver's
 * normal priority order applies.
 */
export function staveForcedEnvMode(
  project: ProjectLike | null | undefined,
): ThreadEnvMode | undefined {
  return isStaveProject(project) ? "local" : undefined;
}

/** PR identity follows the same primary checkout as Git status. */
export function resolveProjectGitRepositoryIdentity(project: ProjectLike | null | undefined) {
  return project?.stave
    ? (project.stave.primaryRepositoryIdentity ?? null)
    : (project?.repositoryIdentity ?? null);
}

/** Normalize saved or explicit workspace choices before creating/submitting a Stave thread. */
export function normalizeProjectThreadWorkspace<
  T extends {
    readonly envMode?: ThreadEnvMode;
    readonly worktreePath?: string | null;
    readonly branch?: string | null;
    readonly startFromOrigin?: boolean;
  },
>(project: ProjectLike | null | undefined, workspace: T) {
  if (!project?.stave) return workspace;
  return {
    ...workspace,
    envMode: "local" as const,
    worktreePath: null,
    startFromOrigin: false,
    ...(workspace.envMode === "worktree" || workspace.worktreePath
      ? { branch: resolveProjectGitBranch({ project }) }
      : {}),
  };
}
