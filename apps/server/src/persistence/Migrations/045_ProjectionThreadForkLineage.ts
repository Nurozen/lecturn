import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "forked_from_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN forked_from_json TEXT
    `;
  }

  if (!threadColumns.some((column) => column.name === "fork_source_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_source_json TEXT
    `;
  }

  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;

  if (!turnColumns.some((column) => column.name === "provider_turn_ref")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN provider_turn_ref TEXT
    `;
  }
});
