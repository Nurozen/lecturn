import {
  ContextualPreparation,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@lecturn/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  contextualCompactionBoundaryKey,
  providerContextIdForSession,
} from "../provider/ContextualCapabilities.ts";
import { contextualBoundary, appendContextualEvent } from "../contextual/ContextualSettings.ts";

const decodePreparation = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualPreparation));
const encodePreparation = Schema.encodeEffect(Schema.fromJsonString(ContextualPreparation));
/** Runtime-only transaction hook: side tables survive historical projection rebuilds. */
export const applyContextualLifecycle = Effect.fn("Contextual.lifecycle")(function* (
  sql: SqlClient.SqlClient,
  event: OrchestrationEvent,
) {
  if (event.type === "thread.session-stop-requested") {
    const threadId = event.payload.threadId;
    const rows = yield* sql<{ id: string; preparation_json: string }>`
      SELECT p.id,p.preparation_json FROM contextual_preparations p
      JOIN contextual_turn_queue q ON q.thread_id=p.thread_id
        AND json_extract(q.event_json,'$.payload.messageId')=p.message_id
      WHERE q.thread_id=${threadId} AND q.sequence<=${event.sequence}
        AND q.state NOT IN ('done','canceled','unknown')
        AND p.state IN ('requested','retrieving','evaluating','checking-conflicts','awaiting-conflict-review','prepared','dispatching')`;
    for (const row of rows) {
      const preparation = yield* decodePreparation(row.preparation_json);
      const next = {
        ...preparation,
        state:
          preparation.state === "dispatching"
            ? ("delivery-unknown" as const)
            : ("canceled" as const),
        revision: preparation.revision + 1,
        updatedAt: event.occurredAt,
      };
      yield* sql`UPDATE contextual_preparations SET state=${next.state},revision=${next.revision},preparation_json=${yield* encodePreparation(next)},continuation_json=NULL,updated_at=${event.occurredAt} WHERE id=${row.id}`;
      yield* appendContextualEvent(sql, {
        threadId,
        revision: next.revision,
        kind: "preparation-changed",
        entityId: next.id,
      });
    }
    // Stop cancels previously submitted work; a later user submission can start a new session.
    yield* sql`INSERT INTO contextual_turn_watermarks(thread_id,through_sequence) VALUES(${threadId},${event.sequence}) ON CONFLICT(thread_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence)`;
    yield* sql`UPDATE contextual_turn_queue SET state=CASE WHEN state='dispatching' THEN 'unknown' ELSE 'canceled' END,event_json=NULL,updated_at=${event.occurredAt} WHERE thread_id=${threadId} AND sequence<=${event.sequence} AND state NOT IN ('done','canceled','unknown')`;
    return;
  }
  if (event.type === "thread.forked") {
    const parent = event.payload.forkedFrom.threadId;
    const child = event.payload.threadId;
    const mapping = event.payload.contextualMessageIdMap;
    if (mapping)
      for (const entry of mapping) {
        if (!event.payload.history.messages.some((message) => message.id === entry.targetId))
          continue;
        yield* sql`INSERT OR IGNORE INTO contextual_supply(thread_id,guidance_id,fingerprint,context_epoch,packet_id,dispatch_id,message_id,source_revision,acceptance,supplied_at)
        SELECT ${child},guidance_id,fingerprint,'initial',packet_id,dispatch_id,${entry.targetId},source_revision,acceptance,supplied_at FROM contextual_supply WHERE thread_id=${parent} AND message_id=${entry.sourceId}`;
        yield* sql`INSERT OR IGNORE INTO contextual_inherited_disclosures(thread_id,message_id,origin_thread_id,receipt_id,packet_id)
        SELECT ${child},${entry.targetId},${parent},r.id,r.packet_id FROM contextual_receipts r JOIN contextual_preparations p ON p.dispatch_id=r.dispatch_id WHERE r.thread_id=${parent} AND p.message_id=${entry.sourceId}`;
        yield* sql`INSERT OR IGNORE INTO contextual_inherited_disclosures(thread_id,message_id,origin_thread_id,receipt_id,packet_id)
        SELECT ${child},${entry.targetId},origin_thread_id,receipt_id,packet_id FROM contextual_inherited_disclosures WHERE thread_id=${parent} AND message_id=${entry.sourceId}`;
      }
    else {
      // Old fork producers do not prove a prefix map. Preserve suppression conservatively.
      yield* sql`INSERT OR IGNORE INTO contextual_supply SELECT ${child},guidance_id,fingerprint,'initial',packet_id,dispatch_id,message_id,source_revision,acceptance,supplied_at FROM contextual_supply WHERE thread_id=${parent}`;
    }
    yield* sql`INSERT OR IGNORE INTO contextual_exclusions SELECT ${child},guidance_id,action_id FROM contextual_exclusions WHERE thread_id=${parent}`;
    // Content-free observations remain conservative when a fork cannot prove which candidates were unseen.
    yield* sql`INSERT OR IGNORE INTO contextual_candidate_observations SELECT ${child},task_fingerprint,guidance_id,content_fingerprint FROM contextual_candidate_observations WHERE thread_id=${parent}`;
    return;
  }
  const targets: ThreadId[] = [];
  if (event.type === "thread.deleted" || event.type === "thread.reverted")
    targets.push(event.payload.threadId);
  if (event.type === "project.deleted") {
    const rows = yield* sql<{
      thread_id: ThreadId;
    }>`SELECT thread_id FROM contextual_thread_settings WHERE project_id=${event.payload.projectId}`;
    targets.push(...rows.map((row) => row.thread_id));
  }
  for (const threadId of targets) {
    const deleting = event.type !== "thread.reverted";
    const rows = yield* sql<{
      id: string;
      preparation_json: string;
      message_id: string;
    }>`SELECT id,preparation_json,message_id FROM contextual_preparations WHERE thread_id=${threadId}`;
    for (const row of rows) {
      const exists =
        yield* sql`SELECT 1 FROM projection_thread_messages WHERE message_id=${row.message_id} AND thread_id=${threadId}`;
      if (!deleting && exists.length) continue;
      const p = yield* decodePreparation(row.preparation_json);
      if (
        ![
          "delivered",
          "delivery-unknown",
          "failed",
          "canceled",
          "skipped",
          "already-supplied",
          "no-useful-context",
        ].includes(p.state)
      ) {
        const next = {
          ...p,
          state: p.state === "dispatching" ? ("delivery-unknown" as const) : ("canceled" as const),
          revision: p.revision + 1,
          updatedAt: event.occurredAt,
        };
        yield* sql`UPDATE contextual_preparations SET state=${next.state},revision=${next.revision},preparation_json=${yield* encodePreparation(next)},continuation_json=NULL,updated_at=${event.occurredAt} WHERE id=${row.id}`;
      }
      yield* sql`UPDATE contextual_packets SET packet_json=NULL,payload_bytes=0,retention='source-deleted' WHERE preparation_id=${row.id}`;
      yield* sql`UPDATE contextual_conflicts SET relation_json=NULL,resolution_json=NULL,status='resolved',revision=revision+1 WHERE preparation_id=${row.id}`;
    }
    // Rollback continuity is unknown; preserve the compact supply ledger until explicit refresh.
    yield* sql`INSERT INTO contextual_turn_watermarks(thread_id,through_sequence) VALUES(${threadId},${event.sequence}) ON CONFLICT(thread_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence)`;
    yield* sql`UPDATE contextual_turn_queue SET state=CASE WHEN state='dispatching' THEN 'unknown' ELSE 'canceled' END,event_json=NULL,updated_at=${event.occurredAt} WHERE thread_id=${threadId} AND state NOT IN ('done','canceled','unknown')`;
    if (deleting) {
      yield* sql`UPDATE contextual_thread_settings SET enabled=0,revision=revision+1,updated_at=${event.occurredAt} WHERE thread_id=${threadId}`;
      yield* sql`DELETE FROM contextual_inherited_disclosures WHERE thread_id=${threadId}`;
      yield* sql`DELETE FROM contextual_candidate_observations WHERE thread_id=${threadId}`;
    } else
      yield* sql`DELETE FROM contextual_inherited_disclosures WHERE thread_id=${threadId} AND message_id NOT IN (SELECT message_id FROM projection_thread_messages WHERE thread_id=${threadId})`;
  }
});
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* ProviderSessionDirectory;
  const observe = Effect.fn("Contextual.observeContextBoundary")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type !== "thread.state.changed" || event.payload.state !== "compacted") return;
    const binding = yield* directory.getBinding(event.threadId);
    if (Option.isNone(binding)) return;
    const nativeContext = providerContextIdForSession(
      binding.value.provider,
      binding.value.resumeCursor,
    );
    const key = contextualCompactionBoundaryKey(event, nativeContext);
    if (!key) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior =
          yield* sql`SELECT 1 FROM contextual_context_boundaries WHERE thread_id=${event.threadId} AND boundary_key=${key}`;
        if (prior.length) return;
        const epoch = `compaction:${key}`;
        yield* sql`INSERT INTO contextual_context_boundaries(thread_id,boundary_key,context_epoch) VALUES(${event.threadId},${key},${epoch})`;
        yield* sql`UPDATE contextual_thread_settings SET context_epoch=${epoch},updated_at=${event.createdAt} WHERE thread_id=${event.threadId}`;
        yield* appendContextualEvent(sql, {
          threadId: event.threadId,
          revision: 0,
          kind: "settings-changed",
          entityId: event.threadId,
        });
      }),
    );
  }, Effect.mapError(contextualBoundary));
  return { observe };
});
export class ContextualLifecycle extends Context.Service<
  ContextualLifecycle,
  Effect.Success<typeof make>
>()("lecturn/orchestration/ContextualLifecycle") {}
export const layer = Layer.effect(ContextualLifecycle, make);
