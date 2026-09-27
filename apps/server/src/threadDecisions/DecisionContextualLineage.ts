import {
  ContextualPacket,
  ContextualSourcePolicy,
  ThreadDecisionError,
  type ThreadId,
  type DecisionWriterInput,
  type DecisionId,
} from "@lecturn/contracts";
import { decisionFingerprint } from "@lecturn/shared/decisionEvidence";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
const decodePacket = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualPacket));
const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualSourcePolicy));
const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
export type ContextualOrigin = NonNullable<DecisionWriterInput["contextualOrigins"]>[number];
export const readContextualOrigins = Effect.fn("Decisions.contextualOrigins")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  jobId: string,
) {
  const hosts = yield* sql<{
    purge_generation: number;
    source_policy_json: string;
  }>`SELECT purge_generation,source_policy_json FROM contextual_host_state WHERE singleton=1`;
  const generation = hosts[0]?.purge_generation ?? 0;
  const threads = yield* sql<{
    enabled: number;
    source_ids_json: string;
    project_sources: string;
  }>`SELECT t.enabled,t.source_ids_json,p.source_ids_json AS project_sources FROM contextual_thread_settings t JOIN contextual_project_settings p ON p.project_id=t.project_id WHERE t.thread_id=${threadId}`;
  const allowed = new Set(
    threads[0]?.enabled === 1 ? yield* decodeIds(threads[0].source_ids_json) : [],
  );
  const projectAllowed = new Set(threads[0] ? yield* decodeIds(threads[0].project_sources) : []);
  const policy = hosts[0] ? yield* decodePolicy(hosts[0].source_policy_json) : null;
  const rows = yield* sql<{
    id: string;
    packet_json: string | null;
  }>`SELECT DISTINCT p.packet_json,p.id FROM contextual_supply s JOIN contextual_packets p ON p.id=s.packet_id WHERE s.thread_id=${threadId} ORDER BY p.created_at DESC,p.id DESC LIMIT 32`;
  const origins: ContextualOrigin[] = [];
  let characters = 0;
  for (const row of rows) {
    yield* sql`INSERT OR IGNORE INTO contextual_lineage SELECT source_id,source_evidence_id,'decision-job',${jobId} FROM contextual_lineage WHERE entity_kind='packet' AND entity_id=${row.id}`;
    if (!row.packet_json) {
      const identities = yield* sql<{
        source_id: string;
        source_evidence_id: string;
      }>`SELECT source_id,source_evidence_id FROM contextual_lineage WHERE entity_kind='packet-origin' AND entity_id=${row.id} ORDER BY source_evidence_id LIMIT 64`;
      for (const identity of identities) {
        if (
          origins.length >= 64 ||
          origins.some((o) => o.evidenceId === identity.source_evidence_id)
        )
          continue;
        origins.push({
          sourceId: identity.source_id,
          evidenceId: identity.source_evidence_id,
          sourceHash: null,
          quote: null,
        });
        yield* sql`INSERT OR IGNORE INTO contextual_lineage VALUES(${identity.source_id},${identity.source_evidence_id},'job-origin',${jobId})`;
      }
      continue;
    }
    const packet = yield* decodePacket(row.packet_json);
    for (const group of packet.groups)
      for (const evidence of group.evidence) {
        if (origins.length >= 64 || origins.some((o) => o.evidenceId === evidence.id)) continue;
        const permitted =
          allowed.has(evidence.sourceId) &&
          projectAllowed.has(evidence.sourceId) &&
          (evidence.sourceKind === "lecturn-decision" ||
            policy?.allowedSourceIds.includes(evidence.sourceId));
        const blocked =
          yield* sql`SELECT 1 FROM contextual_suppression WHERE (entity_kind='source' AND entity_id=${evidence.sourceId}) OR (entity_kind='evidence' AND entity_id=${evidence.id}) OR (entity_kind='occurrence' AND entity_id=${evidence.occurrenceId}) LIMIT 1`;
        const quote =
          permitted && !blocked.length && characters + evidence.quote.length <= 16000
            ? evidence.quote
            : null;
        characters += quote?.length ?? 0;
        yield* sql`INSERT OR IGNORE INTO contextual_lineage VALUES(${evidence.sourceId},${evidence.id},'job-origin',${jobId})`;
        for (const ancestor of [
          evidence.id,
          `occurrence:${evidence.occurrenceId}`,
          ...evidence.lineageIds,
        ])
          yield* sql`INSERT OR IGNORE INTO contextual_lineage VALUES(${evidence.sourceId},${ancestor},'origin',${evidence.id})`;
        if (evidence.locator.sourceKind === "lecturn-decision")
          yield* sql`INSERT OR IGNORE INTO contextual_lineage SELECT source_id,source_evidence_id,'origin',${evidence.id} FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${evidence.locator.decisionId}`;
        origins.push({
          sourceId: evidence.sourceId,
          evidenceId: evidence.id,
          sourceHash: evidence.sourceHash,
          quote,
        });
        for (const original of [
          evidence.id,
          `occurrence:${evidence.occurrenceId}`,
          ...evidence.lineageIds,
        ])
          yield* sql`INSERT OR IGNORE INTO contextual_lineage(source_id,source_evidence_id,entity_kind,entity_id) VALUES(${evidence.sourceId},${original},'decision-job',${jobId})`;
      }
  }
  return { origins, generation, scope: decisionFingerprint([hosts, threads]), threadId };
});
export const assertContextualOrigins = Effect.fn("Decisions.contextualOriginsFence")(function* (
  sql: SqlClient.SqlClient,
  generation: number,
  scope?: { threadId: ThreadId; scope: string },
) {
  const rows = yield* sql<{
    purge_generation: number;
  }>`SELECT purge_generation FROM contextual_host_state WHERE singleton=1`;
  let changed = false;
  if (scope) {
    const hosts =
      yield* sql`SELECT purge_generation,source_policy_json FROM contextual_host_state WHERE singleton=1`;
    const threads =
      yield* sql`SELECT t.enabled,t.source_ids_json,p.source_ids_json AS project_sources FROM contextual_thread_settings t JOIN contextual_project_settings p ON p.project_id=t.project_id WHERE t.thread_id=${scope.threadId}`;
    changed = decisionFingerprint([hosts, threads]) !== scope.scope;
  }
  if (changed || (rows[0]?.purge_generation ?? 0) !== generation)
    return yield* new ThreadDecisionError({
      code: "stale-source",
      message: "Contextual source data changed during writing.",
    });
});
export const recordContextualLineage = Effect.fn("Decisions.recordContextualLineage")(function* (
  sql: SqlClient.SqlClient,
  jobId: string,
  decisionId: DecisionId,
  sourceLineageIds: readonly string[],
) {
  for (const originId of new Set(sourceLineageIds)) {
    const provided =
      yield* sql`SELECT 1 FROM contextual_lineage WHERE entity_kind='job-origin' AND entity_id=${jobId} AND source_evidence_id=${originId} LIMIT 1`;
    if (!provided.length)
      return yield* new ThreadDecisionError({
        code: "invalid",
        message: "Decision lineage must reference an origin supplied to this writer job.",
      });
    // Only the occurrence's validated selected origins contribute ancestry, never ambient history.
    yield* sql`INSERT OR IGNORE INTO contextual_lineage(source_id,source_evidence_id,entity_kind,entity_id) SELECT source_id,source_evidence_id,'decision',${decisionId} FROM contextual_lineage WHERE entity_kind='origin' AND entity_id=${originId}`;
  }
});
