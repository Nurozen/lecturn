import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import StaveProjectLifecycle from "./049_StaveProjectLifecycle.ts";
import StaveLifecycleRecovery from "./050_StaveLifecycleRecovery.ts";
import ThreadPullRequests from "./050_ProjectionThreadPullRequests.ts";

// Both products published migration 50 with different names and schemas. The
// migrator skips IDs below the ledger's latest ID, so an upstream database at 50
// never ran Lecturn's lifecycle schema (49, 50), and a Lecturn database never ran
// upstream's thread pull request table. Create only what is missing, without
// rewriting either installation's ledger. An existing link table is left alone so
// links a user removed are not backfilled again from the legacy column.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (name: string) =>
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  if (!(yield* hasTable("stave_project_lifecycle"))) yield* StaveProjectLifecycle;
  if (!(yield* hasTable("stave_lifecycle_policy"))) yield* StaveLifecycleRecovery;
  if (!(yield* hasTable("projection_thread_pull_requests"))) yield* ThreadPullRequests;
});
