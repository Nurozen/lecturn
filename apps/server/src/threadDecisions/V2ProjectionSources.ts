/**
 * V2 never writes the V1 projection tables, but V1 transcripts hydrate lazily, so a thread's
 * messages are read from the V1 copy until its transcript is imported. The importer preserves
 * message ids, so anchors keyed by message id stay valid.
 */
import type * as SqlClient from "effect/sql/SqlClient";

/** One row per app thread: thread_id, project_id, title, archived_at, deleted_at, created_at, updated_at, model_selection_json. */
const V2_THREADS_SQL = `(SELECT thread_id, project_id, title, archived_at, deleted_at, created_at, updated_at,
  json_extract(payload_json, '$.modelSelection') AS model_selection_json,
  json_extract(payload_json, '$.worktreePath') AS worktree_path
  FROM orchestration_v2_projection_threads)`;

/**
 * Live conversation messages: message_id, thread_id, role, text, is_streaming,
 * created_at, updated_at. Messages of rolled-back runs are excluded (V1 revert
 * removed them from the projection). Not-yet-hydrated legacy transcripts fall
 * back to the V1 rows.
 */
const V2_MESSAGES_SQL = `(SELECT m.message_id, m.thread_id, m.role,
    json_extract(m.payload_json, '$.text') AS text, m.streaming AS is_streaming, m.created_at, m.updated_at
  FROM orchestration_v2_projection_messages m
  WHERE m.run_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.run_id = m.run_id AND r.status = 'rolled_back')
  UNION ALL
  SELECT l.message_id, l.thread_id, l.role, l.text, l.is_streaming, l.created_at, l.updated_at
  FROM projection_thread_messages l
  WHERE EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports li
      WHERE li.thread_id = l.thread_id AND li.transcript_imported_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages v WHERE v.message_id = l.message_id))`;

export const v2Threads = (sql: SqlClient.SqlClient) => sql.literal(V2_THREADS_SQL);
export const v2Messages = (sql: SqlClient.SqlClient) => sql.literal(V2_MESSAGES_SQL);
