import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_notes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL, message_role TEXT NOT NULL CHECK(message_role IN ('user', 'assistant')),
    quote_text TEXT NOT NULL, comment TEXT, anchor_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX thread_notes_project ON thread_notes(project_id, created_at)`;
  yield* sql`CREATE INDEX thread_notes_thread ON thread_notes(thread_id)`;
});
