/**
 * Durable per-thread admission ledger for Contextual turns on the V2 orchestrator.
 *
 * V1 admitted a turn inside the projection transaction of its
 * `thread.turn-start-requested` event and drove its own FIFO worker. On V2 the
 * orchestrator already serializes runs per thread, so a row is admitted by the
 * runtime-only `beforeTurnStart` hook for one run (keyed by run id) and is
 * finished by the run's terminal notice. Projection rebuilds never call either
 * hook, so historical user turns can never be readmitted.
 *
 * `contextual_turn_queue.sequence` is a local monotonic admission counter; the
 * per-thread watermark keeps rejecting anything at or below a finished row.
 */
import { ContextualError, MessageId, RunId, type ThreadId } from "@lecturn/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { contextualBoundary, contextualNow, staleContextual } from "./ContextualSettings.ts";

export type ContextualQueueState = "queued" | "preparing" | "held" | "ready" | "dispatching";
export interface ContextualQueuedTurn {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly sequence: number;
  readonly dispatchId: string;
  readonly preparationId: string | null;
  readonly state: ContextualQueueState;
}
const QueuedRun = Schema.Struct({ runId: RunId, messageId: MessageId });
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(QueuedRun));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(QueuedRun));
type QueueRow = {
  event_id: string;
  sequence: number;
  thread_id: string;
  event_json: string | null;
  dispatch_id: string;
  preparation_id: string | null;
  state: ContextualQueueState | "done" | "canceled" | "unknown";
};
const FINISHED = ["done", "canceled", "unknown"] as const;

const contextualDispatchId = (runId: RunId) => `contextual-dispatch:${runId}`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeRow = Effect.fn("Contextual.queueRow")(function* (row: QueueRow) {
    if (!row.event_json || FINISHED.includes(row.state as (typeof FINISHED)[number]))
      return yield* new ContextualError({ code: "invalid", message: "Invalid queued turn." });
    const run = yield* decodeRun(row.event_json);
    return {
      runId: run.runId,
      threadId: row.thread_id as ThreadId,
      messageId: run.messageId,
      sequence: row.sequence,
      dispatchId: row.dispatch_id,
      preparationId: row.preparation_id,
      state: row.state as ContextualQueueState,
    } satisfies ContextualQueuedTurn;
  });
  const head = Effect.fn("Contextual.queueHead")(function* (threadId: ThreadId) {
    const rows =
      yield* sql<QueueRow>`SELECT * FROM contextual_turn_queue WHERE thread_id=${threadId} AND state NOT IN ('done','canceled','unknown') ORDER BY sequence LIMIT 1`;
    return rows[0] ? yield* decodeRow(rows[0]) : null;
  }, Effect.mapError(contextualBoundary));
  const get = Effect.fn("Contextual.queueGet")(function* (runId: RunId) {
    const rows =
      yield* sql<QueueRow>`SELECT * FROM contextual_turn_queue WHERE event_id=${runId} AND state NOT IN ('done','canceled','unknown')`;
    return rows[0] ? yield* decodeRow(rows[0]) : null;
  }, Effect.mapError(contextualBoundary));
  /** Admits one run once. A finished run (or one under the watermark) stays finished. */
  const admit = Effect.fn("Contextual.admitRun")(
    function* (input: { threadId: ThreadId; runId: RunId; messageId: MessageId }) {
      const existing =
        yield* sql<QueueRow>`SELECT * FROM contextual_turn_queue WHERE event_id=${input.runId}`;
      if (existing[0])
        return FINISHED.includes(existing[0].state as (typeof FINISHED)[number])
          ? null
          : yield* decodeRow(existing[0]);
      const at = yield* contextualNow;
      yield* sql`INSERT INTO contextual_turn_queue(event_id,sequence,thread_id,dispatch_id,event_json,created_at,updated_at)
        VALUES (${input.runId},(SELECT COALESCE(MAX(sequence),0)+1 FROM contextual_turn_queue),${input.threadId},${contextualDispatchId(input.runId)},${yield* encodeRun({ runId: input.runId, messageId: input.messageId })},${at},${at})`;
      return yield* get(input.runId);
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  const setState = Effect.fn("Contextual.queueState")(
    function* (
      threadId: ThreadId,
      runId: RunId,
      state: ContextualQueueState,
      preparationId: string | null,
    ) {
      const first = yield* head(threadId);
      if (first?.runId !== runId) return yield* staleContextual();
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
          WHERE thread_id=${threadId} AND message_id=${first.messageId}
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
      yield* sql`UPDATE contextual_turn_queue SET state=${state},preparation_id=${boundPreparationId},updated_at=${yield* contextualNow} WHERE event_id=${runId}`;
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  const finishRow = (row: QueueRow, state: "done" | "canceled" | "unknown") =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO contextual_turn_watermarks(thread_id,through_sequence) VALUES (${row.thread_id},${row.sequence})
        ON CONFLICT(thread_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence)`;
      yield* sql`UPDATE contextual_turn_queue SET state=${state},event_json=NULL,updated_at=${yield* contextualNow} WHERE event_id=${row.event_id}`;
      // Watermarks permanently reject readmission after compact tombstones are removed.
      yield* sql`DELETE FROM contextual_turn_queue WHERE thread_id=${row.thread_id} AND state IN ('done','canceled','unknown') AND sequence < ${row.sequence}-4096`;
    });
  /** Finishes one run's row. Unlike V1 any row may finish: V2 owns run order. */
  const finish = Effect.fn("Contextual.finishQueuedTurn")(
    function* (runId: RunId, state: "done" | "canceled" | "unknown") {
      const rows =
        yield* sql<QueueRow>`SELECT * FROM contextual_turn_queue WHERE event_id=${runId} AND state NOT IN ('done','canceled','unknown')`;
      if (rows[0]) yield* finishRow(rows[0], state);
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  /**
   * Finishes rows whose V2 run is gone or terminal (terminal notices are live
   * only, so a restart can miss one). An uncertain dispatch stays unknown.
   */
  const reconcile = Effect.fn("Contextual.reconcileQueue")(
    function* (threadId: ThreadId | undefined) {
      const rows = yield* sql<QueueRow>`SELECT q.* FROM contextual_turn_queue q
        LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = q.event_id
        WHERE q.state NOT IN ('done','canceled','unknown')
          AND ${threadId === undefined ? sql`1=1` : sql`q.thread_id=${threadId}`}
          AND (r.run_id IS NULL OR r.status NOT IN ('preparing','queued','starting','running','waiting'))`;
      for (const row of rows)
        yield* finishRow(row, row.state === "dispatching" ? "unknown" : "canceled");
      return rows.map((row) => RunId.make(row.event_id));
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  return { head, get, admit, setState, finish, reconcile };
});
export class ContextualTurnQueue extends Context.Service<
  ContextualTurnQueue,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualTurnQueue") {}
export const layer = Layer.effect(ContextualTurnQueue, make);
