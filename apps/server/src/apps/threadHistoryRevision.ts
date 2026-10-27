import type { ThreadId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each thread's `historyRevision`: the sequence of its last
 * message, turn item or terminal provider turn. A turn can end without a new
 * item, so terminal provider turns count; metadata events (app data, title,
 * pin) never do, which is what keeps them from causing a re-copy. A thread with
 * no such event has revision 0.
 */
export const readHistoryRevisions = Effect.fn("readHistoryRevisions")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const sql = yield* SqlClient.SqlClient;
  // Newest first on the (aggregate_kind, stream_id, sequence) index: the last
  // event is almost always a qualifying one, so this stops after a row or two
  // even on a long thread (a MAX over the filter would scan all of them).
  const revisions = yield* Effect.forEach(threadIds, (threadId) =>
    sql<{ readonly revision: number }>`
      SELECT sequence AS "revision"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND application_event_version = 2
        AND (
          event_type IN ('message.updated', 'turn-item.updated')
          OR (
            event_type = 'provider-turn.updated'
            AND json_extract(payload_json, '$.status') IN ('completed', 'interrupted', 'failed', 'cancelled')
          )
        )
      ORDER BY sequence DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => [threadId, rows[0]?.revision ?? 0] as const)),
  );
  return new Map(revisions);
});
