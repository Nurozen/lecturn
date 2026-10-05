import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Early Preview builds applied migration 56 before paged preparation landed.
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(decision_scans)`;
  const present = new Set(columns.map((column) => column.name));
  for (const [name, definition] of [
    ["prepared", "INTEGER NOT NULL DEFAULT 1"],
    ["source_fingerprint", "TEXT"],
    ["preparation_fingerprint", "TEXT"],
    ["preparation_thread", "TEXT NOT NULL DEFAULT ''"],
    ["preparation_message", "TEXT NOT NULL DEFAULT ''"],
    ["expected_message_count", "INTEGER NOT NULL DEFAULT 0"],
    ["prepared_message_count", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!present.has(name!))
      yield* sql.unsafe(`ALTER TABLE decision_scans ADD COLUMN ${name} ${definition}`);
  }
});
