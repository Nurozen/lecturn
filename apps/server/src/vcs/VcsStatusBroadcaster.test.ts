import { SourceControlProviderKind } from "@lecturn/contracts";
import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  BackgroundScope,
  OrchestrationProjectShell,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@lecturn/contracts";
import { GitManagerError, ProjectId } from "@lecturn/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { StaveProjectShells, StaveProjectShellsError } from "../stave/StaveProjectShells.ts";
import { symlinksSupported } from "@lecturn/shared/testing/symlinks";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

/** A project shell plus its deletion stamp (the V1 `OrchestrationProject` read shape). */
type OrchestrationProject = OrchestrationProjectShell & { readonly deletedAt: string | null };

/** The auto-pull policy reads the V2 project store and Stave-decorated shells. */
interface PolicyQuery {
  readonly getActiveProjectByWorkspaceRoot: (
    cwd: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, PersistenceSqlError>;
  readonly getShellSnapshot: () => Effect.Effect<
    { readonly projects: ReadonlyArray<OrchestrationProjectShell> },
    PersistenceSqlError
  >;
}

const toRow = (project: OrchestrationProject): ProjectStore.ProjectRow => ({
  projectId: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  defaultModelSelection: project.defaultModelSelection,
  defaultThreadEnvMode: null,
  autoPull: project.autoPull ?? false,
  faviconPath: null,
  projectIcon: null,
  scripts: project.scripts,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  deletedAt: project.deletedAt,
});

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const remoteStatusWithPr: VcsStatusRemoteResult = {
  ...baseRemoteStatus,
  pr: {
    number: 2978,
    title: "[codex] Rewrite client connection architecture",
    url: "https://github.com/nurozen/lecturn/pull/2978",
    baseRef: "main",
    headRef: "codex/connection-state-audit",
    state: "open",
  },
};

const baseStatus: VcsStatusResult = {
  ...baseLocalStatus,
  ...baseRemoteStatus,
};

function layerTestFor(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  backgroundWorkEnabled?: boolean;
  automaticFetchInterval?: Effect.Effect<Duration.Duration>;
  beforeRemoteStatus?: Effect.Effect<void>;
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(layerBackgroundPolicy(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.succeed(
        VcsStatusBroadcaster.VcsAutomaticFetchInterval,
        state.automaticFetchInterval ?? Effect.succeed(Duration.seconds(30)),
      ),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.sync(() => {
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        remoteStatus: (_input, options) =>
          Effect.suspend(() => state.beforeRemoteStatus ?? Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                state.remoteStatusCalls += 1;
                state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
                return state.currentRemoteStatus;
              }),
            ),
          ),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
      }),
    ),
  );
}

function layerBackgroundPolicy(shouldRunScopeWork: (scope: BackgroundScope) => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: TEST_EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: false,
      updatedAt: TEST_EPOCH,
    }),
    streamChanges: Stream.empty,
    hasDemand: () => Effect.succeed(true),
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
    shouldRunOpportunisticWork: Effect.succeed(true),
    isUserPresent: Effect.succeed(false),
  });
}

describe("VcsStatusBroadcaster", () => {
  it.effect("publishes a terminal branch switch without reading remote status", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const events = yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.tap((event) =>
          event._tag === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
      assert.equal(refreshed.refName, "main");
      assert.isNull(refreshed.pr);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
      assert.deepStrictEqual((yield* Fiber.join(events))[1], {
        _tag: "snapshot",
        local: state.currentLocalStatus,
        remote: null,
      });
      assert.isNull((yield* broadcaster.getStatus({ cwd: "/repo" })).pr);
      const snapshot = yield* broadcaster
        .streamStatus({ cwd: "/repo", includeRemote: false })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(snapshot[0], {
        _tag: "snapshot",
        local: state.currentLocalStatus,
        remote: null,
      });
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "preserves cached remote status when a local-only refresh stays on the same branch",
    () => {
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 2, behindCount: 3 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const initial = yield* broadcaster.getStatus({ cwd: "/repo" });
        const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
        assert.deepStrictEqual(refreshed, initial);
        assert.deepStrictEqual(yield* broadcaster.getStatus({ cwd: "/repo" }), refreshed);
        assert.equal(state.localInvalidationCalls, 1);
        assert.equal(state.remoteInvalidationCalls, 0);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("clears the previous branch's remote status after an in-flight PR refresh", () => {
    const remoteReadStarted = Deferred.makeUnsafe<void>();
    const releaseRemoteRead = Deferred.makeUnsafe<void>();
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      beforeRemoteStatus: Effect.void,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      state.beforeRemoteStatus = Deferred.succeed(remoteReadStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRemoteRead)),
      );
      const remoteRefresh = yield* broadcaster
        .refreshPullRequestStatus("/repo")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(remoteReadStarted);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      const localRefresh = yield* broadcaster
        .refreshStatus("/repo", { localOnly: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseRemoteRead, undefined);
      yield* Fiber.join(remoteRefresh);
      yield* Fiber.join(localRefresh);

      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(status.refName, "main");
      assert.isNull(status.pr);
      assert.equal(status.aheadCount, 0);
      assert.equal(status.behindCount, 0);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect.skipIf(!symlinksSupported)(
    "automatically pulls an enabled clean default branch when status detects it is behind",
    () => {
      let remoteStatus: VcsStatusRemoteResult = { ...baseRemoteStatus, behindCount: 2 };
      let pullCalls = 0;
      let configuredWorkspaceRoot = "";
      const localStatus: VcsStatusLocalResult = {
        ...baseLocalStatus,
        isDefaultRef: true,
        refName: "main",
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: (cwd) => Effect.succeed(cwd === configuredWorkspaceRoot),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(localStatus),
            remoteStatus: () => Effect.succeed(remoteStatus),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            pullCurrentBranch: () =>
              Effect.sync(() => {
                pullCalls += 1;
                remoteStatus = { ...remoteStatus, behindCount: 0 };
                return {
                  status: "pulled" as const,
                  refName: "main",
                  upstreamRef: "origin/main",
                };
              }),
          }),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "lecturn-vcs-auto-pull-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "lecturn-vcs-auto-pull-link-",
        });
        configuredWorkspaceRoot = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, configuredWorkspaceRoot);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const status = yield* broadcaster.refreshStatus(configuredWorkspaceRoot);

        assert.equal(pullCalls, 1);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("refreshes a loaded cwd without reusing a previous branch's PR", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      assert.isNull(yield* broadcaster.refreshPullRequestStatus("/repo"));
      assert.equal(state.remoteStatusCalls, 0);

      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.remoteStatusCalls, 1);

      state.currentRemoteStatus = remoteStatusWithPr;
      const refreshed = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      state.currentRemoteStatus = baseRemoteStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      const refreshedBranch = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshedBranch, baseRemoteStatus);
      assert.equal(state.remoteStatusCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("a poll that started before the turn-end refresh cannot overwrite its PR", () => {
    const releaseFirstPoll = Deferred.makeUnsafe<void>();
    const firstPollStarted = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 2) {
                yield* Deferred.succeed(firstPollStarted, undefined);
                yield* Deferred.await(releaseFirstPoll);
                return baseRemoteStatus;
              }
              return remoteReads === 1 ? baseRemoteStatus : remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      const poll = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(firstPollStarted);
      const refresh = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseFirstPoll, undefined);
      yield* Fiber.join(poll);
      const refreshed = yield* Fiber.join(refresh);

      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      const final = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(final.pr, remoteStatusWithPr.pr);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("an initial status read cannot overwrite an explicit refresh", () => {
    const firstReadStarted = Deferred.makeUnsafe<void>();
    const releaseFirstRead = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 1) {
                yield* Deferred.succeed(firstReadStarted, undefined);
                yield* Deferred.await(releaseFirstRead);
                return baseRemoteStatus;
              }
              return remoteStatusWithPr;
            }),
          invalidateStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReadStarted);
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.zero);
      yield* Deferred.succeed(releaseFirstRead, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(refresh);
      assert.deepStrictEqual(
        (yield* broadcaster.getStatus({ cwd: "/repo" })).pr,
        remoteStatusWithPr.pr,
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("keeps the cached snapshot unchanged when a refresh branch fails", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failRemoteStatus: false,
    };
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              return state.failRemoteStatus
                ? Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "remote status failed",
                    }),
                  )
                : Effect.succeed(state.currentRemoteStatus);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          invalidateStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/partial-refresh",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 3,
      };
      state.failRemoteStatus = true;

      const refreshExit = yield* broadcaster.refreshStatus("/repo").pipe(Effect.exit);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.deepStrictEqual(cached, baseStatus);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect.skipIf(!symlinksSupported)(
    "normalizes symlinked CWDs before cache lookup and workflow calls",
    () => {
      const seenCwds: string[] = [];
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.localStatusCalls += 1;
                return state.currentLocalStatus;
              }),
            remoteStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.remoteStatusCalls += 1;
                return state.currentRemoteStatus;
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                state.localInvalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                state.remoteInvalidationCalls += 1;
              }),
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "lecturn-vcs-status-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "lecturn-vcs-status-link-",
        });
        const linkDir = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, linkDir);
        const realPath = yield* fileSystem.realPath(realDir);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: linkDir });
        yield* broadcaster.getStatus({ cwd: realDir });

        assert.deepStrictEqual(seenCwds, [realPath, realPath]);
        assert.equal(state.localStatusCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("an explicit refresh reads local totals after the fetch", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const fetchStarted = yield* Deferred.make<void>();
      const finishFetch = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(fetchStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishFetch)),
      );
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(fetchStarted);

      const fetchedLocal: VcsStatusLocalResult = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 0, deletions: 0 },
      };
      state.currentLocalStatus = fetchedLocal;
      yield* Deferred.succeed(finishFetch, undefined);

      const status = yield* Fiber.join(refresh);
      assert.deepStrictEqual(status.branchChanges, fetchedLocal.branchChanges);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("releases remote demand while passive observers remain", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const passiveSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(passiveSnapshot, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(passiveSnapshot);
      assert.equal(state.remoteStatusCalls, 0);
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(layerTest));
  });
});

describe("layerAutoPullPolicy", () => {
  const projectBase = {
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const plainProject: OrchestrationProject = {
    ...projectBase,
    id: ProjectId.make("project-plain"),
    title: "Plain",
    workspaceRoot: "/plain",
    autoPull: true,
    deletedAt: null,
  };
  const staveRoot = "/spaces/lecturn";
  const stavePrimaryRepo = "/spaces/lecturn/lecturn";
  const staveProject: OrchestrationProject = {
    ...projectBase,
    id: ProjectId.make("project-stave"),
    title: "Stave",
    workspaceRoot: staveRoot,
    autoPull: true,
    stave: {
      spaceId: "lecturn",
      isSaga: false,
      repos: [],
      memories: [],
      primaryRepoPath: stavePrimaryRepo,
    },
    deletedAt: null,
  };
  const toShell = ({ deletedAt: _deletedAt, ...project }: OrchestrationProject) =>
    project satisfies OrchestrationProjectShell;
  const shellSnapshot = (projects: ReadonlyArray<OrchestrationProjectShell>) => ({
    snapshotSequence: 1,
    projects,
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const queryFailure = new PersistenceSqlError({ operation: "test", detail: "unavailable" });

  const makePolicyLayer = (query: PolicyQuery, settings = ServerSettings.layerTest()) =>
    VcsStatusBroadcaster.layerAutoPullPolicy.pipe(
      Layer.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          findActiveByWorkspaceRoot: (cwd) =>
            query.getActiveProjectByWorkspaceRoot(cwd).pipe(
              Effect.map(Option.map(toRow)),
              Effect.mapError(
                (cause) => new ProjectStore.ProjectStoreV2Error({ operation: "test", cause }),
              ),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(StaveProjectShells)({
          list: Effect.suspend(query.getShellSnapshot).pipe(
            Effect.map((snapshot) => snapshot.projects),
            Effect.mapError((cause) => new StaveProjectShellsError({ operation: "test", cause })),
          ),
        }),
      ),
      Layer.provide(settings),
      Layer.provideMerge(NodeServices.layer),
    );

  it.effect("enables auto-pull for an ordinary exact workspace-root match", () =>
    Effect.gen(function* () {
      const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
      assert.isTrue(yield* policy.isEnabled("/plain"));
      assert.isFalse(yield* policy.isEnabled("/plain-disabled"));
    }).pipe(
      Effect.provide(
        makePolicyLayer({
          getActiveProjectByWorkspaceRoot: (cwd) =>
            Effect.succeed(
              cwd === "/plain"
                ? Option.some(plainProject)
                : cwd === "/plain-disabled"
                  ? Option.some({ ...plainProject, workspaceRoot: cwd, autoPull: false })
                  : Option.none(),
            ),
          getShellSnapshot: () => Effect.succeed(shellSnapshot([toShell(plainProject)])),
        }),
      ),
    ),
  );

  it.effect(
    "skips auto-pull for a Stave primary repo even when the project setting is enabled",
    () =>
      Effect.gen(function* () {
        const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
        assert.isFalse(yield* policy.isEnabled(stavePrimaryRepo));
        assert.isFalse(yield* policy.isEnabled("/spaces/other/other"));
      }).pipe(
        Effect.provide(
          makePolicyLayer({
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getShellSnapshot: () =>
              Effect.succeed(
                shellSnapshot([
                  toShell(plainProject),
                  toShell(staveProject),
                  toShell({
                    ...staveProject,
                    id: ProjectId.make("project-stave-disabled"),
                    workspaceRoot: "/spaces/other",
                    autoPull: false,
                    stave: { ...staveProject.stave!, primaryRepoPath: "/spaces/other/other" },
                  }),
                ]),
              ),
          }),
        ),
      ),
  );

  it.effect("never enables auto-pull for the Stave space root itself", () =>
    Effect.gen(function* () {
      const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
      assert.isFalse(yield* policy.isEnabled(staveRoot));
    }).pipe(
      Effect.provide(
        makePolicyLayer({
          getActiveProjectByWorkspaceRoot: (cwd) =>
            Effect.succeed(cwd === staveRoot ? Option.some(staveProject) : Option.none()),
          getShellSnapshot: () => Effect.succeed(shellSnapshot([toShell(staveProject)])),
        }),
      ),
    ),
  );

  it.effect("inherits machine defaults and applies checkout overrides while excluding Stave", () =>
    Effect.gen(function* () {
      const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
      assert.isTrue(yield* policy.isEnabled("/plain"));
      assert.isFalse(yield* policy.isEnabled("/opted-out"));
      assert.isFalse(yield* policy.isEnabled(staveRoot));
      assert.isFalse(yield* policy.isEnabled(stavePrimaryRepo));
    }).pipe(
      Effect.provide(
        makePolicyLayer(
          {
            getActiveProjectByWorkspaceRoot: (cwd) =>
              Effect.succeed(
                cwd === "/plain"
                  ? Option.some({ ...plainProject, autoPull: false })
                  : cwd === "/opted-out"
                    ? Option.some({ ...plainProject, id: ProjectId.make("opted-out") })
                    : cwd === staveRoot
                      ? Option.some(staveProject)
                      : Option.none(),
              ),
            getShellSnapshot: () => Effect.succeed(shellSnapshot([toShell(staveProject)])),
          },
          ServerSettings.layerTest({
            defaultAutoPull: true,
            projectSettingsOverrides: {
              [ProjectId.make("opted-out")]: { defaultAutoPull: false },
              [staveProject.id]: { defaultAutoPull: true },
            },
          }),
        ),
      ),
    ),
  );

  it.effect("disables auto-pull for unrelated paths", () =>
    Effect.gen(function* () {
      const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
      assert.isFalse(yield* policy.isEnabled("/elsewhere"));
    }).pipe(
      Effect.provide(
        makePolicyLayer({
          getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
          getShellSnapshot: () =>
            Effect.succeed(shellSnapshot([toShell(plainProject), toShell(staveProject)])),
        }),
      ),
    ),
  );

  it.effect("disables auto-pull when either projection query fails", () =>
    Effect.gen(function* () {
      const rootLookupFails = yield* VcsStatusBroadcaster.VcsAutoPullPolicy.pipe(
        Effect.flatMap((policy) => policy.isEnabled("/plain")),
        Effect.provide(
          makePolicyLayer({
            getActiveProjectByWorkspaceRoot: () => Effect.fail(queryFailure),
            getShellSnapshot: () => Effect.succeed(shellSnapshot([toShell(staveProject)])),
          }),
        ),
      );
      const scanFails = yield* VcsStatusBroadcaster.VcsAutoPullPolicy.pipe(
        Effect.flatMap((policy) => policy.isEnabled("/plain")),
        Effect.provide(
          makePolicyLayer({
            getActiveProjectByWorkspaceRoot: () => Effect.succeedSome(plainProject),
            getShellSnapshot: () => Effect.fail(queryFailure),
          }),
        ),
      );
      assert.isFalse(rootLookupFails);
      assert.isFalse(scanFails);
    }),
  );

  it.effect.each([{ ownerMetadata: true }, { ownerMetadata: false }, { ownerMetadata: null }])(
    "inherited status pulls respect separately registered Stave ownership (metadata: $ownerMetadata)",
    ({ ownerMetadata }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const space = path.join(root, "space");
        const ownerAlias = path.join(root, "aliases", "space");
        const primary = path.join(space, "primary");
        const secondary = path.join(space, "secondary");
        const alias = path.join(root, "alias");
        const ordinary = path.join(root, "space-other");
        const external = path.join(root, "external");
        const externalAlias = path.join(root, "external-alias");
        const unrelated = path.join(root, "aliases", "external");
        yield* fs.makeDirectory(unrelated, { recursive: true });
        for (const cwd of [primary, path.join(secondary, "src"), external, ordinary]) {
          yield* fs.makeDirectory(cwd, { recursive: true });
        }
        if (symlinksSupported) {
          yield* fs.makeDirectory(path.dirname(ownerAlias), { recursive: true });
          yield* fs.symlink(space, ownerAlias);
          yield* fs.symlink(secondary, alias);
          yield* fs.symlink(external, externalAlias);
        }
        if (!ownerMetadata) {
          yield* fs.writeFileString(
            path.join(space, ".stave.yaml"),
            "version: 2\nid: space\nrepos:\n  - name: primary\n    path: primary\n    mode: edit\n  - name: secondary\n    path: secondary\n    mode: edit\n  - name: external\n    path: ../external\n    mode: edit\nmemories: []\n",
          );
        }
        const project = (cwd: string): OrchestrationProject => ({
          ...plainProject,
          id: ProjectId.make(cwd),
          workspaceRoot: cwd,
          autoPull: false,
          stave: null,
        });
        const targets = [
          primary,
          secondary,
          path.join(secondary, "src"),
          ...(ownerMetadata === null ? [] : [external]),
          ...(symlinksSupported
            ? [
                alias,
                path.join(alias, "missing"),
                ...(ownerMetadata === null ? [] : [externalAlias]),
              ]
            : []),
        ];
        const projects = [
          ...targets.map(project),
          project(ordinary),
          project(unrelated),
          ...(ownerMetadata === null
            ? []
            : [
                {
                  ...project(symlinksSupported ? ownerAlias : space),
                  stave: ownerMetadata
                    ? {
                        ...staveProject.stave!,
                        primaryRepoPath: symlinksSupported ? unrelated : external,
                        repos: [
                          { name: "external", path: "../external", mode: "edit" as const },
                          { name: "primary", path: "primary", mode: "edit" as const },
                          { name: "secondary", path: "secondary", mode: "edit" as const },
                        ],
                      }
                    : null,
                } satisfies OrchestrationProject,
              ]),
        ];
        const pulled: string[] = [];
        const testLayer = VcsStatusBroadcaster.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(layerBackgroundPolicy(() => true)),
          Layer.provide(
            makePolicyLayer(
              {
                getActiveProjectByWorkspaceRoot: (cwd) =>
                  Effect.succeed(
                    Option.fromUndefinedOr(
                      projects.find((project) => project.workspaceRoot === cwd),
                    ),
                  ),
                getShellSnapshot: () => Effect.succeed(shellSnapshot(projects.map(toShell))),
              },
              ServerSettings.layerTest({ defaultAutoPull: true }),
            ),
          ),
          Layer.provide(
            Layer.mock(GitWorkflowService.GitWorkflowService)({
              localStatus: () =>
                Effect.succeed({ ...baseLocalStatus, isDefaultRef: true, refName: "main" }),
              remoteStatus: () => Effect.succeed({ ...baseRemoteStatus, behindCount: 1 }),
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              pullCurrentBranch: (cwd) =>
                Effect.sync(() => {
                  pulled.push(cwd);
                  return {
                    status: "pulled" as const,
                    refName: "main",
                    upstreamRef: "origin/main",
                  };
                }),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          for (const cwd of targets) {
            const status = yield* broadcaster.refreshStatus(cwd);
            assert.equal(status.behindCount, 1);
          }
          assert.deepStrictEqual(pulled, []);
          yield* broadcaster.refreshStatus(ordinary);
          yield* broadcaster.refreshStatus(unrelated);
          assert.deepStrictEqual(pulled, [
            yield* fs.realPath(ordinary),
            yield* fs.realPath(unrelated),
          ]);
        }).pipe(Effect.provide(testLayer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a behind Stave primary repo unchanged when status refreshes", () => {
    let remoteStatus: VcsStatusRemoteResult = { ...baseRemoteStatus, behindCount: 1 };
    let pullCalls = 0;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        makePolicyLayer({
          getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
          getShellSnapshot: () => Effect.succeed(shellSnapshot([toShell(staveProject)])),
        }),
      ),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.succeed({ ...baseLocalStatus, isDefaultRef: true, refName: "main" }),
          remoteStatus: () => Effect.succeed(remoteStatus),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
          pullCurrentBranch: () =>
            Effect.sync(() => {
              pullCalls += 1;
              remoteStatus = { ...remoteStatus, behindCount: 0 };
              return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const status = yield* broadcaster.refreshStatus(stavePrimaryRepo);
      assert.equal(pullCalls, 0);
      assert.equal(status.behindCount, 1);
    }).pipe(Effect.provide(testLayer));
  });
});
