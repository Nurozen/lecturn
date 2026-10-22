/**
 * Lecturn fork behavior on the production V2 orchestrator composition
 * (OrchestrationV2LayerLive): thread.import (A1), thread.fork deltas (A12),
 * a settled thread holding its queue (A13), the fork hook call sites, the
 * checkpoint revert preview (A2) and the worktree removal guard (A3).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
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
} from "@lecturn/contracts";
import * as Clock from "effect/Clock";
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
import type { ImportedTranscriptEntry, ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../ProviderAdapter.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import { threadHasQueuedTurnStart } from "../ThreadSettlementService.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "../runtimeLayer.ts";
import { previewCheckpointRevert } from "./CheckpointRevertPreview.ts";
import {
  LecturnHookRejectedError,
  LecturnOrchestrationHooks,
  type LecturnCheckpointRestoreInput,
  type LecturnThreadLifecycleNotice,
} from "./LecturnOrchestrationHooks.ts";
import { guardWorktreeRemoval, listThreadIdsUsingWorktree } from "./WorktreeRemovalGuard.ts";

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

  it.effect("holds the queue of a settled thread until it is unsettled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectId = ProjectId.make("project:settled-queue");
      const threadId = ThreadId.make("thread:settled-queue");
      yield* createThread(threadId, projectId);
      const providerThreadId = yield* writeProviderThread(threadId);
      const active = yield* writeRun({ threadId, ordinal: 1, status: "running", providerThreadId });
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
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`${threadId}:resume`),
        threadId,
      });
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.runs.find((run) => run.id === queued.runId)?.status, "queued");

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`${threadId}:unsettle`),
        threadId,
        reason: "user",
      });
      const released = yield* orchestrator.getThreadProjection(threadId);
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
