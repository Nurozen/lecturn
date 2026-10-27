import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AppId,
  type AppGrantState,
  type AppRuntimeCeiling,
  type AppStatus,
  type AppStatusStreamEvent,
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
  RuntimeRequestId,
  ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
import { AppRegistryService, AppToolApprovalService as AppToolApprovals } from "./services.ts";

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

/** The registry's status stream, driven by the tests; an app without a state here is granted. */
class TestAppStatus extends Context.Service<
  TestAppStatus,
  {
    readonly events: PubSub.PubSub<AppStatusStreamEvent>;
    readonly states: Map<AppId, AppGrantState | "removed">;
    readonly ceilings: Map<AppId, AppRuntimeCeiling>;
  }
>()("lecturn/apps/AppToolApprovalService.test/TestAppStatus") {}

const appStatus = (
  appId: AppId,
  name: string,
  state: AppGrantState,
  runtimeCeiling: AppRuntimeCeiling = null,
) => ({ appId, name, state, runtimeCeiling }) as AppStatus;

const layerAppStatus = Layer.effect(
  TestAppStatus,
  Effect.map(PubSub.unbounded<AppStatusStreamEvent>(), (events) => ({
    events,
    states: new Map(),
    ceilings: new Map(),
  })),
);

const layerApps = Layer.unwrap(
  Effect.gen(function* () {
    const { events, states, ceilings } = yield* TestAppStatus;
    return Layer.mock(AppRegistryService)({
      streamStatus: Stream.fromPubSub(events),
      get: (appId) =>
        Effect.sync(() => {
          const state = states.get(appId) ?? "granted";
          return state === "removed"
            ? Option.none()
            : Option.some({
                status: appStatus(appId, "App", state, ceilings.get(appId) ?? null),
                registration: { toolPrefix: "rw", liveTools: true },
              } as never);
        }),
      cachedTools: () =>
        Effect.succeed({
          headless: Option.some([
            { name: "engine_simulate", title: "Simulate engine", inputSchema: { type: "object" } },
            { name: "motor_search", inputSchema: { type: "object" } },
          ] as never),
          live: Option.some([
            {
              name: "view_open",
              annotations: { title: "Open view" },
              inputSchema: { type: "object" },
            },
          ] as never),
        }),
    });
  }),
);

// Built over the runtime's own layers, so the service and the orchestrator share one database and sink.
const layerTest = AppToolApprovalService.layer.pipe(
  Layer.provide(layerApps),
  Layer.provideMerge(layerAppStatus),
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
        event("attempt", {
          type: "run-attempt.updated",
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId,
            providerInstanceId: instanceId,
            providerThreadId,
            providerTurnId: ProviderTurnId.make(`provider-turn:${name}`),
            reason: "initial",
            status: "running",
            startedAt: now,
            completedAt: null,
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

/** A permission request the provider itself raised in the turn, which no app owns. */
const seedProviderRequest = (turn: RunningTurn) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make(`provider-request:${turn.threadId}`);
    const nodeId = NodeId.make(`provider-approval:${turn.threadId}`);
    const base = {
      threadId: turn.threadId,
      runId: turn.runId,
      nodeId,
      driver,
      providerInstanceId: instanceId,
      occurredAt: now,
    };
    yield* eventSink.write({
      commandId: CommandId.make(`${turn.threadId}:provider-request`),
      events: [
        {
          ...base,
          id: EventId.make(`${turn.threadId}:provider-approval-node`),
          type: "node.updated",
          payload: {
            id: nodeId,
            threadId: turn.threadId,
            runId: turn.runId,
            parentNodeId: turn.rootNodeId,
            rootNodeId: turn.rootNodeId,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          ...base,
          id: EventId.make(`${turn.threadId}:provider-request`),
          type: "runtime-request.updated",
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "permission",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: turn.providerSessionId },
            createdAt: now,
            resolvedAt: null,
          },
        },
      ] as Array<OrchestrationV2DomainEvent>,
    });
    return requestId;
  });

/** The gated MCP call: it raises the request and blocks; returns once the request is persisted. */
const requestApproval = (turn: RunningTurn, approvalInfo: ConnectedAppToolApprovalInfo = info) =>
  Effect.gen(function* () {
    const approvals = yield* AppToolApprovals;
    const eventSink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence({ threadId: turn.threadId });
    const persisted = yield* eventSink
      .stream({ threadId: turn.threadId, afterSequence, eventType: "runtime-request.updated" })
      .pipe(Stream.runHead, Effect.forkChild);
    // A toolkit call names its MCP credential, never the provider session that runs the turn.
    const call = yield* approvals
      .request(
        { threadId: turn.threadId, providerSessionId: "mcp-credential:toolkit" },
        approvalInfo,
      )
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
        connectedAppTool: { ...info, toolTitle: "Simulate engine" },
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
        prompt: "Approve Simulate engine · Simulates 120 s of burn",
        options: [
          { decision: "decline", label: "Decline" },
          { decision: "accept", label: "Approve" },
          { decision: "cancel", label: "Cancel" },
        ],
      });
      yield* Fiber.interrupt(call);
    }),
  );

  it.effect("titles the request from the app's tool definitions, else keeps the called name", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const shown = (toolName: string) =>
        Effect.gen(function* () {
          const turn = yield* seedRunningTurn(`title-${toolName}`);
          const { call, requestId } = yield* requestApproval(turn, {
            ...info,
            toolName,
            reason: null,
          });
          const projection = yield* orchestrator.getThreadProjection(turn.threadId);
          yield* Fiber.interrupt(call);
          const request = projection.runtimeRequests.find((entry) => entry.id === requestId);
          const item = projection.turnItems.find(
            (entry) => entry.type === "approval_request" && entry.requestId === requestId,
          );
          return {
            toolTitle: request?.connectedAppTool?.toolTitle,
            prompt: item?.type === "approval_request" ? item.prompt : undefined,
          };
        });

      assert.deepEqual(yield* shown("rw_view_open"), {
        toolTitle: "Open view",
        prompt: "Approve Open view",
      });
      assert.deepEqual(yield* shown("rw_motor_search"), {
        toolTitle: undefined,
        prompt: "Approve rw_motor_search",
      });
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

      // The effect is still enqueued and runs; only the adapter call is skipped.
      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => [
          effect.request.type,
          effect.status,
        ]),
        [["runtime-request.respond", "succeeded"]],
      );
      assert.deepEqual(yield* Fiber.join(call), { outcome: "approved", requestId });
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
      assert.deepEqual(yield* Fiber.join(call), { outcome: "declined", requestId });
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      const request = projection.runtimeRequests.find((entry) => entry.id === requestId);
      assert.equal(
        projection.nodes.find((node) => node.id === request?.nodeId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect("interrupting the run cancels the waiting call and closes the card", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const turn = yield* seedRunningTurn("interrupt");
      const { call, requestId } = yield* requestApproval(turn);

      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt:stop"),
        threadId: turn.threadId,
        runId: turn.runId,
      });
      yield* worker.drain();

      assert.deepEqual(yield* Fiber.join(call), { outcome: "cancelled", requestId });
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      assert.equal(
        projection.runtimeRequests.find((entry) => entry.id === requestId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect("settling the stopped turn's background work cancels the waiting call", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const turn = yield* seedRunningTurn("settle");
      const { call, requestId } = yield* requestApproval(turn);

      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make("settle:settle"),
        threadId: turn.threadId,
        providerThreadId: ProviderThreadId.make("provider-thread:settle"),
        providerTurnId: ProviderTurnId.make("provider-turn:settle"),
      });

      assert.deepEqual(yield* Fiber.join(call), { outcome: "cancelled", requestId });
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      assert.equal(
        projection.runtimeRequests.find((entry) => entry.id === requestId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect("an unanswered request expires after ten minutes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const turn = yield* seedRunningTurn("expire");
      const { call, requestId } = yield* requestApproval(turn);

      yield* TestClock.adjust(AppToolApprovalService.APPROVAL_TTL);

      assert.deepEqual(yield* Fiber.join(call), { outcome: "expired", requestId });
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      const request = projection.runtimeRequests.find((entry) => entry.id === requestId);
      assert.equal(request?.status, "expired");
      assert.equal(
        projection.nodes.find((node) => node.id === request?.nodeId)?.status,
        "cancelled",
      );
      assert.equal(
        projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === requestId,
        )?.status,
        "cancelled",
      );
    }),
  );

  it.effect("expiry refuses a request that was already answered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const turn = yield* seedRunningTurn("expire-late");
      const { call, requestId } = yield* requestApproval(turn);
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("expire-late:respond"),
        threadId: turn.threadId,
        requestId,
        decision: "accept",
      });
      yield* worker.drain();
      assert.deepEqual(yield* Fiber.join(call), { outcome: "approved", requestId });

      const late = yield* orchestrator
        .dispatch({
          type: "runtime-request.app-expire",
          commandId: CommandId.make("expire-late:expire"),
          threadId: turn.threadId,
          requestId,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(late));
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      assert.equal(
        projection.runtimeRequests.find((entry) => entry.id === requestId)?.status,
        "resolved",
      );
    }),
  );

  it.effect("the Cancel option ends the call as cancelled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const turn = yield* seedRunningTurn("cancel-option");
      const { call, requestId } = yield* requestApproval(turn);

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("cancel-option:respond"),
        threadId: turn.threadId,
        requestId,
        decision: "cancel",
      });
      yield* worker.drain();

      assert.deepEqual(yield* Fiber.join(call), { outcome: "cancelled", requestId });
    }),
  );

  it.effect("a call the agent stops waiting on withdraws its request", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const turn = yield* seedRunningTurn("withdraw");
      const { call, requestId } = yield* requestApproval(turn);

      yield* Fiber.interrupt(call);

      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      const request = projection.runtimeRequests.find((entry) => entry.id === requestId);
      assert.deepInclude(request, { status: "resolved", decision: "cancel" });
    }),
  );

  it.effect("revoking an app cancels its waiting approvals and leaves every other request", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const appId = AppId.make("dev.revoked.app");
      const turn = yield* seedRunningTurn("revoke");
      const revoked = yield* requestApproval(turn, { ...info, appId, appName: "Revokee" });
      const otherApp = yield* requestApproval(turn);
      const providerRequestId = yield* seedProviderRequest(turn);

      const apps = yield* TestAppStatus;
      apps.states.set(appId, "revoked");
      yield* PubSub.publish(apps.events, {
        type: "upsert",
        app: appStatus(appId, "Revokee", "revoked"),
      });

      assert.deepEqual(yield* Fiber.join(revoked.call), {
        outcome: "cancelled",
        requestId: revoked.requestId,
        reason: "Revokee was revoked",
      });
      // Through the ordinary answer path, whose effect never reaches the adapter.
      yield* worker.drain();
      assert.deepEqual(
        (yield* outbox.listByCommandId(
          CommandId.make(`apps:approval-revoked:${revoked.requestId}`),
        )).map((effect) => effect.status),
        ["succeeded"],
      );
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      const statusOf = (requestId: string) =>
        projection.runtimeRequests.find((entry) => entry.id === requestId)?.status;
      const request = projection.runtimeRequests.find((entry) => entry.id === revoked.requestId);
      assert.deepInclude(request, { status: "resolved", decision: "cancel" });
      assert.equal(
        projection.nodes.find((node) => node.id === request?.nodeId)?.status,
        "cancelled",
      );
      assert.equal(
        projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === revoked.requestId,
        )?.status,
        "cancelled",
      );
      assert.equal(statusOf(otherApp.requestId), "pending");
      assert.equal(statusOf(providerRequestId), "pending");
      // The agent gets the refusal and carries on; the run is not ended for it.
      assert.equal(projection.runs.find((run) => run.id === turn.runId)?.status, "running");
      yield* Fiber.interrupt(otherApp.call);
    }),
  );

  it.effect("deleting an app cancels its waiting approvals as removed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const appId = AppId.make("dev.removed.app");
      const turn = yield* seedRunningTurn("remove");
      const { call, requestId } = yield* requestApproval(turn, {
        ...info,
        appId,
        appName: "Leaver",
      });

      const apps = yield* TestAppStatus;
      apps.states.set(appId, "removed");
      yield* PubSub.publish(apps.events, { type: "remove", appId });

      assert.deepEqual(yield* Fiber.join(call), {
        outcome: "cancelled",
        requestId,
        reason: "Leaver was removed",
      });
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      assert.deepInclude(
        projection.runtimeRequests.find((entry) => entry.id === requestId),
        { status: "resolved", decision: "cancel" },
      );
    }),
  );

  it.effect("an approval raised just after its app was revoked is cancelled at once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const appId = AppId.make("dev.late.app");
      (yield* TestAppStatus).states.set(appId, "revoked");
      const turn = yield* seedRunningTurn("late-revoke");
      const { call, requestId } = yield* requestApproval(turn, {
        ...info,
        appId,
        appName: "Latecomer",
      });

      assert.deepEqual(yield* Fiber.join(call), {
        outcome: "cancelled",
        requestId,
        reason: "Latecomer was revoked",
      });
      const projection = yield* orchestrator.getThreadProjection(turn.threadId);
      assert.deepInclude(
        projection.runtimeRequests.find((entry) => entry.id === requestId),
        { status: "resolved", decision: "cancel" },
      );
    }),
  );

  it.effect(
    "limiting an app to Read-only cancels its waiting approvals; asking ceilings keep them",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const appId = AppId.make("dev.limited.app");
        const turn = yield* seedRunningTurn("limit");
        const limited = yield* requestApproval(turn, { ...info, appId, appName: "Limitee" });
        const supervised = yield* requestApproval(turn);

        const apps = yield* TestAppStatus;
        // Published first, so it has been handled once the later cancel lands.
        apps.ceilings.set(info.appId, "approval-required");
        yield* PubSub.publish(apps.events, {
          type: "upsert",
          app: appStatus(info.appId, "RocketWright", "granted", "approval-required"),
        });
        apps.ceilings.set(appId, "read-only");
        yield* PubSub.publish(apps.events, {
          type: "upsert",
          app: appStatus(appId, "Limitee", "granted", "read-only"),
        });

        assert.deepEqual(yield* Fiber.join(limited.call), {
          outcome: "cancelled",
          requestId: limited.requestId,
          reason: "Limitee was limited to Read-only",
        });
        const projection = yield* orchestrator.getThreadProjection(turn.threadId);
        const request = projection.runtimeRequests.find((entry) => entry.id === limited.requestId);
        assert.deepInclude(request, { status: "resolved", decision: "cancel" });
        assert.equal(
          projection.turnItems.find(
            (item) => item.type === "approval_request" && item.requestId === limited.requestId,
          )?.status,
          "cancelled",
        );
        assert.equal(
          projection.runtimeRequests.find((entry) => entry.id === supervised.requestId)?.status,
          "pending",
        );
        assert.equal(projection.runs.find((run) => run.id === turn.runId)?.status, "running");
        yield* Fiber.interrupt(supervised.call);
      }),
  );

  it.effect(
    "an approval raised just after its app was limited to Read-only is cancelled at once",
    () =>
      Effect.gen(function* () {
        const appId = AppId.make("dev.late-limit.app");
        (yield* TestAppStatus).ceilings.set(appId, "read-only");
        const turn = yield* seedRunningTurn("late-limit");
        const { call, requestId } = yield* requestApproval(turn, {
          ...info,
          appId,
          appName: "Latecomer",
        });

        assert.deepEqual(yield* Fiber.join(call), {
          outcome: "cancelled",
          requestId,
          reason: "Latecomer was limited to Read-only",
        });
      }),
  );

  it.effect("cancels without raising anything when the thread has no running turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const approvals = yield* AppToolApprovals;
      const turn = yield* seedRunningTurn("other-session");

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
      assert.deepEqual(noTurn, { outcome: "cancelled", requestId: null });

      for (const threadId of [turn.threadId, idleThreadId]) {
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(projection.runtimeRequests, []);
      }
    }),
  );
});

it("tells the agent why a call did not run", () => {
  assert.include(AppToolApprovalService.refusalMessage("rw_x", "declined"), "approval declined");
  assert.include(AppToolApprovalService.refusalMessage("rw_x", "cancelled"), "approval cancelled");
  assert.include(AppToolApprovalService.refusalMessage("rw_x", "expired"), "approval expired");
  assert.equal(
    AppToolApprovalService.refusalMessage("rw_x", "cancelled", "RocketWright was revoked"),
    "rw_x did not run: RocketWright was revoked (approval cancelled).",
  );
});

it("prompts with the tool alone when the app gives no reason", () => {
  assert.equal(
    AppToolApprovalService.approvalPrompt({ ...info, reason: null, source: "static" }),
    "Approve rw_engine_simulate",
  );
});
