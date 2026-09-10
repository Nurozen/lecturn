import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export const STAVE_LIFECYCLE_PROJECTOR = "stave.project-lifecycle";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE stave_project_lifecycle (
    project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL,
    space_id TEXT, manifest_created_at TEXT,
    disposition TEXT NOT NULL CHECK (disposition IN ('live','pending_evaluation','pending_destroy','pending_archive','destroying','archiving','restoring','destroyed','archived','kept','refused','not_stave')),
    delete_intent_sequence INTEGER, saga_remove_confirmed INTEGER NOT NULL DEFAULT 0,
    refusal_code TEXT, refusal_message TEXT, anchor_at TEXT, scheduled_at TEXT,
    archive_deadline_at TEXT, archive_basename TEXT,
    lease_epoch INTEGER NOT NULL DEFAULT 0, owner_token TEXT, lease_until TEXT,
    updated_at TEXT NOT NULL, refreshed_at TEXT
  )`;
  yield* sql`CREATE INDEX idx_stave_lifecycle_root ON stave_project_lifecycle(workspace_root)`;
  // This cursor is operational state. Projection resets must never replay old deletion intents.
  yield* sql`CREATE TABLE stave_lifecycle_cursor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_applied_sequence INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO stave_lifecycle_cursor SELECT 1, COALESCE(MAX(sequence), 0) FROM orchestration_events`;
  yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT ${STAVE_LIFECYCLE_PROJECTOR}, COALESCE(MAX(sequence), 0), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM orchestration_events`;
});
