import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
/** Content-free observation identities prevent a repeated task from draining its old pool. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE contextual_candidate_observations (
    thread_id TEXT NOT NULL, task_fingerprint TEXT NOT NULL, guidance_id TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL,
    PRIMARY KEY(thread_id,task_fingerprint,guidance_id,content_fingerprint)
  )`;
});
