import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import AutoSettleDisabledAt from "./054_ProjectionThreadsAutoSettleDisabledAt.ts";
import ThreadNotes from "./054_ThreadNotes.ts";

// Both products published migration 54 with different names and schemas. The
// migrator skips IDs below the ledger's latest ID, so an existing Lecturn database
// never ran upstream's auto-settle column, and an upstream database at 54 never ran
// Lecturn's thread notes table. Create only what is missing, without rewriting
// either installation's ledger.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notesTables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_notes'`;
  if (notesTables.length === 0) yield* ThreadNotes;
  yield* AutoSettleDisabledAt;
});
