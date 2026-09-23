import { assert, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MessageId,
  ProjectId,
  ThreadId,
  ThreadNoteId,
  type ThreadNoteCreateInput,
} from "@lecturn/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./ThreadNoteService.ts";

const input: ThreadNoteCreateInput = {
  id: ThreadNoteId.make("note"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  messageRole: "assistant",
  text: "hello",
  comment: null,
  start: 0,
  end: 5,
  prefix: "",
  suffix: " world",
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_notes`;
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project', 'Project', '/tmp/notes', '[]', '2026-09-23', '2026-09-23')`;
  yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, model_selection_json, created_at, updated_at, runtime_mode, interaction_mode) VALUES ('thread', 'project', 'Thread title', '{}', '2026-09-23', '2026-09-23', 'full-access', 'default')`;
  yield* sql`INSERT INTO projection_thread_messages(message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES ('message', 'thread', 'assistant', 'hello world', 0, '2026-09-23', '2026-09-23')`;
  return { sql, service: yield* make };
});
it.layer(SqlitePersistenceMemory)("ThreadNoteService", (it) => {
  it.effect("derives project, persists anchors, edits comments and deletes idempotently", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture;
      const note = yield* service.create(input);
      assert.equal(note.projectId, "project");
      assert.deepEqual(yield* service.create(input), note);
      const updated = yield* service.update({ id: input.id, comment: "Remember this" });
      assert.equal(updated.comment, "Remember this");
      assert.equal((yield* service.create(input)).comment, "Remember this");
      const list = yield* service.list({ projectId: ProjectId.make("project") });
      assert.equal(list.notes[0]?.threadTitle, "Thread title");
      assert.equal(list.notes[0]?.anchorState, "ok");
      assert.equal(list.truncated, false);
      assert.equal((yield* service.list({ projectId: ProjectId.make("other") })).notes.length, 0);
      yield* service.delete({ id: input.id });
      yield* service.delete({ id: input.id });
      assert.equal((yield* service.list({})).notes.length, 0);
    }),
  );
  it.effect("rejects divergent IDs and unknown threads without changing the original note", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture;
      yield* service.create(input);
      for (const change of [{ text: "other" }, { start: 1 }, { messageRole: "user" as const }]) {
        const result = yield* service.create({ ...input, ...change }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.code, "conflict");
      }
      const missing = yield* service
        .create({ ...input, id: ThreadNoteId.make("new"), threadId: ThreadId.make("absent") })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(missing));
      if (Result.isFailure(missing)) assert.equal(missing.failure.code, "not-found");
      assert.equal((yield* service.list({})).notes[0]?.text, "hello");
      const updateMissing = yield* service
        .update({ id: ThreadNoteId.make("absent"), comment: null })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(updateMissing));
    }),
  );
  it.effect("joins current anchor state with deletion over missing over archive precedence", () =>
    Effect.gen(function* () {
      const { sql, service } = yield* fixture;
      yield* service.create(input);
      const state = Effect.map(service.list({}), (list) => list.notes[0]?.anchorState);
      assert.equal(yield* state, "ok");
      yield* sql`UPDATE projection_threads SET archived_at = 'now'`;
      assert.equal(yield* state, "thread-archived");
      yield* sql`DELETE FROM projection_thread_messages`;
      assert.equal(yield* state, "message-missing");
      yield* sql`UPDATE projection_threads SET deleted_at = 'now'`;
      assert.equal(yield* state, "thread-deleted");
      yield* sql`UPDATE projection_threads SET deleted_at = NULL`;
      yield* sql`UPDATE projection_projects SET deleted_at = 'now'`;
      assert.equal(yield* state, "thread-deleted");
      yield* sql`DELETE FROM projection_threads`;
      assert.equal(yield* state, "thread-deleted");
    }),
  );
  it.effect("a revert only invalidates notes on messages it actually removes", () =>
    Effect.gen(function* () {
      const { sql, service } = yield* fixture;
      yield* service.create(input);
      yield* service.create({
        ...input,
        id: ThreadNoteId.make("later-note"),
        messageId: MessageId.make("later"),
      });
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'later'`;
      const notes = (yield* service.list({})).notes;
      assert.equal(notes.find((n) => n.id === input.id)?.anchorState, "ok");
      assert.equal(notes.find((n) => n.id === "later-note")?.anchorState, "message-missing");
    }),
  );
  it.effect("caps payloads deterministically and reports truncation", () =>
    Effect.gen(function* () {
      const { sql, service } = yield* fixture;
      yield* service.create(input);
      yield* sql`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 501)
      INSERT INTO thread_notes SELECT 'note-' || printf('%04d', n), project_id, thread_id, message_id, message_role, quote_text, comment, anchor_json, created_at, updated_at FROM thread_notes CROSS JOIN numbers WHERE id = 'note'`;
      const list = yield* service.list({});
      assert.equal(list.notes.length, 500);
      assert.equal(list.truncated, true);
      assert.equal(list.notes[0]?.id, "note-0501");
    }),
  );
});
