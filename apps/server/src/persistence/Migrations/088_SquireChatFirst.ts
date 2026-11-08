import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Closes the backlog that chat-first Squires no longer show, directly in SQL: the repository's
// transitions write item-resolved rows, and those wake the Lead once per card. Questions and
// overlaps stay because they are live decisions, and the inactivity FYI stays because its answer
// decides whether automation pauses.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(squire_card)`;
  // A ledger holding another migration at 82 creates the table after this one, with the column.
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "expires_at")) {
    yield* sql`ALTER TABLE squire_card ADD COLUMN expires_at TEXT`;
  }

  yield* sql`
    UPDATE squire_card
    SET status = 'outdated', resolution = 'outdated',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'open' AND (
      (kind = 'fyi' AND coalesce(json_extract(payload_json, '$.source'), '') != 'inactivity')
      OR (kind IN ('steer', 'proposal') AND origin NOT IN ('user', 'voice'))
      OR (kind = 'proposal'
        AND json_extract(payload_json, '$.type') = 'control'
        AND json_extract(payload_json, '$.action') = 'merge')
    )
  `;
});
