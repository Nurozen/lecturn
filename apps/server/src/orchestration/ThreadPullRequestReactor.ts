import { canonicalRepositoryKey } from "@lecturn/shared/sourceControl";
import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type ThreadId,
  type ThreadLinkedPullRequest,
} from "@lecturn/contracts";
import { normalizeProjectPathForComparison } from "@lecturn/shared/path";
import { makeDrainableWorker } from "@lecturn/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class ThreadPullRequestReactor extends Context.Service<
  ThreadPullRequestReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("lecturn/orchestration/ThreadPullRequestReactor") {}

function samePullRequest(
  left: ThreadLinkedPullRequest | null | undefined,
  right: ThreadLinkedPullRequest | null,
): boolean {
  if (left == null || right === null) return left == null && right === null;
  return (
    left.projectId === right.projectId &&
    left.host?.toLowerCase() === right.host?.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.number === right.number &&
    left.url === right.url
  );
}

/** Startup lookups per settled thread before discovery gives up on it. */
export const BACKFILL_ATTEMPTS = 5;

interface RefreshRequest {
  readonly threadId: ThreadId | null;
  readonly refresh: boolean;
  readonly backfill?: boolean;
}

export function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: OrchestrationProjectShell,
): boolean {
  const identity = project.stave?.primaryRepositoryIdentity ?? project.repositoryIdentity;
  return (
    pullRequest.repositoryKey !== null &&
    identity != null &&
    canonicalRepositoryKey(pullRequest.repositoryKey) ===
      canonicalRepositoryKey(identity.canonicalKey)
  );
}

/** Only the sole editable manifest checkout can own an inferred thread PR. */
function stavePrimaryCwd(project: OrchestrationProjectShell, path: Path.Path): string | null {
  const stave = project.stave;
  if (stave?.state !== "live" || !stave.primaryRepoPath || !stave.primaryRepositoryIdentity)
    return null;
  const checkouts = new Map<string, "edit" | "reference">();
  for (const repo of stave.repos) {
    const rawPath = repo.resolvedPath ?? repo.path;
    if (rawPath.includes("\0")) return null;
    const cwd = path.resolve(project.workspaceRoot, rawPath);
    const relative = path.relative(project.workspaceRoot, cwd);
    if (!path.isAbsolute(rawPath) && (relative === ".." || relative.startsWith(`..${path.sep}`)))
      return null;
    const key = normalizeProjectPathForComparison(cwd);
    if (checkouts.get(key) !== "reference") checkouts.set(key, repo.mode);
  }
  const edits = [...checkouts].filter(([, mode]) => mode === "edit");
  return edits.length === 1 &&
    edits[0]![0] === normalizeProjectPathForComparison(stave.primaryRepoPath)
    ? stave.primaryRepoPath
    : null;
}

function projectLookupKey(project: OrchestrationProjectShell, path: Path.Path): string {
  return JSON.stringify([
    project.workspaceRoot,
    project.stave?.spaceId,
    project.stave?.createdAt,
    project.stave?.state,
    project.stave?.primaryRepoPath,
    project.stave ? stavePrimaryCwd(project, path) : null,
    project.stave?.primaryRepositoryIdentity ?? project.repositoryIdentity,
  ]);
}

/**
 * Read the shell state for a discovery or settlement sweep. A sweep for one
 * thread reads that thread and the projects it names, not every thread. A
 * sweep over all threads reads only unsettled threads, since both sweeps skip
 * settled ones. Discovery's backfill does its own full read.
 */
export const readSweepSnapshot = (
  snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
  threadId: ThreadId | null,
): Effect.Effect<
  Pick<OrchestrationShellSnapshot, "snapshotSequence" | "projects" | "threads">,
  ProjectionRepositoryError
> =>
  threadId === null
    ? snapshots.getShellSnapshot({ unsettledOnly: true })
    : Effect.gen(function* () {
        // Read the sequence first. The thread is then at least this new, so a
        // command guarded by the sequence is rejected rather than missing a change.
        const { snapshotSequence } = yield* snapshots.getSnapshotSequence();
        const thread = yield* snapshots.getThreadShellById(threadId);
        if (Option.isNone(thread)) return { snapshotSequence, projects: [], threads: [] };
        // Settlement also checks the project a saved pull request names.
        const reference = thread.value.linkedPullRequest ?? thread.value.branchPullRequest;
        const projects = yield* snapshots.getProjectShells(
          reference == null
            ? [thread.value.projectId]
            : [thread.value.projectId, reference.projectId],
        );
        return { snapshotSequence, projects, threads: [thread.value] };
      });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Settled threads get one link discovery at startup. Failed lookups retry on
  // the periodic pass a few times, then stop until the thread changes or the
  // server restarts, so a missing or logged-out CLI cannot loop forever.
  const pendingBackfill = new Map<ThreadId, number>();
  const finishBackfill = (threads: ReadonlyArray<{ readonly id: ThreadId }>) => {
    for (const thread of threads) pendingBackfill.delete(thread.id);
  };
  const failBackfill = (threads: ReadonlyArray<{ readonly id: ThreadId }>) => {
    for (const thread of threads) {
      const remaining = pendingBackfill.get(thread.id);
      if (remaining === undefined) continue;
      if (remaining <= 1) pendingBackfill.delete(thread.id);
      else pendingBackfill.set(thread.id, remaining - 1);
    }
  };

  const synchronize = Effect.fn("ThreadPullRequestReactor.synchronize")(function* (
    request: RefreshRequest,
  ) {
    // Backfill looks up settled threads, so its passes read every thread.
    let snapshot =
      request.threadId === null && (request.backfill || pendingBackfill.size > 0)
        ? yield* snapshots.getShellSnapshot()
        : yield* readSweepSnapshot(snapshots, request.threadId);
    // A live Stave space without a sole editable checkout must drop inferred
    // links from its settled threads too (filter below). The unsettled read
    // omits those threads, so read every thread only while such a space exists.
    if (
      request.threadId === null &&
      !request.backfill &&
      pendingBackfill.size === 0 &&
      snapshot.projects.some(
        (project) => project.stave?.state === "live" && stavePrimaryCwd(project, path) === null,
      )
    ) {
      snapshot = yield* snapshots.getShellSnapshot();
    }
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    if (request.backfill) {
      for (const thread of snapshot.threads) {
        if (
          (thread.settledOverride === "settled" || thread.settledAt !== null) &&
          thread.branchPullRequest == null
        ) {
          pendingBackfill.set(thread.id, BACKFILL_ATTEMPTS);
        }
      }
    }
    // A single-thread read only shows whether its own thread is gone. A thread
    // with no branch has nothing to look up, and its entry would keep every
    // periodic pass on the full read.
    const branchThreadIds = new Set(
      snapshot.threads.filter((thread) => thread.branch !== null).map((thread) => thread.id),
    );
    const checkedIds = request.threadId === null ? pendingBackfill.keys() : [request.threadId];
    for (const threadId of checkedIds) {
      if (!branchThreadIds.has(threadId)) pendingBackfill.delete(threadId);
    }
    const threads = snapshot.threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        ((thread.settledOverride !== "settled" && thread.settledAt === null) ||
          request.threadId !== null ||
          pendingBackfill.has(thread.id) ||
          (thread.branchPullRequest != null &&
            projects.get(thread.projectId)?.stave?.state === "live" &&
            stavePrimaryCwd(projects.get(thread.projectId)!, path) === null)) &&
        (projects.get(thread.projectId)?.stave != null ||
          thread.branch !== null ||
          thread.branchPullRequest != null),
    );
    const groups = Map.groupBy(threads, (thread) =>
      JSON.stringify(
        projects.get(thread.projectId)?.stave != null
          ? [thread.projectId, "stave"]
          : [thread.projectId, thread.worktreePath, thread.branch],
      ),
    );

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const first = group[0]!;
          const snapshotProject = projects.get(first.projectId);
          if (
            snapshotProject === undefined ||
            (snapshotProject.stave != null && snapshotProject.stave.state !== "live")
          )
            return finishBackfill(group);
          // A finished turn may have added the remote this PR lives on. A failed
          // refresh resolves to null, so keep the snapshot's identity then.
          // Stave spaces read the manifest's primary identity instead.
          const project =
            request.refresh && snapshotProject.stave == null
              ? {
                  ...snapshotProject,
                  repositoryIdentity:
                    (yield* repositoryIdentities.resolve(snapshotProject.workspaceRoot, {
                      refresh: true,
                    })) ?? snapshotProject.repositoryIdentity,
                }
              : snapshotProject;
          const identity = project.stave?.primaryRepositoryIdentity ?? project.repositoryIdentity;
          const repository = PullRequestService.repositoryIdentityOf(project);
          const host = identity?.canonicalKey.split("/")[0]?.toLowerCase();
          if (project.stave == null && first.branch !== null && repository === null)
            return finishBackfill(group);
          const lookupCwd = Effect.fn("ThreadPullRequestReactor.lookupCwd")(function* (
            currentProject: OrchestrationProjectShell,
          ) {
            if (currentProject.stave != null) {
              const primary = stavePrimaryCwd(currentProject, path);
              return primary !== null && (yield* fileSystem.exists(primary)) ? primary : null;
            }
            return first.worktreePath !== null && (yield* fileSystem.exists(first.worktreePath))
              ? first.worktreePath
              : currentProject.workspaceRoot;
          });
          const liveBranch = Effect.fn("ThreadPullRequestReactor.liveBranch")(function* (
            cwd: string,
          ) {
            // A cached local status can predate an external checkout switch.
            yield* git.invalidateLocalStatus(cwd);
            const status = yield* git.localStatus({ cwd });
            return status.isRepo ? status.refName : null;
          });
          const cwd = yield* lookupCwd(project);
          const branch =
            project.stave != null ? (cwd !== null ? yield* liveBranch(cwd) : null) : first.branch;
          const detected =
            cwd === null || branch === null
              ? null
              : yield* git.branchPullRequest({ cwd, branch }, { refresh: request.refresh });
          // A worktree can have different remotes, and the project identity
          // can lag a remote edit. Do not attach its PR to the wrong repository.
          if (detected !== null && !pullRequestMatchesProject(detected, project)) {
            return finishBackfill(group);
          }
          const detectedReference =
            detected !== null && repository !== null
              ? {
                  projectId: project.id,
                  repository,
                  number: detected.number,
                  url: detected.url,
                  ...(host !== undefined && (project.stave != null || host !== "github.com")
                    ? { host }
                    : {}),
                }
              : null;

          const plans = yield* Effect.forEach(group, (thread) =>
            Effect.gen(function* () {
              let branchPullRequest = detectedReference;
              // Shared checkouts often return to the default branch after
              // a merge. Keep that thread's terminal PR across the change.
              if (
                branchPullRequest === null &&
                project.stave == null &&
                thread.branch !== null &&
                thread.worktreePath === null &&
                thread.branchPullRequest != null
              ) {
                const previous = yield* pullRequests.summary(thread.branchPullRequest, {
                  recoverTransientFailure: false,
                });
                if (previous.state === "merged" || previous.state === "closed") {
                  branchPullRequest = thread.branchPullRequest;
                }
              }

              let replacement: ThreadLinkedPullRequest | undefined;
              if (
                thread.pullRequests.length === 0 &&
                thread.linkedPullRequest != null &&
                detected?.state === "open" &&
                detectedReference !== null &&
                (project.stave == null ||
                  (thread.linkedPullRequest.repository.toLowerCase() ===
                    detectedReference.repository.toLowerCase() &&
                    thread.linkedPullRequest.host?.toLowerCase() === detectedReference.host)) &&
                !samePullRequest(thread.linkedPullRequest, detectedReference)
              ) {
                const linked = yield* pullRequests.summary(thread.linkedPullRequest, {
                  recoverTransientFailure: false,
                });
                if (linked.state === "merged" || linked.state === "closed") {
                  replacement = detectedReference;
                }
              }

              if (
                samePullRequest(thread.branchPullRequest, branchPullRequest) &&
                replacement === undefined
              ) {
                pendingBackfill.delete(thread.id);
                return null;
              }
              return { thread, branchPullRequest, replacement };
            }).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("thread pull request discovery failed", {
                    threadId: thread.id,
                    cause: Cause.pretty(cause),
                  }).pipe(
                    Effect.tap(() => Effect.sync(() => failBackfill([thread]))),
                    Effect.as(null),
                  ),
              ),
            ),
          );
          const updates = plans.filter((plan) => plan !== null);
          if (updates.length === 0) return;

          if (branch !== null && cwd !== null) {
            // Summary reads can outlast a remote edit. The second PR read shares
            // GitManager's provider cache while verifying its remote context.
            const current = yield* git.branchPullRequest({ cwd, branch });
            const currentIdentity = yield* repositoryIdentities.resolve(
              PullRequestService.pullRequestCwd(project),
              {
                refresh: true,
              },
            );
            if (
              currentIdentity === null ||
              identity == null ||
              canonicalRepositoryKey(currentIdentity.canonicalKey) !==
                canonicalRepositoryKey(identity.canonicalKey) ||
              current?.number !== detected?.number ||
              current?.url !== detected?.url ||
              current?.state !== detected?.state ||
              current?.repositoryKey !== detected?.repositoryKey ||
              (current !== null &&
                !pullRequestMatchesProject(current, {
                  ...project,
                  ...(project.stave != null
                    ? { stave: { ...project.stave, primaryRepositoryIdentity: currentIdentity } }
                    : { repositoryIdentity: currentIdentity }),
                }))
            ) {
              return failBackfill(updates.map((update) => update.thread));
            }
          }

          const currentProject = yield* snapshots.getProjectShellById(project.id);
          if (
            Option.isNone(currentProject) ||
            // Compare with the snapshot's project: a refreshed identity is not a project change.
            projectLookupKey(currentProject.value, path) !==
              projectLookupKey(snapshotProject, path) ||
            (yield* lookupCwd(currentProject.value)) !== cwd ||
            (project.stave != null && cwd !== null && (yield* liveBranch(cwd)) !== branch)
          ) {
            return failBackfill(updates.map((update) => update.thread));
          }

          yield* Effect.forEach(
            updates,
            ({ thread, branchPullRequest, replacement }) =>
              Effect.gen(function* () {
                const uuid = yield* crypto.randomUUIDv4;
                yield* engine.dispatch({
                  type: "thread.pull-request.sync",
                  commandId: CommandId.make(`server:thread-pull-request:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  projectId: project.id,
                  snapshotSequence: snapshot.snapshotSequence,
                  expected: {
                    workspaceRoot: project.workspaceRoot,
                    branch: thread.branch,
                    worktreePath: thread.worktreePath,
                    linkedPullRequest: thread.linkedPullRequest ?? null,
                    branchPullRequest: thread.branchPullRequest ?? null,
                  },
                  branchPullRequest,
                  ...(replacement !== undefined ? { linkedPullRequest: replacement } : {}),
                });
                pendingBackfill.delete(thread.id);
              }).pipe(
                // The thread changed since the lookup. Its own events requeue it.
                Effect.catchTags({
                  OrchestrationCommandInvariantError: () =>
                    Effect.sync(() => finishBackfill([thread])),
                }),
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning("thread pull request update failed", {
                      threadId: thread.id,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.tap(() => Effect.sync(() => failBackfill([thread])))),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("thread branch pull request lookup failed", {
                threadIds: group.map((thread) => thread.id),
                cause: Cause.pretty(cause),
              }).pipe(Effect.tap(() => Effect.sync(() => failBackfill(group)))),
          ),
        ),
      // Wide enough that a sweep's GitHub branch lookups reach GitHubCli together and share one
      // GraphQL document, instead of one `gh pr list` per branch.
      { concurrency: 32, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((request: RefreshRequest) =>
    synchronize(request).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("thread pull request refresh failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.created":
      case "thread.unarchived":
        return worker.enqueue({ threadId: event.payload.threadId, refresh: false });
      case "thread.meta-updated":
        if (
          event.payload.branchPullRequest === undefined &&
          (event.payload.branch !== undefined ||
            event.payload.worktreePath !== undefined ||
            event.payload.linkedPullRequest !== undefined)
        ) {
          return worker.enqueue({ threadId: event.payload.threadId, refresh: false });
        }
        break;
      case "thread.session-set":
        if (
          event.payload.session.status !== "running" &&
          event.payload.session.status !== "starting"
        ) {
          // Checkpoint completion forces the post-turn read. Session lifecycle
          // events reuse it regardless of which event reaches this worker first.
          return worker.enqueue({ threadId: event.payload.threadId, refresh: false });
        }
        break;
      case "thread.turn-diff-completed":
      case "thread.unsettled":
        return worker.enqueue({ threadId: event.payload.threadId, refresh: true });
      case "project.meta-updated":
        if (event.payload.workspaceRoot !== undefined) {
          return worker.enqueue({ threadId: null, refresh: false });
        }
        break;
    }
    return Effect.void;
  };

  const start = Effect.fn("ThreadPullRequestReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    // Run without client demand. Saved branch lookups share GitManager's
    // provider cache and retry backoff with status and automatic settlement.
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue({ threadId: null, refresh: false, backfill: true });
        yield* worker.drain;
        yield* Effect.gen(function* () {
          yield* worker.enqueue({ threadId: null, refresh: false });
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.delay("1 minute"));
      }).pipe(Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadPullRequestReactor["Service"];
});

export const layer = Layer.effect(ThreadPullRequestReactor, make);
