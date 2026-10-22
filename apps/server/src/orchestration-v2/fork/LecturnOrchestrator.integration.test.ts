/**
 * Lecturn fork behavior on the production V2 orchestrator composition
 * (RuntimeLayer.layer): thread.import (A1), thread.fork deltas (A12),
 * a settled thread holding its queue (A13), the fork hook call sites, the
 * checkpoint revert preview (A2) and the worktree removal guard (A3).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachment,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import type { ImportedTranscriptEntry, ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../ProviderAdapter.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import { OrchestrationEffectRequestV2 } from "../EffectOutbox.ts";
import * as ResourceCleanupService from "../ResourceCleanupService.ts";
import { threadHasQueuedTurnStart } from "../ThreadSettlementService.ts";
import * as RuntimeLayer from "../runtimeLayer.ts";
import { previewCheckpointRevert } from "./CheckpointRevertPreview.ts";
import {
  LecturnHookRejectedError,
  LecturnOrchestrationHooks,
  type LecturnCheckpointRestoreInput,
  type LecturnThreadLifecycleNotice,
} from "./LecturnOrchestrationHooks.ts";
import { guardWorktreeRemoval, listThreadIdsUsingWorktree } from "./WorktreeRemovalGuard.ts";

const decodeEffectRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationEffectRequestV2),
);
const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ChatAttachment)));

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;

let importCalls = 0;
let nextTranscript: ReadonlyArray<ImportedTranscriptEntry> = [];
const t = (minute: number) => `2026-05-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

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
  importExternalSession: (input) =>
    Effect.sync(() => {
      importCalls += 1;
      return {
        nativeThreadId: `fork-of-${input.sessionId}`,
        title: "External session",
        cwd: input.cwd,
        transcript: nextTranscript,
      };
    }),
} satisfies ProviderInstance;

const TestLayer = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
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

const seedProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: t(0),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Project",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: t(0),
        updatedAt: t(0),
      },
    }),
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

const importCommand = (threadId: ThreadId, projectId: ProjectId) =>
  ({
    type: "thread.import",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`${threadId}:import`),
    threadId,
    projectId,
    providerInstanceId: instanceId,
    sessionId: "external-1",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  }) as const;

/** A completed run with its user message, the minimum a fork can cut at. */
const writeRun = (input: {
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly providerThreadId: ProviderThreadId;
  readonly withExecution?: boolean;
  /** Attached to the user message, which then also gets its visible turn item. */
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`${input.threadId}:run:${input.ordinal}`);
    const messageId = MessageId.make(`${input.threadId}:message:${input.ordinal}`);
    const text = `message ${input.ordinal}`;
    const attachments = input.attachments ?? [];
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
            text,
            attachments,
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
        ...(input.attachments === undefined
          ? []
          : [
              {
                id: EventId.make(`${runId}:user-item`),
                type: "turn-item.updated" as const,
                threadId: input.threadId,
                runId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`${runId}:user-item`),
                  threadId: input.threadId,
                  runId,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: input.ordinal,
                  status: "completed" as const,
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  createdBy: "user" as const,
                  creationSource: "web" as const,
                  type: "user_message" as const,
                  messageId,
                  inputIntent: "turn_start" as const,
                  text,
                  attachments,
                },
              },
            ]),
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

/** A thread migrated from V1: run-less messages and turn items, historyOrigin v1_import. */
const writeLegacyThread = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly texts: ReadonlyArray<readonly ["user" | "assistant", string]>;
  /** Attached to the first message. */
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* createThread(input.threadId, input.projectId);
    const thread = (yield* orchestrator.getThreadProjection(input.threadId)).thread;
    const at = DateTime.makeUnsafe(t(1));
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${input.threadId}:legacy`),
          type: "thread.metadata-updated",
          threadId: input.threadId,
          occurredAt: at,
          payload: { ...thread, historyOrigin: "v1_import" },
        },
        ...input.texts.flatMap(([role, text], index) => {
          const messageId = MessageId.make(`${input.threadId}:legacy-message:${index}`);
          const attachments = index === 0 ? (input.attachments ?? []) : [];
          const common = {
            id: TurnItemId.make(`${input.threadId}:legacy-item:${index}`),
            threadId: input.threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: index + 1,
            status: "completed" as const,
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
          };
          return [
            {
              id: EventId.make(`${input.threadId}:legacy-message:${index}`),
              type: "message.updated" as const,
              threadId: input.threadId,
              occurredAt: at,
              payload: {
                createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                creationSource: "server" as const,
                id: messageId,
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                role,
                text,
                attachments,
                streaming: false,
                createdAt: at,
                updatedAt: at,
              },
            },
            {
              id: EventId.make(`${input.threadId}:legacy-item:${index}`),
              type: "turn-item.updated" as const,
              threadId: input.threadId,
              occurredAt: at,
              payload:
                role === "user"
                  ? {
                      ...common,
                      createdBy: "user" as const,
                      creationSource: "server" as const,
                      type: "user_message" as const,
                      messageId,
                      inputIntent: "turn_start" as const,
                      text,
                      attachments,
                    }
                  : {
                      ...common,
                      type: "assistant_message" as const,
                      messageId,
                      text,
                      streaming: false,
                    },
            },
          ];
        }),
      ],
    });
    return input.texts.map((_, index) =>
      MessageId.make(`${input.threadId}:legacy-message:${index}`),
    );
  });

const sendMessage = (threadId: ThreadId, text: string, titleSeed?: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${threadId}:send:${text}`),
      threadId,
      messageId: MessageId.make(`${threadId}:send:${text}`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      ...(titleSeed === undefined ? {} : { titleSeed }),
    }),
  );

const transcriptText = (projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems">) =>
  projection.visibleTurnItems.flatMap((row) =>
    row.item.type === "user_message" || row.item.type === "assistant_message"
      ? [row.item.text]
      : [],
  );

it.layer(TestLayer)("Lecturn fork behavior on the V2 orchestrator", (it) => {
  it.effect("imports an external session as run-less history on a native fork", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hooks = yield* LecturnOrchestrationHooks;
      const notices: Array<LecturnThreadLifecycleNotice> = [];
      yield* hooks.register({
        name: "test-relay",
        onThreadLifecycle: (notice) => Effect.sync(() => void notices.push(notice)),
      });
      const projectId = ProjectId.make("project:import");
      yield* seedProject(projectId, "/repo/import");
      const threadId = ThreadId.make("thread:imported");
      importCalls = 0;
      nextTranscript = [
        { kind: "message", role: "user", text: "fix the bug", createdAt: t(1) },
        {
          kind: "activity",
          tone: "tool",
          activityKind: "tool.completed",
          summary: "Ran tests",
          itemType: "command_execution",
          detail: "vp test",
          createdAt: t(2),
        },
        { kind: "message", role: "assistant", text: "fixed", createdAt: t(3) },
      ];

      yield* orchestrator.dispatch(importCommand(threadId, projectId));
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "External session");
      assert.equal(projection.thread.importedFrom?.sessionId, "external-1");
      assert.equal(projection.thread.importedFrom?.cwd, "/repo/import");
      assert.isFalse(projection.thread.importedFrom?.historyTruncated);
      assert.deepEqual(
        projection.messages.map((message) => [message.role, message.text, message.runId]),
        [
          ["user", "fix the bug", null],
          ["assistant", "fixed", null],
        ],
      );
      assert.lengthOf(projection.runs, 0);
      assert.deepEqual(projection.providerThreads[0]?.nativeThreadRef, {
        driver,
        nativeId: "fork-of-external-1",
        strength: "strong",
      });
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.equal(shell?.importedFrom?.sessionId, "external-1");
      // Imported history never counts as a queued turn start.
      assert.isFalse(threadHasQueuedTurnStart(shell!, yield* Clock.currentTimeMillis));
      assert.deepEqual(
        notices.map((notice) => notice.kind),
        ["imported"],
      );

      // A retried command id replays its receipt and never forks again.
      yield* orchestrator.dispatch(importCommand(threadId, projectId));
      assert.equal(importCalls, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects imports before forking when they cannot succeed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:import-reject");
      yield* seedProject(projectId, "/repo/import-reject");
      importCalls = 0;
      nextTranscript = [];
      const missingProject = yield* Effect.flip(
        orchestrator.dispatch(
          importCommand(ThreadId.make("thread:import-no-project"), ProjectId.make("project:none")),
        ),
      );
      assert.equal(missingProject._tag, "OrchestratorDispatchError");
      const wrongInstance = yield* Effect.flip(
        orchestrator.dispatch({
          ...importCommand(ThreadId.make("thread:import-wrong"), projectId),
          modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "x" },
        }),
      );
      assert.equal(wrongInstance._tag, "OrchestratorDispatchError");
      assert.equal(importCalls, 0);
      const empty = yield* Effect.flip(
        orchestrator.dispatch(importCommand(ThreadId.make("thread:import-empty"), projectId)),
      );
      // The rejection detail sits several causes deep; the serialized error shows it.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.include(JSON.stringify(empty), "empty-session");
      assert.isNull(yield* orchestrator.getThreadShell(ThreadId.make("thread:import-empty")));
    }),
  );

  it.effect("records the fork cut and anchors the fork at the message's run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hooks = yield* LecturnOrchestrationHooks;
      const notices: Array<LecturnThreadLifecycleNotice> = [];
      yield* hooks.register({
        name: "test-relay",
        onThreadLifecycle: (notice) => Effect.sync(() => void notices.push(notice)),
      });
      const projectId = ProjectId.make("project:fork");
      const sourceThreadId = ThreadId.make("thread:fork-source");
      const targetThreadId = ThreadId.make("thread:fork-child");
      yield* createThread(sourceThreadId, projectId);
      const providerThreadId = yield* writeProviderThread(sourceThreadId);
      const first = yield* writeRun({
        threadId: sourceThreadId,
        ordinal: 1,
        status: "completed",
        providerThreadId,
      });
      yield* writeRun({
        threadId: sourceThreadId,
        ordinal: 2,
        status: "completed",
        providerThreadId,
      });

      const missingWorktree = yield* Effect.flip(
        orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("fork:new-worktree"),
          sourceThreadId,
          targetThreadId: ThreadId.make("thread:fork-worktree"),
          sourcePoint: { type: "latest_stable" },
          workspace: "new-worktree",
        }),
      );
      // The rejection detail sits several causes deep; the serialized error shows it.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.include(JSON.stringify(missingWorktree), "needs the worktree to prepare");

      yield* orchestrator.dispatch({
        type: "thread.fork",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("fork:cut"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sourceMessageId: first.messageId,
      });
      const child = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.deepEqual(child.thread.forkOrigin, {
        threadId: sourceThreadId,
        messageId: first.messageId,
      });
      assert.deepEqual(child.thread.forkedFrom, {
        type: "run",
        threadId: sourceThreadId,
        runId: first.runId,
      });
      assert.deepEqual((yield* orchestrator.getThreadShell(targetThreadId))?.forkOrigin, {
        threadId: sourceThreadId,
        messageId: first.messageId,
      });
      const forked = notices.find((notice) => notice.kind === "forked");
      assert.equal(forked?.kind === "forked" ? forked.relayAlert : undefined, false);
    }).pipe(Effect.scoped),
  );

  it.effect("forks an imported thread with its import origin and imported history", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:import-fork");
      yield* seedProject(projectId, "/repo/import-fork");
      const sourceThreadId = ThreadId.make("thread:import-fork-source");
      nextTranscript = [
        { kind: "message", role: "user", text: "IMPORTED_QUESTION", createdAt: t(1) },
        { kind: "message", role: "assistant", text: "IMPORTED_ANSWER", createdAt: t(2) },
      ];
      yield* orchestrator.dispatch({
        ...importCommand(sourceThreadId, projectId),
        commandId: CommandId.make("import-fork:import"),
        sessionId: "external-fork",
      });
      const imported = yield* orchestrator.getThreadProjection(sourceThreadId);
      const providerThreadId = imported.providerThreads[0]!.id;
      const run = yield* writeRun({
        threadId: sourceThreadId,
        ordinal: 1,
        status: "completed",
        providerThreadId,
      });
      const targetThreadId = ThreadId.make("thread:import-fork-child");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("import-fork:fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: run.runId },
      });
      const child = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.deepEqual(child.thread.importedFrom, imported.thread.importedFrom);
      const inheritedTexts = child.visibleTurnItems.flatMap((row) =>
        row.item.type === "user_message" || row.item.type === "assistant_message"
          ? [row.item.text]
          : [],
      );
      assert.includeMembers(inheritedTexts, ["IMPORTED_QUESTION", "IMPORTED_ANSWER"]);
    }),
  );

  it.effect("forks V1-migrated history at a user message via portable context", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:legacy-fork");
      yield* seedProject(projectId, "/repo/legacy-fork");
      const sourceThreadId = ThreadId.make("thread:legacy-fork-source");
      const targetThreadId = ThreadId.make("thread:legacy-fork-child");
      const messageIds = yield* writeLegacyThread({
        threadId: sourceThreadId,
        projectId,
        texts: [
          ["user", "LEGACY_QUESTION_1"],
          ["assistant", "LEGACY_ANSWER_1"],
          ["user", "LEGACY_QUESTION_2"],
          ["assistant", "LEGACY_ANSWER_2"],
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("legacy-fork:cut"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sourceMessageId: messageIds[0]!,
      });
      const child = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.isNull(child.thread.forkedFrom);
      assert.equal(child.thread.lineage.relationshipToParent, "fork");
      assert.deepEqual(child.thread.forkOrigin, {
        threadId: sourceThreadId,
        messageId: messageIds[0]!,
      });
      assert.deepEqual(transcriptText(child), ["LEGACY_QUESTION_1", "LEGACY_ANSWER_1"]);
      assert.deepEqual(
        child.messages.map((message) => [message.text, message.runId]),
        [
          ["LEGACY_QUESTION_1", null],
          ["LEGACY_ANSWER_1", null],
        ],
      );
      const transfer = child.contextTransfers.find((candidate) => candidate.type === "fork");
      assert.equal(transfer?.status, "pending");
      assert.isUndefined(transfer?.sourcePoint.runId);

      // The child's first turn receives the copied history as portable context.
      yield* sendMessage(targetThreadId, "continue");
      const continued = yield* orchestrator.getThreadProjection(targetThreadId);
      const consumed = continued.contextTransfers.find((candidate) => candidate.type === "fork");
      assert.equal(consumed?.status, "consumed");
      assert.equal(consumed?.resolution?.strategy, "portable_context");
      const handoff = continued.contextHandoffs[0]!;
      assert.equal(continued.runs[0]?.contextHandoffId, handoff.id);
      const context = `${handoff.summaryText}\n${handoff.history?.messages.map((message) => message.text).join("\n") ?? ""}`;
      assert.include(context, "LEGACY_QUESTION_1");
      assert.include(context, "LEGACY_ANSWER_1");
      assert.notInclude(context, "LEGACY_QUESTION_2");
      // The source keeps its history untouched.
      assert.lengthOf((yield* orchestrator.getThreadProjection(sourceThreadId)).messages, 4);
    }),
  );

  it.effect("forks a whole thread whose only history is run-less", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:runless-whole");
      yield* seedProject(projectId, "/repo/runless-whole");
      const legacyThreadId = ThreadId.make("thread:runless-whole-legacy");
      yield* writeLegacyThread({
        threadId: legacyThreadId,
        projectId,
        texts: [
          ["user", "WHOLE_QUESTION"],
          ["assistant", "WHOLE_ANSWER"],
        ],
      });
      const importedThreadId = ThreadId.make("thread:runless-whole-imported");
      nextTranscript = [
        { kind: "message", role: "user", text: "IMPORTED_Q", createdAt: t(1) },
        { kind: "message", role: "assistant", text: "IMPORTED_A", createdAt: t(2) },
      ];
      yield* orchestrator.dispatch({
        ...importCommand(importedThreadId, projectId),
        commandId: CommandId.make("runless-whole:import"),
        sessionId: "external-whole",
      });
      for (const [sourceThreadId, expected] of [
        [legacyThreadId, ["WHOLE_QUESTION", "WHOLE_ANSWER"]],
        [importedThreadId, ["IMPORTED_Q", "IMPORTED_A"]],
      ] as const) {
        const targetThreadId = ThreadId.make(`${sourceThreadId}:child`);
        yield* orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${sourceThreadId}:fork-whole`),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
        });
        const child = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.deepEqual(transcriptText(child), [...expected]);
        assert.deepEqual(child.thread.forkOrigin, { threadId: sourceThreadId, messageId: null });
        yield* sendMessage(targetThreadId, "go on");
        const continued = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.equal(
          continued.contextTransfers.find((candidate) => candidate.type === "fork")?.resolution
            ?.strategy,
          "portable_context",
        );
        assert.include(continued.contextHandoffs[0]?.summaryText ?? "", expected[1]);
      }
      // An imported anchor cuts the import too.
      const imported = yield* orchestrator.getThreadProjection(importedThreadId);
      const importedQuestion = imported.messages.find((message) => message.text === "IMPORTED_Q")!;
      const cutChildId = ThreadId.make("thread:runless-whole-imported:cut");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runless-whole:imported-cut"),
        sourceThreadId: importedThreadId,
        targetThreadId: cutChildId,
        sourcePoint: { type: "latest_stable" },
        sourceMessageId: importedQuestion.id,
      });
      const cutChild = yield* orchestrator.getThreadProjection(cutChildId);
      assert.deepEqual(transcriptText(cutChild), ["IMPORTED_Q", "IMPORTED_A"]);
      assert.deepEqual(cutChild.thread.importedFrom, imported.thread.importedFrom);
    }),
  );

  it.effect("keeps attachment files a run-less fork shares until no live thread shows them", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const projectId = ProjectId.make("project:fork-attachments");
      yield* seedProject(projectId, "/repo/fork-attachments");
      const sourceThreadId = ThreadId.make("thread:fork-attachments-source");
      const image = (id: string): ChatAttachment => ({
        type: "image",
        id,
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      });
      const sharedId = "thread-fork-attachments-source-0b5e7c1a-3f7d-4c55-9a7e-2d4f1e6b8c90";
      const legacyId = "thread-fork-attachments-legacy-5a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
      yield* writeLegacyThread({
        threadId: sourceThreadId,
        projectId,
        texts: [
          ["user", "LOOK_AT_THIS"],
          ["assistant", "SEEN"],
        ],
        attachments: [image(sharedId), image(legacyId)],
      });
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      const fileOf = (id: string) => `${attachmentsDir}/${id}.png`;
      yield* fileSystem.writeFileString(fileOf(sharedId), "png!");
      yield* fileSystem.writeFileString(fileOf(legacyId), "png!");
      const forkChild = (suffix: string) =>
        Effect.gen(function* () {
          const targetThreadId = ThreadId.make(`${sourceThreadId}:${suffix}`);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${targetThreadId}:fork`),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
          });
          return targetThreadId;
        });
      const firstChild = yield* forkChild("first");
      const secondChild = yield* forkChild("second");
      // The copied history keeps the source's attachment refs.
      const copied = (yield* orchestrator.getThreadProjection(firstChild)).messages;
      assert.deepEqual(
        copied.flatMap((message) => message.attachments.map((attachment) => attachment.id)),
        [sharedId, legacyId],
      );
      // A V1 thread whose transcript is not hydrated yet shows legacyId too.
      const legacyThreadId = ThreadId.make("thread:fork-attachments-legacy");
      yield* createThread(legacyThreadId, projectId);
      yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at)
        VALUES (${legacyThreadId}, ${t(0)}, ${t(0)})`;
      yield* sql`INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES (
          'message:fork-attachments-legacy', ${legacyThreadId}, NULL, 'user', 'legacy', ${encodeAttachments([image(legacyId)])},
          0, ${t(0)}, ${t(0)}
        )`;

      const deleteAndClean = (threadId: ThreadId) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`${threadId}:delete`),
            threadId,
          });
          const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${threadId} AND effect_type = 'attachment.cleanup'`;
          assert.lengthOf(rows, 1);
          const request = yield* decodeEffectRequest(rows[0]!.payload_json);
          assert(request.type === "attachment.cleanup");
          assert.sameMembers([...request.attachmentIds], [sharedId, legacyId]);
          yield* cleanup.cleanupAttachments(request.attachmentIds, threadId);
        });
      const exists = (id: string) => fileSystem.exists(fileOf(id));

      // Deleting a fork child keeps the source's files.
      yield* deleteAndClean(firstChild);
      assert.isTrue(yield* exists(sharedId));
      // Deleting the source keeps the files its other child still shows.
      yield* deleteAndClean(sourceThreadId);
      assert.isTrue(yield* exists(sharedId));
      // The last thread showing a file removes it.
      yield* deleteAndClean(secondChild);
      assert.isFalse(yield* exists(sharedId));
      assert.isTrue(yield* exists(legacyId));
      // Once the V1 transcript is hydrated, only V2 messages count.
      yield* sql`UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = ${t(1)}
        WHERE thread_id = ${legacyThreadId}`;
      yield* cleanup.cleanupAttachments([legacyId], secondChild);
      assert.isFalse(yield* exists(legacyId));
    }).pipe(
      Effect.provide(
        ResourceCleanupService.layer.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-fork-attachments-" }),
          ),
          Layer.provide(Layer.mock(TerminalManager.TerminalManager)({})),
        ),
      ),
    ),
  );

  it.effect("keeps attachment files a native fork shows by reference while it is live", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const projectId = ProjectId.make("project:native-fork-attachments");
      yield* seedProject(projectId, "/repo/native-fork-attachments");
      const image = (id: string): ChatAttachment => ({
        type: "image",
        id,
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      });
      const sourceImage = "thread-native-fork-source-7c2e9a40-1b3d-4f5e-8a6b-0c1d2e3f4a5b";
      const childImage = "thread-native-fork-child-3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7";
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      const fileOf = (id: string) => `${attachmentsDir}/${id}.png`;
      const exists = (id: string) => fileSystem.exists(fileOf(id));
      yield* fileSystem.writeFileString(fileOf(sourceImage), "png!");
      yield* fileSystem.writeFileString(fileOf(childImage), "png!");

      const withRun = (threadId: ThreadId, attachmentId: string) =>
        Effect.flatMap(writeProviderThread(threadId), (providerThreadId) =>
          writeRun({
            threadId,
            ordinal: 1,
            status: "completed",
            providerThreadId,
            attachments: [image(attachmentId)],
          }),
        );
      const fork = (
        sourceThreadId: ThreadId,
        targetThreadId: ThreadId,
        sourceMessageId: MessageId,
      ) =>
        orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${targetThreadId}:fork`),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
          sourceMessageId,
        });
      // source <- child <- grandchild, each a native fork storing no copies.
      const sourceThreadId = ThreadId.make("thread:native-fork-attachments-source");
      const childThreadId = ThreadId.make("thread:native-fork-attachments-child");
      const grandchildThreadId = ThreadId.make("thread:native-fork-attachments-grandchild");
      yield* createThread(sourceThreadId, projectId);
      const sourceRun = yield* withRun(sourceThreadId, sourceImage);
      yield* fork(sourceThreadId, childThreadId, sourceRun.messageId);
      const childRun = yield* withRun(childThreadId, childImage);
      yield* fork(childThreadId, grandchildThreadId, childRun.messageId);
      const grandchild = yield* orchestrator.getThreadProjection(grandchildThreadId);
      assert.equal(grandchild.thread.forkedFrom?.type, "run");
      assert.lengthOf(grandchild.messages, 0);
      const shownImages = (projection: OrchestrationV2ThreadProjection) =>
        projection.visibleTurnItems.flatMap((row) =>
          row.item.type === "user_message"
            ? row.item.attachments.map((attachment) => attachment.id)
            : [],
        );
      assert.deepEqual(shownImages(grandchild), [sourceImage, childImage]);

      const deleteAndClean = (threadId: ThreadId) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`${threadId}:delete`),
            threadId,
          });
          const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${threadId} AND effect_type = 'attachment.cleanup'`;
          assert.lengthOf(rows, 1);
          const request = yield* decodeEffectRequest(rows[0]!.payload_json);
          assert(request.type === "attachment.cleanup");
          yield* cleanup.cleanupAttachments(request.attachmentIds, threadId);
        });
      // Deleting the child, then the source (reached only through the deleted
      // child), keeps what the live grandchild shows.
      yield* deleteAndClean(childThreadId);
      yield* deleteAndClean(sourceThreadId);
      assert.isTrue(yield* exists(sourceImage));
      assert.isTrue(yield* exists(childImage));
      // The grandchild still renders the deleted threads' history.
      assert.deepEqual(shownImages(yield* orchestrator.getThreadProjection(grandchildThreadId)), [
        sourceImage,
        childImage,
      ]);
      // With no live descendant, a deleted thread's own files are removed.
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`${grandchildThreadId}:delete`),
        threadId: grandchildThreadId,
      });
      yield* cleanup.cleanupAttachments([childImage], childThreadId);
      assert.isFalse(yield* exists(childImage));
    }).pipe(
      Effect.provide(
        ResourceCleanupService.layer.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-native-fork-attachments-" }),
          ),
          Layer.provide(Layer.mock(TerminalManager.TerminalManager)({})),
        ),
      ),
    ),
  );

  it.effect("keeps a fork child's rename through its first send", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:fork-title");
      yield* seedProject(projectId, "/repo/fork-title");
      const sourceThreadId = ThreadId.make("thread:fork-title-source");
      yield* createThread(sourceThreadId, projectId);
      const providerThreadId = yield* writeProviderThread(sourceThreadId);
      const run = yield* writeRun({
        threadId: sourceThreadId,
        ordinal: 1,
        status: "completed",
        providerThreadId,
      });
      const fork = (targetThreadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${targetThreadId}:fork`),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "run", runId: run.runId },
          title: "Source (fork)",
        });
      const renamedId = ThreadId.make("thread:fork-title-renamed");
      yield* fork(renamedId);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("fork-title:rename"),
        threadId: renamedId,
        title: "My own name",
      });
      yield* sendMessage(renamedId, "first message", "first message");
      const renamed = yield* orchestrator.getThreadProjection(renamedId);
      assert.equal(renamed.thread.title, "My own name");
      assert.isUndefined(renamed.thread.titleRegeneration ?? undefined);

      // A child that still has the client's default "(fork)" title takes the seed.
      const defaultId = ThreadId.make("thread:fork-title-default");
      yield* fork(defaultId);
      yield* sendMessage(defaultId, "seeded message", "seeded message");
      assert.equal(
        (yield* orchestrator.getThreadProjection(defaultId)).thread.title,
        "seeded message",
      );
    }),
  );

  it.effect.each(["thread.unsettle", "thread.pin"] as const)(
    "holds the queue of a settled thread until %s releases it",
    (release) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make(`project:settled-queue:${release}`);
        const threadId = ThreadId.make(`thread:settled-queue:${release}`);
        yield* createThread(threadId, projectId);
        const providerThreadId = yield* writeProviderThread(threadId);
        const active = yield* writeRun({
          threadId,
          ordinal: 1,
          status: "running",
          providerThreadId,
        });
        const queued = yield* writeRun({
          threadId,
          ordinal: 2,
          status: "queued",
          providerThreadId,
          withExecution: true,
        });
        const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
        const now = yield* DateTime.now;
        // Settled while work was queued (e.g. an automatic wake queued after settling).
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:settled`),
              type: "thread.settled",
              threadId,
              occurredAt: now,
              payload: { ...thread, settledOverride: "settled", settledAt: now },
            },
          ],
        });
        const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === active.runId,
        )!;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:active-completed`),
              type: "run.updated",
              threadId,
              runId: active.runId,
              occurredAt: now,
              payload: { ...activeRun, status: "completed", completedAt: now },
            },
          ],
        });
        // Resuming a settled thread's queue says why it cannot run.
        const resume = yield* Effect.flip(
          orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          }),
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.include(JSON.stringify(resume), "Unsettle it to resume its queue");
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs.find((run) => run.id === queued.runId)?.status, "queued");

        yield* orchestrator.dispatch(
          release === "thread.unsettle"
            ? {
                type: "thread.unsettle",
                commandId: CommandId.make(`${threadId}:release`),
                threadId,
                reason: "user",
              }
            : {
                type: "thread.pin",
                commandId: CommandId.make(`${threadId}:release`),
                threadId,
              },
        );
        const released = yield* orchestrator.getThreadProjection(threadId);
        assert.notEqual(released.thread.settledOverride, "settled");
        assert.notEqual(released.runs.find((run) => run.id === queued.runId)?.status, "queued");
      }),
  );

  it.effect("lets a fork contribution reject a command without recording a receipt", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hooks = yield* LecturnOrchestrationHooks;
      let reject = true;
      yield* hooks.register({
        name: "stave",
        aroundCommand: (input, commit) =>
          reject && input.scope === "thread" && input.command.type === "thread.create"
            ? Effect.fail(
                new LecturnHookRejectedError({
                  hook: "aroundCommand",
                  contribution: "stave",
                  reason: "A Stave operation is changing this space. Retry when it finishes.",
                }),
              )
            : commit,
      });
      const threadId = ThreadId.make("thread:admission");
      const rejected = yield* Effect.flip(
        createThread(threadId, ProjectId.make("project:admission")),
      );
      assert.equal(rejected._tag, "OrchestratorCommandRejectedError");
      reject = false;
      // The same command id succeeds once the space is free.
      yield* createThread(threadId, ProjectId.make("project:admission"));
      assert.isNotNull(yield* orchestrator.getThreadShell(threadId));
    }).pipe(Effect.scoped),
  );

  it.effect("previews files a restoring rollback would delete, capped", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:preview");
      yield* createThread(threadId, ProjectId.make("project:preview"));
      const now = yield* DateTime.now;
      const scopeId = CheckpointScopeId.make("scope:preview");
      const checkpointId = CheckpointId.make("checkpoint:preview");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("preview:scope"),
            type: "checkpoint-scope.created",
            threadId,
            occurredAt: now,
            payload: {
              id: scopeId,
              threadId,
              runId: null,
              nodeId: NodeId.make("node:preview"),
              parentScopeId: null,
              providerThreadId: null,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: "/repo/preview",
              createdAt: now,
            },
          },
          {
            id: EventId.make("preview:checkpoint"),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: {
              id: checkpointId,
              scopeId,
              threadId,
              runId: null,
              nodeId: NodeId.make("node:preview"),
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: 1,
              ref: CheckpointRef.make("refs/lecturn/checkpoints/preview/0"),
              status: "ready",
              files: [],
              capturedAt: now,
            },
          },
        ],
      });
      const preview = yield* previewCheckpointRevert({ threadId, scopeId, checkpointId });
      assert.lengthOf(preview.removedPaths, 200);
      assert.isTrue(preview.truncated);
      assert.equal(preview.removedPaths[0], "/repo/preview/untracked-0.txt");
      const unknown = yield* previewCheckpointRevert({
        threadId,
        scopeId,
        checkpointId: CheckpointId.make("checkpoint:unknown"),
      });
      assert.deepEqual(unknown, { removedPaths: [], truncated: false });
    }),
  );

  it.effect("refuses to remove a worktree another thread, archived included, still uses", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:worktree");
      const owner = ThreadId.make("thread:worktree-owner");
      const sharer = ThreadId.make("thread:worktree-sharer");
      yield* createThread(owner, projectId, "/worktrees/shared");
      yield* createThread(sharer, projectId, "/worktrees/shared");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-sharer"),
        threadId: sharer,
      });
      assert.deepEqual(
        yield* listThreadIdsUsingWorktree("/worktrees/shared/", { excludeThreadId: owner }),
        [sharer],
      );
      const refused = yield* Effect.flip(
        guardWorktreeRemoval("/worktrees/shared", Effect.succeed("removed"), {
          excludeThreadId: owner,
        }),
      );
      assert.equal(refused._tag, "WorktreeStillInUseError");
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-sharer"),
        threadId: sharer,
      });
      assert.equal(
        yield* guardWorktreeRemoval("/worktrees/shared", Effect.succeed("removed"), {
          excludeThreadId: owner,
        }),
        "removed",
      );
    }),
  );

  it.effect("lets a fork contribution refuse a file-restoring rollback at admission", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const hooks = yield* LecturnOrchestrationHooks;
      const reason = "Checkpoints are unavailable for Stave spaces.";
      const asked: Array<LecturnCheckpointRestoreInput> = [];
      yield* hooks.register({
        name: "stave",
        beforeCheckpointRestore: (input) =>
          Effect.sync(() => void asked.push(input)).pipe(
            Effect.andThen(
              Effect.fail(
                new LecturnHookRejectedError({
                  hook: "beforeCheckpointRestore",
                  contribution: "stave",
                  reason,
                }),
              ),
            ),
          ),
      });
      const projectId = ProjectId.make("project:restore-space");
      const threadId = ThreadId.make("thread:restore-space");
      yield* seedProject(projectId, "/spaces/restore");
      yield* createThread(threadId, projectId);
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("thread:restore-space:provider-thread");
      const scopeId = CheckpointScopeId.make("scope:restore-space");
      const checkpointId = CheckpointId.make("checkpoint:restore-space");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("restore-space:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: "provider-session:restore-space" as never,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "restore-space:native", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("restore-space:scope"),
            type: "checkpoint-scope.created",
            threadId,
            occurredAt: now,
            payload: {
              id: scopeId,
              threadId,
              runId: null,
              nodeId: NodeId.make("node:restore-space"),
              parentScopeId: null,
              providerThreadId: null,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: "/spaces/restore",
              createdAt: now,
            },
          },
          {
            id: EventId.make("restore-space:checkpoint"),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: {
              id: checkpointId,
              scopeId,
              threadId,
              runId: null,
              nodeId: NodeId.make("node:restore-space"),
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make("refs/lecturn/checkpoints/restore-space/0"),
              status: "ready",
              files: [],
              capturedAt: now,
            },
          },
        ],
      });
      const refused = yield* Effect.flip(
        orchestrator.dispatch({
          type: "checkpoint.rollback",
          commandId: CommandId.make("restore-space:rollback"),
          threadId,
          scopeId,
          checkpointId,
          restoreFiles: true,
        }),
      );
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.equal((refused as { readonly cause?: unknown }).cause, reason);
      assert.deepEqual(asked, [
        { threadId, projectId, workspaceRoot: "/spaces/restore", scopeCwd: "/spaces/restore" },
      ]);
    }).pipe(Effect.scoped),
  );
});
