import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Idempotent because Migrations.ts re-runs it whenever another build's ledger
// holds a different migration at this id.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS app_registrations (
      app_id TEXT PRIMARY KEY,
      registration_json TEXT NOT NULL,
      state TEXT NOT NULL,
      granted_fingerprint TEXT,
      runtime_ceiling TEXT,
      cached_headless_tools_json TEXT,
      cached_live_tools_json TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS app_pairing_requests (
      request_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      registration_json TEXT NOT NULL,
      poll_secret_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      credential_delivered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_app_pairing_requests_app
    ON app_pairing_requests (app_id, created_at)
  `;
});
