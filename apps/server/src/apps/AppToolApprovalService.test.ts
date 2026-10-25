import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AppId,
  CommandId,
  type ConnectedAppToolApprovalInfo,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as AppToolApprovalRegistry from "./AppToolApprovalRegistry.ts";
import * as AppToolApprovalService from "./AppToolApprovalService.ts";
import { AppToolApprovalService as AppToolApprovals } from "./services.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;

// The adapter can never open a session, so the provider has no live session to
// answer: a respond routed past the app early return fails its effect.
const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:app-approvals" },
  displayName: "Codex app approvals",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("app approvals never reach a provider session"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-app-approvals-" });

const layerRuntime = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provideMerge(EffectOutbox.layer),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(Layer.mock(CheckpointStore.CheckpointStore)({})),
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
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedNone,
    }),
  ),
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused"),
    }),
  ),
);

// Built over the runtime's own layers, so the service and the orchestrator share one database and sink.
const layerTest = AppToolApprovalService.layer.pipe(
  Layer.provideMerge(layerRuntime),
  Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, layerConfig)),
  Layer.provideMerge(NodeServices.layer),
);

const info: ConnectedAppToolApprovalInfo = {
  appId: AppId.make("dev.rocketwright.app"),
  appName: "RocketWright",
  toolName: "rw_engine_simulate",
  reason: "Simulates 120 s of burn",
  source: "app",
};

interface RunningTurn {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly rootNodeId: NodeId;
  readonly runId: RunId;
}

/** A thread whose provider turn is running on a live session, as the gate sees it mid-call. */
const seedRunningTurn = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}:create`),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "App thread",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const now = yield* DateTime.now;
    const providerSessionId = ProviderSessionId.make(`session:${name}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
    const runId = RunId.make(`run:${name}`);
    const attemptId = RunAttemptId.make(`attempt:${name}`);
    const rootNodeId = NodeId.make(`root:${name}`);
    const event = (
      suffix: string,
      fields: Pick<OrchestrationV2DomainEvent, "type" | "payload">,
    ): OrchestrationV2DomainEvent =>
      ({
        ...fields,
        id: EventId.make(`${name}:${suffix}`),
        threadId,
        driver,
        providerInstanceId: instanceId,
        occurredAt: now,
      }) as OrchestrationV2DomainEvent;
    yield* eventSink.write({
      commandId: CommandId.make(`${name}:seed`),
      events: [
        event("session", {
          type: "provider-session.attached",
          payload: {
            id: providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "running",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        }),
        event("provider-thread", {
          type: "provider-thread.updated",
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
        event("run", {
          type: "run.updated",
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:${name}`),
            rootNodeId,
            activeAttemptId: attemptId,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        }),
        event("root", {
          type: "node.updated",
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        }),
        event("provider-turn", {
          type: "provider-turn.updated",
          payload: {
            id: ProviderTurnId.make(`provider-turn:${name}`),
            providerThreadId,
            nodeId: rootNodeId,
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        }),
      ],
    });
    return { threadId, providerSessionId, rootNodeId, runId } satisfies RunningTurn;
  });

/** The gated MCP call: it raises the request and blocks; returns once the request is persisted. */
const requestApproval = (turn: RunningTurn) =>
  Effect.gen(function* () {
    const approvals = yield* AppToolApprovals;
    const eventSink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence({ threadId: turn.threadId });
    const persisted = yield* eventSink
      .stream({ threadId: turn.threadId, afterSequence, eventType: "runtime-request.updated" })
      .pipe(Stream.runHead, Effect.forkChild);
    const call = yield* approvals
      .request({ threadId: turn.threadId, providerSessionId: turn.providerSessionId }, info)
      .pipe(Effect.forkChild);
    const stored = Option.getOrThrow(yield* Fiber.join(persisted));
    assert.equal(stored.event.type, "runtime-request.updated");
    if (stored.event.type !== "runtime-request.updated") throw new Error("unreachable");
    return { call, requestId: stored.event.payload.id };
  });

it.layer(layerTest)("AppToolApprovalService", (it) => {
  it.effect("raises a permission request on the calling session under the run's root", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const turn = yield* seedRunningTurn("raise");
      const { call, requestId } = yield* requestApproval(turn);

      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      const request = projection.runtimeRequests.find((entry) => entry.id === requestId);
      assert.deepInclude(request, {
        kind: "permission",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: turn.providerSessionId },
        connectedAppTool: info,
      });
      assert.isDefined(request);
      if (request === undefined) return;
      const node = projection.nodes.find((entry) => entry.id === request.nodeId);
      assert.deepInclude(node, {
        kind: "approval_request",
        status: "waiting",
        runId: turn.runId,
        parentNodeId: turn.rootNodeId,
        rootNodeId: turn.rootNodeId,
        runtimeRequestId: requestId,
      });
      const item = projection.turnItems.find(
        (entry) => entry.type === "approval_request" && entry.requestId === requestId,
      );
      assert.deepInclude(item, {
        status: "waiting",
        nodeId: request.nodeId,
        requestKind: "permission",
        appName: "RocketWright",
        prompt: "Approve rw_engine_simulate · Simulates 120 s of burn",
        options: [
          { decision: "accept", label: "Approve" },
          { decision: "decline", label: "Decline" },
        ],
      });
      yield* Fiber.interrupt(call);
    }),
  );

  it.effect("an accepted answer reaches the waiting call and never the adapter", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const registry = yield* AppToolApprovalRegistry.AppToolApprovalRegistry;
      const turn = yield* seedRunningTurn("accept");
      const { call, requestId } = yield* requestApproval(turn);

      const commandId = CommandId.make("accept:respond");
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId: turn.threadId,
        requestId,
        decision: "accept",
      });
      yield* worker.drain();

      // The effect is still enqueued and runs; only the adapter call is skipped (D1).
      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => [
          effect.request.type,
          effect.status,
        ]),
        [["runtime-request.respond", "succeeded"]],
      );
      assert.equal(yield* Fiber.join(call), "approved");
      assert.isFalse(yield* registry.claims(requestId));
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      assert.equal(
        projection.runtimeRequests.find((entry) => entry.id === requestId)?.status,
        "resolved",
      );
    }),
  );

  it.effect("a declined answer reaches the waiting call as declined", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const turn = yield* seedRunningTurn("decline");
      const { call, requestId } = yield* requestApproval(turn);

      const commandId = CommandId.make("decline:respond");
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId: turn.threadId,
        requestId,
        decision: "decline",
      });
      yield* worker.drain();

      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => effect.status),
        ["succeeded"],
      );
      assert.equal(yield* Fiber.join(call), "declined");
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      const request = projection.runtimeRequests.find((entry) => entry.id === requestId);
      assert.equal(
        projection.nodes.find((node) => node.id === request?.nodeId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect("cancels without raising anything when the session holds no running turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const approvals = yield* AppToolApprovals;
      const turn = yield* seedRunningTurn("other-session");

      const otherSession = yield* approvals.request(
        { threadId: turn.threadId, providerSessionId: "session:someone-else" },
        info,
      );
      assert.equal(otherSession, "cancelled");

      const idleThreadId = ThreadId.make("thread:idle");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("idle:create"),
        threadId: idleThreadId,
        projectId: ProjectId.make("project:idle"),
        title: "Idle app thread",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const noTurn = yield* approvals.request(
        { threadId: idleThreadId, providerSessionId: turn.providerSessionId },
        info,
      );
      assert.equal(noTurn, "cancelled");

      for (const threadId of [turn.threadId, idleThreadId]) {
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(projection.runtimeRequests, []);
      }
    }),
  );
});

it("prompts with the tool alone when the app gives no reason", () => {
  assert.equal(
    AppToolApprovalService.approvalPrompt({ ...info, reason: null, source: "static" }),
    "Approve rw_engine_simulate",
  );
});
