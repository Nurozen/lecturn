import {
  ThreadNote,
  ThreadNoteListItem,
  ThreadNoteError,
  ThreadNoteCreateInput as ThreadNoteCreateInputSchema,
  ThreadNoteUpdateInput as ThreadNoteUpdateInputSchema,
  type ThreadNoteCreateInput,
  type ThreadNoteUpdateInput,
  type ThreadNoteDeleteInput,
  type ThreadNoteListInput,
  type ThreadNoteListResult,
} from "@lecturn/contracts";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const fail = (code: ThreadNoteError["code"], message: string) =>
  new ThreadNoteError({ code, message });
const isNoteError = Schema.is(ThreadNoteError);
const decodeNote = Schema.decodeUnknownEffect(ThreadNote);
const decodeListItem = Schema.decodeUnknownEffect(ThreadNoteListItem);
const decodeCreate = Schema.decodeUnknownEffect(ThreadNoteCreateInputSchema);
const decodeUpdate = Schema.decodeUnknownEffect(ThreadNoteUpdateInputSchema);
const boundary = (error: unknown) =>
  isNoteError(error) ? error : fail("unavailable", "Thread notes are currently unavailable.");
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const Anchor = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  prefix: Schema.String,
  suffix: Schema.String,
});
const encodeAnchor = Schema.encodeEffect(Schema.fromJsonString(Anchor));
const decodeAnchor = Schema.decodeUnknownEffect(Schema.fromJsonString(Anchor));
interface StoredRow {
  readonly id: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly message_role: string;
  readonly quote_text: string;
  readonly comment: string | null;
  readonly anchor_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}
const decodeRow = Effect.fn("ThreadNotes.decodeRow")(function* (row: StoredRow) {
  return yield* decodeNote({
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    messageRole: row.message_role,
    text: row.quote_text,
    comment: row.comment,
    ...(yield* decodeAnchor(row.anchor_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});
export class ThreadNoteService extends Context.Service<
  ThreadNoteService,
  {
    readonly list: (
      input: ThreadNoteListInput,
    ) => Effect.Effect<ThreadNoteListResult, ThreadNoteError>;
    readonly create: (input: ThreadNoteCreateInput) => Effect.Effect<ThreadNote, ThreadNoteError>;
    readonly update: (input: ThreadNoteUpdateInput) => Effect.Effect<ThreadNote, ThreadNoteError>;
    readonly delete: (input: ThreadNoteDeleteInput) => Effect.Effect<void, ThreadNoteError>;
  }
>()("lecturn/threadNotes/ThreadNoteService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("ThreadNotes.get")(function* (id: string) {
    const rows = yield* sql<StoredRow>`SELECT * FROM thread_notes WHERE id = ${id}`;
    return rows[0] ? yield* decodeRow(rows[0]) : null;
  });
  const create = Effect.fn("ThreadNotes.create")(
    function* (input: ThreadNoteCreateInput) {
      const valid = yield* decodeCreate(input);
      const threads = yield* sql<{
        project_id: string;
      }>`SELECT project_id FROM projection_threads WHERE thread_id = ${valid.threadId}`;
      const thread = threads[0];
      if (!thread) return yield* fail("not-found", "The note's thread no longer exists.");
      const at = yield* now;
      const anchor = yield* encodeAnchor({
        start: valid.start,
        end: valid.end,
        prefix: valid.prefix,
        suffix: valid.suffix,
      });
      yield* sql`INSERT OR IGNORE INTO thread_notes(id, project_id, thread_id, message_id, message_role, quote_text, comment, anchor_json, created_at, updated_at)
      VALUES (${valid.id}, ${thread.project_id}, ${valid.threadId}, ${valid.messageId}, ${valid.messageRole}, ${valid.text}, ${valid.comment}, ${anchor}, ${at}, ${at})`;
      const note = yield* get(valid.id);
      if (!note) return yield* fail("unavailable", "The note could not be saved.");
      // A retry may arrive after a comment edit; immutable identity must still agree.
      if (
        note.threadId !== valid.threadId ||
        note.messageId !== valid.messageId ||
        note.messageRole !== valid.messageRole ||
        note.text !== valid.text ||
        note.start !== valid.start ||
        note.end !== valid.end ||
        note.prefix !== valid.prefix ||
        note.suffix !== valid.suffix
      ) {
        return yield* fail("conflict", "A different note already uses this identifier.");
      }
      return note;
    },
    sql.withTransaction,
    Effect.mapError(boundary),
  );
  const list = Effect.fn("ThreadNotes.list")(
    function* (input: ThreadNoteListInput) {
      const rows = yield* sql<StoredRow & { thread_title: string | null; anchor_state: string }>`
      SELECT n.*, t.title AS thread_title,
        CASE WHEN t.thread_id IS NULL OR t.deleted_at IS NOT NULL OR p.project_id IS NULL OR p.deleted_at IS NOT NULL THEN 'thread-deleted'
             WHEN m.message_id IS NULL THEN 'message-missing'
             WHEN t.archived_at IS NOT NULL THEN 'thread-archived'
             ELSE 'ok' END AS anchor_state
      FROM thread_notes n
      LEFT JOIN projection_threads t ON t.thread_id = n.thread_id
      LEFT JOIN projection_projects p ON p.project_id = n.project_id
      LEFT JOIN projection_thread_messages m ON m.message_id = n.message_id AND m.thread_id = n.thread_id
      WHERE ${input.projectId === undefined ? sql`1 = 1` : sql`n.project_id = ${input.projectId}`}
      ORDER BY n.created_at DESC, n.id DESC LIMIT 501`;
      const notes = yield* Effect.forEach(rows.slice(0, 500), (row) =>
        Effect.gen(function* () {
          return yield* decodeListItem({
            ...(yield* decodeRow(row)),
            threadTitle: row.thread_title,
            anchorState: row.anchor_state,
          });
        }),
      );
      return { notes, truncated: rows.length > 500 };
    },
    sql.withTransaction,
    Effect.mapError(boundary),
  );
  const update = Effect.fn("ThreadNotes.update")(
    function* (input: ThreadNoteUpdateInput) {
      const valid = yield* decodeUpdate(input);
      yield* sql`UPDATE thread_notes SET comment = ${valid.comment}, updated_at = ${yield* now} WHERE id = ${valid.id}`;
      const note = yield* get(valid.id);
      if (!note) return yield* fail("not-found", "The note no longer exists.");
      return note;
    },
    sql.withTransaction,
    Effect.mapError(boundary),
  );
  const remove = Effect.fn("ThreadNotes.delete")(function* (input: ThreadNoteDeleteInput) {
    yield* sql`DELETE FROM thread_notes WHERE id = ${input.id}`;
  }, Effect.mapError(boundary));
  return ThreadNoteService.of({ list, create, update, delete: remove });
});
export const layer = Layer.effect(ThreadNoteService, make);
