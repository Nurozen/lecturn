import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { StaveOrchestration } from "../stave/StaveOrchestration.ts";
import * as StaveOrchestrationLive from "../stave/StaveOrchestrationLive.ts";
import { StaveProjectShells } from "../stave/StaveProjectShells.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:interrupt-provenance");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerThreads = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "interrupt-provenance" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);
const layerTest = Layer.mergeAll(
  OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  ),
  StaveOrchestrationLive.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(StaveProjectShells)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(OrchestrationEventStore)({}),
      ),
    ),
  ),
).pipe(Layer.provideMerge(layerThreads));

const startThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!;
  });

const interruptActors = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.turnItems.flatMap((item) =>
      item.type === "run_interrupt_request" ? [item.createdBy ?? null] : [],
    );
  });

const mcpScope = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:interrupt-provenance"),
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

it.effect.each(
  (["run.interrupt", "thread.stop"] as const).flatMap((type) =>
    (
      [
        ["user", "user"],
        ["a forged agent", "agent"],
        ["a forged server", "system"],
      ] as const
    ).map(([label, claimed]) => ({ type, label, claimed })),
  ),
)("a client $type claiming $label is recorded as the user's", ({ type, claimed }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:client-${type}:${claimed}`);
    const run = yield* startThread(threadId);
    const commandId = CommandId.make(`stop:${threadId}`);
    const fromClient: OrchestrationV2Command =
      type === "run.interrupt"
        ? { type, commandId, threadId, runId: run.id, holdQueue: true, createdBy: claimed }
        : { type, commandId, threadId, createdBy: claimed };
    // The provenance ws.ts applies to every client dispatch.
    yield* orchestrator.dispatch(
      ThreadManagementService.withCreationProvenance(fromClient, {
        createdBy: "user",
        creationSource: "web",
      }),
    );
    assert.deepEqual(yield* interruptActors(threadId), ["user"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["user", "agent", "system", undefined] as const)(
  "thread.stop rebuilt as run.interrupt keeps its provenance (%s)",
  (createdBy) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:thread-stop:${createdBy ?? "none"}`);
      yield* startThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop:${threadId}`),
        threadId,
        ...(createdBy === undefined ? {} : { createdBy }),
      });
      assert.deepEqual(yield* interruptActors(threadId), [createdBy ?? null]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("an agent's lecturn_thread_interrupt is recorded as the agent's", () =>
  Effect.gen(function* () {
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threadId = ThreadId.make("thread:mcp-interrupt");
    yield* startThread(threadId);
    const result = yield* mcp.interruptThread(mcpScope(threadId), {
      threadId,
      clientRequestId: "mcp-interrupt",
    });
    assert.equal(result.status, "interrupt_requested");
    assert.deepEqual(yield* interruptActors(threadId), ["agent" satisfies OrchestrationV2Actor]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegated task the parent's agent cancels is stopped by the agent", () =>
  Effect.gen(function* () {
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
    yield* startThread(parentThreadId);
    const task = yield* delegate(parentThreadId, "cancelled task");
    yield* mcp.cancelTask(mcpScope(parentThreadId), {
      taskId: task.id,
      clientRequestId: "mcp-cancel",
    });
    assert.deepEqual(yield* interruptActors(task.childThreadId!), ["agent"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a Stop's cascade to delegated tasks is the server's, whoever stopped the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:cascade-parent");
    const run = yield* startThread(parentThreadId);
    const task = yield* delegate(parentThreadId, "cascaded task");
    const commandId = CommandId.make("stop:cascade-parent");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId,
      threadId: parentThreadId,
      runId: run.id,
      holdQueue: true,
      createdBy: "user",
    });
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId });
    assert.deepEqual(yield* interruptActors(parentThreadId), ["user"]);
    assert.deepEqual(yield* interruptActors(task.childThreadId!), ["system"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a Stave space operation's interrupt is the server's", () =>
  Effect.gen(function* () {
    const stave = yield* StaveOrchestration;
    const threadId = ThreadId.make("thread:stave-interrupt");
    yield* startThread(threadId);
    yield* stave.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("stave:interrupt"),
      threadId,
    });
    assert.deepEqual(yield* interruptActors(threadId), ["system"]);
  }).pipe(Effect.provide(layerTest)),
);
