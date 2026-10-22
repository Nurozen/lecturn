/**
 * Stave space locks, admission and the runtime fence against the real V2
 * orchestrator and project service: Stave operations hold a space while
 * thread commands in it are refused, unrelated commands advance, and runtime
 * starts drain or stay fenced through teardown and reconciliation.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@lecturn/contracts";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import {
  LecturnHookRejectedError,
  LecturnOrchestrationHooks,
} from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  LecturnOrchestrationHooksLayerLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { StaveLifecycleRepositoryLive } from "../persistence/Layers/StaveLifecycleRepository.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as StaveAdmission from "../stave/StaveAdmission.ts";
import { StaveCli } from "../stave/StaveCli.ts";
import { StaveConfigReader } from "../stave/StaveConfigReader.ts";
import * as StaveExecution from "../stave/StaveExecution.ts";
import { layerWith, StaveOperations } from "../stave/StaveOperations.ts";
import { StaveOrchestration, type StaveRuntimeSession } from "../stave/StaveOrchestration.ts";
import * as StaveOrchestrationHooks from "../stave/StaveOrchestrationHooks.ts";
import * as StaveOrchestrationLive from "../stave/StaveOrchestrationLive.ts";
import * as StaveProjectShells from "../stave/StaveProjectShells.ts";
import * as StaveRuntimeFence from "../stave/StaveRuntimeFence.ts";
import * as StaveSpaceLock from "../stave/StaveSpaceLock.ts";
import * as StaveWorkspaceReader from "../stave/StaveWorkspaceReader.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const now = "2026-09-01T00:00:00.000Z";
const NO_ENRICHMENT = {
  repositoryIdentity: null,
  repositoryIdentityResolved: true,
} as unknown as ProjectEnrichmentService.ProjectEnrichment;
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

/** The V2 orchestrator and project service with the shared hook registry. */
const OrchestrationLayer = Layer.mergeAll(
  OrchestrationV2LayerLive.pipe(Layer.provide(ProjectServiceLayerLive)),
  ProjectServiceLayerLive,
  ProjectStore.layer,
  ProjectionStore.layer,
).pipe(
  Layer.provideMerge(LecturnOrchestrationHooksLayerLive),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(Layer.mock(CheckpointStore.CheckpointStore)({})),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () => Effect.succeed(undefined),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees: () => Effect.void })),
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused"),
    }),
  ),
);

const configReaderFor = (root: string, agentWorkDir: string) =>
  Layer.succeed(StaveConfigReader, {
    load: Effect.succeed({
      configPath: `${root}/config.yaml`,
      exists: true,
      root,
      agentWorkDir,
      bareReposDir: `${root}/bare`,
      repos: [],
      source: "fs-fallback" as const,
    }),
    invalidate: Effect.void,
  });

/** Overrides the provider runtime half of StaveOrchestration with fakes. */
const withRuntimeSessions = (sessions: {
  readonly list: () => Effect.Effect<ReadonlyArray<StaveRuntimeSession>>;
  readonly stopUnder: (root: string) => Effect.Effect<void>;
}) =>
  Layer.effect(
    StaveOrchestration,
    Effect.map(StaveOrchestration, (service) => ({
      ...service,
      listSessions: sessions.list,
      stopSessionsUnder: sessions.stopUnder,
    })),
  ).pipe(Layer.provide(StaveOrchestrationLive.layer)) as typeof StaveOrchestrationLive.layer;

function makeStack(input: {
  readonly root: string;
  readonly agentWorkDir: string;
  readonly cli: Layer.Layer<StaveCli>;
  readonly terminals: Layer.Layer<TerminalManager>;
  readonly fence?: Layer.Layer<
    StaveRuntimeFence.StaveRuntimeFence,
    never,
    | StaveAdmission.StaveAdmission
    | StaveProjectShells.StaveProjectShells
    | FileSystem.FileSystem
    | Path.Path
  >;
  readonly orchestration?: typeof StaveOrchestrationLive.layer;
}) {
  const staveOrchestration = input.orchestration ?? StaveOrchestrationLive.layer;
  return Layer.mergeAll(layerWith({}), StaveOrchestrationHooks.layer).pipe(
    Layer.provideMerge(staveOrchestration),
    Layer.provideMerge(OrchestrationLayer),
    Layer.provideMerge(input.fence ?? StaveRuntimeFence.layerNoop),
    Layer.provideMerge(StaveProjectShells.layer),
    Layer.provideMerge(StaveAdmission.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectStore.layer,
        OrchestrationEventInfrastructureLayerLive,
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
          peek: () => Effect.succeed(NO_ENRICHMENT),
          getAvailable: () => Effect.succeed(NO_ENRICHMENT),
          invalidate: () => Effect.void,
        }),
        StaveSpaceLock.layer,
        StaveLifecycleRepositoryLive,
        StaveWorkspaceReader.layer.pipe(
          Layer.provide(
            Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
          ),
        ),
        AnalyticsService.layerTest,
        StaveExecution.layerNoop,
        configReaderFor(input.root, input.agentWorkDir),
        input.cli,
        input.terminals,
        Layer.mock(ProcessRunner)({}),
        WorkspacePaths.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(input.root, { prefix: "stave-lock-v2-" })),
  );
}

const createProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.flatMap(ProjectService.ProjectService, (projects) =>
    projects.create({
      commandId: CommandId.make(`create-${projectId}`),
      projectId,
      title: projectId,
      workspaceRoot,
    }),
  );

const createThread = (threadId: ThreadId, projectId: ProjectId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`create-${threadId}`),
      threadId,
      projectId,
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  );

const isHookRejection = Schema.is(LecturnHookRejectedError);
const hookRejection = (error: unknown): LecturnHookRejectedError | undefined => {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (isHookRejection(current)) return current;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
};

it.effect(
  "refuses a contended space command while operations refresh and unrelated commands advance",
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
      let mutationCalls = 0;
      const testLayer = makeStack({
        root,
        agentWorkDir,
        cli: Layer.mock(StaveCli)({
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
        terminals: Layer.mock(TerminalManager)({}),
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const operations = yield* StaveOperations;
        const lock = yield* StaveSpaceLock.StaveSpaceLock;
        const events = yield* OrchestrationEventStore;
        const hooks = yield* LecturnOrchestrationHooks;
        for (const [id, workspaceRoot, thread] of [
          [projectId, space, threadId],
          [ordinaryProjectId, unrelatedRoot, ordinaryThreadId],
        ] as const) {
          yield* createProject(id, workspaceRoot);
          yield* createThread(thread, id);
        }
        // Registered after Stave's contribution, so it runs inside its lock.
        let gateCommit = false;
        yield* hooks.register({
          name: "test-commit-gate",
          aroundCommand: (admission, commit) =>
            gateCommit &&
            admission.scope === "thread" &&
            admission.command.type === "thread.pin" &&
            admission.command.threadId === threadId
              ? Deferred.succeed(commitEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCommit)),
                  Effect.andThen(commit),
                )
              : commit,
        });
        const pin = (id: ThreadId, commandId: string) =>
          orchestrator.dispatch({
            type: "thread.pin",
            commandId: CommandId.make(commandId),
            threadId: id,
          });

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
        const refused = yield* pin(threadId, "refused-pin").pipe(Effect.flip);
        expect(hookRejection(refused)?.reason).toContain("Retry when it finishes");
        yield* pin(ordinaryThreadId, "unrelated-pin");
        expect((yield* orchestrator.getThreadShell(threadId))?.pinnedAt ?? null).toBeNull();
        expect((yield* orchestrator.getThreadShell(ordinaryThreadId))?.pinnedAt).not.toBeNull();
        expect(Option.isNone(yield* lock.tryWithSpaceLock(space, Effect.void))).toBe(true);
        yield* Deferred.succeed(releaseCli, undefined);
        const progress = yield* Fiber.join(mutation);
        expect(progress.at(-1)?.kind).toBe("finished");
        expect(mutationCalls).toBe(1);
        const persisted = yield* events
          .readApplicationEvents({
            afterSequence: 0,
            throughSequence: yield* events.latestApplicationSequence,
          })
          .pipe(Stream.runCollect);
        expect(
          persisted.filter(
            (event) =>
              "aggregateKind" in event &&
              event.type === "project.refreshed" &&
              event.aggregateId === projectId,
          ),
        ).toHaveLength(1);

        gateCommit = true;
        const accepted = yield* pin(threadId, "accepted-pin").pipe(Effect.forkChild);
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
        expect((yield* orchestrator.getThreadShell(threadId))?.pinnedAt).not.toBeNull();
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
      const sessions: StaveRuntimeSession[] = [];
      const stopped: ThreadId[] = [];
      const fence = Layer.effect(
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
      const testLayer = makeStack({
        root,
        agentWorkDir,
        fence,
        orchestration: withRuntimeSessions({
          list: () =>
            Effect.sync(() => {
              calls.push("enumerate");
              expect(sessions.map((session) => session.threadId)).toEqual([pendingThread]);
              return sessions.slice();
            }),
          stopUnder: (cwd) =>
            Effect.sync(() => {
              expect(cwd).toBe(space);
              calls.push("providers.stop");
              stopped.push(...sessions.map((session) => session.threadId));
              sessions.length = 0;
            }),
        }),
        cli: Layer.mock(StaveCli)({
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
        terminals: Layer.mock(TerminalManager)({
          closeSessionsUnder: () =>
            Effect.sync(() => {
              calls.push("terminals.stop");
            }),
        }),
      });
      yield* Effect.gen(function* () {
        const operations = yield* StaveOperations;
        const runtimeFence = yield* StaveRuntimeFence.StaveRuntimeFence;
        const lock = yield* StaveSpaceLock.StaveSpaceLock;
        yield* createProject(projectId, space);
        const pending = yield* runtimeFence
          .withStart(
            repo,
            Effect.gen(function* () {
              yield* Deferred.succeed(startEntered, undefined);
              yield* Deferred.await(releaseStart);
              sessions.push({
                providerSessionId: ProviderSessionId.make("pending-session"),
                threadId: pendingThread,
                cwd: repo,
                active: false,
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
        const refusedWhileDraining = yield* runtimeFence
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
          const refusal = yield* runtimeFence
            .withStart(cwd, Effect.die("must not start during teardown"))
            .pipe(Effect.flip);
          expect(refusal._tag).toBe("StaveRuntimeFenced");
        }
        expect(yield* runtimeFence.withStart(unrelated, Effect.succeed("unrelated started"))).toBe(
          "unrelated started",
        );
        yield* Deferred.succeed(releaseCli, undefined);
        yield* Deferred.await(reconciliationEntered);
        const admissionCount = checkedStarts.length;
        const refusedDuringReconciliation = yield* runtimeFence
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
        const after = yield* runtimeFence
          .withStart(space, Effect.die("archived admission must refuse"))
          .pipe(Effect.flip);
        expect(after.message).toContain("Unarchive");
        expect(checkedStarts).toHaveLength(admissionCount + 1);
        expect(yield* runtimeFence.withStart(unrelated, Effect.succeed("still available"))).toBe(
          "still available",
        );
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "restore fences archived source and live destination through rebuild and reconciliation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "stave-restore-fence-" });
      const root = yield* fs.realPath(temp);
      const agentWorkDir = path.join(root, "spaces");
      const live = path.join(agentWorkDir, "demo");
      const archive = path.join(agentWorkDir, ".archive", "demo");
      const alias = path.join(root, "live-alias");
      yield* fs.makeDirectory(path.join(archive, "repo"), { recursive: true });
      yield* fs.symlink(live, alias);
      yield* fs.writeFileString(
        path.join(archive, ".stave.yaml"),
        `id: demo\ncreatedAt: '${now}'\nrepos: []\nmemories: []\n`,
      );
      const projectId = ProjectId.make("restore-original");
      const rebuilding = yield* Deferred.make<void>();
      const finishRebuild = yield* Deferred.make<void>();
      const reconciling = yield* Deferred.make<void>();
      const finishReconcile = yield* Deferred.make<void>();
      const stopped: string[] = [];
      const testLayer = makeStack({
        root,
        agentWorkDir,
        fence: StaveRuntimeFence.layer,
        orchestration: withRuntimeSessions({
          list: () => Effect.succeed([]),
          stopUnder: (cwd) =>
            Effect.sync(() => {
              stopped.push(`provider:${cwd}`);
            }),
        }),
        cli: Layer.mock(StaveCli)({
          spaceRestore: () =>
            Effect.gen(function* () {
              expect(stopped).toEqual([
                `provider:${archive}`,
                `terminal:${archive}`,
                `provider:${live}`,
                `terminal:${live}`,
              ]);
              yield* fs.rename(archive, live).pipe(Effect.orDie);
              yield* Deferred.succeed(rebuilding, undefined);
              yield* Deferred.await(finishRebuild);
              return {
                spaceId: "demo",
                spacePath: live,
                manifest: { id: "demo", createdAt: now, repos: [], memories: [] },
                notes: [],
              };
            }),
          spaceList: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reconciling, undefined);
              yield* Deferred.await(finishReconcile);
              return input?.archived
                ? []
                : [
                    {
                      id: "demo",
                      path: live,
                      isSaga: false,
                      repos: [],
                      archived: false,
                      logicalId: "demo",
                      manifestCreatedAt: now,
                      manifestVersion: 1,
                      memories: [],
                    },
                  ];
            }),
        }),
        terminals: Layer.mock(TerminalManager)({
          closeSessionsUnder: (cwd) =>
            Effect.sync(() => {
              stopped.push(`terminal:${cwd}`);
            }),
        }),
      });
      yield* Effect.gen(function* () {
        const operations = yield* StaveOperations;
        const runtimeFence = yield* StaveRuntimeFence.StaveRuntimeFence;
        const locks = yield* StaveSpaceLock.StaveSpaceLock;
        const projects = yield* ProjectService.ProjectService;
        yield* createProject(projectId, archive);
        const restoring = yield* operations
          .run({
            operationId: "restore-both-roots",
            operation: {
              kind: "restoreSpace",
              workspaceRoot: archive,
              from: "demo",
              expectedManifestCreatedAt: now,
            },
          })
          .pipe(Stream.runCollect, Effect.forkChild);
        yield* Effect.raceFirst(
          Deferred.await(rebuilding),
          Fiber.join(restoring).pipe(
            Effect.flatMap((progress) =>
              Effect.die(`Restore ended before rebuilding: ${progress.at(-1)?.kind}`),
            ),
          ),
        );
        for (const [index, cwd] of [
          live,
          path.join(live, "repo"),
          path.join(alias, "repo"),
        ].entries()) {
          const admission = yield* createProject(ProjectId.make(`racing-${index}`), cwd).pipe(
            Effect.flip,
          );
          expect(hookRejection(admission)).toBeDefined();
          expect(
            (yield* runtimeFence
              .withStart(cwd, Effect.die("provider must not start during rebuild"))
              .pipe(Effect.flip))._tag,
          ).toBe("StaveRuntimeFenced");
        }
        for (const cwd of [archive, live])
          expect(Option.isNone(yield* locks.tryWithSpaceLock(cwd, Effect.void))).toBe(true);
        expect(yield* projects.listShells()).toHaveLength(1);
        yield* Deferred.succeed(finishRebuild, undefined);
        yield* Deferred.await(reconciling);
        expect(
          (yield* runtimeFence
            .withStart(live, Effect.die("provider must not start during reconciliation"))
            .pipe(Effect.flip))._tag,
        ).toBe("StaveRuntimeFenced");
        expect(Option.isNone(yield* locks.tryWithWorkspaceLocks([live], Effect.void))).toBe(true);
        yield* Deferred.succeed(finishReconcile, undefined);
        expect((yield* Fiber.join(restoring)).at(-1)?.kind).toBe("finished");
        expect(
          (yield* projects.listShells()).map((project) => [project.id, project.workspaceRoot]),
        ).toEqual([[projectId, live]]);
        expect(yield* runtimeFence.withStart(live, Effect.succeed("provider may start"))).toBe(
          "provider may start",
        );
        for (const cwd of [archive, live])
          expect(yield* locks.tryWithSpaceLock(cwd, Effect.succeed("released"))).toEqual(
            Option.some("released"),
          );
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
