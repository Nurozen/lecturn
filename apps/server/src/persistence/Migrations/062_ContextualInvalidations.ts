import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE contextual_outbox RENAME TO contextual_outbox_legacy`;
  yield* sql`CREATE TABLE contextual_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, project_id TEXT,
    revision INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, occurred_at TEXT NOT NULL
  )`;
  // Preserve cursors even if the latest rows were already removed.
  yield* sql`INSERT INTO sqlite_sequence(name,seq)
    SELECT 'contextual_outbox',seq FROM sqlite_sequence WHERE name='contextual_outbox_legacy'`;
  yield* sql`INSERT INTO contextual_outbox(sequence,thread_id,revision,kind,entity_id,occurred_at)
    SELECT sequence,thread_id,revision,kind,entity_id,occurred_at FROM contextual_outbox_legacy`;
  yield* sql`DROP TABLE contextual_outbox_legacy`;
  yield* sql`CREATE INDEX contextual_outbox_thread ON contextual_outbox(thread_id, sequence)`;
  yield* sql`ALTER TABLE contextual_host_state ADD COLUMN funding_status_fingerprint TEXT`;
});
