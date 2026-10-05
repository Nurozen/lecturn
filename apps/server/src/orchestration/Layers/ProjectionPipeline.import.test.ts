import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ThreadImportedPayload,
} from "@lecturn/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as StaveWorkspaceReader from "../../stave/StaveWorkspaceReader.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const TestLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(StaveWorkspaceReader.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(
    Layer.fresh(
      OrchestrationProjectionPipelineLive.pipe(
        Layer.provideMerge(OrchestrationEventStoreLive),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-projection-pipeline-import-" }),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.layer(TestLayer)("OrchestrationProjectionPipeline thread.imported", (it) => {
  const now = "2026-06-01T00:00:00.000Z";
  const importAt = "2026-06-01T01:00:00.000Z";
  const projectId = ProjectId.make("project-import-pipe");
  const threadId = ThreadId.make("thread-import-pipe");
  const plainThreadId = ThreadId.make("thread-import-pipe-plain");

  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-4-5",
  };

  const userMessageId = MessageId.make("00000000-0000-4000-8000-000000000e01");
  const assistantMessageId = MessageId.make("assistant:00000000-0000-4000-8000-000000000e02");
  const activityId = EventId.make("00000000-0000-4000-8000-000000000e03");

  const importedFrom = {
    providerInstanceId: modelSelection.instanceId,
    driverKind: ProviderDriverKind.make("claudeAgent"),
    sessionId: "external-session-pipe",
    cwd: "/tmp/project-import-pipe",
    title: "External session",
    importedAt: importAt,
    historyTruncated: true,
  };
  const importSource = {
    providerInstanceId: modelSelection.instanceId,
    resumeCursor: { resume: "forked-session-pipe" },
  };

  const importedPayload: ThreadImportedPayload = {
    threadId,
    importedFrom,
    importSource,
    history: {
      messages: [
        {
          id: userMessageId,
          role: "user",
          text: "imported ask",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-05-31T10:00:00.000Z",
          updatedAt: "2026-05-31T10:00:00.000Z",
        },
        {
          id: assistantMessageId,
          role: "assistant",
          text: "imported answer",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-05-31T10:00:02.000Z",
          updatedAt: "2026-05-31T10:00:02.000Z",
        },
      ],
      activities: [
        {
          id: activityId,
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran command",
          payload: { itemType: "command_execution", title: "Ran command", detail: "bun test" },
          turnId: null,
          createdAt: "2026-05-31T10:00:01.000Z",
        },
      ],
      proposedPlans: [],
      turns: [],
    },
  };

  const appendEvent = (input: {
    readonly eventId: string;
    readonly type: OrchestrationEvent["type"];
    readonly aggregateKind: "project" | "thread";
    readonly aggregateId: string;
    readonly occurredAt?: string;
    readonly payload: unknown;
  }) =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      return yield* eventStore.append({
        type: input.type,
        eventId: EventId.make(input.eventId),
        aggregateKind: input.aggregateKind,
        aggregateId:
          input.aggregateKind === "project"
            ? ProjectId.make(input.aggregateId)
            : ThreadId.make(input.aggregateId),
        occurredAt: input.occurredAt ?? now,
        commandId: CommandId.make(`cmd-${input.eventId}`),
        causationEventId: null,
        correlationId: CommandId.make(`cmd-${input.eventId}`),
        metadata: {},
        payload: input.payload,
      } as never);
    });

  const threadCreatedPayload = (id: ThreadId, createdAt: string) => ({
    threadId: id,
    projectId,
    title: "External session",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
    updatedAt: createdAt,
  });

  it.effect("projects turn-less history rows, the origin and the server-only cursor", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* appendEvent({
        eventId: "evt-import-pipe-project",
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        payload: {
          projectId,
          title: "Import Pipe Project",
          workspaceRoot: "/tmp/project-import-pipe",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* appendEvent({
        eventId: "evt-import-pipe-plain",
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: plainThreadId,
        payload: threadCreatedPayload(plainThreadId, now),
      });
      yield* appendEvent({
        eventId: "evt-import-pipe-created",
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: importAt,
        payload: threadCreatedPayload(threadId, importAt),
      });
      yield* appendEvent({
        eventId: "evt-import-pipe-imported",
        type: "thread.imported",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: importAt,
        payload: importedPayload,
      });

      yield* projectionPipeline.bootstrap;

      const messages = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly attachmentsJson: string | null;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          attachments_json AS "attachmentsJson"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at, message_id
      `;
      assert.deepEqual(messages, [
        { messageId: userMessageId, turnId: null, attachmentsJson: "[]" },
        { messageId: assistantMessageId, turnId: null, attachmentsJson: "[]" },
      ]);

      const activities = yield* sql<{
        readonly activityId: string;
        readonly turnId: string | null;
      }>`
        SELECT activity_id AS "activityId", turn_id AS "turnId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(activities, [{ activityId, turnId: null }]);

      const turnRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM projection_turns WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(turnRows[0]?.count, 0);
      const threadRows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [{ latestTurnId: null }]);

      // Every wire shape carries the origin, and none carries the cursor.
      const shell = Option.getOrThrow(yield* snapshotQuery.getThreadShellById(threadId));
      assert.deepEqual(shell.importedFrom, importedFrom);
      assert.isNull(shell.latestTurn);
      assert.strictEqual(shell.latestUserMessageAt, "2026-05-31T10:00:00.000Z");
      const detail = Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(threadId));
      assert.deepEqual(detail.importedFrom, importedFrom);
      assert.deepEqual(
        detail.messages.map((message) => message.text),
        ["imported ask", "imported answer"],
      );
      assert.deepEqual(
        detail.activities.map((activity) => activity.id),
        [activityId],
      );
      const detailSnapshot = Option.getOrThrow(
        yield* snapshotQuery.getThreadDetailSnapshot(threadId),
      );
      assert.deepEqual(detailSnapshot.thread.importedFrom, importedFrom);
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.importedFrom,
        importedFrom,
      );
      for (const wireThread of [shell, detail, detailSnapshot.thread]) {
        assert.notProperty(wireThread, "importSource");
      }

      assert.deepEqual(
        Option.getOrThrow(yield* snapshotQuery.getThreadImportSourceById(threadId)),
        importSource,
      );

      // The list of cursors the external session lister hides.
      assert.deepEqual(yield* snapshotQuery.listThreadImportSources(), [importSource]);

      // A thread that was never imported reports neither.
      const plainShell = Option.getOrThrow(yield* snapshotQuery.getThreadShellById(plainThreadId));
      assert.isUndefined(plainShell.importedFrom);
      assert.isTrue(Option.isNone(yield* snapshotQuery.getThreadImportSourceById(plainThreadId)));
    }),
  );

  it.effect("keeps imported history through reverts and prunes only real turns", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig;
      const revertThreadId = ThreadId.make("thread-import-revert");
      const removedAttachmentId = "thread-import-revert-00000000-0000-4000-8000-000000000f01";

      const project = (input: Parameters<typeof appendEvent>[0]) =>
        appendEvent(input).pipe(Effect.flatMap(projectionPipeline.projectEvent));
      const threadEvent = (eventId: string, type: OrchestrationEvent["type"], payload: unknown) =>
        project({
          eventId,
          type,
          aggregateKind: "thread",
          aggregateId: revertThreadId,
          occurredAt: importAt,
          payload,
        });

      yield* project({
        eventId: "evt-import-revert-project",
        type: "project.created",
        aggregateKind: "project",
        aggregateId: "project-import-revert",
        payload: {
          projectId: ProjectId.make("project-import-revert"),
          title: "Import Revert Project",
          workspaceRoot: "/tmp/project-import-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* threadEvent("evt-import-revert-created", "thread.created", {
        ...threadCreatedPayload(revertThreadId, importAt),
        projectId: ProjectId.make("project-import-revert"),
      });
      yield* threadEvent("evt-import-revert-imported", "thread.imported", {
        ...importedPayload,
        threadId: revertThreadId,
        history: {
          ...importedPayload.history,
          messages: importedPayload.history.messages.map((message) => ({
            ...message,
            id: MessageId.make(`revert-${message.id}`),
          })),
          activities: importedPayload.history.activities.map((activity) => ({
            ...activity,
            id: EventId.make(`revert-${activity.id}`),
          })),
        },
      });

      // Two real turns. User messages carry no turn id and no turn row claims
      // them, so they survive a revert only through the per-turn fallback
      // count: the path imported user messages must never compete in.
      for (const turn of [1, 2]) {
        const turnId = TurnId.make(`turn-import-revert-${turn}`);
        const at = `2026-06-01T02:0${turn}:00.000Z`;
        yield* threadEvent(`evt-import-revert-user-${turn}`, "thread.message-sent", {
          threadId: revertThreadId,
          messageId: MessageId.make(`import-revert-user-${turn}`),
          role: "user",
          text: `real ask ${turn}`,
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        });
        yield* threadEvent(`evt-import-revert-diff-${turn}`, "thread.turn-diff-completed", {
          threadId: revertThreadId,
          turnId,
          checkpointTurnCount: turn,
          checkpointRef: CheckpointRef.make(
            `refs/lecturn/checkpoints/thread-import-revert/turn/${turn}`,
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make(`import-revert-assistant-${turn}`),
          completedAt: at,
        });
        yield* threadEvent(`evt-import-revert-assistant-${turn}`, "thread.message-sent", {
          threadId: revertThreadId,
          messageId: MessageId.make(`import-revert-assistant-${turn}`),
          role: "assistant",
          text: `real answer ${turn}`,
          attachments:
            turn === 2
              ? [
                  {
                    type: "image",
                    id: removedAttachmentId,
                    name: "remove.png",
                    mimeType: "image/png",
                    sizeBytes: 5,
                  },
                ]
              : [],
          turnId,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        });
        yield* threadEvent(`evt-import-revert-activity-${turn}`, "thread.activity-appended", {
          threadId: revertThreadId,
          activity: {
            id: EventId.make(`import-revert-activity-${turn}`),
            tone: "tool",
            kind: "tool.completed",
            summary: "Ran command",
            payload: {},
            turnId,
            createdAt: at,
          },
        });
      }

      const removedPath = path.join(attachmentsDir, `${removedAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(removedPath, "remove");

      const messageIds = () =>
        sql<{ readonly messageId: string }>`
          SELECT message_id AS "messageId" FROM projection_thread_messages
          WHERE thread_id = ${revertThreadId}
          ORDER BY created_at, message_id
        `.pipe(Effect.map((rows) => rows.map((row) => row.messageId)));
      const activityIds = () =>
        sql<{ readonly activityId: string }>`
          SELECT activity_id AS "activityId" FROM projection_thread_activities
          WHERE thread_id = ${revertThreadId}
          ORDER BY created_at, activity_id
        `.pipe(Effect.map((rows) => rows.map((row) => row.activityId)));
      const importedMessageIds = [`revert-${userMessageId}`, `revert-${assistantMessageId}`];

      yield* threadEvent("evt-import-revert-to-1", "thread.reverted", {
        threadId: revertThreadId,
        turnCount: 1,
      });
      assert.deepEqual(yield* messageIds(), [
        ...importedMessageIds,
        "import-revert-assistant-1",
        "import-revert-user-1",
      ]);
      assert.deepEqual(yield* activityIds(), [`revert-${activityId}`, "import-revert-activity-1"]);
      assert.isFalse(yield* fileSystem.exists(removedPath));

      yield* threadEvent("evt-import-revert-to-0", "thread.reverted", {
        threadId: revertThreadId,
        turnCount: 0,
      });
      assert.deepEqual(yield* messageIds(), importedMessageIds);
      assert.deepEqual(yield* activityIds(), [`revert-${activityId}`]);
    }),
  );

  it.effect("keeps inherited imported history through reverts in a fork of an import", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const childThreadId = ThreadId.make("thread-import-fork-child");
      const childProjectId = ProjectId.make("project-import-fork");
      const forkedAt = "2026-06-01T03:00:00.000Z";
      const parentTurnId = TurnId.make("turn-import-fork-1");
      const parentTurnAt = "2026-06-01T02:01:00.000Z";

      const project = (input: Parameters<typeof appendEvent>[0]) =>
        appendEvent(input).pipe(Effect.flatMap(projectionPipeline.projectEvent));
      const childEvent = (eventId: string, type: OrchestrationEvent["type"], payload: unknown) =>
        project({
          eventId,
          type,
          aggregateKind: "thread",
          aggregateId: childThreadId,
          occurredAt: forkedAt,
          payload,
        });
      const message = (
        id: string,
        role: "user" | "assistant",
        turnId: TurnId | null,
        at: string,
      ) => ({
        id: MessageId.make(id),
        role,
        text: id,
        attachments: [],
        turnId,
        streaming: false,
        createdAt: at,
        updatedAt: at,
      });

      yield* project({
        eventId: "evt-import-fork-project",
        type: "project.created",
        aggregateKind: "project",
        aggregateId: childProjectId,
        payload: {
          projectId: childProjectId,
          title: "Import Fork Project",
          workspaceRoot: "/tmp/project-import-fork",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* childEvent("evt-import-fork-created", "thread.created", {
        ...threadCreatedPayload(childThreadId, forkedAt),
        projectId: childProjectId,
      });
      // The child of an imported parent forked after the parent's first real
      // turn: imported rows, then the parent's turn, whose user message is
      // turnless like the imported ones but newer than importedAt.
      yield* childEvent("evt-import-fork-forked", "thread.forked", {
        threadId: childThreadId,
        forkedFrom: { threadId, turnId: parentTurnId, turnCount: 1, messageId: null },
        forkSource: null,
        importedFrom,
        history: {
          messages: [
            message("fork-imported-user", "user", null, "2026-05-31T10:00:00.000Z"),
            message("fork-imported-assistant", "assistant", null, "2026-05-31T10:00:02.000Z"),
            message("fork-parent-user-1", "user", null, parentTurnAt),
            message("fork-parent-assistant-1", "assistant", parentTurnId, parentTurnAt),
          ],
          activities: [],
          proposedPlans: [],
          turns: [
            {
              turnId: parentTurnId,
              state: "completed",
              requestedAt: parentTurnAt,
              startedAt: parentTurnAt,
              completedAt: parentTurnAt,
              pendingMessageId: null,
              assistantMessageId: MessageId.make("fork-parent-assistant-1"),
              checkpoint: {
                turnId: parentTurnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.make(
                  "refs/lecturn/checkpoints/thread-import-fork-child/turn/1",
                ),
                status: "ready",
                files: [],
                assistantMessageId: MessageId.make("fork-parent-assistant-1"),
                completedAt: parentTurnAt,
              },
              providerTurnRef: null,
            },
          ],
        },
      });
      for (const turn of [2, 3]) {
        const turnId = TurnId.make(`turn-import-fork-${turn}`);
        const at = `2026-06-01T03:0${turn}:00.000Z`;
        yield* childEvent(`evt-import-fork-user-${turn}`, "thread.message-sent", {
          threadId: childThreadId,
          messageId: MessageId.make(`fork-child-user-${turn}`),
          role: "user",
          text: `child ask ${turn}`,
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        });
        yield* childEvent(`evt-import-fork-diff-${turn}`, "thread.turn-diff-completed", {
          threadId: childThreadId,
          turnId,
          checkpointTurnCount: turn,
          checkpointRef: CheckpointRef.make(
            `refs/lecturn/checkpoints/thread-import-fork-child/turn/${turn}`,
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make(`fork-child-assistant-${turn}`),
          completedAt: at,
        });
        yield* childEvent(`evt-import-fork-assistant-${turn}`, "thread.message-sent", {
          threadId: childThreadId,
          messageId: MessageId.make(`fork-child-assistant-${turn}`),
          role: "assistant",
          text: `child answer ${turn}`,
          attachments: [],
          turnId,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        });
      }

      // The origin is inherited; the parent's fork cursor is not.
      const shell = Option.getOrThrow(yield* snapshotQuery.getThreadShellById(childThreadId));
      assert.deepEqual(shell.importedFrom, importedFrom);
      assert.isTrue(Option.isNone(yield* snapshotQuery.getThreadImportSourceById(childThreadId)));

      const messageIds = () =>
        sql<{ readonly messageId: string }>`
          SELECT message_id AS "messageId" FROM projection_thread_messages
          WHERE thread_id = ${childThreadId}
          ORDER BY created_at, message_id
        `.pipe(Effect.map((rows) => rows.map((row) => row.messageId)));

      yield* childEvent("evt-import-fork-revert-1", "thread.reverted", {
        threadId: childThreadId,
        turnCount: 1,
      });
      assert.deepEqual(yield* messageIds(), [
        "fork-imported-user",
        "fork-imported-assistant",
        "fork-parent-assistant-1",
        "fork-parent-user-1",
      ]);

      // The parent's turnless user message predates the child's createdAt but
      // not importedAt, so it is a real turn's message and goes with its turn.
      yield* childEvent("evt-import-fork-revert-0", "thread.reverted", {
        threadId: childThreadId,
        turnCount: 0,
      });
      assert.deepEqual(yield* messageIds(), ["fork-imported-user", "fork-imported-assistant"]);
    }),
  );
});
