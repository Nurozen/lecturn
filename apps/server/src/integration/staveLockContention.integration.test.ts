import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Stream } from "effect";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { StaveLifecycleRepositoryLive } from "../persistence/Layers/StaveLifecycleRepository.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProcessRunner } from "../processRunner.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as StaveAdmission from "../stave/StaveAdmission.ts";
import { StaveCli } from "../stave/StaveCli.ts";
import { StaveConfigReader } from "../stave/StaveConfigReader.ts";
import * as StaveExecution from "../stave/StaveExecution.ts";
import { layerWith, StaveOperations } from "../stave/StaveOperations.ts";
import * as StaveRuntimeFence from "../stave/StaveRuntimeFence.ts";
import * as StaveSpaceLock from "../stave/StaveSpaceLock.ts";
import * as StaveWorkspaceReader from "../stave/StaveWorkspaceReader.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const now = "2026-09-01T00:00:00.000Z";

function makeEngineLayer(
  root: string,
  pipeline: Layer.Layer<
    OrchestrationProjectionPipeline,
    Layer.Error<typeof OrchestrationProjectionPipelineLive>,
    Layer.Services<typeof OrchestrationProjectionPipelineLive>
  > = OrchestrationProjectionPipelineLive,
) {
  return OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(pipeline),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(StaveAdmission.layer),
    Layer.provideMerge(StaveSpaceLock.layer),
    Layer.provideMerge(StaveLifecycleRepositoryLive),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(StaveWorkspaceReader.layer),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    ),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "stave-lock-engine-" })),
  );
}

it.effect(
  "refuses a contended rename while operations refresh and unrelated commands advance",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "stave-lock-contention-" });
      const root = yield* fs.realPath(temp);
      const agentWorkDir = path.join(root, "spaces");
      const space = path.join(agentWorkDir, "demo");
      const unrelatedRoot = path.join(root, "ordinary");
      yield* fs.makeDirectory(space, { recursive: true });
      yield* fs.makeDirectory(unrelatedRoot);
      yield* fs.writeFileString(
        path.join(space, ".stave.yaml"),
        `id: demo\ncreatedAt: '${now}'\nrepos: []\nmemories: []\n`,
      );
      const cliEntered = yield* Deferred.make<void>();
      const releaseCli = yield* Deferred.make<void>();
      const commitEntered = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const projectId = ProjectId.make("stave-project");
      const threadId = ThreadId.make("stave-thread");
      const ordinaryProjectId = ProjectId.make("ordinary-project");
      const ordinaryThreadId = ThreadId.make("ordinary-thread");
      let gateCommit = false;
      let mutationCalls = 0;
      const pipeline = Layer.effect(
        OrchestrationProjectionPipeline,
        Effect.map(OrchestrationProjectionPipeline, (service) => ({
          ...service,
          projectEventDeferred: (event) =>
            Effect.gen(function* () {
              if (
                gateCommit &&
                event.type === "thread.meta-updated" &&
                event.aggregateId === threadId
              ) {
                yield* Deferred.succeed(commitEntered, undefined);
                yield* Deferred.await(releaseCommit);
              }
              return yield* service.projectEventDeferred(event);
            }),
        })),
      ).pipe(Layer.provide(OrchestrationProjectionPipelineLive));
      const core = makeEngineLayer(root, pipeline);
      const testLayer = layerWith({}).pipe(
        Layer.provideMerge(core),
        Layer.provide(
          Layer.mergeAll(
            AnalyticsService.layerTest,
            StaveExecution.layerNoop,
            StaveRuntimeFence.layerNoop,
            Layer.mock(StaveCli)({
              spaceRetarget: () =>
                Effect.gen(function* () {
                  mutationCalls += 1;
                  yield* Deferred.succeed(cliEntered, undefined);
                  yield* Deferred.await(releaseCli);
                  return {
                    spaceId: "demo",
                    spacePath: space,
                    manifest: { id: "demo", createdAt: now, repos: [], memories: [] },
                    notes: [],
                  };
                }),
            }),
            Layer.succeed(StaveConfigReader, {
              load: Effect.succeed({
                configPath: path.join(root, "config.yaml"),
                exists: true,
                root,
                agentWorkDir,
                bareReposDir: path.join(root, "bare"),
                repos: [],
                source: "fs-fallback" as const,
              }),
              invalidate: Effect.void,
            }),
            Layer.mock(ProcessRunner)({}),
            Layer.mock(ProviderService)({}),
            Layer.mock(TerminalManager)({}),
            WorkspacePaths.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const operations = yield* StaveOperations;
        const lock = yield* StaveSpaceLock.StaveSpaceLock;
        const snapshots = yield* ProjectionSnapshotQuery;
        const events = yield* OrchestrationEventStore;
        for (const [id, workspaceRoot, thread] of [
          [projectId, space, threadId],
          [ordinaryProjectId, unrelatedRoot, ordinaryThreadId],
        ] as const) {
          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`create-${id}`),
            projectId: id,
            title: id,
            workspaceRoot,
            createdAt: now,
          });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${thread}`),
            projectId: id,
            threadId: thread,
            title: "Original",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          });
        }
        const mutation = yield* operations
          .run({
            operationId: "retarget-held-root",
            operation: {
              kind: "retarget",
              workspaceRoot: space,
              expectedManifestCreatedAt: now,
              repo: "api",
              base: "main",
            },
          })
          .pipe(Stream.runCollect, Effect.forkChild);
        yield* Deferred.await(cliEntered);
        const refused = yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("refused-rename"),
            threadId,
            title: "Blocked",
          })
          .pipe(Effect.flip);
        expect(refused._tag).toBe("OrchestrationCommandInvariantError");
        expect(refused.message).toContain("Retry when it finishes");
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("unrelated-rename"),
          threadId: ordinaryThreadId,
          title: "Advanced",
        });
        const during = yield* snapshots.getSnapshot();
        expect(during.threads.find((thread) => thread.id === threadId)?.title).toBe("Original");
        expect(during.threads.find((thread) => thread.id === ordinaryThreadId)?.title).toBe(
          "Advanced",
        );
        expect(Option.isNone(yield* lock.tryWithSpaceLock(space, Effect.void))).toBe(true);
        yield* Deferred.succeed(releaseCli, undefined);
        const progress = yield* Fiber.join(mutation);
        expect(progress.at(-1)?.kind).toBe("finished");
        expect(mutationCalls).toBe(1);
        const persisted = yield* events.readAll().pipe(Stream.runCollect);
        expect(
          persisted.filter(
            (event) => event.type === "project.refreshed" && event.aggregateId === projectId,
          ),
        ).toHaveLength(1);

        gateCommit = true;
        const accepted = yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("accepted-rename"),
            threadId,
            title: "After operation",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(commitEntered);
        expect(
          Option.isNone(
            yield* lock.tryWithSpaceLock(space, Effect.die("must not run during commit")),
          ),
        ).toBe(true);
        yield* Deferred.succeed(releaseCommit, undefined);
        yield* Fiber.join(accepted);
        expect(yield* lock.tryWithSpaceLock(space, Effect.succeed("available"))).toEqual(
          Option.some("available"),
        );
        expect(
          (yield* snapshots.getSnapshot()).threads.find((thread) => thread.id === threadId)?.title,
        ).toBe("After operation");
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "drains admitted runtime starts before lifecycle quiescence and fences through reconciliation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "stave-runtime-lifecycle-" });
      const root = yield* fs.realPath(temp);
      const agentWorkDir = path.join(root, "spaces");
      const space = path.join(agentWorkDir, "demo");
      const repo = path.join(space, "repo");
      const archive = path.join(agentWorkDir, ".archive", "demo");
      const alias = path.join(root, "alias");
      const unrelated = path.join(root, "unrelated");
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* fs.makeDirectory(path.dirname(archive));
      yield* fs.makeDirectory(unrelated);
      yield* fs.symlink(space, alias);
      yield* fs.writeFileString(
        path.join(space, ".stave.yaml"),
        `id: demo\ncreatedAt: '${now}'\nrepos: []\nmemories: []\n`,
      );
      const projectId = ProjectId.make("runtime-lifecycle-project");
      const pendingThread = ThreadId.make("pending-runtime-thread");
      const startEntered = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const fenceEntered = yield* Deferred.make<number>();
      const cliEntered = yield* Deferred.make<void>();
      const releaseCli = yield* Deferred.make<void>();
      const reconciliationEntered = yield* Deferred.make<void>();
      const releaseReconciliation = yield* Deferred.make<void>();
      const calls: string[] = [];
      const checkedStarts: string[] = [];
      const sessions: ProviderSession[] = [];
      const stopped: ThreadId[] = [];
      const runtimeLayer = Layer.effect(
        StaveRuntimeFence.StaveRuntimeFence,
        Effect.gen(function* () {
          const admission = yield* StaveAdmission.StaveAdmission;
          return yield* StaveRuntimeFence.makeWithOptions({
            onFenceEntered: (_root, pendingCount) =>
              Deferred.succeed(fenceEntered, pendingCount).pipe(Effect.asVoid),
            checkStart: (cwd) =>
              Effect.sync(() => {
                checkedStarts.push(cwd);
              }).pipe(
                Effect.andThen(
                  admission.check({
                    projectRoot: cwd === unrelated ? unrelated : space,
                    ...(cwd === unrelated ? {} : { projectId }),
                    intent: "thread.turn.start",
                    lockHeld: true,
                  }),
                ),
                Effect.mapError(
                  (error) => new StaveRuntimeFence.StaveRuntimeFenced({ message: error.message }),
                ),
              ),
          });
        }),
      );
      const testLayer = layerWith({}).pipe(
        Layer.provideMerge(runtimeLayer),
        Layer.provideMerge(makeEngineLayer(root)),
        Layer.provide(
          Layer.mergeAll(
            AnalyticsService.layerTest,
            StaveExecution.layerNoop,
            Layer.succeed(StaveConfigReader, {
              load: Effect.succeed({
                configPath: path.join(root, "config.yaml"),
                exists: true,
                root,
                agentWorkDir,
                bareReposDir: path.join(root, "bare"),
                repos: [],
                source: "fs-fallback" as const,
              }),
              invalidate: Effect.void,
            }),
            Layer.mock(StaveCli)({
              spaceArchive: () =>
                Effect.gen(function* () {
                  calls.push("archive");
                  yield* Deferred.succeed(cliEntered, undefined);
                  yield* Deferred.await(releaseCli);
                  yield* fs.rename(space, archive).pipe(Effect.orDie);
                  return { spaceId: "demo", archivedPath: archive, memory: "keep", notes: [] };
                }),
              spaceList: (input) =>
                Effect.gen(function* () {
                  calls.push("reconcile");
                  yield* Deferred.succeed(reconciliationEntered, undefined);
                  yield* Deferred.await(releaseReconciliation);
                  return input?.archived
                    ? [
                        {
                          id: "demo",
                          path: archive,
                          isSaga: false,
                          repos: [],
                          archived: true,
                          logicalId: "demo",
                          archiveBasename: "demo",
                          manifestCreatedAt: now,
                          manifestVersion: 1,
                          memories: [],
                        },
                      ]
                    : [];
                }),
            }),
            Layer.mock(ProcessRunner)({}),
            Layer.mock(ProviderService)({
              listSessions: () =>
                Effect.sync(() => {
                  calls.push("enumerate");
                  expect(sessions.map((session) => session.threadId)).toEqual([pendingThread]);
                  return sessions.slice();
                }),
              stopSessionsUnder: (cwd) =>
                Effect.sync(() => {
                  expect(cwd).toBe(space);
                  calls.push("providers.stop");
                  stopped.push(...sessions.map((session) => session.threadId));
                  sessions.length = 0;
                }),
            }),
            Layer.mock(TerminalManager)({
              closeSessionsUnder: () =>
                Effect.sync(() => {
                  calls.push("terminals.stop");
                }),
            }),
            WorkspacePaths.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const operations = yield* StaveOperations;
        const fence = yield* StaveRuntimeFence.StaveRuntimeFence;
        const lock = yield* StaveSpaceLock.StaveSpaceLock;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("runtime-project-create"),
          projectId,
          title: "Runtime lifecycle",
          workspaceRoot: space,
          createdAt: now,
        });
        const pending = yield* fence
          .withStart(
            repo,
            Effect.gen(function* () {
              yield* Deferred.succeed(startEntered, undefined);
              yield* Deferred.await(releaseStart);
              sessions.push({
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                threadId: pendingThread,
                cwd: repo,
                status: "ready",
                runtimeMode: "full-access",
                createdAt: now,
                updatedAt: now,
              });
              calls.push("start.complete");
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(startEntered);
        const archiveOperation = yield* operations
          .run({
            operationId: "archive-with-pending-start",
            operation: {
              kind: "archiveSpace",
              workspaceRoot: space,
              expectedManifestCreatedAt: now,
              force: false,
              memory: "keep",
            },
          })
          .pipe(Stream.runCollect, Effect.forkChild);
        expect(yield* Deferred.await(fenceEntered)).toBe(1);
        expect(calls).toEqual([]);
        expect(
          yield* lock.tryWithSpaceLock(space, Effect.succeed("not held while draining")),
        ).toEqual(Option.some("not held while draining"));
        const refusedWhileDraining = yield* fence
          .withStart(repo, Effect.die("must not start while draining"))
          .pipe(Effect.flip);
        expect(refusedWhileDraining._tag).toBe("StaveRuntimeFenced");
        yield* Deferred.succeed(releaseStart, undefined);
        yield* Fiber.join(pending);
        yield* Deferred.await(cliEntered);
        expect(calls).toEqual([
          "start.complete",
          "enumerate",
          "providers.stop",
          "terminals.stop",
          "archive",
        ]);
        expect(stopped).toEqual([pendingThread]);
        expect(Option.isNone(yield* lock.tryWithSpaceLock(space, Effect.void))).toBe(true);
        for (const cwd of [repo, path.join(alias, "repo")]) {
          const refusal = yield* fence
            .withStart(cwd, Effect.die("must not start during teardown"))
            .pipe(Effect.flip);
          expect(refusal._tag).toBe("StaveRuntimeFenced");
        }
        expect(yield* fence.withStart(unrelated, Effect.succeed("unrelated started"))).toBe(
          "unrelated started",
        );
        yield* Deferred.succeed(releaseCli, undefined);
        yield* Deferred.await(reconciliationEntered);
        const admissionCount = checkedStarts.length;
        const refusedDuringReconciliation = yield* fence
          .withStart(space, Effect.die("must not start during reconciliation"))
          .pipe(Effect.flip);
        expect(refusedDuringReconciliation.message).toContain("transitioning");
        expect(checkedStarts).toHaveLength(admissionCount);
        expect(Option.isNone(yield* lock.tryWithSpaceLock(space, Effect.void))).toBe(true);
        yield* Deferred.succeed(releaseReconciliation, undefined);
        const progress = yield* Fiber.join(archiveOperation);
        expect(progress.at(-1)?.kind).toBe("finished");
        expect(yield* lock.tryWithSpaceLock(space, Effect.succeed("released"))).toEqual(
          Option.some("released"),
        );
        const after = yield* fence
          .withStart(space, Effect.die("archived admission must refuse"))
          .pipe(Effect.flip);
        expect(after.message).toContain("Unarchive");
        expect(checkedStarts).toHaveLength(admissionCount + 1);
        expect(yield* fence.withStart(unrelated, Effect.succeed("still available"))).toBe(
          "still available",
        );
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
