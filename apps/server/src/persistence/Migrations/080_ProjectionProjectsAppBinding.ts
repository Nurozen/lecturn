import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Guarded by column checks because Migrations.ts re-runs it whenever another
// build's ledger holds a different migration at this id (D31).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_projects')`;
  const hasColumn = (column: string) => columns.some((row) => row.name === column);

  if (!hasColumn("app_id")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN app_id TEXT`;
  }
  if (!hasColumn("app_workspace_root")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN app_workspace_root TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_app_workspace
    ON projection_projects (app_id, app_workspace_root)
    WHERE app_id IS NOT NULL
  `;
});
