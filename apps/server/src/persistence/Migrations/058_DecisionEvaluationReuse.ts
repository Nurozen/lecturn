import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX decision_jobs_evaluation ON decision_jobs(project_id,fingerprint,state)`;
  yield* sql`CREATE INDEX decision_coverage_completed_source ON decision_coverage(project_id,thread_id,source_generation,source_message_id,state,source_hash)`;
});
