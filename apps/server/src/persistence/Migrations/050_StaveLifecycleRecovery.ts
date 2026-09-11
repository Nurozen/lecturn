import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE stave_project_lifecycle ADD COLUMN saga_teardown_json TEXT`;
  // Settings observations and unapplied episode resets survive process restarts.
  yield* sql`CREATE TABLE stave_lifecycle_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL, archive_mode TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE stave_lifecycle_schedule_resets (project_id TEXT PRIMARY KEY)`;
});
