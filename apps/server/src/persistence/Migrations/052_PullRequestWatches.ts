import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE pull_request_watches (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX pull_request_watches_project ON pull_request_watches(project_id)`;
  yield* sql`CREATE TABLE pull_request_watch_receipts (actor TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, watch_id TEXT, result_json TEXT, PRIMARY KEY(actor, request_id))`;
  yield* sql`CREATE TABLE pull_request_watch_settings (id INTEGER PRIMARY KEY CHECK(id = 1), mode TEXT NOT NULL)`;
  yield* sql`INSERT INTO pull_request_watch_settings(id, mode) VALUES (1, 'follow-pr')`;
});
