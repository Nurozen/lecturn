import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SquireId,
  type SquireThreadMarker,
  ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;
const projectId = ProjectId.make("project:squire-marker");
const squire: SquireThreadMarker = { squireId: SquireId.make("squire:lead"), role: "home" };

const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:squire-marker-test" },
  displayName: "Codex Squire marker test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("provider sessions are not used by Squire marker tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestLayer = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  OrchestrationEventStore.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(Layer.mock(CheckpointStore.CheckpointStore)({})),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-marker-" })),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (id) => Effect.succeed(id === instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provideMerge(
    Layer.merge(
      NodeServices.layer,
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused"),
      }),
    ),
  ),
);

const seedProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`seed:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: "2026-10-31T12:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: `/work/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-31T12:00:00.000Z",
      updatedAt: "2026-10-31T12:00:00.000Z",
    },
  }),
);

const createThread = (threadId: ThreadId, marker?: SquireThreadMarker) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title: "Squire · Lead",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(marker === undefined ? {} : { squire: marker }),
    }),
  );

it.layer(TestLayer)("Squire thread marker", (it) => {
  it.effect("a server-built create carries the marker through the event, shell and rebuild", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject;
      const markedId = ThreadId.make("thread:squire-home");
      const plainId = ThreadId.make("thread:squire-plain");
      yield* createThread(markedId, squire);
      yield* createThread(plainId);

      const [created] = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS "payload" FROM orchestration_events
        WHERE stream_id = ${markedId} AND event_type = 'thread.created'
      `;
      assert.deepEqual(JSON.parse(created!.payload).squire, squire);

      const read = Effect.gen(function* () {
        const snapshot = yield* orchestrator.getShellSnapshot({ projectId });
        return {
          shell: (yield* orchestrator.getThreadShell(markedId))?.squire,
          inSnapshot: snapshot.threads.find((shell) => shell.id === markedId)?.squire,
          plain: yield* orchestrator.getThreadShell(plainId),
        };
      });
      const before = yield* read;
      assert.deepEqual(before.shell, squire);
      assert.deepEqual(before.inSnapshot, squire);
      assert.notProperty(before.plain, "squire");

      const verification = yield* maintenance.rebuild;
      assert.isTrue(verification.valid);
      const after = yield* read;
      assert.deepEqual(after.shell, squire);
      assert.deepEqual(after.inSnapshot, squire);
      assert.notProperty(after.plain, "squire");
    }),
  );
});
