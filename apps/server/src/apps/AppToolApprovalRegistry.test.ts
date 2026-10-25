import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as SessionStore from "../auth/SessionStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { LecturnOrchestrationHooks } from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as AppRuntimeState from "./AppRuntimeState.ts";
import * as AppsLayer from "./AppsLayer.ts";
import * as AppToolApprovalRegistry from "./AppToolApprovalRegistry.ts";
import { AppHostContextStore } from "./services.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;

// No adapter can answer a request: a respond that reached the provider path fails.
const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:apps-test" },
  displayName: "Codex apps test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("provider sessions are not used by app approval tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-apps-approvals-" });
const layerProjectService = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const layerRuntime = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provideMerge(EffectOutbox.layer),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(Layer.mock(CheckpointStore.CheckpointStore)({})),
  Layer.provide(layerConfig),
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
  Layer.provide(layerProjectService),
  Layer.provide(
    Layer.merge(
      NodeServices.layer,
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused"),
      }),
    ),
  ),
);

// The same layer values as the runtime's, so one build shares one database.
const layerAppsDependencies = Layer.mergeAll(
  ProjectStore.layer,
  ProjectionStore.layer,
  OrchestrationEventStore.layer,
  layerProjectService,
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "lecturn_session",
    legacyCookieName: undefined,
  }),
  Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({}),
  ServerSettings.layerTest(),
).pipe(
  Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, layerConfig)),
  Layer.provideMerge(NodeServices.layer),
);

// Stands in for the apps contribution: it holds only what the runtime gives it.
const layerHostContextHook = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks;
    const { hostContext } = yield* AppRuntimeState.AppRuntimeState;
    yield* hooks.register({
      name: "apps-test",
      beforeTurnStart: (input) =>
        Ref.get(hostContext).pipe(
          Effect.map((entries) => {
            const contextPrefix = entries.get(
              AppRuntimeState.hostContextKey({ threadId: input.thread.id }),
            );
            return contextPrefix === undefined ? undefined : { contextPrefix };
          }),
        ),
    });
  }),
);

// The server.ts shape: hook registrations inside the runtime, AppsLayer above it.
const layerServer = AppsLayer.layer.pipe(
  Layer.provide(layerAppsDependencies),
  Layer.provideMerge(layerHostContextHook.pipe(Layer.provideMerge(layerRuntime))),
);

const createThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
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
    return threadId;
  });

/** A pending app approval as the gate raises it: a permission request on the live session. */
const seedApproval = (name: string, threadId: ThreadId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerSessionId = ProviderSessionId.make(`session:${name}`);
    const requestId = RuntimeRequestId.make(`request:${name}`);
    const nodeId = NodeId.make(`node:${name}`);
    yield* eventSink.write({
      commandId: CommandId.make(`${name}:seed`),
      events: [
        {
          id: EventId.make(`${name}:session`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
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
        },
        {
          id: EventId.make(`${name}:node`),
          type: "node.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
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
          id: EventId.make(`${name}:request`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "permission",
            status: "pending",
            responseCapability: { type: "live", providerSessionId },
            createdAt: now,
            resolvedAt: null,
          },
        },
      ],
    });
    return requestId;
  });

/** The MCP side: a gated tool call that registers its request and waits for the user. */
const awaitApprovalFromMcp = (requestId: RuntimeRequestId) =>
  Effect.gen(function* () {
    const registry = yield* AppToolApprovalRegistry.AppToolApprovalRegistry;
    const registered = yield* Deferred.make<void>();
    const call = yield* Effect.forkChild(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registry.register(requestId);
          yield* Deferred.succeed(registered, undefined);
          return yield* registry.awaitDecision(requestId);
        }),
      ),
    );
    yield* Deferred.await(registered);
    return call;
  });

it.layer(layerServer)("connected-app state shared across the server", (it) => {
  it.effect("answers an app approval to the waiting MCP call, never to the adapter", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const registry = yield* AppToolApprovalRegistry.AppToolApprovalRegistry;
      const threadId = yield* createThread("approve");
      const requestId = yield* seedApproval("approve", threadId);
      const call = yield* awaitApprovalFromMcp(requestId);

      // What ws.ts dispatchCommand does with a client's answer.
      const commandId = CommandId.make("approve:respond");
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId,
        decision: "accept",
      });
      yield* worker.drain();

      // Checked before joining: a respond routed to the provider fails here instead of hanging.
      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => [
          effect.request.type,
          effect.status,
        ]),
        [["runtime-request.respond", "succeeded"]],
      );
      assert.equal(yield* Fiber.join(call), "approved");
      assert.isFalse(yield* registry.claims(requestId));
    }),
  );

  it.effect("a declined app approval reaches the MCP call as declined", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = yield* createThread("decline");
      const requestId = yield* seedApproval("decline", threadId);
      const call = yield* awaitApprovalFromMcp(requestId);

      const commandId = CommandId.make("decline:respond");
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId,
        decision: "decline",
      });
      yield* worker.drain();

      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => effect.status),
        ["succeeded"],
      );
      assert.equal(yield* Fiber.join(call), "declined");
    }),
  );

  it.effect(
    "a hook registered inside the runtime reads host context an AppsLayer service set",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const hooks = yield* LecturnOrchestrationHooks;
        const store = yield* AppHostContextStore;
        const threadId = yield* createThread("host-context");
        const { thread } = yield* orchestrator.getThreadProjection(threadId);

        yield* store.set({ threadId }, "Selected part: nose cone");
        const decision = yield* hooks.beforeTurnStart({
          thread,
          run: {} as OrchestrationV2Run,
          message: {} as OrchestrationV2ConversationMessage,
          compaction: false,
        });

        assert.equal(decision.contextPrefix, "Selected part: nose cone");
      }),
  );
});

it.effect("server shutdown ends pending approval waits as cancelled", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(AppToolApprovalRegistry.layer, scope);
    const requestId = RuntimeRequestId.make("request:shutdown");
    const call = yield* awaitApprovalFromMcp(requestId).pipe(Effect.provide(context));

    yield* Scope.close(scope, Exit.void);

    assert.equal(yield* Fiber.join(call), "cancelled");
  }),
);

it.effect("a second AppsLayer build over the same state fails loudly", () =>
  Effect.gen(function* () {
    const state = yield* Layer.build(AppRuntimeState.layer);
    const buildApps = (layer: typeof AppsLayer.layer) =>
      Layer.build(layer).pipe(
        Effect.scoped,
        Effect.provide(state),
        // The server takes the registry from RuntimeLayer; this build has no runtime.
        Effect.provide(
          Layer.mergeAll(
            AppToolApprovalRegistry.layer,
            layerAppsDependencies,
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
          ),
        ),
        Effect.exit,
      );

    const twice = yield* buildApps(Layer.mergeAll(AppsLayer.layer, Layer.fresh(AppsLayer.layer)));
    assert.isTrue(Exit.isFailure(twice));
    if (Exit.isFailure(twice)) {
      assert.include(Cause.pretty(twice.cause), "AppsLayer was built twice");
    }

    // Tearing a build down releases the state for the next server in this process.
    const first = yield* buildApps(AppsLayer.layer);
    const again = yield* buildApps(AppsLayer.layer);
    assert.isTrue(Exit.isSuccess(first));
    assert.isTrue(Exit.isSuccess(again));
    assert.isFalse(
      yield* Ref.get(Context.get(state, AppRuntimeState.AppRuntimeState).appsLayerBuilt),
    );
  }),
);
