import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SquireCardId,
  ThreadId,
} from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeScriptedAdapterV2 } from "../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SquireLaunchAction from "./SquireLaunchAction.ts";
import { isFixtureOwnedThread } from "./SquireReactor.ts";
import {
  ALL_INSTANCES,
  codex,
  scripted,
  scriptedModel,
  seedProject,
} from "./testkit/lifecycleHarness.ts";

const projectId = ProjectId.make("project:squire-launch");
const fixtureProjectId = ProjectId.make("project-fixture-launch");
const cardId = SquireCardId.make("card:launch");

const proposal = (overrides: Partial<SquireLaunchAction.SquireThreadProposal> = {}) =>
  ({
    type: "thread-proposal",
    projectId,
    provider: ProviderDriverKind.make("scripted"),
    providerInstanceId: scripted,
    model: "scripted",
    firstPrompt: "Fix the flaky billing test\nIt fails on CI only.",
    ...overrides,
  }) satisfies SquireLaunchAction.SquireThreadProposal;

const intentOf = (overrides: Partial<SquireLaunchAction.SquireLaunchIntentInput> = {}) =>
  Result.getOrThrow(
    SquireLaunchAction.launchIntentFor({
      card: { id: cardId },
      proposal: proposal(),
      text: proposal().firstPrompt,
      verb: "execute",
      attempt: 1,
      senderThreadId: null,
      modes: { runtimeMode: "approval-required", interactionMode: "default" },
      fixtureOwned: null,
      ...overrides,
    }),
  );

/** Records every call a real (non-scripted) provider would receive. */
const makeHarness = () => {
  const providerCalls: Array<string> = [];
  const titleCalls: Array<unknown> = [];
  const codexAdapter = {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => {
      providerCalls.push("getCapabilities");
      return Effect.succeed(CodexProviderCapabilitiesV2);
    },
    planSelectionTransition: () => {
      providerCalls.push("planSelectionTransition");
      return Effect.succeed({ type: "apply_on_next_turn" as const });
    },
    openSession: () => {
      providerCalls.push("openSession");
      return Effect.die("a fixture launch reached a real provider");
    },
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      return [
        yield* makeScriptedAdapterV2({ instanceId: scripted, environment: {} }),
        codexAdapter,
      ];
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(IdAllocator.layer, TestProviderHost.layer())),
    Layer.provide(NodeServices.layer),
  );
  const database = SqlitePersistence.layerMemory;
  const orchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "squire-launch" },
    registry,
    {
      databaseLayer: database,
      runEffectWorker: false,
    },
  );
  // The scripted driver is no default instance, so only settings enable it.
  const settings = ServerSettings.layerTest({
    defaultModelSelection: scriptedModel,
    providerInstances: {
      [scripted]: { driver: ProviderDriverKind.make("scripted"), enabled: true },
    },
  });
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const threads = ThreadManagement.layer.pipe(
    Layer.provide(orchestrator),
    Layer.provide(settings),
    Layer.provide(receipts),
  );
  const stores = Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer).pipe(
    Layer.provide(database),
  );
  // Projects resolve from the projected store, so a seeded project is the real one.
  const projectService = Layer.unwrap(
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      return Layer.mock(ProjectService.ProjectService)({
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
      });
    }),
  ).pipe(Layer.provide(stores));
  const external = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    projectService,
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: (input) => {
        titleCalls.push(input);
        return Effect.succeed({ title: "Generated" });
      },
    }),
    settings,
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(external, threads, receipts, IdAllocator.layer)),
  );
  const instances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(ALL_INSTANCES.find((entry) => entry.instanceId === id)),
    listInstances: Effect.succeed(ALL_INSTANCES),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "squire-launch-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const services = Layer.mergeAll(launch, threads, receipts, stores, settings, instances, config);
  return {
    layer: SquireLaunchAction.layer.pipe(
      Layer.provideMerge(services),
      Layer.provideMerge(orchestrator),
      Layer.provideMerge(database),
    ),
    providerCalls,
    titleCalls,
  };
};

const withProject = (id: ProjectId, workspaceRoot: string) =>
  seedProject(id, workspaceRoot).pipe(Effect.orDie);

/** What `launch` committed before a crash that lost the initial message. */
const createOnly = (intent: SquireLaunchAction.SquireLaunchIntent) =>
  Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
    threads.dispatch({
      type: "thread.create",
      commandId: intent.commandId,
      threadId: intent.threadId,
      projectId: intent.projectId,
      title: intent.title,
      modelSelection: intent.modelSelection,
      runtimeMode: intent.runtimeMode,
      interactionMode: intent.interactionMode,
      branch: null,
      worktreePath: null,
      createdBy: intent.createdBy,
      creationSource: "server",
    }),
  );

const projectThreads = (id: ProjectId) =>
  Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
    threads.getShellSnapshot(),
  ).pipe(Effect.map((snapshot) => snapshot.threads.filter((thread) => thread.projectId === id)));

it("derives the same ids for the same card, attempt, and verb", () => {
  const first = intentOf();
  assert.deepEqual(intentOf(), first);
  assert.equal(first.commandId, `server:squire:execute:${cardId}:1`);
  assert.equal(first.title, "Fix the flaky billing test");
  assert.equal(first.createdBy, "agent");
  const retry = intentOf({ attempt: 2, verb: "accept" });
  assert.notEqual(retry.threadId, first.threadId);
  assert.notEqual(retry.messageId, first.messageId);
  assert.equal(retry.createdBy, "user");
});

it.effect("re-launches a thread whose initial message a crash lost, once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const action = yield* SquireLaunchAction.SquireLaunchAction;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* withProject(projectId, "/repo/launch");
    const intent = intentOf();
    yield* createOnly(intent);

    assert.deepEqual(yield* action.receipts(intent), {
      create: { status: "accepted" },
      message: { status: "absent" },
    });
    yield* action.launch(intent);

    assert.deepEqual(yield* action.receipts(intent), {
      create: { status: "accepted" },
      message: { status: "accepted" },
    });
    const projection = yield* threads.getThreadProjection(intent.threadId);
    assert.deepEqual(
      projection.messages.map((message) => message.id),
      [intent.messageId],
    );
    assert.equal(projection.runs.length, 1);
    assert.equal((yield* projectThreads(projectId)).length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports both receipts after a launch and a retry keeps one thread", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const action = yield* SquireLaunchAction.SquireLaunchAction;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* withProject(projectId, "/repo/launch");
    const intent = intentOf();
    assert.deepEqual(yield* action.receipts(intent), {
      create: { status: "absent" },
      message: { status: "absent" },
    });

    yield* action.launch(intent);
    assert.deepEqual(yield* action.receipts(intent), {
      create: { status: "accepted" },
      message: { status: "accepted" },
    });

    yield* action.launch(intent);
    const projection = yield* threads.getThreadProjection(intent.threadId);
    assert.equal(projection.messages.length, 1);
    assert.equal(projection.runs.length, 1);
    assert.equal((yield* projectThreads(projectId)).length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "refuses a partial launch once the provider is disabled and archives the empty thread",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const action = yield* SquireLaunchAction.SquireLaunchAction;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* withProject(projectId, "/repo/launch");
      const intent = intentOf();
      yield* createOnly(intent);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [scripted]: { enabled: false } } },
        },
      });

      const refused = yield* action.launch(intent).pipe(Effect.flip);
      if (refused._tag !== "SquireLaunchRefused")
        assert.fail(`expected a refusal, got ${refused._tag}`);
      assert.include(refused.reason, scripted);
      assert.deepEqual((yield* action.receipts(intent)).message, { status: "absent" });

      yield* action.archiveEmpty(intent);
      const shell = yield* threads.getThreadShell(intent.threadId);
      assert.isNotNull(shell?.archivedAt ?? null);
      assert.equal(yield* threads.getMessageCount(intent.threadId), 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("refuses a launch into a project that is gone without creating a thread", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const action = yield* SquireLaunchAction.SquireLaunchAction;
    const intent = intentOf({ proposal: proposal({ projectId: ProjectId.make("project:gone") }) });
    const refused = yield* action.launch(intent).pipe(Effect.flip);
    assert.equal(refused._tag, "SquireLaunchRefused");
    assert.deepEqual(yield* action.receipts(intent), {
      create: { status: "absent" },
      message: { status: "absent" },
    });
    yield* action.archiveEmpty(intent);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "launches a fixture Squire's proposal on the scripted instance as a fixture thread",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const action = yield* SquireLaunchAction.SquireLaunchAction;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const config = yield* ServerConfig.ServerConfig;
      yield* withProject(fixtureProjectId, `${config.baseDir}/squire-fixtures/billing`);
      yield* withProject(projectId, "/repo/launch");
      const home = ThreadId.make("thread:fixture-home");
      const codexProposal = proposal({
        projectId: fixtureProjectId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codex,
        model: "gpt-5.1-codex",
      });

      // A real Squire's proposal keeps the provider it names.
      const real = yield* action.intentFor({
        card: { id: cardId },
        squire: { create_request_id: null, home_thread_id: home },
        proposal: { ...codexProposal, projectId },
        text: codexProposal.firstPrompt,
        verb: "execute",
        attempt: 1,
      });
      assert.equal(real.modelSelection.instanceId, ProviderInstanceId.make("codex"));

      const intent = yield* action.intentFor({
        card: { id: cardId },
        squire: { create_request_id: "fixture:billing", home_thread_id: home },
        proposal: codexProposal,
        text: codexProposal.firstPrompt,
        verb: "execute",
        attempt: 1,
      });
      assert.deepEqual(intent.modelSelection, scriptedModel);
      assert.equal(intent.senderThreadId, home);

      yield* action.launch(intent);
      const projection = yield* threads.getThreadProjection(intent.threadId);
      assert.equal(projection.thread.modelSelection.instanceId, scripted);
      assert.equal(projection.thread.squire, undefined);
      assert.equal(projection.runs.length, 1);
      assert.isTrue(yield* isFixtureOwnedThread(intent.threadId));
      assert.deepEqual(harness.providerCalls, []);
      assert.deepEqual(harness.titleCalls, []);
    }).pipe(Effect.provide(harness.layer));
  },
);
