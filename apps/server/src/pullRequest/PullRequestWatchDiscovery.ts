import {
  pullRequestHostOf,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type PullRequestListEntry,
  type PullRequestWatchTrackInput,
} from "@lecturn/contracts";
import { stableStringify } from "@lecturn/shared/relaySigning";
import { Context, DateTime, Effect, Layer, Path, Schema, Semaphore, type Scope } from "effect";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  projectRepositories,
  resolveProjectRepositories,
  pullRequestRepositoryBinding,
  repositorySelector,
  PullRequestService,
} from "./PullRequestService.ts";
import { PullRequestWatchService } from "./PullRequestWatchService.ts";
import {
  loadWatchSagaRosters,
  projectContainsWatch,
  type WatchSagaRosters,
} from "./PullRequestWatchPolicy.ts";
import { StaveRpcRuntime } from "../stave/staveRpcHandlers.ts";

const isProviderKind = Schema.is(SourceControlProviderKind);
const RECENT_MS = 6 * 60 * 60 * 1_000;
const PROJECT_INTERVAL_MS = 5 * 60 * 1_000;
const PROJECTS_PER_TICK = 4;
const REPOSITORIES_PER_PROJECT = 16;

export interface DiscoveryCandidate {
  readonly thread: OrchestrationThreadShell;
  readonly projectId: OrchestrationProjectShell["id"];
  readonly cwd: string;
  readonly repository: string;
  readonly host: string;
  readonly remoteName: string;
  readonly branch: string;
}

/** A matching branch establishes association, never authorship or managing-agent ownership. */
export function matchesDiscoveredPullRequest(
  candidate: DiscoveryCandidate,
  entry: PullRequestListEntry,
  defaultBranch: string | null,
  viewer: string | undefined,
): boolean {
  return (
    defaultBranch !== null &&
    candidate.branch !== defaultBranch &&
    entry.state === "open" &&
    entry.projectId === candidate.projectId &&
    entry.repository.toLowerCase() === candidate.repository.toLowerCase() &&
    entry.host.toLowerCase() === candidate.host.toLowerCase() &&
    entry.headBranch === candidate.branch &&
    entry.headBranch !== entry.baseBranch &&
    viewer !== undefined &&
    entry.author?.login.toLowerCase() === viewer.toLowerCase() &&
    entry.createdAt >= candidate.thread.createdAt
  );
}

export function discoveryCandidates(
  project: OrchestrationProjectShell,
  threads: readonly OrchestrationThreadShell[],
  path: Path.Path,
  now: number,
  projects: readonly OrchestrationProjectShell[] = [project],
  rosters?: WatchSagaRosters,
  repositories = projectRepositories(project, path),
  currentBranches?: ReadonlyMap<string, string | null>,
): readonly DiscoveryCandidate[] {
  // Listing expands a project's manifest, so do not accidentally fan out into hundreds of hosts.
  if (repositories.length > REPOSITORIES_PER_PROJECT) return [];
  const active = threads
    .filter(
      (thread) =>
        projectContainsWatch(
          thread.projectId,
          project.id,
          projects,
          thread.worktreePath,
          undefined,
          rosters,
        ) &&
        !thread.archivedAt &&
        thread.latestUserMessageAt !== null &&
        (thread.session?.activeTurnId ||
          thread.session?.status === "running" ||
          now - DateTime.toEpochMillis(DateTime.makeUnsafe(thread.updatedAt)) <= RECENT_MS),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 100);
  return active.flatMap((thread) =>
    repositories.flatMap(({ identity, cwd }) => {
      const repository = repositorySelector(identity);
      if (!repository || !isProviderKind(identity.provider) || identity.provider === "unknown")
        return [];
      const host = pullRequestHostOf(identity, identity.provider);
      if (
        !projectContainsWatch(
          thread.projectId,
          project.id,
          projects,
          thread.worktreePath,
          {
            repository,
            host,
          },
          rosters,
          pullRequestRepositoryBinding(project, cwd, identity.canonicalKey),
        )
      )
        return [];
      const repo = project.stave?.repos.find(
        (entry) => path.resolve(project.workspaceRoot, entry.resolvedPath ?? entry.path) === cwd,
      );
      // A Stave thread's scalar branch identifies at most the primary repo; never reuse it here.
      const branch = project.stave
        ? currentBranches
          ? currentBranches.get(cwd)
          : repo?.branch
        : thread.branch;
      if (!branch) return [];
      return [
        {
          thread,
          projectId: project.id,
          cwd: project.stave ? cwd : (thread.worktreePath ?? cwd),
          repository,
          host,
          remoteName: identity.locator.remoteName,
          branch,
        },
      ];
    }),
  );
}

export class PullRequestWatchDiscovery extends Context.Service<
  PullRequestWatchDiscovery,
  {
    readonly tick: Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("lecturn/pullRequest/PullRequestWatchDiscovery") {}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;
  const staveRuntime = yield* Effect.serviceOption(StaveRpcRuntime);
  const requests = yield* PullRequestService;
  const watches = yield* PullRequestWatchService;
  const git = yield* GitVcsDriver;
  const path = yield* Path.Path;
  const vcs = yield* Effect.serviceOption(VcsDriverRegistry);
  const scanned = new Map<string, number>();
  const threadRevisions = new Map<string, string>();
  const semaphore = Semaphore.makeUnsafe(1);
  const tick = Effect.gen(function* () {
    const at = DateTime.toEpochMillis(yield* DateTime.now);
    const snapshot = yield* projections.getShellSnapshot();
    const rosters = yield* loadWatchSagaRosters(snapshot.projects, staveRuntime);
    const known = (yield* watches.list({})).watches;
    const liveIds = new Set(snapshot.projects.map((project) => project.id));
    for (const key of scanned.keys())
      if (!liveIds.has(key as OrchestrationProjectShell["id"])) {
        scanned.delete(key);
        threadRevisions.delete(key);
      }
    const revisions = new Map(
      snapshot.projects.map((project) => [
        project.id,
        stableStringify(
          snapshot.threads
            .filter((thread) =>
              projectContainsWatch(
                thread.projectId,
                project.id,
                snapshot.projects,
                thread.worktreePath,
                undefined,
                rosters,
              ),
            )
            .map((thread) => [
              thread.id,
              thread.latestUserMessageAt,
              thread.latestTurn?.completedAt,
              thread.linkedPullRequest,
            ]),
        ),
      ]),
    );
    const projects = snapshot.projects
      .filter(
        (project) =>
          threadRevisions.get(project.id) !== revisions.get(project.id) ||
          at - (scanned.get(project.id) ?? -Infinity) >= PROJECT_INTERVAL_MS,
      )
      .toSorted((left, right) => (scanned.get(left.id) ?? -1) - (scanned.get(right.id) ?? -1));
    let queried = 0;
    const branches = new Map<string, string | null>();
    for (const project of projects) {
      if (queried >= PROJECTS_PER_TICK) break;
      queried++;
      scanned.set(project.id, at);
      threadRevisions.set(project.id, revisions.get(project.id)!);
      if (projectRepositories(project, path).length > REPOSITORIES_PER_PROJECT) continue;
      const repositories = yield* resolveProjectRepositories(project, path, vcs, true);
      if (repositories.length > REPOSITORIES_PER_PROJECT) continue;
      if (project.stave) {
        // Read once per physical checkout across all remotes and project aliases in this tick.
        // Manifest branches describe creation-time intent, not a later agent's git switch.
        const checkouts = [...new Set(repositories.map(({ cwd }) => cwd))].filter(
          (cwd) => !branches.has(cwd),
        );
        yield* Effect.forEach(
          checkouts,
          (cwd) =>
            git
              .execute({
                operation: "PullRequestWatchDiscovery.currentBranch",
                cwd,
                args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
                allowNonZeroExit: true,
                timeoutMs: 5_000,
                maxOutputBytes: 4_096,
              })
              .pipe(
                Effect.map((result) =>
                  result.exitCode === 0 && !result.stdoutTruncated && result.stdout.trim()
                    ? result.stdout.trim()
                    : null,
                ),
                Effect.orElseSucceed(() => null),
                Effect.tap((branch) => Effect.sync(() => branches.set(cwd, branch))),
              ),
          { concurrency: 4, discard: true },
        );
      }
      const candidates = discoveryCandidates(
        project,
        snapshot.threads,
        path,
        at,
        snapshot.projects,
        rosters,
        repositories,
        project.stave ? branches : undefined,
      );
      if (candidates.length === 0) continue;
      yield* Effect.gen(function* () {
        const listing = yield* requests.list(
          {
            projectId: project.id,
            state: "open",
            involvement: "authored",
            limit: 100,
          },
          { allRemotes: true },
        );
        const defaults = new Map<string, string | null>();
        const associations = new Set<string>();
        for (const candidate of candidates) {
          const possible = listing.entries.filter(
            (entry) =>
              entry.headBranch === candidate.branch &&
              entry.repository.toLowerCase() === candidate.repository.toLowerCase() &&
              entry.host.toLowerCase() === candidate.host.toLowerCase(),
          );
          if (possible.length === 0) continue;
          const key = stableStringify([candidate.cwd, candidate.remoteName]);
          if (!defaults.has(key))
            defaults.set(
              key,
              yield* git
                .resolveDefaultBranchName(candidate.cwd, candidate.remoteName)
                .pipe(Effect.orElseSucceed(() => null)),
            );
          for (const entry of possible) {
            if (
              !matchesDiscoveredPullRequest(
                candidate,
                entry,
                defaults.get(key) ?? null,
                listing.viewers[entry.host],
              )
            )
              continue;
            const reference = {
              projectId: project.id,
              repository: entry.repository,
              host: entry.host,
              number: entry.number,
            };
            const existing = known.find(
              (watch) =>
                watch.reference.projectId === project.id &&
                watch.reference.number === entry.number &&
                watch.reference.host?.toLowerCase() === entry.host.toLowerCase() &&
                watch.reference.repository.toLowerCase() === entry.repository.toLowerCase(),
            );
            if (existing?.threadIds.includes(candidate.thread.id)) continue;
            // Rebinding deliberately clears associations. Its new revision must not replay an old receipt.
            const requestId = `discover:${stableStringify([project.id, entry.host, entry.repository, entry.number, candidate.thread.id, existing?.binding, existing?.revision])}`;
            if (associations.has(requestId)) continue;
            associations.add(requestId);
            const input: PullRequestWatchTrackInput = {
              requestId,
              reference,
              threadId: candidate.thread.id,
            };
            yield* watches.track(input, "system:pr-discovery");
          }
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("PR discovery could not refresh a project", {
            projectId: project.id,
            error,
          }),
        ),
      );
    }
  }).pipe(
    semaphore.withPermit,
    Effect.catch((error) => Effect.logWarning("PR discovery could not refresh", { error })),
  );
  let started = false;
  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        started = false;
      }),
    );
    yield* tick.pipe(Effect.andThen(Effect.sleep("60 seconds")), Effect.forever, forkParked);
  });
  return PullRequestWatchDiscovery.of({ tick, start });
});
export const layer = Layer.effect(PullRequestWatchDiscovery, make);
