import { normalizeProjectPathForComparison } from "@lecturn/shared/path";
import { Effect, Option, Schema } from "effect";
import { StaveRpcRuntime } from "../stave/staveRpcHandlers.ts";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestRef,
  PullRequestWatch,
  PullRequestWatchAuthorization,
  StaveSagaStatus,
} from "@lecturn/contracts";

export type WatchSagaRosters = readonly {
  readonly root: string;
  readonly status: StaveSagaStatus;
}[];

/** Missing or failed rosters confer no saga membership when the runtime is available. */
export const loadWatchSagaRosters = Effect.fn("PullRequestWatch.loadSagaRosters")(function* (
  projects: readonly OrchestrationProjectShell[],
  runtime: Option.Option<StaveRpcRuntime["Service"]>,
) {
  if (Option.isNone(runtime)) return undefined;
  const rosters: { root: string; status: StaveSagaStatus }[] = [];
  for (const project of projects) {
    if (!project.stave?.isSaga || project.stave.state !== "live") continue;
    const status = yield* runtime.value.sagaStatus(project.workspaceRoot).pipe(Effect.option);
    if (Option.isSome(status)) rosters.push({ root: project.workspaceRoot, status: status.value });
  }
  return rosters as WatchSagaRosters;
});

function rosterContains(
  parent: OrchestrationProjectShell,
  child: OrchestrationProjectShell,
  rosters: WatchSagaRosters,
) {
  return rosters.some(
    ({ root, status }) =>
      normalizeProjectPathForComparison(root) ===
        normalizeProjectPathForComparison(parent.workspaceRoot) &&
      status.sagaId === parent.stave?.spaceId &&
      status.sagaCreatedAt !== undefined &&
      status.sagaCreatedAt === parent.stave.createdAt &&
      status.members.some(
        (member) =>
          member.id === child.stave?.spaceId &&
          member.createdAt !== undefined &&
          member.createdAt === child.stave.createdAt &&
          member.workspaceRoot !== undefined &&
          normalizeProjectPathForComparison(member.workspaceRoot) ===
            normalizeProjectPathForComparison(child.workspaceRoot),
      ),
  );
}

/** Only fresh facts from this reconciliation may authorize an external write. */
export function mergeDecision(watch: PullRequestWatch): {
  authorization: PullRequestWatchAuthorization | null;
  action: "merge" | null;
} {
  const authorization = watch.authorization;
  const observation = watch.observation;
  const stay = (status: PullRequestWatchAuthorization["status"], message: string | null) => ({
    authorization: authorization ? { ...authorization, status, message } : null,
    action: null,
  });
  if (!authorization || !observation || !watch.watching || watch.error)
    return { authorization, action: null };
  if (authorization.status === "needs-authorization") return { authorization, action: null };
  if (observation.state === "merged") return stay("merged", null);
  if (observation.state !== "open") return stay("blocked", "The pull request is closed.");
  if (authorization.baseBranch !== observation.baseBranch)
    return stay("needs-authorization", "The target branch changed. Authorize merging again.");
  if (
    authorization.mode === "revision-only" &&
    (!authorization.headRevision || authorization.headRevision !== observation.headRevision)
  )
    return stay(
      "needs-authorization",
      "The pull request revision changed. Authorize merging again.",
    );
  if (!observation.headRevision)
    return stay("blocked", "The current pull request revision could not be verified.");
  if (observation.autoMergeEnabled !== false)
    return stay(
      "blocked",
      "Provider auto-merge must be confirmed disabled before watch-managed merging.",
    );
  if (!observation.supportsRevisionMerge)
    return stay("blocked", "This provider does not support merging with an atomic revision check.");
  if (observation.requiredChecks === "unknown")
    return stay("blocked", "Required checks could not be verified.");
  if (
    observation.checksRevision !== observation.headRevision ||
    !["passing", "none"].includes(observation.requiredChecks) ||
    !observation.mergeable
  )
    return stay("waiting", "Waiting for required checks and repository merge rules.");
  return {
    authorization: { ...authorization, status: "waiting" as const, message: null },
    action: "merge",
  };
}

const decodeBinding = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.String,
      Schema.String,
      Schema.NullOr(Schema.String),
      Schema.NullOr(Schema.String),
      Schema.String,
      Schema.String,
    ]),
  ),
);

/** A server-created binding identifies the checkout independently of grouping's upstream remote. */
export function boundWatchCheckout(
  binding: string | undefined,
  target: OrchestrationProjectShell,
  reference: Pick<PullRequestRef, "repository" | "host"> | undefined,
): string | null {
  if (!binding || !reference) return null;
  const decoded = decodeBinding(binding);
  if (Option.isNone(decoded)) return null;
  const [projectId, root, spaceId, createdAt, cwd, canonicalKey] = decoded.value;
  if (
    projectId !== target.id ||
    normalizeProjectPathForComparison(root) !==
      normalizeProjectPathForComparison(target.workspaceRoot) ||
    spaceId !== (target.stave?.spaceId ?? null) ||
    createdAt !== (target.stave?.createdAt ?? null) ||
    canonicalKey.split("/").slice(1).join("/").toLowerCase() !==
      reference.repository.toLowerCase() ||
    (reference.host !== undefined &&
      canonicalKey.split("/")[0]?.toLowerCase() !== reference.host.toLowerCase())
  )
    return null;
  return normalizeProjectPathForComparison(cwd);
}

/** Projected ancestry is environment-local. Ambiguous saga names never confer membership. */
export function projectContainsWatch(
  sourceId: ProjectId,
  targetId: ProjectId,
  projects: readonly OrchestrationProjectShell[],
  sourceCheckoutPath?: string | null,
  targetReference?: Pick<PullRequestRef, "repository" | "host">,
  rosters?: WatchSagaRosters,
  targetBinding?: string,
): boolean {
  if (sourceId === targetId) return true;
  const source = projects.find((project) => project.id === sourceId);
  let target = projects.find((project) => project.id === targetId);
  if (!source || !target) return false;
  const sameRoot =
    normalizeProjectPathForComparison(source.workspaceRoot) ===
    normalizeProjectPathForComparison(target.workspaceRoot);
  if (sameRoot && (source.stave || target.stave)) {
    return (
      source.stave?.spaceId === target.stave?.spaceId &&
      source.stave?.createdAt !== undefined &&
      source.stave.createdAt === target.stave?.createdAt
    );
  }
  if (
    sameRoot &&
    source.repositoryIdentity?.canonicalKey &&
    source.repositoryIdentity.canonicalKey === target.repositoryIdentity?.canonicalKey
  )
    return true;
  if (!source.stave && source.repositoryIdentity && target.stave) {
    const checkout = normalizeProjectPathForComparison(sourceCheckoutPath ?? source.workspaceRoot);
    const aliases = target.stave.repos.filter(
      (repo) =>
        repo.resolvedPath !== undefined &&
        normalizeProjectPathForComparison(repo.resolvedPath) === checkout,
    );
    if (
      !aliases.some((repo) => repo.mode === "reference") &&
      aliases.some((repo) => {
        if (repo.mode !== "edit") return false;
        if (boundWatchCheckout(targetBinding, target!, targetReference) === checkout) return true;
        const identity = repo.repositoryIdentity;
        if (!identity || identity.canonicalKey !== source.repositoryIdentity?.canonicalKey)
          return false;
        if (!targetReference) return true;
        const repository =
          identity.displayName ||
          (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
        return (
          repository?.toLowerCase() === targetReference.repository.toLowerCase() &&
          (targetReference.host === undefined ||
            identity.canonicalKey.split("/")[0]?.toLowerCase() ===
              targetReference.host.toLowerCase())
        );
      })
    )
      return true;
  }
  const visited = new Set<ProjectId>();
  while (target?.stave && !visited.has(target.id)) {
    if (!rosters && !target.stave.memberOf) break;
    visited.add(target.id);
    const parents = projects.filter(
      (project) =>
        project.stave?.isSaga &&
        project.stave.state === "live" &&
        (rosters
          ? rosterContains(project, target!, rosters)
          : project.stave.spaceId === target?.stave?.memberOf),
    );
    if (parents.length !== 1) return false;
    target = parents[0];
    if (target?.id === sourceId) return true;
  }
  return false;
}
