import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "imported_from_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN imported_from_json TEXT
    `;
  }

  if (!threadColumns.some((column) => column.name === "import_source_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN import_source_json TEXT
    `;
  }
});
