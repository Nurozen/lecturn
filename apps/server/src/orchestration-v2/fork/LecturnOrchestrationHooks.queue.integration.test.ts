/**
 * Lecturn regression (review-a N2): a turn a fork hook withdraws (a held
 * Contextual turn the user cancels) settles as cancelled and the thread's
 * queue moves on, while a refused turn (policy) still fails and holds it.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../ProviderAdapter.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import * as ProjectStore from "../ProjectStore.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "../runtimeLayer.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;

const orchestrationAdapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by fork tests"),
} as ProviderAdapterV2Shape;

const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:fork-test" },
  displayName: "Codex fork test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
  listExternalSessions: () => Effect.succeed({ sessions: [], truncated: false }),
  importExternalSession: () => Effect.die("unused"),
} satisfies ProviderInstance;

const TestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProjectStore.layer,
  ProjectionStore.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    Layer.mock(CheckpointStore.CheckpointStore)({
      listRestoreDeletions: (input) =>
        Effect.succeed({
          paths: Array.from({ length: 205 }, (_, index) => `${input.cwd}/untracked-${index}.txt`),
          truncated: false,
        }),
    }),
  ),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-orchestration-v2-fork-" }),
  ),
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
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provideMerge(
    Layer.merge(
      NodeServices.layer,
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused"),
      }),
    ),
  ),
);

const createThread = (
  threadId: ThreadId,
  projectId: ProjectId,
  worktreePath: string | null = null,
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title: "Source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: worktreePath === null ? null : "feature/x",
      worktreePath,
    }),
  );

/** A run with its user message (and execution ids when it can start). */
const writeRun = (input: {
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly providerThreadId: ProviderThreadId;
  readonly withExecution?: boolean;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`${input.threadId}:run:${input.ordinal}`);
    const messageId = MessageId.make(`${input.threadId}:message:${input.ordinal}`);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${runId}:message`),
          type: "message.updated",
          threadId: input.threadId,
          runId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: messageId,
            threadId: input.threadId,
            runId,
            nodeId: null,
            role: "user",
            text: `message ${input.ordinal}`,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: input.providerThreadId,
            userMessageId: messageId,
            rootNodeId: input.withExecution ? NodeId.make(`${runId}:root`) : null,
            activeAttemptId: input.withExecution ? RunAttemptId.make(`${runId}:attempt`) : null,
            status: input.status,
            queuePosition: input.status === "queued" ? 1 : null,
            requestedAt: now,
            startedAt: input.status === "queued" ? null : now,
            completedAt: input.status === "completed" ? now : null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    return { runId, messageId };
  });

const writeProviderThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`${threadId}:provider-thread`);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${providerThreadId}:updated`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: `${threadId}:native`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 2,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    return providerThreadId;
  });

const settleFirstRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly outcome: "cancelled" | "failed";
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(input.threadId)).runs.find(
      (candidate) => candidate.id === input.runId,
    )!;
    // What ProviderTurnStartService writes for a withdrawn vs. a refused turn.
    const base = {
      id: TurnItemId.make(`${input.runId}:lecturn-turn-start-rejected`),
      threadId: input.threadId,
      runId: input.runId,
      nodeId: run.rootNodeId!,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const item =
      input.outcome === "cancelled"
        ? {
            ...base,
            status: "cancelled" as const,
            type: "system_notice" as const,
            title: "Turn was canceled",
            message: "The turn was canceled before it started.",
          }
        : {
            ...base,
            status: "failed" as const,
            type: "error" as const,
            title: "Turn was not started",
            failure: makeProviderFailure({
              class: "permission_error",
              message: "Provider 'codex' is disabled by your organization.",
            }),
          };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${input.runId}:rejected-item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: item as never,
        },
        {
          id: EventId.make(`${input.runId}:settled`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: { ...run, status: input.outcome, completedAt: now },
        },
      ],
    });
  });

/** Lets the orchestrator's terminal-run tail react. */
const eventually = <E, R>(label: string, done: () => Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let step = 0; step < 2_000; step++) {
      if (yield* done()) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    assert.fail(`timed out waiting for: ${label}`);
  });

const queuedRunState = (threadId: ThreadId, runId: RunId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator
      .getThreadProjection(threadId)
      .pipe(Effect.map((projection) => projection.runs.find((run) => run.id === runId))),
  );

const setup = (name: string) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`project:${name}`);
    const threadId = ThreadId.make(`thread:${name}`);
    yield* createThread(threadId, projectId);
    const providerThreadId = yield* writeProviderThread(threadId);
    const first = yield* writeRun({
      threadId,
      ordinal: 1,
      status: "starting",
      providerThreadId,
      withExecution: true,
    });
    const next = yield* writeRun({
      threadId,
      ordinal: 2,
      status: "queued",
      providerThreadId,
      withExecution: true,
    });
    return { threadId, first, next };
  });

it.layer(TestLayer)("withdrawn fork-hook turns and the thread queue (Lecturn)", (it) => {
  it.effect("a cancelled held turn lets the queue start the next message", () =>
    Effect.gen(function* () {
      const { threadId, first, next } = yield* setup("hold-cancelled");
      yield* settleFirstRun({ threadId, runId: first.runId, outcome: "cancelled" });
      yield* eventually("the next queued run was promoted", () =>
        queuedRunState(threadId, next.runId).pipe(Effect.map((run) => run?.status !== "queued")),
      );
      assert.notEqual((yield* queuedRunState(threadId, next.runId))?.queueHeld, true);
    }),
  );

  it.effect("a refused (failed) turn still holds the queue for the user", () =>
    Effect.gen(function* () {
      const { threadId, first, next } = yield* setup("policy-refused");
      yield* settleFirstRun({ threadId, runId: first.runId, outcome: "failed" });
      yield* eventually("the queue was held", () =>
        queuedRunState(threadId, next.runId).pipe(Effect.map((run) => run?.queueHeld === true)),
      );
      assert.equal((yield* queuedRunState(threadId, next.runId))?.status, "queued");
    }),
  );
});
