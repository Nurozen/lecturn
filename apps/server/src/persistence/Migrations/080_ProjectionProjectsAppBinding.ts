import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Lecturn connected apps. Every statement is guarded because Migrations.ts
// re-runs it whenever another build's ledger holds a different migration at
// this id, so it must be safe to run twice.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("app_id")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN app_id TEXT`;
  }
  // The root as the app sent it; workspace_root holds the normalized path.
  if (!names.has("app_workspace_root")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN app_workspace_root TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_app_workspace
    ON projection_projects(app_id, app_workspace_root, deleted_at)
  `;
});
