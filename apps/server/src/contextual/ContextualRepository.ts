import { ContextualDisplaySummary } from "./ContextualDisplaySummary.ts";
import { ContextualNotifications } from "./ContextualNotifications.ts";
import {
  ContextualError,
  MessageId,
  ContextualPreparation,
  ContextualPacket,
  ContextualDeliveryReceipt,
  type ContextualDisclosure,
  ContextualTaskSnapshot,
  type ThreadId,
} from "@lecturn/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  appendContextualEvent,
  contextualBoundary,
  requireContextualThread,
  staleContextual,
} from "./ContextualSettings.ts";

const encodePreparation = Schema.encodeEffect(Schema.fromJsonString(ContextualPreparation));
const decodePreparation = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualPreparation));
const encodePacket = Schema.encodeEffect(Schema.fromJsonString(ContextualPacket));
const decodePacket = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualPacket));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(ContextualDeliveryReceipt));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualDeliveryReceipt));
const encodeTask = Schema.encodeSync(Schema.fromJsonString(ContextualTaskSnapshot));
const terminal = new Set<ContextualPreparation["state"]>([
  "delivered",
  "no-useful-context",
  "already-supplied",
  "skipped",
  "canceled",
  "failed",
  "delivery-unknown",
]);
const transitions: Record<
  ContextualPreparation["state"],
  readonly ContextualPreparation["state"][]
> = {
  requested: ["retrieving", "skipped", "canceled", "failed"],
  retrieving: [
    "evaluating",
    "no-useful-context",
    "already-supplied",
    "skipped",
    "canceled",
    "failed",
  ],
  evaluating: [
    "checking-conflicts",
    "prepared",
    "no-useful-context",
    "skipped",
    "canceled",
    "failed",
  ],
  "checking-conflicts": [
    "awaiting-conflict-review",
    "prepared",
    "no-useful-context",
    "skipped",
    "canceled",
    "failed",
  ],
  "awaiting-conflict-review": ["checking-conflicts", "prepared", "skipped", "canceled"],
  prepared: ["dispatching", "skipped", "canceled"],
  dispatching: ["delivered", "delivery-unknown", "failed"],
  delivered: [],
  "no-useful-context": [],
  "already-supplied": [],
  skipped: [],
  canceled: [],
  failed: [],
  "delivery-unknown": [],
};
type PreparationRow = { preparation_json: string; created_at: string };
type PacketRow = { packet_json: string | null; retention: ContextualDisclosure["retention"] };

/** Replacing a held packet also replaces its actual supplied-origin identities. */
export const recordContextualPacketLineage = Effect.fn("Contextual.recordPacketLineage")(function* (
  sql: SqlClient.SqlClient,
  packet: ContextualPacket,
) {
  yield* sql`DELETE FROM contextual_lineage WHERE entity_kind IN ('packet','packet-origin') AND entity_id=${packet.id}`;
  for (const group of packet.groups)
    for (const evidence of group.evidence) {
      yield* sql`INSERT OR IGNORE INTO contextual_lineage VALUES(${evidence.sourceId},${evidence.id},'packet-origin',${packet.id})`;
      for (const original of [
        evidence.id,
        `occurrence:${evidence.occurrenceId}`,
        ...evidence.lineageIds,
      ])
        yield* sql`INSERT OR IGNORE INTO contextual_lineage VALUES(${evidence.sourceId},${original},'origin',${evidence.id})`;
      if (evidence.locator.sourceKind === "lecturn-decision")
        yield* sql`INSERT OR IGNORE INTO contextual_lineage SELECT source_id,source_evidence_id,'origin',${evidence.id} FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${evidence.locator.decisionId}`;
      for (const sourceEvidenceId of [
        evidence.id,
        `occurrence:${evidence.occurrenceId}`,
        ...evidence.lineageIds,
      ])
        yield* sql`INSERT OR IGNORE INTO contextual_lineage(source_id,source_evidence_id,entity_kind,entity_id) VALUES (${evidence.sourceId},${sourceEvidenceId},'packet',${packet.id})`;
      if (evidence.locator.sourceKind === "lecturn-decision")
        yield* sql`INSERT OR IGNORE INTO contextual_lineage SELECT source_id,source_evidence_id,'packet',${packet.id} FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${evidence.locator.decisionId}`;
    }
});

/** Every handoff rechecks mutable authorization and source intent in its transaction. */
export const assertContextualFence = Effect.fn("Contextual.assertFence")(function* (
  sql: SqlClient.SqlClient,
  task: ContextualTaskSnapshot,
) {
  const projectId = yield* requireContextualThread(sql, task.threadId);
  if (projectId !== task.projectId) return yield* staleContextual();
  const threads = yield* sql<{
    enabled: number;
    revision: number;
    exclusion_revision: number;
    context_epoch: string;
  }>`SELECT * FROM contextual_thread_settings WHERE thread_id=${task.threadId}`;
  const projects = yield* sql<{
    revision: number;
  }>`SELECT revision FROM contextual_project_settings WHERE project_id=${task.projectId}`;
  const hosts = yield* sql<{
    source_revision: number;
    funding_generation: number;
    purge_generation: number;
  }>`SELECT * FROM contextual_host_state WHERE singleton=1`;
  const thread = threads[0];
  const project = projects[0];
  const host = hosts[0];
  if (
    !thread ||
    thread.enabled !== 1 ||
    thread.revision !== task.threadSettingsRevision ||
    thread.exclusion_revision !== task.threadExclusionRevision ||
    thread.context_epoch !== task.providerContextEpoch ||
    (project?.revision ?? 0) !== task.projectSettingsRevision ||
    (host?.source_revision ?? 0) !== task.sourceScopeRevision ||
    (host?.funding_generation ?? 0) !== task.fundingGeneration ||
    (host?.purge_generation ?? 0) !== task.purgeGeneration
  )
    return yield* staleContextual();
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const summaries = yield* Effect.serviceOption(ContextualDisplaySummary);
  const notifications = yield* Effect.serviceOption(ContextualNotifications);
  const publish = Option.isSome(notifications) ? notifications.value.publish : Effect.void;
  const get = Effect.fn("Contextual.getPreparation")(function* (id: string) {
    const rows = yield* sql<PreparationRow>`SELECT * FROM contextual_preparations WHERE id=${id}`;
    if (!rows[0])
      return yield* new ContextualError({ code: "not-found", message: "Preparation unavailable." });
    const value = yield* decodePreparation(rows[0].preparation_json);
    yield* requireContextualThread(sql, value.task.threadId);
    return value;
  }, Effect.mapError(contextualBoundary));

  const create = Effect.fn("Contextual.createPreparation")(
    function* (value: ContextualPreparation, continuation: string) {
      yield* assertContextualFence(sql, value.task);
      if (
        value.state !== "requested" ||
        value.revision !== 0 ||
        value.attemptsUsed !== 0 ||
        continuation.length > 1048576
      )
        return yield* new ContextualError({
          code: "invalid",
          message: "Invalid preparation admission.",
        });
      const existing =
        yield* sql<PreparationRow>`SELECT * FROM contextual_preparations WHERE thread_id=${value.task.threadId} AND submission_id=${value.task.submissionId}`;
      if (existing[0]) {
        const old = yield* decodePreparation(existing[0].preparation_json);
        if (
          old.task.taskFingerprint !== value.task.taskFingerprint ||
          old.task.messageId !== value.task.messageId
        )
          return yield* staleContextual();
        return old;
      }
      const body = yield* encodePreparation(value);
      yield* sql`INSERT INTO contextual_preparations(id,thread_id,project_id,submission_id,message_id,state,revision,preparation_json,continuation_json,created_at,updated_at)
      VALUES (${value.id},${value.task.threadId},${value.task.projectId},${value.task.submissionId},${value.task.messageId},${value.state},0,${body},${continuation},${value.updatedAt},${value.updatedAt})`;
      yield* appendContextualEvent(sql, {
        threadId: value.task.threadId,
        revision: 0,
        kind: "preparation-changed",
        entityId: value.id,
      });
      return value;
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );

  const update = Effect.fn("Contextual.updatePreparation")(
    function* (value: ContextualPreparation, expectedRevision: number) {
      const old = yield* get(value.id);
      if (["canceled", "skipped", "awaiting-conflict-review", "failed"].includes(value.state)) {
        const admitted =
          yield* sql`SELECT 1 FROM contextual_turn_queue WHERE preparation_id=${value.id} AND state='dispatching' LIMIT 1`;
        if (admitted.length) return yield* staleContextual();
      }
      if (
        old.revision !== expectedRevision ||
        value.revision !== expectedRevision + 1 ||
        terminal.has(old.state) ||
        (!transitions[old.state].includes(value.state) && value.state !== old.state) ||
        value.task.submissionId !== old.task.submissionId ||
        value.task.taskFingerprint !== old.task.taskFingerprint ||
        encodeTask(value.task) !== encodeTask(old.task) ||
        value.task.threadId !== old.task.threadId ||
        value.attemptsUsed < old.attemptsUsed ||
        value.comparisonPairsChecked < old.comparisonPairsChecked
      )
        return yield* staleContextual();
      if (!["skipped", "canceled", "failed", "delivery-unknown", "delivered"].includes(value.state))
        yield* assertContextualFence(sql, value.task);
      const body = yield* encodePreparation(value);
      yield* sql`UPDATE contextual_preparations SET state=${value.state}, revision=${value.revision}, preparation_json=${body}, dispatch_id=${value.dispatchId}, updated_at=${value.updatedAt} WHERE id=${value.id}`;
      yield* appendContextualEvent(sql, {
        threadId: value.task.threadId,
        revision: value.revision,
        kind: "preparation-changed",
        entityId: value.id,
      });
      return value;
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );

  const putPacket = Effect.fn("Contextual.putPacket")(
    function* (packet: ContextualPacket) {
      const preparation = yield* get(packet.preparationId);
      yield* assertContextualFence(sql, packet.task);
      if (
        preparation.task.submissionId !== packet.task.submissionId ||
        preparation.task.taskFingerprint !== packet.task.taskFingerprint ||
        encodeTask(preparation.task) !== encodeTask(packet.task) ||
        preparation.task.threadId !== packet.task.threadId ||
        !["evaluating", "checking-conflicts", "awaiting-conflict-review"].includes(
          preparation.state,
        )
      )
        return yield* staleContextual();
      const body = yield* encodePacket(packet);
      const bytes = new TextEncoder().encode(body).byteLength;
      yield* sql`INSERT INTO contextual_packets(id,preparation_id,thread_id,packet_json,payload_bytes,created_at) VALUES (${packet.id},${packet.preparationId},${packet.task.threadId},${body},${bytes},${packet.createdAt})`;
      yield* recordContextualPacketLineage(sql, packet);
      const totals = yield* sql<{
        bytes: number;
      }>`SELECT (SELECT COALESCE(SUM(payload_bytes),0) FROM contextual_packets WHERE packet_json IS NOT NULL) + (SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) FROM contextual_display_summaries) + (SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))),0) FROM contextual_evaluations) + (SELECT COALESCE(SUM(length(CAST(relation_json AS BLOB)) + COALESCE(length(CAST(resolution_json AS BLOB)),0)),0) FROM contextual_conflicts WHERE relation_json IS NOT NULL) AS bytes`;
      let excess = (totals[0]?.bytes ?? 0) - 32 * 1024 * 1024;
      if (excess > 0) {
        const victims = yield* sql<{
          id: string;
          payload_bytes: number;
        }>`SELECT p.id,p.payload_bytes FROM contextual_packets p JOIN contextual_preparations r ON r.id=p.preparation_id WHERE p.packet_json IS NOT NULL AND r.state IN ('delivered','delivery-unknown','skipped','canceled','failed') ORDER BY p.created_at,p.id`;
        for (const victim of victims) {
          if (excess <= 0) break;
          yield* sql`UPDATE contextual_packets SET packet_json=NULL,payload_bytes=0,retention='expired' WHERE id=${victim.id}`;
          excess -= victim.payload_bytes;
        }
        if (excess > 0)
          return yield* new ContextualError({
            code: "unavailable",
            message: "Contextual disclosure storage is busy.",
          });
      }
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );

  const packet = Effect.fn("Contextual.packet")(function* (id: string, threadId: ThreadId) {
    yield* requireContextualThread(sql, threadId);
    const rows =
      yield* sql<PacketRow>`SELECT packet_json,retention FROM contextual_packets WHERE id=${id} AND thread_id=${threadId}`;
    return rows[0]?.packet_json ? yield* decodePacket(rows[0].packet_json) : null;
  }, Effect.mapError(contextualBoundary));

  // Forks inherit supply identities whose retained evidence remains in the parent packet.
  const suppliedPacket = Effect.fn("Contextual.suppliedPacket")(function* (
    id: string,
    threadId: ThreadId,
  ) {
    yield* requireContextualThread(sql, threadId);
    const rows =
      yield* sql<PacketRow>`SELECT p.packet_json,p.retention FROM contextual_packets p WHERE p.id=${id} AND EXISTS (SELECT 1 FROM contextual_supply s WHERE s.thread_id=${threadId} AND s.packet_id=p.id)`;
    return rows[0]?.packet_json ? yield* decodePacket(rows[0].packet_json) : null;
  }, Effect.mapError(contextualBoundary));

  const recordReceipt = Effect.fn("Contextual.recordReceipt")(
    function* (value: ContextualDeliveryReceipt) {
      const preparation = yield* get(value.preparationId);
      if (
        preparation.dispatchId !== value.dispatchId ||
        preparation.task.threadId !== value.threadId ||
        preparation.task.submissionId !== value.submissionId ||
        preparation.task.providerInstanceId !== value.providerInstanceId ||
        preparation.task.providerContextEpoch !== value.providerContextEpoch ||
        preparation.packetId !== value.packetId
      )
        return yield* staleContextual();
      const existing = yield* sql<{
        receipt_json: string;
      }>`SELECT receipt_json FROM contextual_receipts WHERE dispatch_id=${value.dispatchId}`;
      const body = yield* encodeReceipt(value);
      let reconciled = false;
      if (existing[0]) {
        if (existing[0].receipt_json === body) return;
        const previous = yield* decodeReceipt(existing[0].receipt_json);
        if (
          previous.acceptance !== "unknown" ||
          value.acceptance === "unknown" ||
          previous.id !== value.id ||
          previous.evidenceIncluded !== value.evidenceIncluded ||
          preparation.state !== "delivery-unknown"
        )
          return yield* staleContextual();
        reconciled = true;
      }
      if (!reconciled && preparation.state !== "dispatching") return yield* staleContextual();
      const delivered = value.packetId ? yield* packet(value.packetId, value.threadId) : null;
      const evidenceIds = delivered?.groups.flatMap((g) => g.evidence.map((e) => e.id)) ?? [];
      if (value.suppliedEvidenceIds.some((id) => !evidenceIds.includes(id)))
        return yield* staleContextual();
      yield* sql`INSERT INTO contextual_receipts(id,dispatch_id,thread_id,packet_id,receipt_json,received_at) VALUES (${value.id},${value.dispatchId},${value.threadId},${value.packetId},${body},${value.receivedAt})
        ON CONFLICT(dispatch_id) DO UPDATE SET receipt_json=excluded.receipt_json,received_at=excluded.received_at`;
      if (value.evidenceIncluded && value.acceptance !== "rejected" && delivered) {
        for (const group of delivered.groups) {
          if (
            value.acceptance === "accepted" &&
            !group.evidence.every((e) => value.suppliedEvidenceIds.includes(e.id))
          )
            return yield* staleContextual();
          yield* sql`INSERT OR IGNORE INTO contextual_supply(thread_id,guidance_id,fingerprint,context_epoch,packet_id,dispatch_id,message_id,source_revision,acceptance,supplied_at)
          VALUES (${value.threadId},${group.guidanceId},${group.contentFingerprint},${value.providerContextEpoch},${delivered.id},${value.dispatchId},${preparation.task.messageId},${group.recordRevision},${value.acceptance},${value.receivedAt})`;
        }
      }
      const state =
        value.acceptance === "unknown"
          ? "delivery-unknown"
          : value.acceptance === "accepted" && value.evidenceIncluded
            ? "delivered"
            : "failed";
      if (reconciled) {
        if (value.acceptance === "rejected")
          yield* sql`DELETE FROM contextual_supply WHERE dispatch_id=${value.dispatchId} AND acceptance='unknown'`;
        else
          yield* sql`UPDATE contextual_supply SET acceptance='accepted' WHERE dispatch_id=${value.dispatchId}`;
        const settled = {
          ...preparation,
          state,
          revision: preparation.revision + 1,
          updatedAt: value.receivedAt,
        } as const;
        yield* sql`UPDATE contextual_preparations SET state=${state},revision=${settled.revision},preparation_json=${yield* encodePreparation(settled)},updated_at=${value.receivedAt} WHERE id=${preparation.id}`;
      } else {
        yield* update(
          {
            ...preparation,
            state,
            revision: preparation.revision + 1,
            updatedAt: value.receivedAt,
          },
          preparation.revision,
        );
      }
      yield* appendContextualEvent(sql, {
        threadId: value.threadId,
        revision: preparation.revision + 1,
        kind: "delivery-recorded",
        entityId: value.id,
      });
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );

  const receipt = (value: ContextualDeliveryReceipt) =>
    recordReceipt(value).pipe(
      Effect.tap(() => (Option.isSome(summaries) ? summaries.value.schedule(value) : Effect.void)),
    );

  const supplied = Effect.fn("Contextual.wasSupplied")(function* (
    threadId: ThreadId,
    guidanceId: string,
    fingerprint: string,
    contextEpoch: string,
  ) {
    const rows =
      yield* sql`SELECT 1 FROM contextual_supply WHERE thread_id=${threadId} AND guidance_id=${guidanceId} AND fingerprint=${fingerprint} AND context_epoch=${contextEpoch} LIMIT 1`;
    return rows.length > 0;
  }, Effect.mapError(contextualBoundary));

  const disclosures = Effect.fn("Contextual.disclosures")(function* (
    threadId: ThreadId,
    cursor?: string,
    limit = 50,
    messageId?: MessageId,
  ) {
    yield* requireContextualThread(sql, threadId);
    const rows = yield* sql<{
      preparation_json: string | null;
      receipt_json: string;
      origin_thread_id: ThreadId | null;
      inherited_message_id: string | null;
      message_id: string | null;
      packet_json: string | null;
      summary_text: string | null;
      retention: ContextualDisclosure["retention"] | null;
    }>`SELECT r.receipt_json,p.packet_json,p.retention,ds.text AS summary_text,pr.preparation_json,i.origin_thread_id,i.message_id AS inherited_message_id,COALESCE(i.message_id,pr.message_id) AS message_id FROM contextual_receipts r LEFT JOIN contextual_packets p ON p.id=r.packet_id LEFT JOIN contextual_display_summaries ds ON ds.packet_id=p.id AND p.packet_json IS NOT NULL AND p.retention='available' AND json_extract(r.receipt_json,'$.acceptance')='accepted' LEFT JOIN contextual_inherited_disclosures i ON i.receipt_id=r.id AND i.thread_id=${threadId} LEFT JOIN contextual_preparations pr ON pr.id=json_extract(r.receipt_json,'$.preparationId')
    WHERE (r.thread_id=${threadId} OR EXISTS(SELECT 1 FROM contextual_inherited_disclosures i WHERE i.thread_id=${threadId} AND i.receipt_id=r.id))
    AND ${messageId ? sql`COALESCE(i.message_id,pr.message_id)=${messageId}` : sql`1=1`}
    AND ${cursor ? sql`r.id<${cursor}` : sql`1=1`} ORDER BY r.id DESC LIMIT ${limit}`;
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return {
          ...(row.origin_thread_id && row.inherited_message_id
            ? {
                inherited: {
                  originThreadId: row.origin_thread_id,
                  messageId: MessageId.make(row.inherited_message_id),
                },
              }
            : {}),
          ...(row.message_id ? { messageId: MessageId.make(row.message_id) } : {}),
          ...(row.preparation_json
            ? { coverage: (yield* decodePreparation(row.preparation_json)).coverage }
            : {}),
          ...(row.summary_text
            ? { displaySummary: { state: "ready" as const, text: row.summary_text } }
            : {}),
          receipt: yield* decodeReceipt(row.receipt_json),
          packet: row.packet_json ? yield* decodePacket(row.packet_json) : null,
          retention: row.retention ?? "expired",
        } satisfies ContextualDisclosure;
      }),
    );
  }, Effect.mapError(contextualBoundary));
  return { get, create, update, putPacket, packet, suppliedPacket, receipt, supplied, disclosures };
});
export class ContextualRepository extends Context.Service<
  ContextualRepository,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualRepository") {}
export const layer = Layer.effect(ContextualRepository, make);
