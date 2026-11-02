// @effect-diagnostics nodeBuiltinImport:off - Fixture repos are built and inspected with synchronous git, outside the code under test.
/**
 * A real orchestrator (scripted adapters) over a Sqlite file in a temp Lecturn
 * home, with the Squire command allowlist registered, so lifecycle tests
 * prove every dispatch passes it. Building `serverLayer` again over the same
 * home is a restart.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SquireId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { makeScriptedAdapterV2 } from "../../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as LecturnOrchestrationHooks from "../../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import { planProjectCommand } from "../../orchestration-v2/ProjectCommands.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as SquireCommandHook from "../SquireCommandHook.ts";
import * as SquireContainers from "../SquireContainers.ts";
import * as SquireLifecycle from "../SquireLifecycle.ts";
import * as SquirePolicyLock from "../SquirePolicyLock.ts";
import * as SquireRepository from "../SquireRepository.ts";
import * as SquireRules from "../SquireRules.ts";
import * as SquireScope from "../SquireScope.ts";
import * as SquireService from "../SquireService.ts";
import * as SquireWorkspace from "../SquireWorkspace.ts";

export const scripted = ProviderInstanceId.make("scripted");
export const scriptedB = ProviderInstanceId.make("scripted-b");
export const codex = ProviderInstanceId.make("codex");
export const claude = ProviderInstanceId.make("claudeAgent");
export const cursor = ProviderInstanceId.make("cursor");
export const scriptedModel = { instanceId: scripted, model: "scripted" } satisfies ModelSelection;
export const scriptedBModel = { instanceId: scriptedB, model: "scripted" } satisfies ModelSelection;

export const instanceOf = (instanceId: ProviderInstanceId, driver: string) =>
  ({
    instanceId,
    driverKind: ProviderDriverKind.make(driver),
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({ models: [{ slug: "scripted", isDefault: true }] }),
    },
  }) as unknown as ProviderInstance;

export const ALL_INSTANCES: ReadonlyArray<ProviderInstance> = [
  instanceOf(scripted, "scripted"),
  instanceOf(scriptedB, "scripted"),
  instanceOf(codex, "codex"),
  instanceOf(claude, "claudeAgent"),
  instanceOf(cursor, "cursor"),
];

export interface HarnessOptions {
  readonly instances?: ReadonlyArray<ProviderInstance>;
  readonly defaultModelSelection?: ModelSelection | null;
  /** `LECTURN_TEST_PROVIDERS=1`, which makes the scripted driver a Squire provider (D44g). */
  readonly testProviders?: boolean;
  /** Pretends the host has Claude's managed-mcp.json. */
  readonly managedMcpConfig?: boolean;
  readonly staveSpaces?: ReadonlyArray<SquireContainers.SquireContainersTestSpace>;
}

// Orchestration only knows the scripted instances; the others exist to be refused.
const scriptedRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
  Effect.gen(function* () {
    return [
      yield* makeScriptedAdapterV2({ instanceId: scripted, environment: {} }),
      yield* makeScriptedAdapterV2({ instanceId: scriptedB, environment: {} }),
    ];
  }),
).pipe(
  Layer.provide(Layer.mergeAll(IdAllocator.layer, TestProviderHost.layer())),
  Layer.provide(NodeServices.layer),
);

export const serverLayer = (baseDir: string, options: HarnessOptions = {}) => {
  const config = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const dbPath = NodePath.join(baseDir, "userdata", "state.sqlite");
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const projections = ProjectionStore.layer.pipe(Layer.provide(database));
  const projectStore = ProjectStore.layer.pipe(Layer.provide(database));
  const repository = SquireRepository.layer.pipe(Layer.provide(database));
  const hooks = SquireCommandHook.layer.pipe(
    Layer.provideMerge(LecturnOrchestrationHooks.layer),
    Layer.provide(Layer.merge(projections, repository)),
  );
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "squire-lifecycle" },
    scriptedRegistry,
    { databaseLayer: database, runEffectWorker: false },
  ).pipe(Layer.provide(hooks));
  const workspace = SquireWorkspace.layer.pipe(
    Layer.provide(config),
    Layer.provide(VcsProcess.layer),
    Layer.provide(NodeServices.layer),
  );
  const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({ remove: () => Effect.void });
  const lifecycle = SquireLifecycle.layer.pipe(
    Layer.provide(
      Layer.mergeAll(orchestration, projections, projectStore, repository, workspace, secrets),
    ),
  );
  const policyLock = SquirePolicyLock.layer;
  const containers = SquireContainers.layerTest({ spaces: options.staveSpaces ?? [] });
  const scope = SquireScope.layer.pipe(
    Layer.provide(Layer.mergeAll(repository, projections, containers)),
  );
  const rules = SquireRules.layer.pipe(
    Layer.provide(
      Layer.mergeAll(repository, scope, policyLock, projections, projectStore, containers),
    ),
  );
  const instances = options.instances ?? ALL_INSTANCES;
  const registry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(instances.find((entry) => entry.instanceId === id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const fileSystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) =>
      options.managedMcpConfig === true
        ? FileSystem.FileSystem.of({
            ...fs,
            exists: (path) =>
              path.endsWith("managed-mcp.json") ? Effect.succeed(true) : fs.exists(path),
          })
        : fs,
    ),
  ).pipe(Layer.provide(NodeServices.layer));
  const service = SquireService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        lifecycle,
        repository,
        policyLock,
        scope,
        rules,
        registry,
        projections,
        projectStore,
        fileSystem,
        ServerSettings.layerTest({
          defaultModelSelection: options.defaultModelSelection ?? null,
        }),
        Layer.succeed(
          HostProcess.Environment,
          options.testProviders === false ? {} : { LECTURN_TEST_PROVIDERS: "1" },
        ),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(
    database,
    service,
    lifecycle,
    repository,
    orchestration,
    projections,
    projectStore,
    workspace,
    registry,
    rules,
  ).pipe(Layer.provideMerge(NodeServices.layer));
};

// Test repos commit with -c identity so no global Git config is read or written.
export const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Squire", "-c", "user.email=squire@example.test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

export const initRepo = (dir: string) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  git(dir, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
  NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "home\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "--quiet", "-m", "initial"]);
  return dir;
};

export const lecturnRefs = (cwd: string) =>
  git(cwd, ["for-each-ref", "--format=%(refname)", "refs/lecturn"]);

/** A temp root with a Lecturn home under it, removed when the scope closes. */
export const tempRoot = Effect.gen(function* () {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "squire-lifecycle-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );
  return { root, baseDir: NodePath.join(root, "home") };
});

export const seedProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`project:create:${projectId}`);
    const created = planProjectCommand({
      command: { type: "project.create", commandId, projectId, title: projectId, workspaceRoot },
      state: { project: undefined, workspaceOwner: undefined, appWorkspaceOwner: undefined },
      eventId: EventId.make(`event:${commandId}`),
      now,
    });
    yield* eventSink.commitProjectCommand({
      commandId,
      projectId,
      commandType: "project.create",
      acceptedAt: now,
      event: Result.getOrThrow(created),
    });
  });

export const deleteProject = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const project = Option.getOrThrow(yield* projects.get(projectId));
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`project:delete:${projectId}`);
    const deleted = planProjectCommand({
      command: { type: "project.delete", commandId, projectId },
      state: { project, workspaceOwner: undefined, appWorkspaceOwner: undefined },
      eventId: EventId.make(`event:${commandId}`),
      now,
    });
    yield* eventSink.commitProjectCommand({
      commandId,
      projectId,
      commandType: "project.delete",
      acceptedAt: now,
      event: Result.getOrThrow(deleted),
    });
  });

/** Every thread carrying this Squire's marker, live and archived. */
export const markedThreads = (squireId: SquireId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const snapshot = yield* projections.getShellSnapshot();
    const mine = (shell: OrchestrationV2ThreadShell) => shell.squire?.squireId === squireId;
    return {
      live: snapshot.threads.filter(mine),
      archived: snapshot.archivedThreads.filter(mine),
    };
  });

export const workspacePath = (baseDir: string, squireId: SquireId) =>
  NodePath.join(baseDir, "userdata", "squires", squireId, "workspace");

export const isOwnRepository = (dir: string) =>
  NodeFS.existsSync(NodePath.join(dir, ".git")) &&
  NodeFS.realpathSync(git(dir, ["rev-parse", "--show-toplevel"])) === NodeFS.realpathSync(dir);
