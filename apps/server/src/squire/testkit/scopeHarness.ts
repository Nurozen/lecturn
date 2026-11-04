import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SquireId,
  type ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import type * as SquireRepository from "../SquireRepository.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const threadModel = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;

const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:squire-scope-test" },
  displayName: "Codex Squire scope test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by Squire scope tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
  listExternalSessions: () => Effect.succeed({ sessions: [], truncated: false }),
  importExternalSession: () => Effect.die("imports are not used by Squire scope tests"),
} satisfies ProviderInstance;

/** The V2 orchestrator over in-memory SQLite, with no provider sessions. */
export const orchestratorLayer = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(Layer.mock(CheckpointStore.CheckpointStore)({})),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-scope-" })),
  Layer.provide(ServerSettings.layerTest()),
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

/** Dispatches `thread.create`; with `squireId` the thread is a Squire home thread. */
export const createThread = (threadId: ThreadId, projectId: ProjectId, squireId?: SquireId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title: "Thread",
      modelSelection: threadModel,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(squireId === undefined ? {} : { squire: { squireId, role: "home" as const } }),
    }),
  );

export const dispatchThread = (type: "thread.archive" | "thread.delete", threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({ type, commandId: CommandId.make(`${threadId}:${type}`), threadId }),
  );

export const squireRow = (
  id: SquireId,
  overrides: Partial<SquireRepository.SquireRow> = {},
): SquireRepository.SquireRow => ({
  id,
  role: "squire",
  name: id,
  lifecycle: "ready",
  home_generation: 0,
  home_thread_id: null,
  home_project_id: ProjectId.make("project:home"),
  provider_instance_id: "codex",
  model_selection_json: "{}",
  summary_model_selection_json: null,
  brief: "",
  status: "active",
  events_json: "{}",
  permissions_json: "{}",
  budgets_json: "{}",
  undo_window_seconds: 10,
  digest_json: null,
  digest_last_date: null,
  onboarded_at: null,
  sweep_json: null,
  user_active_at: null,
  inactivity_prompted_at: null,
  automation_paused_at: null,
  companion_json: "{}",
  revision: 0,
  create_request_id: null,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

export const grantRow = (
  squireId: SquireId,
  kind: SquireRepository.SquireGrantRow["kind"],
  targetId: string,
): SquireRepository.SquireGrantRow => ({
  squire_id: squireId,
  kind,
  target_id: targetId,
  origin: "granted",
  created_at: "2026-11-01T00:00:00.000Z",
});
