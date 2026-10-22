/** Test-only seeding of the V2 projection rows read through V2ProjectionSources. */
import {
  EventId,
  MessageId,
  RunId,
  ThreadId,
  type ApplicationProjectEvent,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type ProjectId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const clearV2Projection = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM orchestration_v2_projection_messages`;
    yield* sql`DELETE FROM orchestration_v2_projection_runs`;
    yield* sql`DELETE FROM orchestration_v2_projection_threads`;
    yield* sql`DELETE FROM orchestration_v2_legacy_imports`;
  });

export const insertV2Thread = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly projectId: string;
    readonly title?: string;
    readonly createdAt?: string;
    readonly archivedAt?: string | null;
    readonly deletedAt?: string | null;
    readonly modelSelection?: unknown;
  },
) => {
  const at = input.createdAt ?? "2026-09-23T00:00:00.000Z";
  const payload = JSON.stringify({
    id: input.threadId,
    projectId: input.projectId,
    title: input.title ?? "Thread",
    modelSelection: input.modelSelection ?? { instanceId: "codex", model: "gpt-5" },
  });
  return sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES (${input.threadId}, ${input.projectId}, ${input.title ?? "Thread"}, 'codex', 'codex', 'full-access', 'default', NULL, ${at}, ${at}, ${input.archivedAt ?? null}, ${input.deletedAt ?? null}, ${payload})
    ON CONFLICT(thread_id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, archived_at = excluded.archived_at, deleted_at = excluded.deleted_at, payload_json = excluded.payload_json`;
};

export const insertV2Message = (
  sql: SqlClient.SqlClient,
  input: {
    readonly messageId: string;
    readonly threadId: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly createdAt?: string;
    readonly streaming?: boolean;
    readonly runId?: string | null;
  },
) => {
  const at = input.createdAt ?? "2026-09-23T00:00:00.000Z";
  const payload = JSON.stringify({
    id: input.messageId,
    threadId: input.threadId,
    role: input.role,
    text: input.text,
  });
  return sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${input.messageId}, ${input.threadId}, ${input.runId ?? null}, NULL, ${input.role}, ${input.streaming ? 1 : 0}, ${at}, ${at}, ${payload})
    ON CONFLICT(message_id) DO UPDATE SET role = excluded.role, streaming = excluded.streaming, run_id = excluded.run_id, updated_at = excluded.updated_at, payload_json = excluded.payload_json`;
};

export const insertV2Run = (
  sql: SqlClient.SqlClient,
  input: {
    readonly runId: string;
    readonly threadId: string;
    readonly ordinal: number;
    readonly status: string;
  },
) =>
  sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
    VALUES (${input.runId}, ${input.threadId}, ${input.ordinal}, 'codex', NULL, ${input.status}, '2026-09-23T00:00:00.000Z', NULL, '{}')
    ON CONFLICT(run_id) DO UPDATE SET status = excluded.status`;

/** Marks a thread as a migrated V1 shell whose transcript is not hydrated yet. */
export const markLegacyTranscriptPending = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`INSERT INTO orchestration_v2_legacy_imports(thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
    VALUES (${threadId}, '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z', NULL)
    ON CONFLICT(thread_id) DO UPDATE SET transcript_imported_at = NULL`;

const v2ThreadFromLegacy = `INSERT OR REPLACE INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
  VALUES (NEW.thread_id, NEW.project_id, NEW.title, 'codex', 'codex', NEW.runtime_mode, NEW.interaction_mode, NULL, NEW.created_at, NEW.updated_at, NEW.archived_at, NEW.deleted_at,
    json_object('id', NEW.thread_id, 'projectId', NEW.project_id, 'title', NEW.title,
      'modelSelection', CASE WHEN json_valid(NEW.model_selection_json) THEN json(NEW.model_selection_json) ELSE NULL END,
      'worktreePath', NEW.worktree_path));`;
const v2MessageFromLegacy = `INSERT OR REPLACE INTO orchestration_v2_projection_messages(message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
  VALUES (NEW.message_id, NEW.thread_id, NULL, NULL, NEW.role, NEW.is_streaming, NEW.created_at, NEW.updated_at,
    json_object('id', NEW.message_id, 'threadId', NEW.thread_id, 'role', NEW.role, 'text', NEW.text));`;

/**
 * Lets fork tests keep seeding threads/messages with their original V1-shaped
 * SQL while the code under test reads only the V2 projection: every write to
 * the V1 tables is mirrored into the V2 rows.
 */
export const installLegacyProjectionMirror = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(
      `CREATE TRIGGER IF NOT EXISTS test_v2_thread_insert AFTER INSERT ON projection_threads BEGIN ${v2ThreadFromLegacy} END`,
    );
    yield* sql.unsafe(
      `CREATE TRIGGER IF NOT EXISTS test_v2_thread_update AFTER UPDATE ON projection_threads BEGIN ${v2ThreadFromLegacy} END`,
    );
    yield* sql.unsafe(
      `CREATE TRIGGER IF NOT EXISTS test_v2_thread_delete AFTER DELETE ON projection_threads BEGIN DELETE FROM orchestration_v2_projection_threads WHERE thread_id = OLD.thread_id; END`,
    );
    yield* sql.unsafe(
      `CREATE TRIGGER IF NOT EXISTS test_v2_message_insert AFTER INSERT ON projection_thread_messages BEGIN ${v2MessageFromLegacy} END`,
    );
    yield* sql.unsafe(
      `CREATE TRIGGER IF NOT EXISTS test_v2_message_update AFTER UPDATE ON projection_thread_messages BEGIN ${v2MessageFromLegacy} END`,
    );
    yield* sql.unsafe(
      `CREATE TRIGGER IF NOT EXISTS test_v2_message_delete AFTER DELETE ON projection_thread_messages BEGIN DELETE FROM orchestration_v2_projection_messages WHERE message_id = OLD.message_id; END`,
    );
  });

const occurredAt = DateTime.makeUnsafe("2026-09-23T00:00:00.000Z");
const stored = (
  sequence: number,
  event: Record<string, unknown> & { readonly type: OrchestrationV2DomainEvent["type"] },
  eventId = `event-${sequence}`,
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(eventId),
    occurredAt,
    ...event,
  } as unknown as OrchestrationV2DomainEvent,
});

/** A V2 `message.updated` stored event (final unless `streaming`). */
export const v2MessageEvent = (
  sequence: number,
  input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly role?: "user" | "assistant" | "system";
    readonly streaming?: boolean;
    readonly eventId?: string;
  },
) =>
  stored(
    sequence,
    {
      type: "message.updated",
      threadId: ThreadId.make(input.threadId),
      payload: {
        id: MessageId.make(input.messageId),
        threadId: ThreadId.make(input.threadId),
        runId: null,
        nodeId: null,
        role: input.role ?? "assistant",
        text: "",
        attachments: [],
        streaming: input.streaming ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    },
    input.eventId,
  );

/** A V2 thread lifecycle stored event; `fork` marks a fork child's thread.created. */
export const v2ThreadEvent = (
  sequence: number,
  type:
    | "thread.created"
    | "thread.imported"
    | "thread.deleted"
    | "thread.archived"
    | "thread.unarchived",
  threadId: string,
  options: { readonly fork?: boolean; readonly eventId?: string } = {},
) =>
  stored(
    sequence,
    {
      type,
      threadId: ThreadId.make(threadId),
      payload: {
        id: ThreadId.make(threadId),
        lineage: {
          parentThreadId: options.fork ? ThreadId.make(`${threadId}-parent`) : null,
          relationshipToParent: options.fork ? "fork" : null,
          rootThreadId: ThreadId.make(threadId),
        },
      },
    },
    options.eventId,
  );

/** A V2 `run.updated` stored event for a run reaching `status`. */
export const v2RunEvent = (sequence: number, threadId: string, runId: string, status: string) =>
  stored(sequence, {
    type: "run.updated",
    threadId: ThreadId.make(threadId),
    runId: RunId.make(runId),
    payload: { id: RunId.make(runId), threadId: ThreadId.make(threadId), status },
  });

export const projectDeletedEvent = (sequence: number, projectId: ProjectId) =>
  ({
    sequence,
    eventId: EventId.make(`project-event-${sequence}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: "2026-09-23T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.deleted",
    payload: { projectId, deletedAt: "2026-09-23T00:00:00.000Z" },
  }) as unknown as ApplicationProjectEvent;
