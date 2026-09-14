import type {
  EnvironmentId,
  OrchestrationProjectShell,
  ProjectId,
  PullRequestRef,
  ScopedProjectRef,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { normalizeProjectPathForComparison } from "@lecturn/shared/path";
import {
  resolveProjectGitTargets,
  resolveRepositoryPullRequestSelector,
  type ProjectGitTarget,
} from "./projectGit.ts";
import type { SagaProjectIndexEntry } from "./projectGrouping.ts";

export type RepositoryScopeProject = Pick<OrchestrationProjectShell, "id" | "workspaceRoot"> & {
  readonly environmentId: EnvironmentId;
  readonly stave?: OrchestrationProjectShell["stave"];
  readonly repositoryIdentity?: OrchestrationProjectShell["repositoryIdentity"];
};

export interface RepositoryScopeTarget extends ProjectGitTarget {
  /** Checkout identity includes the environment, never just the remote repository. */
  readonly environmentId: EnvironmentId;
  readonly projectIds: readonly ProjectId[];
}

export interface RepositoryScopeInput {
  readonly projects: readonly RepositoryScopeProject[];
  /** A project/space/saga uses one root; a project group supplies all of its children. */
  readonly roots: readonly ScopedProjectRef[];
  readonly includeReferences?: boolean;
  /** When supplied, the verified roster replaces memberOf-only membership inference. */
  readonly sagaIndex?: readonly SagaProjectIndexEntry[];
  readonly thread?: ScopedProjectRef & {
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
  };
}

function projectKey(ref: ScopedProjectRef): string {
  return JSON.stringify([ref.environmentId, ref.projectId]);
}

function matchesRoster(
  parent: RepositoryScopeProject,
  child: RepositoryScopeProject,
  entry: SagaProjectIndexEntry,
): boolean {
  return (
    parent.environmentId === entry.environmentId &&
    parent.stave?.spaceId === entry.status.sagaId &&
    entry.status.sagaCreatedAt !== undefined &&
    parent.stave.createdAt === entry.status.sagaCreatedAt &&
    normalizeProjectPathForComparison(parent.workspaceRoot) ===
      normalizeProjectPathForComparison(entry.sagaRoot) &&
    entry.status.members.some(
      (member) =>
        member.id === child.stave?.spaceId &&
        member.createdAt !== undefined &&
        member.createdAt === child.stave.createdAt &&
        member.workspaceRoot !== undefined &&
        normalizeProjectPathForComparison(member.workspaceRoot) ===
          normalizeProjectPathForComparison(child.workspaceRoot),
    )
  );
}

/**
 * Resolve Git checkouts from projected workspace membership, without scanning
 * container directories. Saga descendants and group roots form a stable union;
 * reference aliases take precedence before writable targets are filtered.
 */
export function resolveRepositoryScope(
  input: RepositoryScopeInput,
): readonly RepositoryScopeTarget[] {
  const byId = new Map(
    input.projects.map((project) => [
      projectKey({ environmentId: project.environmentId, projectId: project.id }),
      project,
    ]),
  );
  const children = new Map<string, RepositoryScopeProject[]>();
  const sagas = input.projects.filter((project) => project.stave?.isSaga);
  for (const child of input.projects) {
    if (!child.stave) continue;
    const parents = sagas.filter(
      (parent) =>
        parent.environmentId === child.environmentId &&
        (input.sagaIndex
          ? input.sagaIndex.some((entry) => matchesRoster(parent, child, entry))
          : child.stave?.memberOf === parent.stave?.spaceId),
    );
    // Reused saga names must not capture spaces from an unrelated checkout.
    if (parents.length !== 1) continue;
    const parent = parents[0]!;
    const key = projectKey({ environmentId: parent.environmentId, projectId: parent.id });
    const members = children.get(key) ?? [];
    members.push(child);
    children.set(key, members);
  }

  const targets = new Map<string, RepositoryScopeTarget>();
  const visited = new Set<string>();
  const pending = [...input.roots];
  for (let index = 0; index < pending.length; index++) {
    const ref = pending[index]!;
    const scopeKey = projectKey(ref);
    if (visited.has(scopeKey)) continue;
    visited.add(scopeKey);
    const project = byId.get(scopeKey);
    if (!project) continue;
    pending.push(
      ...(children.get(scopeKey) ?? []).map((child) => ({
        environmentId: child.environmentId,
        projectId: child.id,
      })),
    );
    for (const target of resolveProjectGitTargets({ project, includeReferences: true })) {
      const thread = input.thread;
      const useThread =
        !project.stave &&
        thread?.environmentId === project.environmentId &&
        thread.projectId === project.id;
      const cwd = (useThread && thread.worktreePath) || target.cwd;
      const key = JSON.stringify([project.environmentId, normalizeProjectPathForComparison(cwd)]);
      const existing = targets.get(key);
      const projectIds = [...new Set([...(existing?.projectIds ?? []), project.id])];
      const next = {
        ...target,
        cwd,
        key,
        environmentId: project.environmentId,
        branch: useThread ? (thread.branch ?? target.branch) : target.branch,
        projectIds,
      };
      targets.set(
        key,
        existing && (existing.mode === "reference" || next.mode === "edit")
          ? { ...existing, projectIds }
          : next,
      );
    }
  }
  return [...targets.values()].filter(
    (target) => input.includeReferences || target.mode === "edit",
  );
}

// Watch bindings are server-issued physical checkout receipts. Project grouping may
// name an upstream repository while the receipt identifies a verified fork remote.
const WatchBinding = Schema.fromJsonString(
  Schema.Tuple([
    Schema.String,
    Schema.String,
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.String,
    Schema.String,
  ]),
);
const decodeWatchBinding = Schema.decodeUnknownOption(WatchBinding);

/** A manager must own the watched repository through its scope or an editable checkout alias. */
export function isRepositoryWatchManagerEligible(input: {
  readonly projects: readonly RepositoryScopeProject[];
  readonly sagaIndex?: readonly SagaProjectIndexEntry[];
  readonly environmentId: EnvironmentId;
  readonly thread: NonNullable<RepositoryScopeInput["thread"]>;
  readonly watch: {
    readonly reference: Pick<PullRequestRef, "projectId" | "repository" | "host">;
    readonly binding?: string;
  };
}): boolean {
  const { projects, environmentId, thread, watch } = input;
  if (thread.environmentId !== environmentId) return false;
  const source = projects.find(
    (project) => project.environmentId === environmentId && project.id === thread.projectId,
  );
  const watched = projects.find(
    (project) =>
      project.environmentId === environmentId && project.id === watch.reference.projectId,
  );
  if (!source || !watched) return false;
  if (watched.stave?.state === "archived") return false;
  const binding = watch.binding === undefined ? undefined : decodeWatchBinding(watch.binding);
  // An invalid or stale receipt never falls back to a broad repository-name match.
  if (binding?._tag === "None") return false;
  const bound = binding?._tag === "Some" ? binding.value : undefined;
  if (
    bound &&
    (bound[0] !== watched.id ||
      normalizeProjectPathForComparison(bound[1]) !==
        normalizeProjectPathForComparison(watched.workspaceRoot) ||
      bound[2] !== (watched.stave?.spaceId ?? null) ||
      bound[3] !== (watched.stave?.createdAt ?? null) ||
      bound[5].split("/").slice(1).join("/").toLowerCase() !==
        watch.reference.repository.toLowerCase() ||
      (watch.reference.host !== undefined &&
        bound[5].split("/")[0]?.toLowerCase() !== watch.reference.host.toLowerCase()))
  )
    return false;
  const watchTargets = resolveProjectGitTargets({ project: watched }).filter((target) => {
    if (bound)
      return (
        normalizeProjectPathForComparison(target.cwd) ===
        normalizeProjectPathForComparison(bound[4])
      );
    const identity = target.repositoryIdentity;
    return (
      resolveRepositoryPullRequestSelector(identity)?.toLowerCase() ===
        watch.reference.repository.toLowerCase() &&
      (watch.reference.host === undefined ||
        identity?.canonicalKey.split("/")[0]?.toLowerCase() === watch.reference.host.toLowerCase())
    );
  });
  if (
    watchTargets.length === 0 ||
    new Set(watchTargets.map((target) => target.repositoryIdentity?.canonicalKey)).size !== 1
  )
    return false;
  let ancestor: RepositoryScopeProject = watched;
  const visited = new Set<ProjectId>();
  while (
    ancestor.id !== source.id &&
    (input.sagaIndex || ancestor.stave?.memberOf) &&
    !visited.has(ancestor.id)
  ) {
    visited.add(ancestor.id);
    const parents = projects.filter(
      (project) =>
        project.environmentId === environmentId &&
        project.stave?.isSaga &&
        project.stave.state === "live" &&
        (input.sagaIndex
          ? input.sagaIndex.some((entry) => matchesRoster(project, ancestor, entry))
          : project.stave.spaceId === ancestor?.stave?.memberOf),
    );
    if (parents.length !== 1) break;
    ancestor = parents[0]!;
  }
  const ownsProject = ancestor.id === source.id;
  const scope = resolveRepositoryScope({
    projects,
    roots: [thread],
    thread,
    ...(input.sagaIndex ? { sagaIndex: input.sagaIndex } : {}),
  });
  return watchTargets.some((target) =>
    scope.some((candidate) => {
      if (
        !bound &&
        (!target.repositoryIdentity ||
          candidate.repositoryIdentity?.canonicalKey !== target.repositoryIdentity.canonicalKey)
      )
        return false;
      if (ownsProject && candidate.projectIds.includes(watched.id)) return true;
      if (
        normalizeProjectPathForComparison(candidate.cwd) !==
        normalizeProjectPathForComparison(target.cwd)
      )
        return false;
      if (!source.stave) return true;
      // A second project for the same space must refer to the same manifest incarnation.
      return (
        normalizeProjectPathForComparison(source.workspaceRoot) ===
          normalizeProjectPathForComparison(watched.workspaceRoot) &&
        source.stave.spaceId === watched.stave?.spaceId &&
        source.stave.createdAt !== undefined &&
        source.stave.createdAt === watched.stave.createdAt
      );
    }),
  );
}
