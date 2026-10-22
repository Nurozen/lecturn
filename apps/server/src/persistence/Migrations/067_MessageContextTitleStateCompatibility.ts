import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import MessageContext from "./051_ProjectionThreadMessageContext.ts";
import SagaWorkbench from "./051_SagaWorkbench.ts";
import PullRequestWatches from "./052_PullRequestWatches.ts";
import TitleState from "./052_ProjectionThreadTitleState.ts";

// Both products published migrations 51 and 52 with different names and schemas.
// The migrator skips IDs below the ledger's latest ID, so an existing Lecturn
// database never ran upstream's message context and title state columns, and an
// upstream database at 51 or 52 never ran Lecturn's saga workbench or pull request
// watch tables. Create only what is missing, without rewriting either ledger.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (name: string) =>
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const hasColumn = (table: string, column: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => rows.some((row) => row.name === column)),
    );

  if (!(yield* hasTable("saga_workbench"))) yield* SagaWorkbench;
  if (!(yield* hasTable("pull_request_watches"))) yield* PullRequestWatches;
  yield* MessageContext;
  if (!(yield* hasColumn("projection_threads", "title_state_json"))) yield* TitleState;
});
