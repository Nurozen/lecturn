import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN description TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN project_cancellation_epoch INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN prepared INTEGER NOT NULL DEFAULT 1`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN source_fingerprint TEXT`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN preparation_fingerprint TEXT`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN preparation_thread TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN preparation_message TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN expected_message_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE decision_scans ADD COLUMN prepared_message_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE decision_coverage ADD COLUMN source_hash TEXT`;
  yield* sql`CREATE INDEX decision_coverage_backlog ON decision_coverage(state,reason,project_id,consumer_id)`;
});
