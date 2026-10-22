/**
 * Lecturn: deleting a thread removes only attachment files that no other
 * thread, live when the cleanup effect runs, shows. Two ways a thread shows
 * another thread's files:
 * - A run-less fork (V1-migrated or imported history) copies its source's
 *   messages with their attachment refs, and some V1-migrated fork children
 *   already reference their parent's files. Those copies are counted per id.
 * - A native fork (`forkedFrom.type === "run"`) stores no copies; it renders
 *   its source's history by reference, and keeps doing so after the source is
 *   soft-deleted (also through a deleted intermediate fork). While any live
 *   thread descends from the deleted thread through `forkedFrom` runs, all of
 *   its ids are kept, including messages past the fork cut. Those files are
 *   then never removed (no later cleanup lists them): a leak, never data loss.
 *
 * Checked when the cleanup effect runs, after the deleting thread's own
 * `thread.deleted` is committed, so the last of several threads sharing
 * copied refs to be deleted removes the file. A fork that commits after this
 * check is not seen.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The ids among `attachmentIds` that a non-deleted thread other than `threadId` shows. */
export const listAttachmentIdsReferencedElsewhere = Effect.fn(
  "orchestrationV2.listAttachmentIdsReferencedElsewhere",
)(function* (input: { readonly threadId: string; readonly attachmentIds: ReadonlyArray<string> }) {
  if (input.attachmentIds.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  // Native fork children read the source's rows directly, at any depth.
  const liveForkDescendants = yield* sql<{ readonly thread_id: string }>`
    WITH RECURSIVE descendant(thread_id, deleted_at) AS (
      SELECT thread_id, deleted_at
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.forkedFrom.type') = 'run'
        AND json_extract(payload_json, '$.forkedFrom.threadId') = ${input.threadId}
      UNION
      SELECT child.thread_id, child.deleted_at
      FROM orchestration_v2_projection_threads AS child
      JOIN descendant
        ON json_extract(child.payload_json, '$.forkedFrom.threadId') = descendant.thread_id
      WHERE json_extract(child.payload_json, '$.forkedFrom.type') = 'run'
    )
    SELECT thread_id FROM descendant
    WHERE deleted_at IS NULL AND thread_id <> ${input.threadId}
    LIMIT 1
  `;
  if (liveForkDescendants.length > 0) return new Set(input.attachmentIds);
  const wanted = encodeIds(Array.from(new Set(input.attachmentIds)));
  // instr() is a cheap pre-filter so only candidate rows are parsed as JSON.
  // V1-migrated threads whose transcript is not hydrated yet still hold their
  // messages in the legacy table only.
  const rows = yield* sql<{ readonly id: string }>`
    WITH wanted(id) AS (SELECT value FROM json_each(${wanted}))
    SELECT DISTINCT wanted.id AS id
    FROM orchestration_v2_projection_messages AS message
    JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = message.thread_id AND thread.deleted_at IS NULL
    JOIN json_each(message.payload_json, '$.attachments') AS attachment
    JOIN wanted ON wanted.id = json_extract(
      CASE WHEN attachment.type = 'object' THEN attachment.value END, '$.id'
    )
    WHERE message.thread_id <> ${input.threadId}
      AND EXISTS (SELECT 1 FROM wanted AS probe WHERE instr(message.payload_json, probe.id) > 0)
    UNION
    SELECT wanted.id AS id
    FROM projection_thread_messages AS legacy
    JOIN orchestration_v2_legacy_imports AS legacy_import
      ON legacy_import.thread_id = legacy.thread_id
      AND legacy_import.transcript_imported_at IS NULL
    JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = legacy.thread_id AND thread.deleted_at IS NULL
    JOIN json_each(
      CASE WHEN json_valid(legacy.attachments_json) THEN legacy.attachments_json ELSE '[]' END
    ) AS attachment
    JOIN wanted ON wanted.id = json_extract(
      CASE WHEN attachment.type = 'object' THEN attachment.value END, '$.id'
    )
    WHERE legacy.thread_id <> ${input.threadId}
      AND EXISTS (SELECT 1 FROM wanted AS probe WHERE instr(legacy.attachments_json, probe.id) > 0)
  `;
  return new Set(rows.map((row) => row.id));
});
