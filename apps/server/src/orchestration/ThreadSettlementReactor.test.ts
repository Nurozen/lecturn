import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type PullRequestSummary,
  type PullRequestRef,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@lecturn/contracts";
import { applyServerSettingsPatch } from "@lecturn/shared/serverSettings";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { StaveMergeSignal } from "../stave/StaveMergeSignal.ts";
import { GitManager, type GitBranchPullRequest } from "../git/GitManager.ts";
import {
  PullRequestService,
  type PullRequestMergeEvent,
} from "../pullRequest/PullRequestService.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadSettlementReactor from "./ThreadSettlementReactor.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");
const LINKED_PROJECT_ID = ProjectId.make("linked-settlement-project");

type AutoSettleCommand = Extract<OrchestrationCommand, { readonly type: "thread.auto-settle" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(
  id: ProjectId = PROJECT_ID,
  workspaceRoot = "/workspace/project",
): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects,
    threads,
    updatedAt: NOW,
  };
}

function makePullRequestSummary(input: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: string;
}): PullRequestSummary {
  return {
    provider: "github",
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://example.test/${input.repository}/pull/${input.number}`,
    state: input.state,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: input.updatedAt ?? NOW,
    closedAt: input.state === "closed" ? (input.updatedAt ?? NOW) : null,
    mergedAt: input.state === "merged" ? (input.updatedAt ?? NOW) : null,
  };
}

function makeBranchPullRequest(
  state: GitBranchPullRequest["state"],
  updatedAt: string | null = NOW,
): GitBranchPullRequest {
  return {
    number: 42,
    title: "Branch pull request",
    url: "https://example.test/owner/repository/pull/42",
    baseRef: "main",
    headRef: "saved-feature",
    repositoryKey: "example.test/owner/repository",
    state,
    updatedAt,
    closedAt: state === "closed" ? updatedAt : null,
    mergedAt: state === "merged" ? updatedAt : null,
  };
}

interface HarnessOptions {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly settings?: ServerSettings;
  readonly staveMerged?: ReadonlySet<ProjectId>;
  readonly localStatus?: GitManager["Service"]["localStatus"];
  readonly branchPullRequest?: GitManager["Service"]["branchPullRequest"];
  readonly pullRequestSummary?: PullRequestService["Service"]["summary"];
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly onDispatch?: (
    command: AutoSettleCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsReads = yield* Queue.unbounded<ServerSettings>();
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  const mergedPullRequests = yield* PubSub.unbounded<PullRequestMergeEvent>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const branchCalls = yield* Ref.make<
    ReadonlyArray<{ readonly cwd: string; readonly branch: string }>
  >([]);
  const summaryCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const summaryRecovery = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
  const invalidatedCwds = yield* Ref.make<ReadonlyArray<string>>([]);

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const branchPullRequest: GitManager["Service"]["branchPullRequest"] = (input, readOptions) =>
    Ref.update(branchCalls, (calls) => [...calls, input]).pipe(
      Effect.andThen(options.branchPullRequest?.(input, readOptions) ?? Effect.succeed(null)),
    );
  const pullRequestSummary: PullRequestService["Service"]["summary"] = (input, readOptions) =>
    Effect.gen(function* () {
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      yield* Ref.update(summaryRecovery, (values) => [
        ...values,
        readOptions?.recoverTransientFailure,
      ]);
      return yield* (
        options.pullRequestSummary?.(input, readOptions) ??
          Effect.succeed(
            makePullRequestSummary({
              ...input,
              state: "open",
            }),
          )
      );
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1 }),
    );
  };

  const serverSettings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings).pipe(Effect.tap((value) => Queue.offer(settingsReads, value))),
    updateSettings,
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const dependencies = Layer.mergeAll(
    Path.layer,
    Layer.succeed(StaveMergeSignal, {
      candidates: () => Effect.succeed(options.staveMerged ?? new Set<ProjectId>()),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Ref.updateAndGet(snapshotReadCount, (count) => count + 1).pipe(
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
        ),
    }),
    Layer.mock(GitManager)({
      branchPullRequest,
      localStatus:
        options.localStatus ??
        (() =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: "stave/s/repo",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          })),
      invalidateStatus: (cwd) => Ref.update(invalidatedCwds, (cwds) => [...cwds, cwd]),
    }),
    Layer.mock(PullRequestService)({
      summary: pullRequestSummary,
      subscribeMerges: PubSub.subscribe(mergedPullRequests).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(options.existingWorktreePaths?.includes(path) ?? false),
    }),
  );

  return {
    activation,
    snapshots,
    snapshotReadCount,
    snapshotReads,
    settingsReads,
    commands,
    branchCalls,
    summaryCalls,
    summaryRecovery,
    invalidatedCwds,
    updateSettings,
    publishMergeEvent: (event: PullRequestMergeEvent) => PubSub.publish(mergedPullRequests, event),
    publishMerge: PubSub.publish(mergedPullRequests, {
      projectId: PROJECT_ID,
      repository: "owner/repository",
      number: 42,
      mergedAt: NOW,
    }),
    layer: ThreadSettlementReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementReactor.ThreadSettlementReactor["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

describe("ThreadSettlementReactor", () => {
  it.effect("keeps a Stave-hosted link active on another host's matching merge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const summarized = yield* Queue.unbounded<void>();
        const linkedPullRequest = {
          projectId: LINKED_PROJECT_ID,
          repository: "owner/repository",
          host: "one.enterprise.test",
          number: 42,
          url: "https://one.enterprise.test/owner/repository/pull/42",
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("host-link", {
                linkedPullRequest,
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
            ],
            [
              makeProject(),
              {
                ...makeProject(LINKED_PROJECT_ID, "/workspace/linked"),
                stave: {
                  spaceId: "linked-space",
                  isSaga: false,
                  state: "live",
                  memories: [],
                  repos: [{ name: "repo", path: "repo", mode: "edit" }],
                },
              },
            ],
          ),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          pullRequestSummary: (input) =>
            Queue.offer(summarized, undefined).pipe(
              Effect.as(makePullRequestSummary({ ...input, state: "open" })),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* Queue.take(summarized);
          yield* fixture.publishMergeEvent({
            projectId: LINKED_PROJECT_ID,
            repository: "owner/repository",
            host: "two.enterprise.test",
            number: 42,
            mergedAt: NOW,
          });
          yield* Queue.take(summarized);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            {
              projectId: LINKED_PROJECT_ID,
              repository: "owner/repository",
              host: "one.enterprise.test",
              number: 42,
            },
            {
              projectId: LINKED_PROJECT_ID,
              repository: "owner/repository",
              host: "one.enterprise.test",
              number: 42,
            },
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it("distinguishes a project that inherits the threshold from one that disables it", () => {
    const inherits = ThreadSettlementReactor.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: true } },
    });
    const never = ThreadSettlementReactor.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: null },
      },
    });
    assert.notStrictEqual(inherits, never);
  });

  it("ignores project overrides that do not touch settlement", () => {
    const base = ThreadSettlementReactor.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: false } },
    });
    const unrelated = ThreadSettlementReactor.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [LINKED_PROJECT_ID]: { defaultThreadEnvMode: "worktree" },
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: false, defaultAutoPull: true },
      },
    });
    assert.strictEqual(base, unrelated);
  });

  it.effect(
    "settles all-terminal links from snapshots and keeps open or unsynced links active",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const link = (number: number, state: "open" | "merged" | null) => ({
            host: "example.test",
            repository: "owner/repository",
            number,
            url: `https://example.test/owner/repository/pull/${number}`,
            source: "manual" as const,
            linkedAt: NOW,
            stack: null,
            snapshot:
              state === null
                ? null
                : {
                    state,
                    title: "Review",
                    headBranch: "feature",
                    baseBranch: "main",
                    isDraft: false,
                    updatedAt: NOW,
                    syncedAt: NOW,
                    mergedAt: state === "merged" ? NOW : null,
                  },
          });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([
              makeThread("merged", { pullRequests: [link(1, "merged"), link(2, "merged")] }),
              makeThread("open", { pullRequests: [link(1, "merged"), link(2, "open")] }),
              makeThread("unsynced", { pullRequests: [link(1, "merged"), link(2, null)] }),
            ]),
            settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleOnMerge: true },
            branchPullRequest: () => Effect.die("linked threads must not query the branch"),
            pullRequestSummary: () => Effect.die("linked threads must use their snapshots"),
          });
          yield* Effect.gen(function* () {
            const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
            yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(
              (yield* Ref.get(fixture.commands)).map(({ threadId }) => threadId),
              [ThreadId.make("merged")],
            );
            assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
            assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("uses saved PRs without settling resumed threads or branches with newer PRs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const previous = {
          projectId: PROJECT_ID,
          repository: "owner/repository",
          number: 1,
          url: "https://example.test/owner/repository/pull/1",
        };
        const project = {
          ...makeProject(),
          repositoryIdentity: {
            canonicalKey: "example.test/owner/repository",
            rootPath: "/workspace/project",
            displayName: "owner/repository",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://example.test/owner/repository.git",
            },
          },
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("retained-terminal", { branch: "main", branchPullRequest: previous }),
              makeThread("reused-manual", { branch: "reused", linkedPullRequest: previous }),
              makeThread("reused-detected", { branch: "reused", branchPullRequest: previous }),
              makeThread("foreign-branch-pr", { branch: "foreign", linkedPullRequest: previous }),
              makeThread("resumed-manual", {
                branch: "main",
                linkedPullRequest: previous,
                latestUserMessageAt: "2026-08-28T00:00:00.000Z",
              }),
              makeThread("resumed-detected", {
                branch: "main",
                branchPullRequest: previous,
                latestUserMessageAt: "2026-08-28T00:00:00.000Z",
              }),
            ],
            [project],
          ),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
          branchPullRequest: ({ branch }, options) =>
            Effect.succeed(
              branch === "reused"
                ? makeBranchPullRequest(options?.refresh ? "open" : "merged")
                : branch === "foreign"
                  ? {
                      ...makeBranchPullRequest("open"),
                      repositoryKey: "example.test/another/repository",
                    }
                  : null,
            ),
          pullRequestSummary: (input) =>
            Effect.succeed({
              ...makePullRequestSummary({ ...input, state: "merged" }),
              mergedAt: "2026-08-27T00:00:00.000Z",
            }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(
            new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
            new Set([ThreadId.make("retained-terminal"), ThreadId.make("foreign-branch-pr")]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips PR work on startup, timer and merge sweeps when settlement is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("branch-thread", { branch: "feature" }),
            makeThread("linked-thread", {
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
          ]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
          },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          yield* Queue.take(fixture.settingsReads);
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          yield* fixture.publishMerge;
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;

          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 0);

          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          // Inactive threads settle without a PR lookup, so only the dispatches prove work resumed.
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId).toSorted(),
            [ThreadId.make("branch-thread"), ThreadId.make("linked-thread")],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a project override settles only that project's inactive threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const overriddenProject = ProjectId.make("overridden-project");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("inherits-thread"),
              makeThread("overridden-thread", { projectId: overriddenProject }),
            ],
            [makeProject(), makeProject(overriddenProject, "/workspace/overridden")],
          ),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            projectSettingsOverrides: {
              [overriddenProject]: { sidebarAutoSettleAfterDays: 1 },
            },
          },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          yield* Queue.take(fixture.settingsReads);
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("overridden-thread")],
          );

          // Clearing the override is a settlement change, so the sweep re-arms.
          yield* fixture.updateSettings({
            projectSettingsOverrides: { [overriddenProject]: null },
            sidebarAutoSettleAfterDays: 1,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          // The static snapshot never records the first settlement, so the
          // second sweep dispatches for both; the inheriting thread is new.
          assert.include(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            ThreadId.make("inherits-thread"),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("starts without clients and skips protected threads before pull request lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const linkedPullRequest = {
          projectId: LINKED_PROJECT_ID,
          repository: "owner/repository",
          number: 42,
          url: "https://example.test/owner/repository/pull/42",
        } as const;
        const skipped = [
          makeThread("pending-approval", {
            branch: "skip-approval",
            hasPendingApprovals: true,
          }),
          makeThread("snoozed", {
            branch: "skip-snoozed",
            snoozedUntil: "2026-08-29T00:00:00.000Z",
          }),
        ];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("inactive", { branch: "inactive-feature" }),
              makeThread("closed-pr", {
                linkedPullRequest,
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
              ...skipped,
            ],
            [makeProject(), makeProject(LINKED_PROJECT_ID, "/workspace/linked")],
          ),
          branchPullRequest: () => Effect.succeed(null),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "closed" })),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 0);

          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          const commands = yield* Ref.get(fixture.commands);
          assert.deepStrictEqual(
            commands
              .map(({ threadId, snapshotSequence, settledAt }) => ({
                threadId,
                snapshotSequence,
                settledAt,
              }))
              .sort((left, right) => left.threadId.localeCompare(right.threadId)),
            [
              {
                threadId: ThreadId.make("closed-pr"),
                snapshotSequence: 1,
                settledAt: "2026-08-27T00:00:00.000Z",
              },
              {
                threadId: ThreadId.make("inactive"),
                snapshotSequence: 1,
                settledAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          );
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            { projectId: LINKED_PROJECT_ID, repository: "owner/repository", number: 42 },
          ]);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryRecovery), [false]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reevaluates inactivity and pull request state once per minute", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const pullRequest = yield* Ref.make<"open" | "merged">("open");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("at-boundary", {
              latestUserMessageAt: "2026-08-25T12:00:00.000Z",
            }),
            makeThread("open-pr", {
              branch: "saved-feature",
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
            }),
          ]),
          branchPullRequest: () =>
            Ref.get(pullRequest).pipe(Effect.map((state) => makeBranchPullRequest(state))),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* Ref.set(pullRequest, "merged");
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands))
              .map((command) => command.threadId)
              .sort((left, right) => left.localeCompare(right)),
            [ThreadId.make("at-boundary"), ThreadId.make("open-pr")],
          );
          assert.strictEqual((yield* Ref.get(fixture.branchCalls)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reevaluates immediately after a pull request merge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const periodicLookupStarted = yield* Deferred.make<void>();
        const releasePeriodicLookup = yield* Deferred.make<void>();
        const mergedThreadSettled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("slow-periodic-lookup", {
              branch: "another-feature",
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
            }),
          ]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePeriodicLookup)),
                      Effect.as(makeBranchPullRequest("open")),
                    ),
              ),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Deferred.await(periodicLookupStarted);

          yield* fixture.publishMerge;
          yield* Deferred.await(mergedThreadSettled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          yield* Deferred.succeed(releasePeriodicLookup, undefined);
          yield* reactor.drain;
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "settles branch threads on a pull request merge without waiting for the next sweep",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const state = yield* Ref.make<"open" | "merged">("open");
          const mergedThreadSettled = yield* Deferred.make<void>();
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([
              makeThread("branch-thread", {
                branch: "saved-feature",
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
            ]),
            branchPullRequest: () =>
              Ref.get(state).pipe(
                Effect.map((pullRequestState) => makeBranchPullRequest(pullRequestState)),
              ),
            onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
          });

          yield* Effect.gen(function* () {
            const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
            yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
            assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), []);

            yield* Ref.set(state, "merged");
            yield* fixture.publishMerge;
            yield* Deferred.await(mergedThreadSettled);

            assert.deepStrictEqual(
              (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
              [ThreadId.make("branch-thread")],
            );
            assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), ["/workspace/project"]);
            yield* reactor.drain;
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("a merge does not settle threads linked to an unrelated pull request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const mergedThreadSettled = yield* Deferred.make<void>();
        const mergeLookupStarted = yield* Deferred.make<void>();
        const releaseMergeLookup = yield* Deferred.make<void>();
        const lookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("unrelated-linked", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 99,
                url: "https://example.test/owner/repository/pull/99",
              },
            }),
          ]),
          pullRequestSummary: (input) =>
            Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
              // The initial sweep looks up both linked threads; the merge
              // sweep only looks up the unrelated one, since the merged
              // thread settles from the event itself.
              Effect.tap((count) =>
                count === 3 ? Deferred.succeed(mergeLookupStarted, undefined) : Effect.void,
              ),
              Effect.tap((count) =>
                count === 3 ? Deferred.await(releaseMergeLookup) : Effect.void,
              ),
              Effect.map(() => makePullRequestSummary({ ...input, state: "open" })),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* fixture.publishMerge;
          yield* Deferred.await(mergeLookupStarted);
          yield* Deferred.await(mergedThreadSettled);
          yield* Deferred.succeed(releaseMergeLookup, undefined);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls))
              .map((call) => call.number)
              .toSorted((left, right) => left - right),
            [42, 99, 99],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("uses fresh settlement settings after lookup and ignores unrelated changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<"merged" | "closed">("merged");
        const firstLookupStarted = yield* Deferred.make<void>();
        const releaseFirstLookup = yield* Deferred.make<void>();
        const laterLookupStarted = yield* Deferred.make<void>();
        const releaseLaterLookup = yield* Deferred.make<void>();
        const lookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("settings-thread", {
              branch: "saved-feature",
              latestUserMessageAt: "2026-08-28T00:00:00.000Z",
            }),
          ]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
          branchPullRequest: () =>
            Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 1
                  ? Deferred.succeed(firstLookupStarted, undefined)
                  : count === 2
                    ? Deferred.succeed(laterLookupStarted, undefined)
                    : Effect.void,
              ),
              Effect.tap((count) =>
                count === 1
                  ? Deferred.await(releaseFirstLookup)
                  : count === 2
                    ? Deferred.await(releaseLaterLookup)
                    : Effect.void,
              ),
              Effect.andThen(Ref.get(state)),
              Effect.map((pullRequestState) => makeBranchPullRequest(pullRequestState)),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* Deferred.await(firstLookupStarted);
          yield* Queue.clear(fixture.settingsReads);

          yield* fixture.updateSettings({ sidebarAutoSettleOnMerge: false });
          yield* Deferred.succeed(releaseFirstLookup, undefined);
          // The in-flight decision and the newly queued sweep both read the disabled settings.
          yield* Queue.take(fixture.settingsReads);
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 1);

          yield* Ref.set(state, "closed");
          yield* fixture.updateSettings({ enableAgentBrowserAccess: false });
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
          yield* Deferred.await(laterLookupStarted);
          yield* Deferred.succeed(releaseLaterLookup, undefined);
          yield* reactor.drain;

          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 2);
          assert.strictEqual(yield* Ref.get(lookupCount), 2);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("settings-thread")],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps an unknown pull request active and continues with other candidates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("lookup-failed", {
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
                linkedPullRequest: {
                  projectId: LINKED_PROJECT_ID,
                  repository: "owner/repository",
                  number: 9,
                  url: "https://example.test/owner/repository/pull/9",
                },
              }),
              makeThread("inactive-without-pr"),
            ],
            [makeProject(), makeProject(LINKED_PROJECT_ID, "/workspace/linked")],
          ),
          pullRequestSummary: () =>
            Effect.fail(
              new PullRequestOperationError({
                operation: "summary",
                detail: "host unavailable",
              }),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("inactive-without-pr")],
          );
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles inactive linked and branch threads without reading an unavailable host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("inactive-linked", {
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("inactive-branch", {
              branch: "saved-feature",
              latestUserMessageAt: "2026-08-21T00:00:00.000Z",
            }),
          ]),
          branchPullRequest: () => Effect.die(new Error("host unavailable")),
          pullRequestSummary: () =>
            Effect.fail(
              new PullRequestOperationError({
                operation: "summary",
                detail: "host unavailable",
              }),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands))
              .map(({ threadId, snapshotSequence, settledAt }) => ({
                threadId,
                snapshotSequence,
                settledAt,
              }))
              .sort((left, right) => left.threadId.localeCompare(right.threadId)),
            [
              {
                threadId: ThreadId.make("inactive-branch"),
                snapshotSequence: 1,
                settledAt: "2026-08-21T00:00:00.000Z",
              },
              {
                threadId: ThreadId.make("inactive-linked"),
                snapshotSequence: 1,
                settledAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          );
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles an inactive thread before its shared pull request lookup completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const lookupStarted = yield* Deferred.make<void>();
        const releaseLookup = yield* Deferred.make<void>();
        const linkedPullRequest = {
          projectId: PROJECT_ID,
          repository: "owner/repository",
          number: 42,
          url: "https://example.test/owner/repository/pull/42",
        } as const;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("recent-linked", {
              linkedPullRequest,
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
            }),
            makeThread("inactive-linked", { linkedPullRequest }),
          ]),
          pullRequestSummary: () =>
            Deferred.succeed(lookupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLookup)),
              Effect.andThen(
                Effect.fail(
                  new PullRequestOperationError({
                    operation: "summary",
                    detail: "host unavailable",
                  }),
                ),
              ),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Deferred.await(lookupStarted);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map(({ threadId }) => threadId),
            [ThreadId.make("inactive-linked")],
          );

          yield* Deferred.succeed(releaseLookup, undefined);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 1);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps threads active when their pull request project is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const linkedPullRequest = {
          projectId: LINKED_PROJECT_ID,
          repository: "owner/repository",
          number: 10,
          url: "https://example.test/owner/repository/pull/10",
        } as const;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("missing-own-project", {
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
                linkedPullRequest,
              }),
              makeThread("missing-branch-project", {
                branch: "saved-feature",
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
            ],
            [makeProject(LINKED_PROJECT_ID, "/workspace/linked")],
          ),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "open" })),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            { projectId: LINKED_PROJECT_ID, repository: "owner/repository", number: 10 },
          ]);
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("deduplicates saved-branch and linked pull request lookups within a sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const linkedPullRequest = {
          projectId: LINKED_PROJECT_ID,
          repository: "owner/repository",
          number: 77,
          url: "https://example.test/owner/repository/pull/77",
        } as const;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("branch-one", {
                branch: "saved-feature",
                worktreePath: "/deleted/worktree-one",
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
              makeThread("branch-two", {
                branch: "saved-feature",
                worktreePath: "/deleted/worktree-two",
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
              makeThread("linked-one", {
                linkedPullRequest,
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
              makeThread("linked-two", {
                linkedPullRequest,
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
            ],
            [
              makeProject(PROJECT_ID, "/workspace/project-root"),
              makeProject(LINKED_PROJECT_ID, "/workspace/linked-root"),
            ],
          ),
          branchPullRequest: () => Effect.succeed(makeBranchPullRequest("closed")),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "merged" })),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), [
            { cwd: "/workspace/project-root", branch: "saved-feature" },
          ]);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            { projectId: LINKED_PROJECT_ID, repository: "owner/repository", number: 77 },
          ]);
          assert.deepStrictEqual(
            new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
            new Set([
              ThreadId.make("branch-one"),
              ThreadId.make("branch-two"),
              ThreadId.make("linked-one"),
              ThreadId.make("linked-two"),
            ]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("looks up the branch pull request from a thread's live worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("live-worktree", {
                branch: "feature/live",
                worktreePath: "/workspace/project-root/.worktrees/live",
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
              makeThread("deleted-worktree", {
                branch: "feature/deleted",
                worktreePath: "/workspace/project-root/.worktrees/deleted",
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
            ],
            [makeProject(PROJECT_ID, "/workspace/project-root")],
          ),
          existingWorktreePaths: ["/workspace/project-root/.worktrees/live"],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            new Set(yield* Ref.get(fixture.branchCalls)),
            new Set([
              { cwd: "/workspace/project-root/.worktrees/live", branch: "feature/live" },
              { cwd: "/workspace/project-root", branch: "feature/deleted" },
            ]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("carries the snapshot guard and survives a stale dispatch rejection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("stale"), makeThread("next-candidate")]),
          onDispatch: (command) =>
            command.threadId === ThreadId.make("stale")
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "thread changed after settlement evaluation",
                  }),
                )
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          const firstSweep = yield* Ref.get(fixture.commands);
          assert.strictEqual(
            firstSweep.find((command) => command.threadId === ThreadId.make("stale"))
              ?.snapshotSequence,
            1,
          );
          assert.strictEqual(
            firstSweep.some((command) => command.threadId === ThreadId.make("next-candidate")),
            true,
          );

          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 4);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("Stave saga settlement", () => {
  it.effect(
    "settles all merged members with the independent Stave toggle while retaining candidate guards",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("ready"),
            makeThread("created-now", { createdAt: NOW, latestUserMessageAt: null }),
            makeThread("busy", {
              session: {
                threadId: ThreadId.make("busy"),
                status: "running",
                updatedAt: NOW,
              } as OrchestrationThreadShell["session"],
            }),
            makeThread("override", { settledOverride: "active" }),
            makeThread("ordinary", {
              projectId: LINKED_PROJECT_ID,
              branch: "ordinary-feature",
              linkedPullRequest: {
                projectId: LINKED_PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
          ]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            stave: {
              ...DEFAULT_SERVER_SETTINGS.stave,
              enabled: true,
              lifecycle: { ...DEFAULT_SERVER_SETTINGS.stave.lifecycle, settleOnSagaMerge: true },
            },
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
          },
          staveMerged: new Set([PROJECT_ID]),
          branchPullRequest: () => Effect.die("must not query Git for saga merge signal"),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, harness.activation, harness.snapshotReads);
          const commands = yield* Ref.get(harness.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.threadId),
            [ThreadId.make("ready"), ThreadId.make("created-now")],
          );
          assert.strictEqual(commands[0]?.settledAt, "2026-08-20T00:00:00.000Z");
          assert.strictEqual(commands[1]?.settledAt, NOW);
          assert.deepStrictEqual(yield* Ref.get(harness.branchCalls), []);
          assert.deepStrictEqual(yield* Ref.get(harness.summaryCalls), []);
          assert.deepStrictEqual(yield* Ref.get(harness.invalidatedCwds), []);
        }).pipe(Effect.provide(harness.layer));
      }),
  );
  it.effect("uses the editable repo checkout branch for Stave PR lookup", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const project = {
        ...makeProject(),
        stave: {
          spaceId: "s",
          isSaga: false,
          repos: [{ name: "repo", path: "repo", mode: "edit" as const }],
          memories: [],
          state: "live" as const,
          primaryRepoPath: "/workspace/project/repo",
          primaryBranch: "stave/s/repo",
        },
      };
      const harness = yield* makeHarness({ snapshot: makeSnapshot([makeThread("a")], [project]) });
      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
        yield* startHarness(reactor, harness.activation, harness.snapshotReads);
        assert.deepStrictEqual(yield* Ref.get(harness.branchCalls), [
          { cwd: "/workspace/project/repo", branch: "stave/s/repo" },
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("Stave inactivity settlement", () => {
  const linkedPullRequest = {
    projectId: PROJECT_ID,
    repository: "owner/repository",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
  };
  for (const scenario of [
    { name: "keeps an idle live space active while its PR is open", stave: true, expected: 0 },
    {
      name: "keeps an idle live space active while an explicit linked PR is open",
      stave: true,
      branch: "merged",
      linkedOpen: true,
      expected: 0,
    },
    {
      name: "settles an idle live space that has no PR",
      stave: true,
      branch: null,
      expected: 1,
    },
    { name: "settles an idle ordinary thread whose PR is open", stave: false, expected: 1 },
  ] as const) {
    it.effect(scenario.name, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const project: OrchestrationProjectShell = {
          ...makeProject(),
          ...(scenario.stave
            ? {
                stave: {
                  spaceId: "s",
                  isSaga: false,
                  repos: [{ name: "repo", path: "repo", mode: "edit" }],
                  memories: [],
                  state: "live",
                  primaryRepoPath: "/workspace/project/repo",
                  primaryBranch: "stave/s/repo",
                },
              }
            : {}),
        };
        const branchState = "branch" in scenario ? scenario.branch : "open";
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("idle", {
                branch: "stave/s/repo",
                ...("linkedOpen" in scenario ? { linkedPullRequest } : {}),
              }),
            ],
            [project],
          ),
          // Defaults: settle after three idle days; the thread has been idle for eight.
          settings: DEFAULT_SERVER_SETTINGS,
          branchPullRequest: () =>
            Effect.succeed(
              branchState === null
                ? null
                : makeBranchPullRequest(branchState, "2026-08-19T00:00:00.000Z"),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, scenario.expected);
          assert.strictEqual((yield* Ref.get(fixture.branchCalls)).length, scenario.stave ? 1 : 0);
        }).pipe(Effect.provide(fixture.layer));
      }),
    );
  }
});

describe("Stave multi-repo settlement", () => {
  const project: OrchestrationProjectShell = {
    ...makeProject(),
    stave: {
      spaceId: "multi",
      isSaga: false,
      state: "live",
      memories: [],
      repos: [
        { name: "api", path: "services/api", mode: "edit", branch: "stale-manifest" },
        { name: "web", path: "web", mode: "edit", branch: "also-stale" },
        { name: "reference", path: "references/docs", mode: "reference" },
      ],
      primaryRepoPath: "/workspace/project/services/api",
      primaryBranch: "stale-primary",
    },
  };
  const linkedPullRequest = {
    projectId: PROJECT_ID,
    repository: "owner/repository",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
  };
  const terminalScenarios = [
    {
      name: "all-closed members with the latest close in a checkout",
      api: "closed",
      web: "closed",
      linked: "closed",
      latest: "web",
      onMerge: false,
    },
    {
      name: "all-closed members with the latest close in the explicit link",
      api: "closed",
      web: "closed",
      linked: "closed",
      latest: "linked",
      onMerge: false,
    },
    {
      name: "mixed members with the latest close in a checkout",
      api: "merged",
      web: "closed",
      linked: "merged",
      latest: "web",
      onMerge: true,
    },
    {
      name: "mixed members with the latest close in the explicit link",
      api: "merged",
      web: "merged",
      linked: "closed",
      latest: "linked",
      onMerge: true,
    },
    {
      name: "mixed members with the latest merge in a checkout",
      api: "merged",
      web: "closed",
      linked: "closed",
      latest: "api",
      onMerge: true,
    },
    {
      name: "all-merged members with the latest merge in the explicit link",
      api: "merged",
      web: "merged",
      linked: "merged",
      latest: "linked",
      onMerge: true,
    },
  ] as const;
  const invalidScenarios = (["closed", "merged"] as const).flatMap((state) =>
    (["api", "web", "linked"] as const).flatMap((member) =>
      [undefined, null, "invalid"].map((timestamp) => ({
        name: `${state} members with ${String(timestamp)} terminal time in ${member}`,
        api: state,
        web: state,
        linked: state,
        latest: "web" as const,
        onMerge: true,
        invalidMember: member,
        invalidTimestamp: timestamp,
      })),
    ),
  );
  for (const scenario of [...terminalScenarios, ...invalidScenarios]) {
    it.effect(`uses terminal evidence for ${scenario.name} despite metadata changes`, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const older = "2026-08-19T00:00:00.000Z";
        const latest = "2026-08-21T00:00:00.000Z";
        const metadataAt = yield* Ref.make(older);
        const memberSummary = (member: "api" | "web" | "linked", updatedAt: string) => {
          const state = scenario[member];
          const terminalAt =
            "invalidMember" in scenario && scenario.invalidMember === member
              ? scenario.invalidTimestamp
              : scenario.latest === member
                ? latest
                : older;
          return {
            ...makeBranchPullRequest(state, updatedAt),
            state,
            updatedAt,
            closedAt: state === "closed" ? (terminalAt ?? null) : NOW,
            mergedAt: state === "merged" ? (terminalAt ?? null) : NOW,
          };
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("before-terminal", { linkedPullRequest }),
              makeThread("at-terminal", { linkedPullRequest, latestUserMessageAt: latest }),
              makeThread("resumed", {
                linkedPullRequest,
                latestUserMessageAt: "2026-08-22T00:00:00.000Z",
              }),
            ],
            [project],
          ),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: scenario.onMerge ? null : 365,
            sidebarAutoSettleOnMerge: scenario.onMerge,
          },
          branchPullRequest: ({ cwd }) =>
            Ref.get(metadataAt).pipe(
              Effect.map((updatedAt) =>
                memberSummary(cwd.endsWith("/api") ? "api" : "web", updatedAt),
              ),
            ),
          pullRequestSummary: (input) =>
            Ref.get(metadataAt).pipe(
              Effect.map((updatedAt) => ({
                ...makePullRequestSummary({ ...input, state: scenario.linked }),
                ...memberSummary("linked", updatedAt),
              })),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          const expected =
            "invalidMember" in scenario
              ? []
              : [
                  {
                    threadId: ThreadId.make("before-terminal"),
                    settledAt: "2026-08-20T00:00:00.000Z",
                  },
                  { threadId: ThreadId.make("at-terminal"), settledAt: latest },
                ];
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map(({ threadId, settledAt }) => ({
              threadId,
              settledAt,
            })),
            expected,
          );
          yield* Ref.set(fixture.commands, []);
          yield* Ref.set(metadataAt, NOW);
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map(({ threadId, settledAt }) => ({
              threadId,
              settledAt,
            })),
            expected,
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    );
  }
  for (const scenario of [
    {
      name: "waits for an older explicit open PR",
      second: "merged",
      linkedOpen: true,
      merged: true,
      expected: 0,
    },
    { name: "waits for the second open repo", second: "open", merged: true, expected: 0 },
    { name: "waits when a repo has no PR", second: null, merged: true, expected: 0 },
    { name: "waits when a repo lookup fails", second: "error", merged: true, expected: 0 },
    {
      name: "settles after every editable repo merges",
      second: "merged",
      merged: true,
      expected: 1,
    },
    { name: "honors the merge toggle across repos", second: "merged", merged: false, expected: 0 },
    {
      name: "does not bypass the merge toggle with another closed PR",
      second: "closed",
      merged: false,
      expected: 0,
    },
  ] as const) {
    it.effect(scenario.name, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("multi-thread", {
                branch: "stale-thread",
                linkedPullRequest,
              }),
            ],
            [project],
          ),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: scenario.merged,
          },
          localStatus: ({ cwd }) =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: cwd.endsWith("/api") ? "api-current" : "web-current",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          branchPullRequest: ({ cwd }) => {
            if (cwd.endsWith("/api")) return Effect.succeed(makeBranchPullRequest("merged", NOW));
            if (scenario.second === "error") return Effect.die("repo unavailable");
            return Effect.succeed(
              scenario.second === null
                ? null
                : {
                    ...makeBranchPullRequest(scenario.second, NOW),
                    state: scenario.second,
                    updatedAt: NOW,
                    closedAt: scenario.second === "closed" ? NOW : null,
                    mergedAt: scenario.second === "merged" ? NOW : null,
                  },
            );
          },
          pullRequestSummary: (input) =>
            Effect.succeed(
              makePullRequestSummary({
                ...input,
                state: "linkedOpen" in scenario ? "open" : "merged",
                updatedAt: NOW,
              }),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          if (scenario.merged) {
            yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          } else {
            yield* reactor.start();
            yield* Queue.take(fixture.settingsReads);
            yield* Deferred.succeed(fixture.activation, undefined);
            yield* Queue.take(fixture.settingsReads);
            yield* reactor.drain;
          }
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, scenario.expected);
          assert.deepStrictEqual(
            yield* Ref.get(fixture.branchCalls),
            scenario.merged
              ? [
                  { cwd: "/workspace/project/services/api", branch: "api-current" },
                  { cwd: "/workspace/project/web", branch: "web-current" },
                ]
              : [],
          );
          yield* Queue.clear(fixture.settingsReads);
          yield* fixture.publishMerge;
          if (scenario.merged) yield* Queue.take(fixture.snapshotReads);
          else yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          if (!scenario.merged) {
            assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 0);
            assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          }
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, scenario.expected * 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    );
  }
});
