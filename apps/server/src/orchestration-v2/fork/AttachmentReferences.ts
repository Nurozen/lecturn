/**
 * Lecturn: never remove an attachment file another thread still shows.
 *
 * A run-less fork (V1-migrated or imported history) copies its source's
 * messages with their attachment refs, and some V1-migrated fork children
 * already reference their parent's files. Thread deletion therefore removes
 * only ids no other live thread references. Checked when the cleanup effect
 * runs, after the deleting thread's own `thread.deleted` is committed, so the
 * last of several sharing threads to be deleted removes the file.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The ids among `attachmentIds` that a non-deleted thread other than `threadId` references. */
export const listAttachmentIdsReferencedElsewhere = Effect.fn(
  "orchestrationV2.listAttachmentIdsReferencedElsewhere",
)(function* (input: { readonly threadId: string; readonly attachmentIds: ReadonlyArray<string> }) {
  if (input.attachmentIds.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
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
