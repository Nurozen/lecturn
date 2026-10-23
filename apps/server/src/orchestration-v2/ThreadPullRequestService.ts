import {
  canonicalRepositoryKey,
  sourceControlRepositorySelector,
} from "@lecturn/shared/sourceControl";
import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadLinkedPullRequest,
} from "@lecturn/contracts";
import { normalizeProjectPathForComparison } from "@lecturn/shared/path";
import { makeDrainableWorker } from "@lecturn/shared/DrainableWorker";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
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
import * as ProjectStore from "./ProjectStore.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import { StaveProjectShells } from "../stave/StaveProjectShells.ts";
import * as Orchestrator from "./Orchestrator.ts";

class ThreadPullRequestServiceV2 extends Context.Service<
  ThreadPullRequestServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("lecturn/orchestration-v2/ThreadPullRequestService/ThreadPullRequestServiceV2") {}

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

function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: OrchestrationProjectShell,
): boolean {
  // A Stave space answers with its manifest's primary checkout identity.
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

export const resolveProjectForPullRequestDiscovery = Effect.fn(
  "ThreadPullRequestServiceV2.resolveProject",
)(function* (
  project: OrchestrationProjectShell,
  repositoryIdentities: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  options?: { readonly refresh?: boolean },
) {
  // Stave spaces read the manifest's primary identity instead of the space root's.
  if (project.stave != null) {
    return { project, repository: PullRequestService.repositoryIdentityOf(project) };
  }
  // Identities stay cached for 15 minutes. A finished turn may have added the
  // remote its pull request lives on, so post-turn discovery refreshes.
  const repositoryIdentity = yield* repositoryIdentities.resolve(project.workspaceRoot, {
    refresh: options?.refresh ?? false,
  });
  return {
    project: { ...project, repositoryIdentity },
    repository: sourceControlRepositorySelector(repositoryIdentity),
  };
});

export function projectWorkspaceMatchesSnapshot(
  currentProject: Option.Option<Pick<OrchestrationProjectShell, "workspaceRoot">>,
  expectedWorkspaceRoot: string,
): boolean {
  return (
    Option.isSome(currentProject) && currentProject.value.workspaceRoot === expectedWorkspaceRoot
  );
}

const BACKFILL_ATTEMPTS = 5;

interface RefreshRequest {
  readonly threadId: ThreadId | null;
  readonly refresh: boolean;
  readonly backfill?: boolean;
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  // Platform path semantics; tests without a Path service get the default one.
  const path = yield* Effect.serviceOption(Path.Path).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.provide(Path.Path, Path.layer),
      }),
    ),
  );
  // Stave fields (space manifest, primary checkout) on project shells; absent
  // when the Stave reader is not provided, which leaves upstream discovery.
  const staveShells = yield* Effect.serviceOption(StaveProjectShells);
  const listProjectShells = projectStore
    .listShells()
    .pipe(
      Effect.flatMap((shells) =>
        Option.isSome(staveShells) ? staveShells.value.decorate(shells) : Effect.succeed(shells),
      ),
    );
  const getProjectShell = (projectId: OrchestrationProjectShell["id"]) =>
    projectStore
      .getShell(projectId)
      .pipe(
        Effect.flatMap((shell) =>
          Option.isNone(shell) || Option.isNone(staveShells)
            ? Effect.succeed(shell)
            : staveShells.value
                .decorate([shell.value])
                .pipe(Effect.map((decorated) => Option.fromUndefinedOr(decorated[0]))),
        ),
      );
  // A live Stave space without a sole editable checkout must drop inferred
  // links from its settled threads too, so sweeps read every thread while one exists.
  const hasUnownedStaveSpace = (projects: ReadonlyArray<OrchestrationProjectShell>) =>
    projects.some(
      (project) => project.stave?.state === "live" && stavePrimaryCwd(project, path) === null,
    );
  const pendingBackfill = new Map<ThreadId, number>();

  const finishBackfill = (threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id">>) => {
    for (const thread of threads) pendingBackfill.delete(thread.id);
  };
  const failBackfill = (threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id">>) => {
    for (const thread of threads) {
      const remaining = pendingBackfill.get(thread.id);
      if (remaining === undefined) continue;
      if (remaining <= 1) pendingBackfill.delete(thread.id);
      else pendingBackfill.set(thread.id, remaining - 1);
    }
  };

  const readThreadSnapshot = (
    { threadId, backfill }: RefreshRequest,
    projects: ReadonlyArray<OrchestrationProjectShell>,
  ) =>
    threadId === null
      ? orchestrator
          .getShellSnapshot({
            location: "active",
            unsettledOnly: !(
              backfill ||
              pendingBackfill.size > 0 ||
              hasUnownedStaveSpace(projects)
            ),
          })
          .pipe(NodeSqliteClient.readOnly)
      : Effect.gen(function* () {
          // Read the sequence first. The thread is then at least this new, so a
          // sync guarded by the sequence is rejected rather than missing a change.
          const snapshotSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const thread = yield* orchestrator.getThreadShell(threadId);
          return { snapshotSequence, threads: thread === null ? [] : [thread] };
        });

  const synchronize = Effect.fn("ThreadPullRequestServiceV2.synchronize")(function* (
    request: RefreshRequest,
  ) {
    const projectShells = yield* listProjectShells;
    const threadSnapshot = yield* readThreadSnapshot(request, projectShells);
    const projects = new Map(projectShells.map((project) => [project.id, project]));
    if (request.backfill) {
      for (const thread of threadSnapshot.threads) {
        if (
          (thread.settledOverride === "settled" || thread.settledAt !== null) &&
          thread.branchPullRequest == null
        ) {
          pendingBackfill.set(thread.id, BACKFILL_ATTEMPTS);
        }
      }
    }
    const visibleThreadIds = new Set(
      threadSnapshot.threads
        .filter((thread) => thread.branch !== null || projects.get(thread.projectId)?.stave != null)
        .map((thread) => thread.id),
    );
    const checkedIds = request.threadId === null ? [...pendingBackfill.keys()] : [request.threadId];
    for (const threadId of checkedIds) {
      if (!visibleThreadIds.has(threadId)) pendingBackfill.delete(threadId);
    }
    const threads = threadSnapshot.threads.filter(
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
    // Every thread in a Stave space shares the space's primary checkout.
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
          const project = projects.get(first.projectId);
          if (project === undefined || (project.stave != null && project.stave.state !== "live"))
            return finishBackfill(group);
          const { project: resolvedProject, repository } =
            yield* resolveProjectForPullRequestDiscovery(project, repositoryIdentities, {
              refresh: request.refresh,
            });
          if (project.stave == null && first.branch !== null && repository === null)
            return finishBackfill(group);
          const identity =
            resolvedProject.stave?.primaryRepositoryIdentity ?? resolvedProject.repositoryIdentity;
          const host = identity?.canonicalKey.split("/")[0]?.toLowerCase();
          const lookupCwd = Effect.fn("ThreadPullRequestServiceV2.lookupCwd")(function* (
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
          const liveBranch = Effect.fn("ThreadPullRequestServiceV2.liveBranch")(function* (
            cwd: string,
          ) {
            // A cached local status can predate an external checkout switch.
            yield* git.invalidateLocalStatus(cwd);
            const status = yield* git.localStatus({ cwd });
            return status.isRepo ? status.refName : null;
          });
          const cwd = yield* lookupCwd(project);
          // A Stave space's branch is whatever its primary checkout has checked out.
          const branch =
            project.stave != null ? (cwd !== null ? yield* liveBranch(cwd) : null) : first.branch;
          const detected =
            cwd === null || branch === null
              ? null
              : yield* git.branchPullRequest({ cwd, branch }, { refresh: request.refresh });
          // A worktree can have different remotes, and the project identity
          // can lag a remote edit. Do not attach its PR to the wrong repository.
          if (detected !== null && !pullRequestMatchesProject(detected, resolvedProject)) {
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
                (thread.pullRequests ?? []).length === 0 &&
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
            // GitManager's provider cache while verifying its remote context, and
            // rereads the branch's git state rather than trusting the cached one.
            const current = yield* git.branchPullRequest({ cwd, branch }, { freshGitState: true });
            const currentIdentity = yield* repositoryIdentities.resolve(
              PullRequestService.pullRequestCwd(project),
              { refresh: true },
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
                  ...resolvedProject,
                  ...(project.stave != null
                    ? { stave: { ...project.stave, primaryRepositoryIdentity: currentIdentity } }
                    : { repositoryIdentity: currentIdentity }),
                }))
            ) {
              return failBackfill(updates.map((update) => update.thread));
            }
          }

          // The space manifest, its primary checkout and that checkout's branch
          // must still be the ones discovery read.
          const currentShell = yield* getProjectShell(project.id);
          if (
            Option.isNone(currentShell) ||
            projectLookupKey(currentShell.value, path) !== projectLookupKey(project, path) ||
            (yield* lookupCwd(currentShell.value)) !== cwd ||
            (project.stave != null && cwd !== null && (yield* liveBranch(cwd)) !== branch)
          ) {
            return failBackfill(updates.map((update) => update.thread));
          }

          yield* Effect.forEach(
            updates,
            ({ thread, branchPullRequest, replacement }) =>
              Effect.gen(function* () {
                // Discovery can perform network I/O. Re-read the project at
                // the transaction boundary so a deleted project or changed
                // workspace root cannot apply a result from the old checkout.
                const currentProject = yield* projectStore.getShell(project.id);
                if (!projectWorkspaceMatchesSnapshot(currentProject, project.workspaceRoot)) {
                  return failBackfill([thread]);
                }
                const uuid = yield* crypto.randomUUIDv4();
                yield* orchestrator.dispatch({
                  type: "thread.pull-request.sync",
                  commandId: CommandId.make(`server:thread-pull-request:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  projectId: project.id,
                  snapshotSequence: threadSnapshot.snapshotSequence,
                  expected: {
                    workspaceRoot: project.workspaceRoot,
                    branch: thread.branch,
                    worktreePath: thread.worktreePath,
                    linkedPullRequest: thread.linkedPullRequest ?? null,
                    branchPullRequest: thread.branchPullRequest ?? null,
                  },
                  branchPullRequest,
                  ...(replacement === undefined ? {} : { linkedPullRequest: replacement }),
                });
                pendingBackfill.delete(thread.id);
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("thread pull request update failed", {
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
      // Wide enough that a sweep's GitHub branch lookups reach the GitHub provider together and share one
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

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.created":
      case "thread.unarchived":
      case "thread.metadata-updated":
        return worker.enqueue({ threadId: event.threadId, refresh: false });
      case "thread.unsettled":
      case "checkpoint.captured":
        return worker.enqueue({ threadId: event.threadId, refresh: true });
      case "run.updated":
        if (
          event.payload.status === "completed" ||
          event.payload.status === "failed" ||
          event.payload.status === "cancelled" ||
          event.payload.status === "interrupted"
        ) {
          return worker.enqueue({ threadId: event.threadId, refresh: true });
        }
        break;
    }
    return Effect.void;
  };

  const start: ThreadPullRequestServiceV2["Service"]["start"] = Effect.fn(
    "ThreadPullRequestServiceV2.start",
  )(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, processEvent));
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

  return { start, drain: worker.drain } satisfies ThreadPullRequestServiceV2["Service"];
});

const layer = Layer.effect(ThreadPullRequestServiceV2, make);
