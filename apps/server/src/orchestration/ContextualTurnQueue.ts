import { ContextualError, OrchestrationEvent, type ThreadId } from "@lecturn/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  contextualBoundary,
  contextualNow,
  staleContextual,
} from "../contextual/ContextualSettings.ts";

type TurnEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(OrchestrationEvent));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationEvent));
export interface ContextualQueuedTurn {
  readonly event: TurnEvent;
  readonly dispatchId: string;
  readonly preparationId: string | null;
  readonly state: "queued" | "preparing" | "held" | "ready" | "dispatching";
}
type QueueRow = {
  event_json: string;
  dispatch_id: string;
  preparation_id: string | null;
  state: ContextualQueuedTurn["state"];
};

/** Runtime commit hook only. Projection rebuilds must never readmit historical user turns. */
export const admitContextualTurn = Effect.fn("Contextual.admitTurn")(function* (
  sql: SqlClient.SqlClient,
  event: TurnEvent,
) {
  const intent =
    yield* sql`SELECT 1 FROM contextual_thread_settings WHERE thread_id=${event.payload.threadId} AND enabled=1
    UNION ALL SELECT 1 FROM contextual_turn_queue WHERE thread_id=${event.payload.threadId} AND state NOT IN ('done','canceled','unknown') LIMIT 1`;
  if (!intent[0]) return;
  const finished = yield* sql<{
    through_sequence: number;
  }>`SELECT through_sequence FROM contextual_turn_watermarks WHERE thread_id=${event.payload.threadId}`;
  if ((finished[0]?.through_sequence ?? 0) >= event.sequence) return;
  yield* sql`INSERT OR IGNORE INTO contextual_turn_queue(event_id,sequence,thread_id,dispatch_id,event_json,created_at,updated_at)
    VALUES (${event.eventId},${event.sequence},${event.payload.threadId},${`contextual-dispatch:${event.eventId}`},${yield* encodeEvent(event)},${event.occurredAt},${event.occurredAt})`;
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const head = Effect.fn("Contextual.queueHead")(function* (threadId: ThreadId) {
    const rows =
      yield* sql<QueueRow>`SELECT * FROM contextual_turn_queue WHERE thread_id=${threadId} AND state NOT IN ('done','canceled','unknown') ORDER BY sequence LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    const event = yield* decodeEvent(row.event_json);
    if (event.type !== "thread.turn-start-requested")
      return yield* new ContextualError({ code: "invalid", message: "Invalid queued turn." });
    return {
      event,
      dispatchId: row.dispatch_id,
      preparationId: row.preparation_id,
      state: row.state,
    } satisfies ContextualQueuedTurn;
  }, Effect.mapError(contextualBoundary));
  const contains = Effect.fn("Contextual.queueContains")(function* (event: TurnEvent) {
    const rows = yield* sql`SELECT 1 FROM contextual_turn_queue WHERE event_id=${event.eventId}
      UNION ALL SELECT 1 FROM contextual_turn_watermarks WHERE thread_id=${event.payload.threadId} AND through_sequence>=${event.sequence} LIMIT 1`;
    return rows.length > 0;
  }, Effect.mapError(contextualBoundary));
  const setState = Effect.fn("Contextual.queueState")(
    function* (
      threadId: ThreadId,
      eventId: string,
      state: ContextualQueuedTurn["state"],
      preparationId: string | null,
    ) {
      const first = yield* head(threadId);
      if (first?.event.eventId !== eventId) return yield* staleContextual();
      if (first.state === "dispatching") return yield* staleContextual();
      let boundPreparationId = preparationId ?? first.preparationId;
      if (state === "dispatching") {
        // The admission marker and cancellation fence share one database transaction.
        // Optional evaluation failure must never erase a concurrently persisted hold/cancel.
        const preparations = yield* sql<{
          id: string;
          state: string;
          dispatch_id: string | null;
        }>`SELECT id,state,dispatch_id FROM contextual_preparations
          WHERE thread_id=${threadId} AND message_id=${first.event.payload.messageId}
          ORDER BY created_at DESC LIMIT 1`;
        const preparation = preparations[0];
        if (preparation) {
          boundPreparationId = preparation.id;
          if (
            ["canceled", "awaiting-conflict-review", "delivered", "delivery-unknown"].includes(
              preparation.state,
            ) ||
            (preparation.state === "dispatching" && preparation.dispatch_id !== first.dispatchId)
          )
            return yield* staleContextual();
        }
      }
      yield* sql`UPDATE contextual_turn_queue SET state=${state},preparation_id=${boundPreparationId},updated_at=${yield* contextualNow} WHERE event_id=${eventId}`;
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  const finish = Effect.fn("Contextual.finishQueuedTurn")(
    function* (threadId: ThreadId, eventId: string, state: "done" | "canceled" | "unknown") {
      const first = yield* head(threadId);
      if (!first) return;
      if (first.event.eventId !== eventId) return yield* staleContextual();
      yield* sql`INSERT INTO contextual_turn_watermarks(thread_id,through_sequence) VALUES (${threadId},${first.event.sequence})
     ON CONFLICT(thread_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence)`;
      yield* sql`UPDATE contextual_turn_queue SET state=${state},event_json=NULL,updated_at=${yield* contextualNow} WHERE event_id=${eventId}`;
      // Watermarks permanently reject historical readmission after compact tombstones are removed.
      yield* sql`DELETE FROM contextual_turn_queue WHERE thread_id=${threadId} AND state IN ('done','canceled','unknown') AND sequence < ${first.event.sequence}-4096`;
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  const pendingThreads = Effect.fn("Contextual.pendingThreads")(function* (after: string) {
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT DISTINCT thread_id FROM contextual_turn_queue WHERE state NOT IN ('done','canceled','unknown') AND thread_id>${after} ORDER BY thread_id LIMIT 128`;
    return rows.map((r) => r.thread_id as ThreadId);
  }, Effect.mapError(contextualBoundary));
  return { head, contains, setState, finish, pendingThreads };
});
export class ContextualTurnQueue extends Context.Service<
  ContextualTurnQueue,
  Effect.Success<typeof make>
>()("lecturn/orchestration/ContextualTurnQueue") {}
export const layer = Layer.effect(ContextualTurnQueue, make);
