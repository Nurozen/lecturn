import type {
  OrchestrationProjectShell,
  RepositoryIdentity,
  ThreadEnvMode,
} from "@t3tools/contracts";
import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";
import { resolveProjectPathForDispatch } from "./projects.ts";

/** Git targets follow manifest checkout paths; agent sessions keep the space root. */

type ProjectLike = Pick<OrchestrationProjectShell, "workspaceRoot"> & {
  readonly stave?: OrchestrationProjectShell["stave"];
  readonly repositoryIdentity?: OrchestrationProjectShell["repositoryIdentity"];
};

interface ThreadLike {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export interface ProjectGitTarget {
  readonly key: string;
  readonly cwd: string;
  readonly repoName: string;
  readonly mode: "edit" | "reference";
  readonly branch: string | null;
  readonly repositoryIdentity: RepositoryIdentity | null;
}

/** Resolve old relative manifest paths without using the client's OS or cwd. */
function resolveManifestRepoPath(root: string, repoPath: string): string | null {
  const value = repoPath.trim();
  if (!value || value.includes("\0")) return null;
  if (isWindowsAbsolutePath(value) || value.startsWith("/")) {
    return normalizeProjectPathForDispatch(value);
  }
  if (!isWindowsAbsolutePath(root) && !root.startsWith("/")) return null;
  // Reject ambiguous drive-relative paths and paths that escape the manifest root.
  if (/^[a-zA-Z]:/.test(value) || value.startsWith("\\")) return null;
  let depth = 0;
  for (const segment of value.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (--depth < 0) return null;
    } else depth++;
  }
  return resolveProjectPathForDispatch(`./${value}`, root);
}

/** All manifest repositories, with references exposed only for inspection on request. */
export function resolveProjectGitTargets(input: {
  readonly project: ProjectLike | null | undefined;
  readonly includeReferences?: boolean;
}): readonly ProjectGitTarget[] {
  const { project, includeReferences = false } = input;
  if (!project) return [];
  if (!project.stave) {
    const cwd = project.workspaceRoot;
    return [
      {
        key: normalizeProjectPathForComparison(cwd),
        cwd,
        repoName:
          project.repositoryIdentity?.displayName ??
          cwd.split(/[\\/]/).findLast((segment) => segment.length > 0) ??
          cwd,
        mode: "edit",
        branch: null,
        repositoryIdentity: project.repositoryIdentity ?? null,
      },
    ];
  }
  const targets = new Map<string, ProjectGitTarget>();
  for (const repo of project.stave.repos) {
    const cwd = resolveManifestRepoPath(project.workspaceRoot, repo.resolvedPath ?? repo.path);
    if (!cwd) continue;
    const key = normalizeProjectPathForComparison(cwd);
    const existing = targets.get(key);
    // Conflicting aliases must never turn a reference checkout into a writable target.
    if (existing && (existing.mode === "reference" || repo.mode === "edit")) continue;
    targets.set(key, {
      key,
      cwd,
      repoName: repo.name,
      mode: repo.mode,
      branch: repo.branch ?? null,
      repositoryIdentity:
        repo.repositoryIdentity ??
        (normalizeProjectPathForComparison(project.stave.primaryRepoPath ?? "") === key
          ? (project.stave.primaryRepositoryIdentity ?? null)
          : null),
    });
  }
  return [...targets.values()].filter((target) => includeReferences || target.mode === "edit");
}

/** Full remote repository path for PR identity; provider adapters translate CLI selectors. */
export function resolveRepositoryPullRequestSelector(
  identity:
    | {
        readonly provider?: string;
        readonly displayName?: string | null;
        readonly owner?: string | null;
        readonly name?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!identity) return null;
  return (
    identity.displayName ||
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null)
  );
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
