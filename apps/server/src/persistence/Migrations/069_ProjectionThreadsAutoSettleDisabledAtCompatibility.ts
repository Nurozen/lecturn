import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import AutoSettleDisabledAt from "./054_ProjectionThreadsAutoSettleDisabledAt.ts";
import ThreadNotes from "./054_ThreadNotes.ts";

// Both products published migration 54 with different names and schemas, and the migrator skips IDs
// below the ledger's latest, so each side missed the other's. Create only what is missing, without
// rewriting either ledger.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notesTables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_notes'`;
  if (notesTables.length === 0) yield* ThreadNotes;
  yield* AutoSettleDisabledAt;
});
