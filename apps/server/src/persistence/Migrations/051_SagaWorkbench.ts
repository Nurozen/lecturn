import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE saga_workbench (identity_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, workflow_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE saga_workbench_receipts (identity_key TEXT NOT NULL, actor_key TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(identity_key, actor_key, request_id))`;
  yield* sql`CREATE TABLE saga_workbench_activity (identity_key TEXT NOT NULL, revision INTEGER NOT NULL, activity_json TEXT NOT NULL, PRIMARY KEY(identity_key, revision))`;
});
