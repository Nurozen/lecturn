// @effect-diagnostics nodeBuiltinImport:off - The database directory is made synchronously before the layer builds.
/**
 * The server's Squire wiring (`layerSquire`, switch on or off) over a real
 * orchestrator with the scripted provider and the Squire command allowlist,
 * on a Sqlite file in a temp Lecturn home. Building it again over the same
 * home is a restart. Home-thread turns run the scripts set through
 * `SquireFakeScripts`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as HostProcess from "@lecturn/shared/HostProcess";
import {
  EventId,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  ProviderDriverKind,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as AppRuntimeState from "../../apps/AppRuntimeState.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import type * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  makeScriptedAdapterV2,
  ScriptedScriptSource,
} from "../../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as LecturnOrchestrationHooks from "../../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import { planProjectCommand } from "../../orchestration-v2/ProjectCommands.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import {
  STAVE_ADMISSION_WAIT,
  staveSpaceBusyRejection,
} from "../../stave/StaveOrchestrationHooks.ts";
import * as StaveSpaceLock from "../../stave/StaveSpaceLock.ts";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as RuntimePolicy from "../../orchestration-v2/RuntimePolicy.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import * as LayerSquire from "../layerSquire.ts";
import * as SquireCommandHook from "../SquireCommandHook.ts";
import * as SquireFakeScripts from "../SquireFakeScripts.ts";
import * as SquireRepository from "../SquireRepository.ts";
import { ALL_INSTANCES, scripted, scriptedModel } from "./lifecycleHarness.ts";

export interface Phase4Options {
  /** `LECTURN_SQUIRE`; on unless set. */
  readonly squireEnabled?: boolean;
  /** The summary model; absent, summaries keep their deterministic fields. */
  readonly generateSquireTurnSummary?: TextGeneration["Service"]["generateSquireTurnSummary"];
  /** Runs before a delivered Squire turn starts its script, so a test can hold the turn open. */
  readonly deliveryGate?: Effect.Effect<void>;
  /** The runtime's shared Scheduler, which the server provides to the Squire layer. */
  readonly scheduler?: Layer.Layer<Scheduler.Scheduler>;
  /** A real MCP session registry, so home turns reach the `/mcp` route a harness serves. */
  readonly mcpSessionRegistry?: Layer.Layer<McpSessionRegistry.McpSessionRegistry>;
  /** Adapters beside the scripted one, such as a live provider a Squire home runs on. */
  readonly extraAdapters?: Effect.Effect<
    ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>,
    never,
    McpProviderSessions.McpProviderSessions | ServerConfig.ServerConfig | Scope.Scope
  >;
  /** The default model an instance lists, in place of `scripted`. */
  readonly instanceModels?: Readonly<Record<string, string>>;
  /**
   * Wraps the real `ThreadManagementService`, so a test can hold or fail a
   * held action's `sendToThread` around its dispatch.
   */
  readonly wrapThreadManagement?: (
    real: ThreadManagement.ThreadManagementService["Service"],
  ) => Effect.Effect<ThreadManagement.ThreadManagementService["Service"]>;
  /** `threadForkingEnabled`; on unless set. */
  readonly threadForkingEnabled?: boolean;
  /**
   * The server's Stave space lock, with Stave's admission of a turn or new
   * thread: it waits up to `STAVE_ADMISSION_WAIT` for an operation holding its
   * project's space, then refuses. `onWaiting` runs when a command has to
   * queue, `onRefused` when the wait runs out.
   */
  readonly staveSpaceLock?: {
    readonly onWaiting?: Effect.Effect<void>;
    readonly onRefused?: Effect.Effect<void>;
  };
}

// Stave's thread admission (StaveOrchestrationHooks) without the manifest
// checks: only its shared, bounded wait for the space lock.
const layerStaveSpaceAdmission = (options: NonNullable<Phase4Options["staveSpaceLock"]>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* LecturnOrchestrationHooks.LecturnOrchestrationHooks;
      const locks = yield* StaveSpaceLock.StaveSpaceLock;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectOf = (command: OrchestrationV2ServerCommand) =>
        command.type === "thread.create"
          ? Effect.succeed<ProjectId | undefined>(command.projectId)
          : command.type === "message.dispatch"
            ? projections.getThreadShell(command.threadId).pipe(
                Effect.map((shell) => shell?.projectId),
                Effect.orDie,
              )
            : Effect.succeed(undefined);
      yield* hooks.register({
        name: "stave",
        aroundThreadLock: (command, dispatch) =>
          Effect.gen(function* () {
            const projectId = yield* projectOf(command);
            if (projectId === undefined) return yield* dispatch;
            const project = yield* projects.get(projectId).pipe(Effect.orDie);
            if (Option.isNone(project)) return yield* dispatch;
            const root = project.value.workspaceRoot;
            const now = yield* locks.withSharedSpaceLock(root, dispatch, Duration.zero);
            if (Option.isSome(now)) return now.value;
            // Timed here rather than by the lock, which resolves the root with
            // real I/O before its timer starts: this timer exists once
            // `onWaiting` runs, so a test's TestClock adjustment never races it.
            const granted = yield* Deferred.make<void>();
            const admitted = yield* locks
              .withSharedSpaceLock(
                root,
                Deferred.succeed(granted, undefined).pipe(Effect.andThen(dispatch)),
              )
              .pipe(Effect.map(Option.getOrThrow), Effect.forkChild);
            yield* options.onWaiting ?? Effect.void;
            const inTime = yield* Deferred.await(granted).pipe(
              Effect.timeoutOption(STAVE_ADMISSION_WAIT),
            );
            if (Option.isSome(inTime)) return yield* Fiber.join(admitted);
            yield* Fiber.interrupt(admitted);
            yield* options.onRefused ?? Effect.void;
            return yield* staveSpaceBusyRejection();
          }),
      });
    }),
  );

// The script source resolves once, when the adapter is made, so the registry
// shares the one `SquireFakeScripts` the test writes to.
const scriptedRegistry = (
  deliveryGate: Effect.Effect<void> | undefined,
  extraAdapters: Phase4Options["extraAdapters"],
) =>
  // Unwrapped, so a live adapter's resources live as long as the registry.
  Layer.unwrap(
    Effect.gen(function* () {
      const fakes = yield* SquireFakeScripts.SquireFakeScripts;
      const source = ScriptedScriptSource.of({
        scriptFor: (input) =>
          (deliveryGate !== undefined && input.message.notification?.source?.kind === "squire"
            ? deliveryGate
            : Effect.void
          ).pipe(Effect.andThen(fakes.scriptFor(input.threadId, input.message))),
      });
      return ProviderAdapterRegistry.layerFromAdapters([
        yield* makeScriptedAdapterV2({ instanceId: scripted, environment: {} }).pipe(
          Effect.provideService(ScriptedScriptSource, source),
        ),
        ...(extraAdapters === undefined ? [] : yield* extraAdapters),
      ]);
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(IdAllocator.layer, TestProviderHost.layer(), SquireFakeScripts.layer),
    ),
    Layer.provide(NodeServices.layer),
  );

// Run summaries pick the thread's provider as the summary model when it can
// summarize; the call itself goes through the `TextGeneration` mock.
const instancesLayer = (models: Readonly<Record<string, string>>) => {
  const summarizing = ALL_INSTANCES.map((instance) => {
    const model = models[instance.instanceId];
    return {
      ...instance,
      ...(model === undefined
        ? {}
        : {
            snapshot: {
              getSnapshot: Effect.succeed({ models: [{ slug: model, isDefault: true }] }),
            },
          }),
      textGeneration: { generateSquireTurnSummary: () => Effect.die("use TextGeneration") },
    };
  }) as unknown as ReadonlyArray<ProviderInstance>;
  return Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(summarizing.find((entry) => entry.instanceId === id)),
    listInstances: Effect.succeed(summarizing),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
};

// Fixture projects commit the project command the real service would; Stave shells are none.
const projectService = Layer.unwrap(
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    return Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeedNone,
      // Thread launches resolve the projected project, so a seeded project is the real one.
      getById: (id) =>
        projects.get(id).pipe(
          Effect.orDie,
          Effect.map(
            Option.map((row) => ({
              id: row.projectId,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: row.defaultModelSelection,
              defaultThreadEnvMode: row.defaultThreadEnvMode,
              autoPull: row.autoPull,
              projectIcon: row.projectIcon,
              scripts: row.scripts,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            })),
          ),
        ),
      create: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const planned = planProjectCommand({
            command: {
              type: "project.create",
              commandId: input.commandId,
              projectId: input.projectId,
              title: input.title,
              workspaceRoot: input.workspaceRoot,
            },
            state: { project: undefined, workspaceOwner: undefined, appWorkspaceOwner: undefined },
            eventId: EventId.make(`event:${input.commandId}`),
            now,
          });
          yield* eventSink.commitProjectCommand({
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: "project.create",
            acceptedAt: now,
            event: Result.getOrThrow(planned),
          });
          const row = Option.getOrThrow(yield* projects.get(input.projectId));
          return {
            id: row.projectId,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          };
        }).pipe(Effect.orDie),
    });
  }),
);

// A host power monitor with nothing to report, so the policy sees no host signal.
const hostPowerUnknown = Layer.effect(
  HostPowerMonitor.HostPowerMonitor,
  Effect.map(DateTime.now, (updatedAt) =>
    HostPowerMonitor.HostPowerMonitor.of({
      snapshot: Effect.succeed({
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt,
      }),
      report: () => Effect.void,
      streamChanges: Stream.never,
    }),
  ),
);

export const phase4Layer = (baseDir: string, options: Phase4Options = {}) => {
  const squireEnabled = options.squireEnabled ?? true;
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (current) => ({
      ...current,
      squireEnabled,
      threadForkingEnabled: options.threadForkingEnabled ?? current.threadForkingEnabled,
    })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  const dbPath = NodePath.join(baseDir, "userdata", "state.sqlite");
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  // `SquireRepository.layer` is the instance the server shares (memoized),
  // so the hook, the tests, and the Squire services see one change stream.
  const stores = Layer.mergeAll(
    ProjectionStore.layer,
    ProjectStore.layer,
    RuntimeLayer.layerEventInfrastructure,
    SquireRepository.layer,
  );
  const instances = instancesLayer(options.instanceModels ?? {});
  const hooks = (
    options.staveSpaceLock
      ? Layer.merge(SquireCommandHook.layer, layerStaveSpaceAdmission(options.staveSpaceLock))
      : SquireCommandHook.layer
  ).pipe(Layer.provideMerge(LecturnOrchestrationHooks.layer));
  // Merged below, so a test can register a contribution beside the server's.
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "squire-phase4" },
    scriptedRegistry(options.deliveryGate, options.extraAdapters).pipe(
      Layer.provide(config),
      Layer.provide(NodeServices.layer),
    ),
    {
      databaseLayer: database,
      runEffectWorker: false,
      ...(options.mcpSessionRegistry === undefined
        ? {}
        : { mcpSessionRegistry: options.mcpSessionRegistry }),
      // A live provider reads the Squire deny runtime from the server's policy.
      ...(options.extraAdapters === undefined
        ? {}
        : {
            runtimePolicy: RuntimePolicy.layerFromProjectStore.pipe(
              Layer.provide(Layer.merge(ProjectStore.layer, instances)),
              Layer.provide(database),
              Layer.orDie,
            ),
          }),
    },
  ).pipe(Layer.provideMerge(hooks));
  const settings = ServerSettings.layerTest({
    defaultModelSelection: scriptedModel,
    // Thread management refuses dispatches to an instance the settings do not enable.
    providerInstances: {
      [scripted]: { driver: ProviderDriverKind.make("scripted"), enabled: true },
    },
  });
  // One BackgroundPolicy, below the orchestration and Squire layers that read
  // it, over the harness settings and a host that reports nothing.
  const background = BackgroundPolicy.layer.pipe(Layer.provide(hostPowerUnknown));
  const runtime = Layer.mergeAll(
    instances,
    Layer.mock(TextGeneration)({
      // A launched thread's title; the thread keeps its given title.
      generateThreadTitle: () => Effect.succeed({ title: "Generated" }),
      ...(options.generateSquireTurnSummary === undefined
        ? {}
        : { generateSquireTurnSummary: options.generateSquireTurnSummary }),
    }),
    // Run summaries diff the checkpoints the scripted turns capture.
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
      Layer.provide(VcsProcess.layer),
    ),
    Layer.mock(ServerSecretStore.ServerSecretStore)({ remove: () => Effect.void }),
    Layer.succeed(HostProcess.Environment, { LECTURN_TEST_PROVIDERS: "1" }),
    options.scheduler ?? Scheduler.layer,
  );
  // Held actions and accepts dispatch through the real thread services.
  const receipts = CommandReceiptStore.layerFromApplicationReceipts;
  const realThreads = ThreadManagement.layer.pipe(Layer.provide(receipts));
  const wrap = options.wrapThreadManagement;
  const threads =
    wrap === undefined
      ? realThreads
      : Layer.effect(
          ThreadManagement.ThreadManagementService,
          Effect.flatMap(ThreadManagement.ThreadManagementService, wrap),
        ).pipe(Layer.provide(realThreads));
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorktreeSetupTracker.layer,
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
        ProviderRegistryMock.layer(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          folderForThread: () => Effect.succeed(Option.none()),
        }),
        receipts,
        IdAllocator.layer,
      ),
    ),
    Layer.provideMerge(threads),
  );
  return Layer.mergeAll(LayerSquire.layer, LayerSquire.layerDatabaseStorage).pipe(
    Layer.provideMerge(launch),
    Layer.provideMerge(projectService),
    Layer.provideMerge(Layer.mergeAll(orchestration, runtime, SquireFakeScripts.layer)),
    Layer.provideMerge(background),
    // The server's runtime layer provides it; the showcase route publishes into it.
    Layer.provideMerge(AppRuntimeState.layer),
    Layer.provideMerge(settings),
    Layer.provideMerge(stores),
    // The server provides it beside the Squire layer; only `staveSpaceLock` admits through it.
    Layer.provideMerge(StaveSpaceLock.layer),
    Layer.provideMerge(config),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );
};

export type Phase4Services = Layer.Success<ReturnType<typeof phase4Layer>>;
