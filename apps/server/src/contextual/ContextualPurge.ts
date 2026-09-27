import * as NodeCrypto from "node:crypto";
import {
  ContextualDataForgetRequest,
  ContextualDataJobReceipt,
  ContextualPreparation,
  ContextualPacket,
  ContextualSourcePolicy,
  ContextualError,
} from "@lecturn/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ExtensionsRuntime } from "../extensions/ExtensionsRuntime.ts";
import { contextualBoundary, contextualNow, appendContextualEvent } from "./ContextualSettings.ts";
import { fingerprint } from "./DecisionCandidates.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(ContextualDataForgetRequest));
const encodePolicy = Schema.encodeSync(Schema.fromJsonString(ContextualSourcePolicy));
const encodePreparation = Schema.encodeSync(Schema.fromJsonString(ContextualPreparation));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(ContextualDataJobReceipt));
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ContextualDataForgetRequest),
);
const decodePacket = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualPacket));
const decodePreparation = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualPreparation));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualDataJobReceipt));
export const emptyPolicy = ContextualSourcePolicy.make({
  allowedSourceIds: [],
  allowDirectMessages: false,
  allowGroupDirectMessages: false,
  unknownConversationPolicy: "exclude",
  draftsPolicy: "exclude",
  revision: 0,
});
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const helper = yield* ExtensionsRuntime;
  const ensureHost = sql`INSERT OR IGNORE INTO contextual_host_state(singleton,source_policy_json,updated_at) VALUES(1,${encodePolicy(emptyPolicy)},'1970-01-01T00:00:00.000Z')`;
  const fence = Effect.fn("Contextual.purge.fence")(
    function* (input: ContextualDataForgetRequest) {
      yield* ensureHost;
      const old = yield* sql<{
        id: string;
        selection_json: string;
      }>`SELECT id,selection_json FROM contextual_purge_jobs WHERE action_id=${input.actionId}`;
      if (old[0]) {
        if (fingerprint(yield* decodeRequest(old[0].selection_json)) !== fingerprint(input))
          return yield* new ContextualError({
            code: "stale-revision",
            message: "Forget action changed.",
          });
        return old[0].id;
      }
      const at = yield* contextualNow;
      yield* sql`UPDATE contextual_host_state SET purge_generation=purge_generation+1,updated_at=${at} WHERE singleton=1`;
      const host = yield* sql<{
        purge_generation: number;
      }>`SELECT purge_generation FROM contextual_host_state WHERE singleton=1`;
      const generation = host[0]!.purge_generation;
      const id = NodeCrypto.randomUUID();
      yield* sql`INSERT INTO contextual_purge_jobs(id,action_id,generation,selection_json,state,updated_at) VALUES(${id},${input.actionId},${generation},${encodeRequest(input)},'pending',${at})`;
      const selection = input.selection;
      const sourceIds = selection.kind === "sources" ? selection.sourceIds : [selection.sourceId];
      for (const sourceId of sourceIds) {
        if (selection.kind === "sources")
          yield* sql`INSERT OR REPLACE INTO contextual_suppression(entity_kind,entity_id,generation) VALUES('source',${sourceId},${generation})`;
        else
          for (const occurrence of selection.occurrenceIds)
            yield* sql`INSERT OR REPLACE INTO contextual_suppression(entity_kind,entity_id,generation) VALUES('occurrence',${occurrence},${generation})`;
      }
      if (selection.kind === "sources") {
        const projects = yield* sql<{
          project_id: string;
          source_ids_json: string;
        }>`SELECT project_id,source_ids_json FROM contextual_project_settings`;
        for (const project of projects) {
          const ids = yield* decodeIds(project.source_ids_json);
          if (ids.some((id) => sourceIds.includes(id)))
            yield* sql`UPDATE contextual_project_settings SET source_ids_json=${encodeIds(ids.filter((id) => !sourceIds.includes(id)))},revision=revision+1 WHERE project_id=${project.project_id}`;
        }
        const threads = yield* sql<{
          thread_id: string;
          source_ids_json: string;
        }>`SELECT thread_id,source_ids_json FROM contextual_thread_settings`;
        for (const thread of threads) {
          const ids = yield* decodeIds(thread.source_ids_json);
          if (ids.some((id) => sourceIds.includes(id)))
            yield* sql`UPDATE contextual_thread_settings SET source_ids_json=${encodeIds(ids.filter((id) => !sourceIds.includes(id)))},revision=revision+1 WHERE thread_id=${thread.thread_id}`;
        }
      }
      if (selection.kind === "items")
        for (const occurrence of selection.occurrenceIds)
          yield* sql`INSERT OR REPLACE INTO contextual_suppression(entity_kind,entity_id,generation) VALUES('evidence',${`occurrence:${occurrence}`},${generation})`;
      // Discover exact original evidence lineage before removing purgeable payloads.
      const packets = yield* sql<{
        id: string;
        packet_json: string;
      }>`SELECT id,packet_json FROM contextual_packets WHERE packet_json IS NOT NULL`;
      const affected = new Set<string>();
      for (const row of packets) {
        const packet = yield* decodePacket(row.packet_json);
        for (const group of packet.groups)
          for (const e of group.evidence) {
            if (
              sourceIds.includes(e.sourceId) &&
              (selection.kind === "sources" || selection.occurrenceIds.includes(e.occurrenceId))
            ) {
              affected.add(row.id);
              for (const evidenceId of [e.id, ...e.lineageIds])
                yield* sql`INSERT OR REPLACE INTO contextual_suppression(entity_kind,entity_id,generation) VALUES('evidence',${evidenceId},${generation})`;
            }
          }
      }
      yield* sql`INSERT OR REPLACE INTO contextual_suppression(entity_kind,entity_id,generation)
      SELECT 'decision',l.entity_id,${generation} FROM contextual_lineage l WHERE l.entity_kind='decision' AND (${selection.kind === "sources" ? sql`l.source_id IN ${sql.in(sourceIds)}` : sql`0=1`} OR l.source_evidence_id IN (SELECT entity_id FROM contextual_suppression WHERE entity_kind='evidence'))`;
      const derived = yield* sql<{
        entity_id: string;
      }>`SELECT DISTINCT entity_id FROM contextual_lineage WHERE entity_kind='packet' AND source_evidence_id IN (SELECT entity_id FROM contextual_suppression WHERE entity_kind='evidence')`;
      derived.forEach((r) => affected.add(r.entity_id));
      for (const packetId of affected)
        yield* sql`UPDATE contextual_packets SET packet_json=NULL,payload_bytes=0,retention='forgotten' WHERE id=${packetId}`;
      yield* sql`DELETE FROM contextual_evaluations`;
      yield* sql`UPDATE decision_jobs SET state='canceled',reason='contextual-forgotten',stage_json='{}',fence=fence+1,lease_owner=NULL,lease_until=NULL WHERE id IN (SELECT entity_id FROM contextual_lineage WHERE entity_kind='decision-job' AND (${selection.kind === "sources" ? sql`source_id IN ${sql.in(sourceIds)}` : sql`0=1`} OR source_evidence_id IN (SELECT entity_id FROM contextual_suppression WHERE entity_kind='evidence'))) AND state NOT IN ('completed','canceled')`;
      // Pending tasks contain user text only, but packets and conflict claims may contain forgotten source text.
      yield* sql`UPDATE contextual_conflicts SET relation_json=NULL,resolution_json=NULL,status='invalidated',revision=revision+1,updated_at=${at}`;
      const pending = yield* sql<{
        preparation_json: string;
      }>`SELECT preparation_json FROM contextual_preparations WHERE state IN ('requested','retrieving','evaluating','checking-conflicts','prepared','awaiting-conflict-review')`;
      for (const row of pending) {
        const p = yield* decodePreparation(row.preparation_json);
        const next = {
          ...p,
          state:
            p.state === "awaiting-conflict-review"
              ? ("awaiting-conflict-review" as const)
              : ("skipped" as const),
          packetId: null,
          conflictIds: p.state === "awaiting-conflict-review" ? p.conflictIds : [],
          revision: p.revision + 1,
          updatedAt: at,
        };
        yield* sql`UPDATE contextual_preparations SET state=${next.state},revision=${next.revision},preparation_json=${encodePreparation(next)},continuation_json=NULL,updated_at=${at} WHERE id=${p.id}`;
        yield* appendContextualEvent(sql, {
          threadId: p.task.threadId,
          revision: next.revision,
          kind: "data-forgotten",
          entityId: id,
        });
      }
      return id;
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  const finish = Effect.fn("Contextual.purge.finish")(function* (
    input: ContextualDataForgetRequest,
    id: string,
  ) {
    const actions = yield* sql<{
      result_json: string;
    }>`SELECT result_json FROM contextual_actions WHERE action_id=${input.actionId}`;
    if (actions[0]) return yield* decodeReceipt(actions[0].result_json);
    const selection = input.selection;
    const localOnly =
      selection.kind === "sources"
        ? selection.sourceIds.every((id) => id.startsWith("decisions:"))
        : selection.sourceId.startsWith("decisions:");
    const remoteSelection =
      selection.kind === "sources"
        ? {
            ...selection,
            sourceIds: selection.sourceIds.filter((id) => !id.startsWith("decisions:")),
          }
        : selection;
    const hostRows = yield* sql<{
      source_revision: number;
      purge_generation: number;
    }>`SELECT source_revision,purge_generation FROM contextual_host_state WHERE singleton=1`;
    const receipt: ContextualDataJobReceipt = localOnly
      ? {
          jobId: id,
          actionId: input.actionId,
          operation: "forget",
          state: "completed",
          sourceGeneration: hostRows[0]!.source_revision,
          purgeGeneration: hostRows[0]!.purge_generation,
          artifactId: null,
          affectedRecords: 0,
          updatedAt: yield* contextualNow,
        }
      : yield* helper.request("contextual.data.forget", { ...input, selection: remoteSelection });
    const sources = localOnly
      ? null
      : yield* helper.request("contextual.sources.list", { limit: 1 });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT OR REPLACE INTO contextual_actions(action_id,fingerprint,result_json,created_at) VALUES(${input.actionId},${fingerprint(input)},${encodeReceipt(receipt)},${receipt.updatedAt})`;
        yield* sql`UPDATE contextual_purge_jobs SET state='completed',updated_at=${receipt.updatedAt} WHERE id=${id}`;
        if (sources)
          yield* sql`UPDATE contextual_host_state SET source_policy_json=${encodePolicy(sources.policy)},source_revision=source_revision+1,updated_at=${receipt.updatedAt} WHERE singleton=1`;
      }),
    );
    return receipt;
  }, Effect.mapError(contextualBoundary));
  const forget = Effect.fn("Contextual.forget")(function* (input: ContextualDataForgetRequest) {
    return yield* finish(input, yield* fence(input));
  });
  const recover = Effect.fn("Contextual.purge.recover")(function* () {
    const rows = yield* sql<{
      id: string;
      selection_json: string;
    }>`SELECT id,selection_json FROM contextual_purge_jobs WHERE state='pending' ORDER BY generation`;
    for (const row of rows)
      yield* finish(yield* decodeRequest(row.selection_json), row.id).pipe(Effect.ignore);
  }, Effect.mapError(contextualBoundary));
  return { forget, recover, ensureHost };
});
export class ContextualPurge extends Context.Service<
  ContextualPurge,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualPurge") {}
export const layer = Layer.effect(ContextualPurge, make);
