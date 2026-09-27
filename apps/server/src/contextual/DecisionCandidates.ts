import * as NodeCrypto from "node:crypto";
import {
  ContextualDecisionCandidate,
  type ContextualTaskSnapshot,
  type ThreadDecision,
  type ContextualCandidate,
  type ContextualEvidence,
  type ContextualPacketGroup,
  DecisionId,
} from "@lecturn/contracts";
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DecisionRepository } from "../threadDecisions/DecisionRepository.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { contextualBoundary } from "./ContextualSettings.ts";

export const fingerprint = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const completeCoverage = {
  complete: true,
  missingAntecedents: false,
  truncated: false,
  unexaminedCount: 0,
} as const;
export const evidenceIdentity = (e: ContextualEvidence): string =>
  fingerprint([
    e.locator.sourceKind === "slack"
      ? [e.locator.workspaceId, e.locator.channelId, e.locator.messageTs]
      : [e.locator.environmentId, e.locator.threadId, e.locator.messageId],
    e.sourceHash,
    e.start,
    e.end,
  ]);

const evidenceVersion = (e: ContextualEvidence): string =>
  fingerprint([
    evidenceIdentity(e),
    e.id,
    e.sourceId,
    e.sourceKind,
    e.occurrenceId,
    e.sourceRevision,
    e.canonicalVersion,
    e.coordinateSystem,
    e.quote,
    e.prefix,
    e.suffix,
    e.author,
    e.occurredAt,
    e.observedAt,
    e.sourceUrl,
    e.availability,
    [...e.lineageIds].sort(),
    e.locator.sourceKind === "lecturn-decision"
      ? [e.locator.projectId, e.locator.decisionId, e.locator.evidenceId, e.locator.messageRole]
      : [e.locator.threadTs],
  ]);

/** The saved note is derived content; its exact original anchors retain their own authority. */
export function decisionCandidate(
  note: ThreadDecision,
  task: ContextualTaskSnapshot,
  lineageIds: readonly string[] = [],
): ContextualDecisionCandidate | null {
  if (note.projectId !== task.projectId || note.evidence.length === 0) return null;
  const evidence = note.evidence.filter((e) => e.availability !== "changed");
  const missingAntecedents =
    evidence.length !== note.evidence.length ||
    (note.attribution === "user-accepted" &&
      !evidence.some(
        (proposal) =>
          proposal.messageRole === "assistant" &&
          evidence.some(
            (acceptance) =>
              acceptance.messageRole === "user" &&
              acceptance.threadId === proposal.threadId &&
              acceptance.occurrence > proposal.occurrence,
          ),
      ));
  if (evidence.length === 0) return null;
  const sourceId = `decisions:${note.projectId}`;
  return ContextualDecisionCandidate.make({
    id: `decision:${note.id}:${note.revision}`,
    sourceId,
    sourceKind: "lecturn-decision",
    occurrenceId: note.id,
    recordRevision: note.revision,
    guidanceId: `decision:${note.id}`,
    contentFingerprint: fingerprint([
      note.title,
      note.body,
      note.rationale,
      note.attribution,
      note.reviewState,
      note.lifecycle,
      note.evidence,
      note.relationships,
      [...lineageIds].sort(),
    ]),
    lineageIds: [...lineageIds],
    coverage: { ...completeCoverage, complete: !missingAntecedents, missingAntecedents },
    evidence: evidence.map((e) => ({
      id: e.id,
      sourceId,
      sourceKind: "lecturn-decision" as const,
      occurrenceId: note.id,
      sourceRevision: e.sourceGeneration,
      sourceHash: e.sourceHash,
      canonicalVersion: e.canonicalVersion,
      coordinateSystem: "utf16" as const,
      quote: e.quote,
      start: e.start,
      end: e.end,
      prefix: e.prefix,
      suffix: e.suffix,
      author: e.messageRole,
      occurredAt: note.occurredAt,
      observedAt: note.updatedAt,
      sourceUrl: null,
      availability:
        e.availability === "available" || e.availability === "thread-archived"
          ? ("available" as const)
          : ("stored-only" as const),
      lineageIds: [...lineageIds],
      locator: {
        sourceKind: "lecturn-decision" as const,
        environmentId: task.environmentId,
        projectId: note.projectId,
        threadId: e.threadId,
        messageId: e.messageId,
        messageRole: e.messageRole,
        decisionId: note.id,
        evidenceId: e.id,
      },
    })),
    state: "not-yet-evaluated",
    environmentId: task.environmentId,
    projectId: note.projectId,
    threadId: note.threadId,
    decisionId: note.id,
    decisionRevision: note.revision,
    attribution: note.attribution,
    reviewState: note.reviewState,
    lifecycle: note.lifecycle,
    replacementIds: note.relationships
      .filter((r) => r.state === "accepted" && r.predecessorId === note.id)
      .map((r) => r.successorId)
      .slice(0, 32),
    derivedSummary: {
      title: note.title,
      body: note.body,
      rationale: note.rationale,
      userEdited: note.userEdited,
    },
  });
}

/** Preserve complete exchanges; do not trim antecedents merely to fill the packet. */
export function deduplicateCandidates(
  candidates: readonly ContextualCandidate[],
): ContextualCandidate[] {
  const identities = new Set<string>();
  const guidance = new Set<string>();
  const result: ContextualCandidate[] = [];
  for (const candidate of [...candidates].sort(
    (a, b) => Number(b.coverage.complete) - Number(a.coverage.complete),
  )) {
    if (candidate.coverage.missingAntecedents || candidate.coverage.truncated) continue;
    const keys = candidate.evidence.map(evidenceIdentity);
    if (
      guidance.has(candidate.guidanceId) ||
      // Lineage links provenance, not interchangeable evidence spans. It still
      // controls forgetting/suppression, but cannot prove the quotes are duplicates.
      keys.every((key) => identities.has(key))
    )
      continue;
    guidance.add(candidate.guidanceId);
    keys.forEach((key) => identities.add(key));
    result.push(candidate);
    if (result.length === 24) break;
  }
  return result;
}

export const make = Effect.gen(function* () {
  const decisions = yield* DecisionRepository;
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const routineEligible = (note: ThreadDecision) =>
    note.lifecycle === "current" &&
    note.reviewState !== "dismissed" &&
    !note.relationships.some((r) => r.predecessorId === note.id && r.state === "proposed");
  const candidate = Effect.fn("Contextual.decisionCandidate")(function* (
    note: ThreadDecision,
    task: ContextualTaskSnapshot,
  ) {
    if (task.environmentId !== environmentId || note.projectId !== task.projectId) return null;
    const origins = yield* sql<{
      source_evidence_id: string;
    }>`SELECT source_evidence_id FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${note.id} ORDER BY source_evidence_id, source_id LIMIT 65`;
    if (origins.length > 64) return null;
    const blocked =
      yield* sql`SELECT 1 FROM contextual_suppression WHERE (entity_kind IN ('decision','occurrence') AND entity_id=${note.id}) OR (entity_kind='source' AND entity_id=${`decisions:${task.projectId}`}) OR (entity_kind='evidence' AND entity_id IN (SELECT id FROM decision_evidence WHERE decision_id=${note.id} UNION SELECT source_evidence_id FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${note.id})) OR (entity_kind='source' AND entity_id IN (SELECT source_id FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${note.id})) LIMIT 1`;
    if (blocked.length) return null;
    const anchors = yield* sql<{
      id: string;
      text: string | null;
      role: string | null;
      generation: number | null;
      deleted_at: string | null;
    }>`SELECT e.id, m.text, m.role, s.source_generation AS generation, t.deleted_at FROM decision_evidence e LEFT JOIN projection_thread_messages m ON m.thread_id=e.thread_id AND m.message_id=e.message_id LEFT JOIN decision_thread_state s ON s.thread_id=e.thread_id LEFT JOIN projection_threads t ON t.thread_id=e.thread_id WHERE e.decision_id=${note.id}`;
    const invalid = new Set(
      anchors
        .filter((a) => {
          const e = note.evidence.find((e) => e.id === a.id);
          return (
            e &&
            a.deleted_at === null &&
            ((a.generation !== null && a.generation !== e.sourceGeneration) ||
              (a.text !== null &&
                (a.text.slice(e.start, e.end) !== e.quote || a.role !== e.messageRole)))
          );
        })
        .map((a) => a.id),
    );
    const value = decisionCandidate(
      {
        ...note,
        evidence: note.evidence.map((e) =>
          invalid.has(e.id) ? { ...e, availability: "changed" as const } : e,
        ),
      },
      task,
      [...new Set(origins.map((r) => r.source_evidence_id))],
    );
    if (!value) return null;
    const members = yield* sql<{
      group_id: string;
    }>`SELECT group_id FROM contextual_group_members WHERE decision_id=${note.id} AND occurrence_revision=${note.revision}`;
    return members[0] ? { ...value, guidanceId: `group:${members[0].group_id}` } : value;
  });
  const retrieve = Effect.fn("Contextual.decisions.retrieve")(function* (
    task: ContextualTaskSnapshot,
    includeHistorical = false,
  ) {
    if (task.environmentId !== environmentId) return [];
    // Exact references and task terms can retrieve old constraints; a separate small recent slice supports discovery.
    const terms = [
      ...new Set([
        ...task.explicitReferences,
        ...(task.newestMessage.match(/[\p{L}\p{N}_./-]{4,}/gu) ?? []),
      ]),
    ].slice(0, 8);
    const notes = new Map<string, ThreadDecision>();
    for (const reference of task.explicitReferences.slice(0, 8)) {
      const id = reference.replace(/^decision:/, "");
      if (!id.trim()) continue;
      const note = yield* decisions
        .get({ projectId: task.projectId, id: DecisionId.make(id) })
        .pipe(
          Effect.catchTag("ThreadDecisionError", (error) =>
            error.code === "not-found" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
      if (note) notes.set(note.id, note);
    }
    for (const search of terms) {
      const page = yield* decisions.list({
        projectId: task.projectId,
        search: search.slice(0, 256),
        limit: 12,
        ...(includeHistorical ? { lifecycle: "all" as const, reviewState: "all" as const } : {}),
      });
      for (const note of page.decisions) if (notes.size < 48) notes.set(note.id, note);
    }
    const recent = yield* decisions.list({
      projectId: task.projectId,
      limit: 6,
      ...(includeHistorical ? { lifecycle: "all" as const, reviewState: "all" as const } : {}),
    });
    for (const note of recent.decisions) if (notes.size < 48) notes.set(note.id, note);
    const result: ContextualDecisionCandidate[] = [];
    for (const note of [...notes.values()].sort(
      (a, b) => Number(b.reviewState === "confirmed") - Number(a.reviewState === "confirmed"),
    )) {
      if (!includeHistorical && !routineEligible(note)) continue;
      if (
        task.trigger === "submission" &&
        (note.threadId === task.threadId || note.evidence.some((e) => e.threadId === task.threadId))
      )
        continue;
      const value = yield* candidate(note, task);
      if (value) result.push(value);
      if (result.length === 24) break;
    }
    return result;
  }, Effect.mapError(contextualBoundary));
  const revalidate = Effect.fn("Contextual.decisions.revalidate")(function* (
    value: ContextualDecisionCandidate,
    task: ContextualTaskSnapshot,
  ) {
    const note = yield* decisions.get({ projectId: task.projectId, id: value.decisionId });
    const current = yield* candidate(note, task);
    return (
      current !== null &&
      note.revision === value.decisionRevision &&
      routineEligible(note) &&
      current.coverage.complete &&
      current.contentFingerprint === value.contentFingerprint &&
      current.guidanceId === value.guidanceId
    );
  }, Effect.mapError(contextualBoundary));
  const revalidateGroup = Effect.fn("Contextual.decisions.revalidateGroup")(function* (
    group: ContextualPacketGroup,
    task: ContextualTaskSnapshot,
  ) {
    const locator = group.evidence[0]?.locator;
    if (
      !locator ||
      locator.sourceKind !== "lecturn-decision" ||
      locator.environmentId !== task.environmentId ||
      locator.projectId !== task.projectId
    )
      return false;
    const note = yield* decisions
      .get({ projectId: task.projectId, id: locator.decisionId })
      .pipe(
        Effect.catchTag("ThreadDecisionError", (error) =>
          error.code === "not-found" ? Effect.succeed(null) : Effect.fail(error),
        ),
      );
    if (!note || !routineEligible(note)) return false;
    const current = yield* candidate(note, task);
    if (
      !current ||
      !current.coverage.complete ||
      current.id !== group.candidateId ||
      current.occurrenceId !== group.occurrenceId ||
      current.guidanceId !== group.guidanceId ||
      current.recordRevision !== group.recordRevision ||
      current.contentFingerprint !== group.contentFingerprint ||
      current.attribution !== group.attribution
    )
      return false;
    return (
      group.evidence.length === current.evidence.length &&
      group.evidence.every((e) =>
        current.evidence.some((now) => evidenceVersion(e) === evidenceVersion(now)),
      )
    );
  }, Effect.mapError(contextualBoundary));
  return { retrieve, revalidate, revalidateGroup, candidate };
});
export class DecisionCandidates extends Context.Service<
  DecisionCandidates,
  Effect.Success<typeof make>
>()("lecturn/contextual/DecisionCandidates") {}
export const layer = Layer.effect(DecisionCandidates, make);
