/**
 * Contextual side-table lifecycle on V2, re-homed from V1
 * orchestration/ContextualLifecycle.ts.
 *
 * Every entry point here is driven by runtime-only V2 signals (Lecturn
 * orchestration hooks and the live application-event tail started after
 * boot). None of them runs on a projection rebuild, so historical events can
 * never cancel, readmit or copy Contextual state twice.
 */
import {
  ContextualPreparation,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@lecturn/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { v2Messages } from "../threadDecisions/V2ProjectionSources.ts";
import { appendContextualEvent, contextualBoundary } from "./ContextualSettings.ts";

const decodePreparation = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualPreparation));
const encodePreparation = Schema.encodeEffect(Schema.fromJsonString(ContextualPreparation));
const ACTIVE_PREPARATION_STATES = sql_list([
  "requested",
  "retrieving",
  "evaluating",
  "checking-conflicts",
  "awaiting-conflict-review",
  "prepared",
  "dispatching",
]);
const TERMINAL_PREPARATION_STATES = new Set<string>([
  "delivered",
  "delivery-unknown",
  "failed",
  "canceled",
  "skipped",
  "already-supplied",
  "no-useful-context",
]);
function sql_list(values: ReadonlyArray<string>): string {
  return values.map((value) => `'${value}'`).join(",");
}

const settlePreparation = (
  sql: SqlClient.SqlClient,
  row: { id: string; preparation_json: string },
  threadId: ThreadId,
  at: string,
) =>
  Effect.gen(function* () {
    const preparation = yield* decodePreparation(row.preparation_json);
    const next = {
      ...preparation,
      state:
        preparation.state === "dispatching" ? ("delivery-unknown" as const) : ("canceled" as const),
      revision: preparation.revision + 1,
      updatedAt: at,
    };
    yield* sql`UPDATE contextual_preparations SET state=${next.state},revision=${next.revision},preparation_json=${yield* encodePreparation(next)},continuation_json=NULL,updated_at=${at} WHERE id=${row.id}`;
    yield* appendContextualEvent(sql, {
      threadId,
      revision: next.revision,
      kind: "preparation-changed",
      entityId: next.id,
    });
  });

const finishQueueRows = (sql: SqlClient.SqlClient, threadId: ThreadId, at: string, runId?: RunId) =>
  Effect.gen(function* () {
    const scope = runId === undefined ? sql`1=1` : sql`event_id=${runId}`;
    yield* sql`INSERT INTO contextual_turn_watermarks(thread_id,through_sequence)
      SELECT thread_id, MAX(sequence) FROM contextual_turn_queue
      WHERE thread_id=${threadId} AND ${scope} AND state NOT IN ('done','canceled','unknown') GROUP BY thread_id
      ON CONFLICT(thread_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence)`;
    yield* sql`UPDATE contextual_turn_queue SET state=CASE WHEN state='dispatching' THEN 'unknown' ELSE 'canceled' END,event_json=NULL,updated_at=${at}
      WHERE thread_id=${threadId} AND ${scope} AND state NOT IN ('done','canceled','unknown')`;
  });

/**
 * V1 session stop, now scoped to runs: cancels in-flight preparations of the
 * thread's queued runs (or one run) and finishes their admission rows. An
 * already-dispatched packet becomes delivery-unknown, never canceled.
 */
const cancelQueuedTurns = Effect.fn("Contextual.cancelQueuedTurns")(function* (
  sql: SqlClient.SqlClient,
  input: { threadId: ThreadId; runId?: RunId; at: string },
) {
  const { threadId, runId, at } = input;
  const rows = yield* sql<{ id: string; preparation_json: string }>`
    SELECT p.id,p.preparation_json FROM contextual_preparations p
    JOIN contextual_turn_queue q ON q.thread_id=p.thread_id
      AND json_extract(q.event_json,'$.messageId')=p.message_id
    WHERE q.thread_id=${threadId} AND ${runId === undefined ? sql`1=1` : sql`q.event_id=${runId}`}
      AND q.state NOT IN ('done','canceled','unknown')
      AND p.state IN (${sql.literal(ACTIVE_PREPARATION_STATES)})`;
  for (const row of rows) yield* settlePreparation(sql, row, threadId, at);
  yield* finishQueueRows(sql, threadId, at, runId);
});

/**
 * Thread deletion and rollback (V1 thread.deleted / thread.reverted). A
 * rollback only invalidates preparations whose message it actually removed
 * (V2 keeps rolled-back messages but excludes them from the live view).
 */
const applyThreadRemoval = Effect.fn("Contextual.threadRemoval")(function* (
  sql: SqlClient.SqlClient,
  input: { threadId: ThreadId; kind: "deleted" | "rolled-back"; at: string },
) {
  const { threadId, at } = input;
  const deleting = input.kind === "deleted";
  const rows = yield* sql<{
    id: string;
    preparation_json: string;
    message_id: string;
  }>`SELECT id,preparation_json,message_id FROM contextual_preparations WHERE thread_id=${threadId}`;
  for (const row of rows) {
    if (!deleting) {
      const exists =
        yield* sql`SELECT 1 FROM ${v2Messages(sql)} m WHERE message_id=${row.message_id} AND thread_id=${threadId}`;
      if (exists.length) continue;
    }
    const p = yield* decodePreparation(row.preparation_json);
    if (!TERMINAL_PREPARATION_STATES.has(p.state)) {
      const next = {
        ...p,
        state: p.state === "dispatching" ? ("delivery-unknown" as const) : ("canceled" as const),
        revision: p.revision + 1,
        updatedAt: at,
      };
      yield* sql`UPDATE contextual_preparations SET state=${next.state},revision=${next.revision},preparation_json=${yield* encodePreparation(next)},continuation_json=NULL,updated_at=${at} WHERE id=${row.id}`;
    }
    yield* sql`UPDATE contextual_packets SET packet_json=NULL,payload_bytes=0,retention='source-deleted' WHERE preparation_id=${row.id}`;
    yield* sql`UPDATE contextual_conflicts SET relation_json=NULL,resolution_json=NULL,status='resolved',revision=revision+1 WHERE preparation_id=${row.id}`;
  }
  // Rollback continuity is unknown; preserve the compact supply ledger until explicit refresh.
  yield* finishQueueRows(sql, threadId, at);
  if (deleting) {
    yield* sql`UPDATE contextual_thread_settings SET enabled=0,revision=revision+1,updated_at=${at} WHERE thread_id=${threadId}`;
    yield* sql`DELETE FROM contextual_inherited_disclosures WHERE thread_id=${threadId}`;
    yield* sql`DELETE FROM contextual_candidate_observations WHERE thread_id=${threadId}`;
  } else
    yield* sql`DELETE FROM contextual_inherited_disclosures WHERE thread_id=${threadId} AND message_id NOT IN (SELECT message_id FROM ${v2Messages(sql)} m WHERE thread_id=${threadId})`;
});

const applyProjectDeleted = Effect.fn("Contextual.projectDeleted")(function* (
  sql: SqlClient.SqlClient,
  input: { projectId: ProjectId; at: string },
) {
  const rows = yield* sql<{
    thread_id: ThreadId;
  }>`SELECT thread_id FROM contextual_thread_settings WHERE project_id=${input.projectId}`;
  for (const row of rows)
    yield* applyThreadRemoval(sql, { threadId: row.thread_id, kind: "deleted", at: input.at });
});

/**
 * Fork child inherits suppression conservatively. V2 forks do not copy the
 * parent's messages (history resolves lazily), so no message map exists and
 * per-message disclosures are not re-anchored, exactly like V1 forks from
 * producers without a prefix map.
 */
export const applyFork = Effect.fn("Contextual.fork")(function* (
  sql: SqlClient.SqlClient,
  input: { parentThreadId: ThreadId; threadId: ThreadId },
) {
  const parent = input.parentThreadId;
  const child = input.threadId;
  yield* sql`INSERT OR IGNORE INTO contextual_supply SELECT ${child},guidance_id,fingerprint,'initial',packet_id,dispatch_id,message_id,source_revision,acceptance,supplied_at FROM contextual_supply WHERE thread_id=${parent}`;
  yield* sql`INSERT OR IGNORE INTO contextual_exclusions SELECT ${child},guidance_id,action_id FROM contextual_exclusions WHERE thread_id=${parent}`;
  // Content-free observations remain conservative when a fork cannot prove which candidates were unseen.
  yield* sql`INSERT OR IGNORE INTO contextual_candidate_observations SELECT ${child},task_fingerprint,guidance_id,content_fingerprint FROM contextual_candidate_observations WHERE thread_id=${parent}`;
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  /**
   * A confirmed provider compaction starts a new context epoch. V2 records
   * compaction as a durable turn item, so its id is the dedupe key.
   */
  const observeCompaction = Effect.fn("Contextual.observeContextBoundary")(
    function* (input: { threadId: ThreadId; boundaryKey: string; at: string }) {
      const prior =
        yield* sql`SELECT 1 FROM contextual_context_boundaries WHERE thread_id=${input.threadId} AND boundary_key=${input.boundaryKey}`;
      if (prior.length) return;
      const epoch = `compaction:${input.boundaryKey}`;
      yield* sql`INSERT INTO contextual_context_boundaries(thread_id,boundary_key,context_epoch) VALUES(${input.threadId},${input.boundaryKey},${epoch})`;
      yield* sql`UPDATE contextual_thread_settings SET context_epoch=${epoch},updated_at=${input.at} WHERE thread_id=${input.threadId}`;
      yield* appendContextualEvent(sql, {
        threadId: input.threadId,
        revision: 0,
        kind: "settings-changed",
        entityId: input.threadId,
      });
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  const transactional =
    <I, E>(work: (sql: SqlClient.SqlClient, input: I) => Effect.Effect<void, E>) =>
    (input: I) =>
      work(sql, input).pipe(sql.withTransaction, Effect.mapError(contextualBoundary));
  return {
    observeCompaction,
    cancelQueuedTurns: transactional(cancelQueuedTurns),
    applyThreadRemoval: transactional(applyThreadRemoval),
    applyProjectDeleted: transactional(applyProjectDeleted),
    applyFork: transactional(applyFork),
  };
});
export class ContextualLifecycle extends Context.Service<
  ContextualLifecycle,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualLifecycle") {}
export const layer = Layer.effect(ContextualLifecycle, make);
