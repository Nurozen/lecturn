import {
  CheckpointRef,
  EventId,
  GitManagerError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type PullRequestRef,
  type PullRequestSummary,
  type ThreadLinkedPullRequest,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitManager, type GitBranchPullRequest } from "../git/GitManager.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { ServerActivation } from "../serverActivation.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { StaveWorkspaceReader } from "../stave/StaveWorkspaceReader.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import * as ThreadPullRequestReactor from "./ThreadPullRequestReactor.ts";

const NOW = "2026-09-01T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project");
const REPOSITORY = "owner/repository";
const REPOSITORY_KEY = `github.com/${REPOSITORY}`;
type SyncCommand = Extract<OrchestrationCommand, { type: "thread.pull-request.sync" }>;

function reference(number: number): ThreadLinkedPullRequest {
  return {
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
  };
}

function branchPullRequest(
  number = 42,
  state: GitBranchPullRequest["state"] = "open",
): GitBranchPullRequest {
  return {
    ...reference(number),
    title: "Branch pull request",
    baseRef: "main",
    headRef: "feature",
    state,
    updatedAt: NOW,
    repositoryKey: REPOSITORY_KEY,
  };
}

function summary(input: PullRequestRef, state: PullRequestSummary["state"]): PullRequestSummary {
  return {
    ...input,
    provider: "github",
    title: "Pull request",
    url: reference(input.number).url,
    state,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: NOW,
  };
}

function thread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: "feature",
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const project = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: {
    canonicalKey: REPOSITORY_KEY,
    displayName: REPOSITORY,
    rootPath: "/workspace/project",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `git@github.com:${REPOSITORY}.git`,
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
} satisfies OrchestrationProjectShell;

function localStatus(refName: string | null, isRepo = true) {
  return {
    isRepo,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  };
}

const staveProject = {
  ...project,
  repositoryIdentity: null,
  stave: {
    spaceId: "space",
    isSaga: false,
    state: "live",
    memories: [],
    repos: [{ name: "repo", path: "repo", mode: "edit", branch: "manifest-old" }],
    primaryRepoPath: "/workspace/project/repo",
    primaryBranch: "primary-old",
    primaryRepositoryIdentity: {
      ...project.repositoryIdentity,
      rootPath: "/workspace/project/repo",
    },
  },
} satisfies OrchestrationProjectShell;

const makeHarness = Effect.fn("makeThreadPullRequestHarness")(function* (options: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly branchPullRequest?: GitManager["Service"]["branchPullRequest"];
  readonly localStatus?: GitManager["Service"]["localStatus"];
  readonly summary?: PullRequestService["Service"]["summary"];
  readonly existingWorktrees?: ReadonlyArray<string>;
  readonly project?: OrchestrationProjectShell;
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver["Service"]["resolve"];
  /** Serve full sweep reads from this instead of `threads`. */
  readonly getShellSnapshot?: ProjectionSnapshotQueryShape["getShellSnapshot"];
}) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make<OrchestrationShellSnapshot>({
    snapshotSequence: 1,
    projects: [options.project ?? project],
    threads: options.threads,
    updatedAt: NOW,
  });
  // Each shell read: a thread id for a one-thread read, null for a full read.
  const reads = yield* Queue.unbounded<ThreadId | null>();
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const commands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const branchCalls = yield* Ref.make<
    ReadonlyArray<{ readonly cwd: string; readonly branch: string; readonly refresh: boolean }>
  >([]);
  const localCalls = yield* Ref.make<ReadonlyArray<string>>([]);
  const invalidations = yield* Ref.make<ReadonlyArray<string>>([]);
  const summaryCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  let uuid = 0;
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: (readOptions) =>
        (
          options.getShellSnapshot?.(readOptions) ??
          Ref.get(snapshots).pipe(
            // Match the SQL filter: an unsettled read omits settled threads.
            Effect.map((snapshot) =>
              readOptions?.unsettledOnly === true
                ? {
                    ...snapshot,
                    threads: snapshot.threads.filter(
                      (thread) => thread.settledOverride !== "settled" && thread.settledAt === null,
                    ),
                  }
                : snapshot,
            ),
          )
        ).pipe(Effect.tap(() => Queue.offer(reads, null))),
      getSnapshotSequence: () =>
        Ref.get(snapshots).pipe(Effect.map(({ snapshotSequence }) => ({ snapshotSequence }))),
      getThreadShellById: (threadId) =>
        Ref.get(snapshots).pipe(
          Effect.map(({ threads }) =>
            Option.fromUndefinedOr(
              threads.find((thread) => thread.id === threadId && thread.archivedAt === null),
            ),
          ),
          Effect.tap(() => Queue.offer(reads, threadId)),
        ),
      getProjectShells: (projectIds) =>
        Ref.get(snapshots).pipe(
          Effect.map(({ projects }) =>
            projects.filter((project) => projectIds?.includes(project.id) ?? true),
          ),
        ),
      getProjectShellById: (id) =>
        Ref.get(snapshots).pipe(
          Effect.map((snapshot) =>
            Option.fromNullishOr(snapshot.projects.find((p) => p.id === id)),
          ),
        ),
    }),
    Layer.mock(GitManager)({
      invalidateLocalStatus: (cwd) => Ref.update(invalidations, (calls) => [...calls, cwd]),
      localStatus: (input) =>
        Ref.update(localCalls, (calls) => [...calls, input.cwd]).pipe(
          Effect.andThen(options.localStatus?.(input) ?? Effect.succeed(localStatus("feature"))),
        ),
      branchPullRequest: (input, readOptions) =>
        Ref.update(branchCalls, (calls) => [
          ...calls,
          { ...input, refresh: readOptions?.refresh === true },
        ]).pipe(
          Effect.andThen(options.branchPullRequest?.(input, readOptions) ?? Effect.succeed(null)),
        ),
    }),
    Layer.mock(PullRequestService)({
      summary: (input, readOptions) =>
        Ref.update(summaryCalls, (calls) => [...calls, input]).pipe(
          Effect.andThen(
            options.summary?.(input, readOptions) ?? Effect.succeed(summary(input, "open")),
          ),
        ),
    }),
    Layer.mock(RepositoryIdentityResolver)({
      resolve:
        options.resolveRepositoryIdentity ??
        (() =>
          Effect.succeed(
            options.project?.stave?.primaryRepositoryIdentity ??
              options.project?.repositoryIdentity ??
              project.repositoryIdentity,
          )),
    }),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      dispatch: (command) => {
        if (command.type !== "thread.pull-request.sync") {
          return Effect.die(`Unexpected command: ${command.type}`);
        }
        return Ref.update(commands, (current) => [...current, command]).pipe(
          Effect.andThen(
            Ref.updateAndGet(snapshots, (snapshot) => ({
              ...snapshot,
              snapshotSequence: snapshot.snapshotSequence + 1,
              threads: snapshot.threads.map((current) =>
                current.id === command.threadId
                  ? {
                      ...current,
                      branchPullRequest: command.branchPullRequest,
                      ...(command.linkedPullRequest !== undefined
                        ? { linkedPullRequest: command.linkedPullRequest }
                        : {}),
                    }
                  : current,
              ),
            })),
          ),
          Effect.map((snapshot) => ({ sequence: snapshot.snapshotSequence })),
        );
      },
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(++uuid),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
    Path.layer,
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(options.existingWorktrees?.includes(path) ?? false),
    }),
  );

  const start = Effect.fn("startThreadPullRequestHarness")(function* () {
    const reactor = yield* ThreadPullRequestReactor.ThreadPullRequestReactor;
    yield* reactor.start();
    yield* Deferred.succeed(activation, undefined);
    yield* Queue.take(reads);
    yield* reactor.drain;
    return reactor;
  });

  return {
    start,
    reads,
    snapshots,
    commands,
    branchCalls,
    localCalls,
    invalidations,
    summaryCalls,
    publish: (event: OrchestrationEvent) => PubSub.publish(events, event),
    layer: ThreadPullRequestReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

describe("ThreadPullRequestReactor", () => {
  it.effect("discovers saved branch PRs without a client and shares branch lookups", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [
            thread("first"),
            thread("second"),
            thread("archived", { archivedAt: NOW }),
            thread("no-branch", { branch: null }),
          ],
          branchPullRequest: () => Effect.succeed(branchPullRequest()),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* fixture.start();
          expect(yield* Ref.get(fixture.branchCalls)).toEqual([
            { cwd: project.workspaceRoot, branch: "feature", refresh: false },
            { cwd: project.workspaceRoot, branch: "feature", refresh: false },
          ]);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            "first",
            "second",
          ]);
          expect((yield* Ref.get(fixture.snapshots)).threads[0]?.branchPullRequest).toEqual(
            reference(42),
          );

          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.reads);
          yield* reactor.drain;
          expect(yield* Ref.get(fixture.commands)).toHaveLength(2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("discovers the Stave primary checkout while preserving a secondary host link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const primaryIdentity = {
          ...project.repositoryIdentity,
          canonicalKey: `github.enterprise.test/${REPOSITORY}`,
          rootPath: "/workspace/project/repo",
        };
        const staveProject: OrchestrationProjectShell = {
          ...project,
          repositoryIdentity: null,
          stave: {
            spaceId: "space",
            isSaga: false,
            state: "live",
            memories: [],
            repos: [{ name: "repo", path: "repo", mode: "edit" }],
            primaryRepoPath: primaryIdentity.rootPath,
            primaryRepositoryIdentity: primaryIdentity,
          },
        };
        const manualLink = {
          ...reference(1),
          repository: "owner/secondary",
          host: "other.enterprise.test",
          url: "https://other.enterprise.test/owner/secondary/pull/1",
        };
        const fixture = yield* makeHarness({
          project: staveProject,
          existingWorktrees: [primaryIdentity.rootPath],
          threads: [
            thread("stave", { linkedPullRequest: manualLink }),
            thread("primary", {
              linkedPullRequest: {
                ...reference(2),
                host: "github.enterprise.test",
                url: `https://github.enterprise.test/${REPOSITORY}/pull/2`,
              },
            }),
          ],
          branchPullRequest: () =>
            Effect.succeed({
              ...branchPullRequest(),
              repositoryKey: primaryIdentity.canonicalKey,
              url: `https://github.enterprise.test/${REPOSITORY}/pull/42`,
            }),
          resolveRepositoryIdentity: () => Effect.succeed(primaryIdentity),
          summary: (input) =>
            input.repository === REPOSITORY
              ? Effect.succeed(summary(input, "merged"))
              : Effect.die("primary discovery must not replace the secondary link"),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start();
          const [command] = yield* Ref.get(fixture.commands);
          expect(command?.branchPullRequest).toEqual({
            ...reference(42),
            host: "github.enterprise.test",
            url: `https://github.enterprise.test/${REPOSITORY}/pull/42`,
          });
          expect(command).not.toHaveProperty("linkedPullRequest");
          expect((yield* Ref.get(fixture.commands))[1]?.linkedPullRequest).toEqual(
            command?.branchPullRequest,
          );
          expect(yield* Ref.get(fixture.summaryCalls)).toHaveLength(1);
          expect((yield* Ref.get(fixture.snapshots)).threads[0]?.linkedPullRequest).toEqual(
            manualLink,
          );
          expect(
            (yield* Ref.get(fixture.branchCalls)).every(
              (call) => call.cwd === primaryIdentity.rootPath,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "follows live Stave HEAD for null and stale saved branches, with references alongside one edit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeHarness({
            project: {
              ...staveProject,
              stave: {
                ...staveProject.stave,
                repos: [
                  ...staveProject.stave.repos,
                  { name: "reference", path: "reference", mode: "reference" },
                ],
              },
            },
            existingWorktrees: [staveProject.stave.primaryRepoPath],
            threads: [
              thread("branchless", { branch: null }),
              thread("stale", { branch: "thread-old", worktreePath: "/workspace/stale" }),
              thread("archived", { branch: null, archivedAt: NOW }),
            ],
            localStatus: () => Effect.succeed(localStatus("live-head")),
            branchPullRequest: ({ branch }) =>
              branch === "live-head"
                ? Effect.succeed({ ...branchPullRequest(), headRef: branch })
                : Effect.die(`Unexpected saved branch lookup: ${branch}`),
          });
          yield* Effect.gen(function* () {
            yield* fixture.start();
            const commands = yield* Ref.get(fixture.commands);
            expect(commands.map((c) => c.threadId)).toEqual(["branchless", "stale"]);
            expect(commands.map((c) => c.expected.branch)).toEqual([null, "thread-old"]);
            expect(commands[1]?.expected.worktreePath).toBe("/workspace/stale");
            expect(commands.map((c) => c.branchPullRequest)).toEqual([
              { ...reference(42), host: "github.com" },
              { ...reference(42), host: "github.com" },
            ]);
            expect(yield* Ref.get(fixture.branchCalls)).toEqual([
              { cwd: "/workspace/project/repo", branch: "live-head", refresh: false },
              { cwd: "/workspace/project/repo", branch: "live-head", refresh: false },
            ]);
            expect(yield* Ref.get(fixture.localCalls)).toEqual([
              "/workspace/project/repo",
              "/workspace/project/repo",
            ]);
            expect(yield* Ref.get(fixture.invalidations)).toEqual(
              yield* Ref.get(fixture.localCalls),
            );
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("does not discover an ordinary project PR without a saved branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [thread("ordinary-null", { branch: null })],
          localStatus: () => Effect.die("ordinary branchless threads must not read HEAD"),
          branchPullRequest: () => Effect.die("ordinary branchless threads must not discover PRs"),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start();
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          expect(yield* Ref.get(fixture.localCalls)).toEqual([]);
          expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each([
    "multi-edit",
    "reference-only",
    "reference-alias",
    "missing-primary",
    "missing-identity",
    "not-repo",
    "detached",
    "wrong-primary",
    "missing-checkout",
    "archived",
  ] as const)("does not discover inferred Stave PRs for %s scope", (scope) =>
    Effect.scoped(
      Effect.gen(function* () {
        const stave = staveProject.stave;
        const { primaryRepoPath, primaryRepositoryIdentity, ...withoutPrimary } = stave;
        const candidate: OrchestrationProjectShell = {
          ...staveProject,
          stave: {
            ...withoutPrimary,
            ...(scope === "missing-primary" ? {} : { primaryRepoPath }),
            ...(scope === "missing-identity" ? {} : { primaryRepositoryIdentity }),
            ...(scope === "multi-edit"
              ? {
                  repos: [
                    ...stave.repos,
                    { name: "second", path: "second", mode: "edit" as const },
                  ],
                }
              : {}),
            ...(scope === "reference-only"
              ? { repos: [{ name: "repo", path: "repo", mode: "reference" as const }] }
              : {}),
            ...(scope === "reference-alias"
              ? {
                  repos: [
                    ...stave.repos,
                    { name: "alias", path: "repo", mode: "reference" as const },
                  ],
                }
              : {}),
            ...(scope === "wrong-primary" ? { primaryRepoPath: "/workspace/project/other" } : {}),
            ...(scope === "archived" ? { state: "archived" as const } : {}),
          },
        };
        const manualLink = reference(1);
        const fixture = yield* makeHarness({
          project: candidate,
          threads: [thread("guarded", { branch: null, linkedPullRequest: manualLink })],
          existingWorktrees: scope === "missing-checkout" ? [] : [stave.primaryRepoPath],
          localStatus: () =>
            Effect.succeed(
              localStatus(scope === "detached" ? null : "feature", scope !== "not-repo"),
            ),
          branchPullRequest: () => Effect.die("unsafe Stave scopes must not query PRs"),
          summary: () => Effect.die("unsafe Stave scopes must not replace explicit links"),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start();
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
          expect((yield* Ref.get(fixture.snapshots)).threads[0]?.linkedPullRequest).toEqual(
            manualLink,
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each(["multi-edit", "reference-only"] as const)(
    "clears obsolete inferred links after a single-edit to %s transition while preserving explicit links",
    (scope) =>
      Effect.scoped(
        Effect.gen(function* () {
          const manualLink = reference(1);
          const fixture = yield* makeHarness({
            project: staveProject,
            existingWorktrees: [staveProject.stave.primaryRepoPath],
            threads: [thread("transition", { branch: "saved", linkedPullRequest: manualLink })],
            branchPullRequest: () => Effect.succeed(branchPullRequest()),
            summary: (input) => Effect.succeed(summary(input, "open")),
          });
          yield* Effect.gen(function* () {
            const reactor = yield* fixture.start();
            expect((yield* Ref.get(fixture.commands))[0]?.branchPullRequest?.number).toBe(42);
            const branchCalls = (yield* Ref.get(fixture.branchCalls)).length;
            const summaries = (yield* Ref.get(fixture.summaryCalls)).length;
            yield* Ref.update(fixture.snapshots, (snapshot) => ({
              ...snapshot,
              threads: snapshot.threads.map((current) => ({
                ...current,
                settledOverride: "settled" as const,
              })),
              projects: [
                {
                  ...staveProject,
                  stave: {
                    ...staveProject.stave,
                    repos:
                      scope === "multi-edit"
                        ? [
                            ...staveProject.stave.repos,
                            { name: "second", path: "second", mode: "edit" as const },
                          ]
                        : [{ name: "repo", path: "repo", mode: "reference" as const }],
                  },
                },
              ],
            }));
            yield* TestClock.adjust("1 minute");
            yield* Queue.take(fixture.reads);
            yield* reactor.drain;
            const commands = yield* Ref.get(fixture.commands);
            expect(commands).toHaveLength(2);
            expect(commands[1]?.branchPullRequest).toBeNull();
            expect(commands[1]).not.toHaveProperty("linkedPullRequest");
            expect((yield* Ref.get(fixture.snapshots)).threads[0]?.linkedPullRequest).toEqual(
              manualLink,
            );
            expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(branchCalls);
            expect(yield* Ref.get(fixture.summaryCalls)).toHaveLength(summaries);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect.each(["head", "checkout", "repository", "ambiguous"] as const)(
    "rejects a delayed Stave lookup when its %s context changes",
    (change) =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const head = yield* Ref.make("feature");
          const fixture = yield* makeHarness({
            project: staveProject,
            existingWorktrees: [staveProject.stave.primaryRepoPath, "/workspace/project/second"],
            threads: [thread("delayed", { branch: null, linkedPullRequest: reference(1) })],
            localStatus: () => Ref.get(head).pipe(Effect.map((branch) => localStatus(branch))),
            branchPullRequest: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(branchPullRequest()),
              ),
            summary: (input) => Effect.succeed(summary(input, "merged")),
          });
          yield* Effect.gen(function* () {
            const starting = yield* Effect.forkScoped(fixture.start());
            yield* Deferred.await(entered);
            if (change === "head") yield* Ref.set(head, "switched");
            else
              yield* Ref.update(fixture.snapshots, (snapshot) => ({
                ...snapshot,
                projects: [
                  {
                    ...staveProject,
                    stave: {
                      ...staveProject.stave,
                      ...(change === "checkout"
                        ? {
                            primaryRepoPath: "/workspace/project/second",
                            repos: [{ name: "second", path: "second", mode: "edit" as const }],
                          }
                        : {}),
                      ...(change === "repository"
                        ? {
                            primaryRepositoryIdentity: {
                              ...project.repositoryIdentity,
                              canonicalKey: "github.com/other/repo",
                            },
                          }
                        : {}),
                      ...(change === "ambiguous"
                        ? {
                            repos: [
                              ...staveProject.stave.repos,
                              { name: "second", path: "second", mode: "edit" as const },
                            ],
                          }
                        : {}),
                    },
                  },
                ],
              }));
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(starting);
            expect(yield* Ref.get(fixture.commands)).toEqual([]);
            expect((yield* Ref.get(fixture.snapshots)).threads[0]?.linkedPullRequest).toEqual(
              reference(1),
            );
            if (change === "head") {
              const reactor = yield* ThreadPullRequestReactor.ThreadPullRequestReactor;
              yield* TestClock.adjust("1 minute");
              yield* Queue.take(fixture.reads);
              yield* reactor.drain;
              expect((yield* Ref.get(fixture.branchCalls)).at(-1)?.branch).toBe("switched");
              expect((yield* Ref.get(fixture.commands))[0]?.expected.branch).toBeNull();
            }
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect(
    "does not clear a saved Stave inference when HEAD switches during a missing PR lookup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const head = yield* Ref.make("feature");
          const saved = { ...reference(42), host: "github.com" };
          const fixture = yield* makeHarness({
            project: staveProject,
            existingWorktrees: [staveProject.stave.primaryRepoPath],
            threads: [thread("missing-race", { branch: null, branchPullRequest: saved })],
            localStatus: () => Ref.get(head).pipe(Effect.map((branch) => localStatus(branch))),
            branchPullRequest: () => Ref.set(head, "switched").pipe(Effect.as(null)),
          });
          yield* Effect.gen(function* () {
            yield* fixture.start();
            expect(yield* Ref.get(fixture.commands)).toEqual([]);
            expect((yield* Ref.get(fixture.snapshots)).threads[0]?.branchPullRequest).toEqual(
              saved,
            );
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect(
    "preserves an inferred Stave link when a missing PR result outlasts a remote change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const identity = yield* Ref.make(staveProject.stave.primaryRepositoryIdentity);
          const saved = { ...reference(42), host: "github.com" };
          const fixture = yield* makeHarness({
            project: staveProject,
            existingWorktrees: [staveProject.stave.primaryRepoPath],
            threads: [thread("remote-race", { branch: null, branchPullRequest: saved })],
            branchPullRequest: () =>
              Ref.set(identity, {
                ...staveProject.stave.primaryRepositoryIdentity,
                canonicalKey: "github.com/other/repository",
              }).pipe(Effect.as(null)),
            resolveRepositoryIdentity: () => Ref.get(identity),
          });
          yield* Effect.gen(function* () {
            yield* fixture.start();
            expect(yield* Ref.get(fixture.commands)).toEqual([]);
            expect((yield* Ref.get(fixture.snapshots)).threads[0]?.branchPullRequest).toEqual(
              saved,
            );
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("replaces terminal manual links but preserves open links and explicit unlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [
            thread("merged", { linkedPullRequest: reference(1) }),
            thread("closed", { linkedPullRequest: reference(2) }),
            thread("open", { linkedPullRequest: reference(3) }),
            thread("unlinked", { linkedPullRequest: null }),
          ],
          branchPullRequest: () => Effect.succeed(branchPullRequest()),
          summary: (input) =>
            Effect.succeed(
              summary(
                input,
                input.number === 1 ? "merged" : input.number === 2 ? "closed" : "open",
              ),
            ),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start();
          const snapshot = yield* Ref.get(fixture.snapshots);
          expect(snapshot.threads.map((current) => current.linkedPullRequest)).toEqual([
            reference(42),
            reference(42),
            reference(3),
            null,
          ]);
          expect(
            snapshot.threads.every((current) => current.branchPullRequest?.number === 42),
          ).toBe(true);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each(["session-first", "checkpoint-first"] as const)(
    "refreshes discovery once after a turn ends with %s event ordering",
    (order) =>
      Effect.scoped(
        Effect.gen(function* () {
          const current = thread("turn-thread");
          const detected = yield* Ref.make<GitBranchPullRequest | null>(null);
          const fixture = yield* makeHarness({
            threads: [current],
            branchPullRequest: (_input, options) =>
              options?.refresh
                ? Ref.set(detected, branchPullRequest()).pipe(Effect.andThen(Ref.get(detected)))
                : Ref.get(detected),
          });
          yield* Effect.gen(function* () {
            const reactor = yield* fixture.start();
            expect(yield* Ref.get(fixture.commands)).toHaveLength(0);
            const sessionEvent: OrchestrationEvent = {
              type: "thread.session-set",
              sequence: 2,
              eventId: EventId.make("turn-finished"),
              aggregateKind: "thread",
              aggregateId: current.id,
              occurredAt: NOW,
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                threadId: current.id,
                session: {
                  threadId: current.id,
                  status: "ready",
                  providerName: "Codex",
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: NOW,
                },
              },
            };
            const checkpointEvent: OrchestrationEvent = {
              ...sessionEvent,
              type: "thread.turn-diff-completed",
              sequence: 3,
              eventId: EventId.make("checkpoint-finished"),
              payload: {
                threadId: current.id,
                turnId: TurnId.make("turn"),
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.make("checkpoint"),
                status: "ready",
                files: [],
                assistantMessageId: null,
                completedAt: NOW,
              },
            };
            const events =
              order === "session-first"
                ? [sessionEvent, checkpointEvent]
                : [checkpointEvent, sessionEvent];
            for (const event of events) {
              yield* fixture.publish(event);
              expect(yield* Queue.take(fixture.reads)).toBe(current.id);
              yield* reactor.drain;
            }
            expect((yield* Ref.get(fixture.commands))[0]?.branchPullRequest).toEqual(reference(42));
            expect(
              (yield* Ref.get(fixture.branchCalls)).filter((call) => call.refresh),
            ).toHaveLength(1);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("refreshes the project identity when a turn adds the remote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = thread("new-remote");
        const fixture = yield* makeHarness({
          threads: [current],
          project: { ...project, repositoryIdentity: null },
          branchPullRequest: () => Effect.succeed(branchPullRequest()),
          resolveRepositoryIdentity: (_cwd, options) =>
            Effect.succeed(options?.refresh ? project.repositoryIdentity : null),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* fixture.start();
          expect(yield* Ref.get(fixture.commands)).toHaveLength(0);

          yield* fixture.publish({
            type: "thread.turn-diff-completed",
            sequence: 2,
            eventId: EventId.make("checkpoint-finished"),
            aggregateKind: "thread",
            aggregateId: current.id,
            occurredAt: NOW,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId: current.id,
              turnId: TurnId.make("turn"),
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("checkpoint"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: NOW,
            },
          });
          yield* Queue.take(fixture.reads);
          yield* reactor.drain;
          expect((yield* Ref.get(fixture.commands))[0]?.branchPullRequest).toEqual(reference(42));
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("uses live worktrees and falls back to the project for removed worktrees", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [
            thread("live", { worktreePath: "/workspace/worktree" }),
            thread("removed", { worktreePath: "/workspace/removed" }),
          ],
          existingWorktrees: ["/workspace/worktree"],
          branchPullRequest: () => Effect.succeed(branchPullRequest()),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start();
          expect(new Set((yield* Ref.get(fixture.branchCalls)).map((call) => call.cwd))).toEqual(
            new Set(["/workspace/project", "/workspace/worktree"]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("retains only terminal PRs on shared checkouts and clears a removed branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [
            thread("terminal", { branch: "main", branchPullRequest: reference(1) }),
            thread("open", { branchPullRequest: reference(2) }),
            thread("worktree", {
              worktreePath: "/workspace/worktree",
              branchPullRequest: reference(1),
            }),
            thread("cleared", {
              branch: null,
              branchPullRequest: reference(1),
              linkedPullRequest: reference(3),
            }),
          ],
          summary: (input) =>
            Effect.succeed(summary(input, input.number === 1 ? "merged" : "open")),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start();
          const snapshot = yield* Ref.get(fixture.snapshots);
          expect(snapshot.threads.map((current) => current.branchPullRequest)).toEqual([
            reference(1),
            null,
            null,
            null,
          ]);
          expect(snapshot.threads[3]?.linkedPullRequest).toEqual(reference(3));
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps saved links on lookup failures and rejects a different repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [
            thread("failed", { branch: "failed", branchPullRequest: reference(1) }),
            thread("wrong-repository", {
              branch: "wrong-repository",
              branchPullRequest: reference(2),
            }),
            thread("healthy"),
          ],
          branchPullRequest: ({ cwd, branch }) =>
            branch === "failed"
              ? Effect.fail(
                  new GitManagerError({
                    operation: "branchPullRequest",
                    cwd,
                    detail: "Lookup failed",
                  }),
                )
              : Effect.succeed({
                  ...branchPullRequest(),
                  repositoryKey:
                    branch === "wrong-repository" ? "github.com/other/repository" : REPOSITORY_KEY,
                }),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start();
          expect(
            (yield* Ref.get(fixture.snapshots)).threads.map((current) => current.branchPullRequest),
          ).toEqual([reference(1), reference(2), reference(42)]);
          expect(yield* Ref.get(fixture.commands)).toHaveLength(1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each(["settled", null] as const)(
    "retries settled backfills and stops after success with settledOverride %s",
    (settledOverride) =>
      Effect.scoped(
        Effect.gen(function* () {
          const online = yield* Ref.make(false);
          const fixture = yield* makeHarness({
            threads: [
              thread("backfill", { settledOverride, settledAt: NOW }),
              thread("known", {
                branch: "known",
                settledOverride,
                settledAt: NOW,
                branchPullRequest: reference(1),
              }),
            ],
            branchPullRequest: ({ cwd }) =>
              Ref.get(online).pipe(
                Effect.flatMap((connected) =>
                  connected
                    ? Effect.succeed(branchPullRequest(42, "merged"))
                    : Effect.fail(
                        new GitManagerError({
                          operation: "branchPullRequest",
                          cwd,
                          detail: "Offline",
                        }),
                      ),
                ),
              ),
          });
          yield* Effect.gen(function* () {
            const reactor = yield* fixture.start();
            expect(yield* Ref.get(fixture.commands)).toHaveLength(0);
            // A one-thread read cannot show that other pending threads are gone.
            const gone = ThreadId.make("gone");
            yield* fixture.publish({
              type: "thread.unarchived",
              sequence: 2,
              eventId: EventId.make("gone-unarchived"),
              aggregateKind: "thread",
              aggregateId: gone,
              occurredAt: NOW,
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: { threadId: gone, updatedAt: NOW },
            });
            expect(yield* Queue.take(fixture.reads)).toBe(gone);
            yield* reactor.drain;
            yield* Ref.set(online, true);
            yield* TestClock.adjust("1 minute");
            yield* Queue.take(fixture.reads);
            yield* reactor.drain;
            expect((yield* Ref.get(fixture.commands))[0]?.threadId).toBe("backfill");
            yield* TestClock.adjust("1 minute");
            yield* Queue.take(fixture.reads);
            yield* reactor.drain;
            expect((yield* Ref.get(fixture.branchCalls)).map((call) => call.branch)).toEqual([
              "feature",
              "feature",
              "feature",
            ]);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("stops retrying a settled backfill after repeated lookup failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [thread("backfill", { settledOverride: "settled", settledAt: NOW })],
          branchPullRequest: ({ cwd }) =>
            Effect.fail(
              new GitManagerError({ operation: "branchPullRequest", cwd, detail: "No gh" }),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* fixture.start();
          for (
            let attempt = 1;
            attempt < ThreadPullRequestReactor.BACKFILL_ATTEMPTS + 2;
            attempt++
          ) {
            yield* TestClock.adjust("1 minute");
            yield* Queue.take(fixture.reads);
            yield* reactor.drain;
          }
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(
            ThreadPullRequestReactor.BACKFILL_ATTEMPTS,
          );
          expect(yield* Ref.get(fixture.commands)).toHaveLength(0);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("discovers the same PRs from the unsettled read as from the full read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'Project', '/workspace/project', '[]', ${NOW}, ${NOW}),
          ('dormant', 'Dormant', '/workspace/dormant', '[]', ${NOW}, ${NOW})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, branch_pull_request_json, created_at, updated_at, archived_at, settled_override, settled_at)
        VALUES
          ('open', 'project', 'Open', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', 'open', NULL, ${NOW}, ${NOW}, NULL, NULL, NULL),
          ('resumed', 'project', 'Resumed', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', 'resumed', NULL, ${NOW}, ${NOW}, NULL, 'active', NULL),
          ('linked', 'project', 'Linked', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', 'linked', '{"projectId":"project","repository":"owner/repository","number":3,"url":"https://github.com/owner/repository/pull/3"}', ${NOW}, ${NOW}, NULL, NULL, NULL),
          ('settled', 'project', 'Settled', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', 'settled', '{"projectId":"project","repository":"owner/repository","number":4,"url":"https://github.com/owner/repository/pull/4"}', ${NOW}, ${NOW}, NULL, 'settled', ${NOW}),
          ('backfill', 'project', 'Backfill', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', 'backfill', NULL, ${NOW}, ${NOW}, NULL, 'settled', ${NOW}),
          ('imported', 'dormant', 'Imported', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', NULL, NULL, ${NOW}, ${NOW}, NULL, 'settled', ${NOW}),
          ('archived', 'project', 'Archived', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', 'archived', NULL, ${NOW}, ${NOW}, ${NOW}, NULL, NULL)`;
      const numbers = new Map([
        ["open", 1],
        ["resumed", 2],
        ["linked", 3],
        ["settled", 4],
        ["backfill", 5],
        ["archived", 6],
      ]);

      // Startup, then two periodic passes. The startup backfill lookup fails,
      // so the first periodic pass retries it from the full read.
      const discover = (read: ProjectionSnapshotQueryShape["getShellSnapshot"]) =>
        Effect.gen(function* () {
          const online = yield* Ref.make(false);
          const reads: Array<ReadonlyArray<string>> = [];
          const fixture = yield* makeHarness({
            threads: [],
            getShellSnapshot: (options) =>
              read(options).pipe(
                Effect.tap((snapshot) =>
                  Effect.sync(() => reads.push(snapshot.threads.map(({ id }) => id).toSorted())),
                ),
              ),
            branchPullRequest: ({ cwd, branch }) =>
              Effect.gen(function* () {
                if (branch === "backfill" && !(yield* Ref.get(online))) {
                  return yield* new GitManagerError({
                    operation: "branchPullRequest",
                    cwd,
                    detail: "Offline",
                  });
                }
                const number = numbers.get(branch);
                return number === undefined ? null : branchPullRequest(number);
              }),
          });
          return yield* Effect.gen(function* () {
            const reactor = yield* fixture.start();
            const startupCalls = (yield* Ref.get(fixture.branchCalls)).length;
            const startupCommands = (yield* Ref.get(fixture.commands)).length;
            yield* Ref.set(online, true);
            for (let pass = 0; pass < 2; pass++) {
              yield* TestClock.adjust("1 minute");
              yield* Queue.take(fixture.reads);
              yield* reactor.drain;
            }
            return {
              reads,
              branchCalls: (yield* Ref.get(fixture.branchCalls))
                .slice(startupCalls)
                .map(({ branch }) => branch)
                .toSorted(),
              commands: (yield* Ref.get(fixture.commands))
                .slice(startupCommands)
                .map(
                  ({ threadId, branchPullRequest }) => `${threadId} ${branchPullRequest?.number}`,
                )
                .toSorted(),
            };
          }).pipe(Effect.provide(fixture.layer));
        }).pipe(Effect.scoped);

      const { reads: unsettledReads, ...unsettled } = yield* discover(query.getShellSnapshot);
      const { reads: fullReads, ...full } = yield* discover(() => query.getShellSnapshot());
      expect(unsettled).toEqual(full);
      expect(unsettled.commands).toEqual([
        "backfill 5",
        "open 1",
        "open 1",
        "resumed 2",
        "resumed 2",
      ]);
      // The last pass has no backfill left, so it reads no settled thread.
      expect(fullReads.at(-1)).toContain("imported");
      expect(unsettledReads.at(-1)).toEqual(["linked", "open", "resumed"]);
    }).pipe(
      Effect.provide(
        OrchestrationProjectionSnapshotQueryLive.pipe(
          Layer.provide(ThreadBackgroundLiveness.layer),
          Layer.provide(ThreadPlanProgress.layer),
          Layer.provide(
            Layer.succeed(
              StaveWorkspaceReader,
              StaveWorkspaceReader.of({
                load: () => Effect.succeed(Option.none()),
                invalidate: () => Effect.void,
                invalidateAll: () => Effect.void,
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(project.repositoryIdentity),
            }),
          ),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
  );

  it.effect("matches HTTPS PRs while retaining the full Azure SSH identity and host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [thread("azure")],
          project: {
            ...project,
            repositoryIdentity: {
              canonicalKey: "ssh.dev.azure.com/v3/org/project/repository",
              displayName: "v3/org/project/repository",
              name: "repository",
              provider: "azure-devops",
              rootPath: project.workspaceRoot,
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "git@ssh.dev.azure.com:v3/org/project/repository",
              },
            },
          },
          branchPullRequest: () =>
            Effect.succeed({
              ...branchPullRequest(),
              repositoryKey: "dev.azure.com/org/project/_git/repository",
              url: "https://dev.azure.com/org/project/_git/repository/pullrequest/42",
            }),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start();
          expect((yield* Ref.get(fixture.commands))[0]?.branchPullRequest).toEqual({
            projectId: PROJECT_ID,
            repository: "v3/org/project/repository",
            host: "ssh.dev.azure.com",
            number: 42,
            url: "https://dev.azure.com/org/project/_git/repository/pullrequest/42",
          });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each(["primary", "branch"] as const)(
    "rejects the group's links if the %s remote changes during a summary read",
    (changedRemote) =>
      Effect.scoped(
        Effect.gen(function* () {
          const identity = yield* Ref.make(project.repositoryIdentity);
          const detected = yield* Ref.make(branchPullRequest());
          const fixture = yield* makeHarness({
            threads: [thread("manual", { linkedPullRequest: reference(1) }), thread("automatic")],
            branchPullRequest: () => Ref.get(detected),
            resolveRepositoryIdentity: (_cwd, options) =>
              options?.refresh ? Ref.get(identity) : Effect.succeed(project.repositoryIdentity),
            summary: (input) =>
              (changedRemote === "primary"
                ? Ref.set(identity, {
                    ...project.repositoryIdentity,
                    canonicalKey: "github.com/other/repository",
                    displayName: "other/repository",
                  })
                : Ref.set(detected, {
                    ...branchPullRequest(99),
                    repositoryKey: "github.com/other/repository",
                    url: "https://github.com/other/repository/pull/99",
                  })
              ).pipe(Effect.as(summary(input, "merged"))),
          });
          yield* Effect.gen(function* () {
            yield* fixture.start();
            expect(yield* Ref.get(fixture.commands)).toEqual([]);
            expect((yield* Ref.get(fixture.snapshots)).threads[0]?.linkedPullRequest).toEqual(
              reference(1),
            );
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );
});
