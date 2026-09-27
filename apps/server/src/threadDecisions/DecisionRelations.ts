import * as C from "@lecturn/contracts";
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { DecisionRepository } from "./DecisionRepository.ts";
import { ContextualGroups } from "../contextual/ContextualGroups.ts";
import { ExtensionsCloudClient } from "../extensions/ExtensionsCloudClient.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  decisionCandidate,
  evidenceIdentity,
  fingerprint,
} from "../contextual/DecisionCandidates.ts";
import {
  contextualNow,
  contextualBoundary,
  appendContextualEvent,
} from "../contextual/ContextualSettings.ts";

const encodePairs = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(C.ContextualComparisonPair)),
);
const encodeTargets = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(C.ContextualEquivalenceTarget)),
);
const decodeConflicts = Schema.decodeUnknownEffect(C.ContextualConflictCheckResult);
const decodeEquivalence = Schema.decodeUnknownEffect(C.ContextualEquivalenceCheckResult);
const live = (note: C.ThreadDecision) =>
  note.lifecycle === "current" &&
  note.reviewState !== "dismissed" &&
  note.evidence.every(
    (e) => e.availability === "available" || e.availability === "thread-archived",
  );
const claim = (candidate: C.ContextualDecisionCandidate): C.ContextualClaim => ({
  id: candidate.id,
  candidateId: candidate.id,
  occurrenceId: candidate.occurrenceId,
  revision: candidate.decisionRevision,
  evidence: candidate.evidence.slice(0, 8),
  attribution: candidate.attribution,
  scope: `Project ${candidate.projectId}`,
  temporalApplicability: "Current saved decision; assess applicability from its evidence",
  acceptedReplacementIds: candidate.replacementIds,
});
/** Revision-bound relationships are background work; they never hold or rewrite a running turn. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const background = yield* Effect.serviceOption(BackgroundPolicy);
  const repository = yield* DecisionRepository;
  const groups = yield* Effect.serviceOption(ContextualGroups);
  const cloud = yield* ExtensionsCloudClient;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const mutex = yield* Semaphore.make(1);
  const permitted = Effect.fn("DecisionRelations.permitted")(function* (note: C.ThreadDecision) {
    const blocked =
      yield* sql`SELECT 1 FROM contextual_suppression WHERE (entity_kind IN ('decision','occurrence') AND entity_id=${note.id}) OR (entity_kind='source' AND (entity_id=${`decisions:${note.projectId}`} OR entity_id IN (SELECT source_id FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${note.id}))) OR (entity_kind='evidence' AND entity_id IN (SELECT source_evidence_id FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${note.id})) LIMIT 1`;
    return blocked.length === 0;
  });
  const drive = Effect.gen(function* () {
    if (Option.isSome(background) && !(yield* background.value.shouldRunDurableWork)) return;
    const rows = yield* sql<{
      decision_id: C.DecisionId;
      project_id: C.ProjectId;
      revision: number;
    }>`SELECT q.* FROM decision_relation_queue q JOIN decision_project_settings s ON s.project_id=q.project_id AND s.enabled=1 JOIN thread_decisions d ON d.id=q.decision_id AND d.revision=q.revision JOIN projection_threads t ON t.thread_id=d.thread_id AND t.deleted_at IS NULL JOIN projection_projects p ON p.project_id=q.project_id AND p.deleted_at IS NULL WHERE q.state='queued' ORDER BY q.updated_at,q.decision_id LIMIT 1`;
    const row = rows[0];
    if (!row) return;
    const funding = yield* cloud.status("decisions");
    if (
      !funding.eligible ||
      funding.state !== "active" ||
      (funding.allowance?.remainingInputTokens ?? 0) <= 0
    )
      return;
    const note = yield* repository.get({ projectId: row.project_id, id: row.decision_id });
    if (!live(note) || !(yield* permitted(note))) {
      yield* sql`UPDATE decision_relation_queue SET state='skipped' WHERE decision_id=${note.id} AND revision=${row.revision}`;
      return;
    }
    const generations = yield* sql<{
      purge_generation: number;
    }>`SELECT purge_generation FROM contextual_host_state WHERE singleton=1`;
    const purgeGeneration = generations[0]?.purge_generation ?? 0;
    const task: C.ContextualTaskSnapshot = {
      environmentId,
      projectId: note.projectId,
      threadId: note.threadId,
      submissionId: `intake:${note.id}:${note.revision}`,
      messageId: note.evidence[0]!.messageId,
      turnId: null,
      providerInstanceId: "decisions-intake",
      providerContextEpoch: "intake",
      taskFingerprint: fingerprint([note.id, note.revision]),
      knownContextFingerprint: "none",
      threadSettingsRevision: 0,
      projectSettingsRevision: 0,
      sourceScopeRevision: 0,
      threadExclusionRevision: 0,
      fundingGeneration: funding.generation,
      purgeGeneration,
      newestMessage: `Assess whether this saved decision conflicts with or duplicates other current decisions: ${note.title}\n${note.body}`,
      projectDescription: "Saved decisions in the same project",
      explicitReferences: [],
      recentContext: "",
      trigger: "correction",
    };
    const left = decisionCandidate(note, task);
    if (!left || !left.coverage.complete || left.evidence.length > 8) {
      yield* sql`UPDATE decision_relation_queue SET state='skipped' WHERE decision_id=${note.id} AND revision=${row.revision}`;
      return;
    }
    // Bound by both lexical retrieval and recent commitments; there is no exhaustive project scan.
    const terms =
      note.title
        .toLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu)
        ?.slice(0, 6) ?? [];
    const others = yield* sql<{
      id: C.DecisionId;
    }>`SELECT id FROM thread_decisions WHERE project_id=${note.projectId} AND id<>${note.id} AND lifecycle='current' AND review_state<>'dismissed' ORDER BY CASE WHEN ${terms.length ? sql.join(" OR ")(terms.map((t) => sql`lower(title || ' ' || body) LIKE ${`%${t}%`}`)) : sql`0=1`} THEN 0 ELSE 1 END,occurred_at DESC,id LIMIT 8`;
    const candidates: { note: C.ThreadDecision; candidate: C.ContextualDecisionCandidate }[] = [];
    for (const other of others) {
      const saved = yield* repository.get({ projectId: note.projectId, id: other.id });
      const candidate = decisionCandidate(saved, task);
      if (
        live(saved) &&
        (yield* permitted(saved)) &&
        candidate?.coverage.complete &&
        candidate.evidence.length <= 8
      )
        candidates.push({ note: saved, candidate });
    }
    const pairs: C.ContextualComparisonPair[] = [];
    const targets: C.ContextualEquivalenceTarget[] = [];
    for (const other of candidates) {
      const id = fingerprint(
        [
          [note.id, note.revision],
          [other.note.id, other.note.revision],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
      const pair = { id, left: claim(left), right: claim(other.candidate) };
      const target = { id, left, right: other.candidate };
      if (
        encodePairs([...pairs, pair]).length > 35000 ||
        encodeTargets([...targets, target]).length > 45000
      )
        break;
      pairs.push(pair);
      targets.push(target);
    }
    if (!pairs.length) {
      yield* sql`UPDATE decision_relation_queue SET state='completed' WHERE decision_id=${note.id} AND revision=${row.revision}`;
      return;
    }
    const runId = fingerprint([
      "decision-relations-v1",
      note.id,
      note.revision,
      funding.generation,
    ]);
    // Persist the admission before I/O. Unknown/crashed calls never get silently replayed.
    const admitted = yield* sql<{
      decision_id: string;
    }>`UPDATE decision_relation_queue SET state='dispatching' WHERE decision_id=${note.id} AND revision=${row.revision} AND state='queued' RETURNING decision_id`;
    if (!admitted.length) return;
    const result = yield* cloud
      .conflicts({
        featureId: "decisions",
        requestId: `${runId}:conflict`,
        runId,
        fundingGeneration: funding.generation,
        templateVersion: "contextual-v1",
        task,
        pairs,
      })
      .pipe(Effect.flatMap(decodeConflicts), Effect.result);
    const equivalence = yield* cloud
      .equivalence({
        featureId: "decisions",
        requestId: `${runId}:equivalence`,
        runId,
        fundingGeneration: funding.generation,
        environmentId,
        projectId: note.projectId,
        templateVersion: "decisions-equivalence-v1",
        targets,
      })
      .pipe(Effect.flatMap(decodeEquivalence), Effect.result);
    const currentFunding = yield* cloud.status("decisions");
    if (
      currentFunding.generation !== funding.generation ||
      !currentFunding.eligible ||
      currentFunding.state !== "active"
    ) {
      yield* sql`UPDATE decision_relation_queue SET state='stale' WHERE decision_id=${note.id} AND revision=${row.revision}`;
      return;
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const generations = yield* sql<{
          purge_generation: number;
        }>`SELECT purge_generation FROM contextual_host_state WHERE singleton=1`;
        if ((generations[0]?.purge_generation ?? 0) !== purgeGeneration) return;
        const current = yield* repository.get({ projectId: note.projectId, id: note.id });
        if (current.revision !== note.revision || !live(current) || !(yield* permitted(current)))
          return;
        for (const other of candidates) {
          const pair = pairs.find((p) => p.right.occurrenceId === other.note.id);
          if (!pair) continue;
          const latest = yield* repository.get({ projectId: note.projectId, id: other.note.id });
          if (
            latest.revision !== other.note.revision ||
            !live(latest) ||
            !(yield* permitted(latest))
          )
            continue;
          const conflict =
            result._tag === "Success" &&
            result.success.requestId === `${runId}:conflict` &&
            result.success.runId === runId
              ? result.success.judgments.find(
                  (j) =>
                    j.pairId === pair.id &&
                    j.relation === "incompatible" &&
                    j.leftEvidenceIds.length > 0 &&
                    j.rightEvidenceIds.length > 0 &&
                    j.leftEvidenceIds.every((id) => pair.left.evidence.some((e) => e.id === id)) &&
                    j.rightEvidenceIds.every((id) => pair.right.evidence.some((e) => e.id === id)),
                )
              : undefined;
          const equal =
            equivalence._tag === "Success" &&
            equivalence.success.requestId === `${runId}:equivalence` &&
            equivalence.success.runId === runId
              ? equivalence.success.judgments.find(
                  (j) =>
                    j.targetId === pair.id &&
                    j.relation === "equivalent" &&
                    j.equivalentCommitment >= 0.95 &&
                    j.sameApplicability >= 0.95 &&
                    j.sufficientEvidence >= 0.95,
                )
              : undefined;
          if (!conflict && !equal) continue;
          const kind = conflict ? "conflict" : "equivalent";
          const metadata =
            conflict && result._tag === "Success"
              ? result.success
              : equivalence._tag === "Success"
                ? equivalence.success
                : null;
          if (!metadata) continue;
          const canonical = [note, other.note].sort(
            (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
          )[0]!.id;
          yield* sql`INSERT OR IGNORE INTO decision_relation_suggestions(id,project_id,left_id,right_id,left_revision,right_revision,canonical_id,kind,state,model,policy_version,created_at) VALUES(${fingerprint([pair.id, kind])},${note.projectId},${note.id},${other.note.id},${note.revision},${other.note.revision},${canonical},${kind},'suggested',${metadata.model},${metadata.policyVersion},${yield* contextualNow})`;
          // Only the private evaluator can attest to a separately qualified pinned policy.
          // Unknown conflict results, edits and shared origins remain suggestions.
          if (
            conflict ||
            !equal ||
            Option.isNone(groups) ||
            equivalence._tag !== "Success" ||
            !equivalence.success.qualificationId ||
            equivalence.success.model !== "extensions-v1" ||
            equivalence.success.policyVersion !== "decisions-equivalence-v1" ||
            current.userEdited ||
            latest.userEdited ||
            current.relationships.length > 0 ||
            latest.relationships.length > 0 ||
            result._tag !== "Success" ||
            result.success.requestId !== `${runId}:conflict` ||
            result.success.runId !== runId ||
            result.success.model !== "extensions-v1" ||
            result.success.policyVersion !== "contextual-v1" ||
            !result.success.coverage.complete ||
            result.success.coverage.missingAntecedents ||
            result.success.coverage.truncated ||
            result.success.coverage.unexaminedCount !== 0 ||
            !result.success.judgments.some(
              (j) =>
                j.pairId === pair.id &&
                j.relation === "compatible" &&
                j.leftEvidenceIds.length === pair.left.evidence.length &&
                j.rightEvidenceIds.length === pair.right.evidence.length &&
                pair.left.evidence.every((e) => j.leftEvidenceIds.includes(e.id)) &&
                pair.right.evidence.every((e) => j.rightEvidenceIds.includes(e.id)),
            ) ||
            left.evidence.some((e) =>
              other.candidate.evidence.some((r) => evidenceIdentity(e) === evidenceIdentity(r)),
            )
          )
            continue;
          const relatedOrigins =
            yield* sql`SELECT 1 FROM contextual_lineage l JOIN contextual_lineage r ON l.source_evidence_id=r.source_evidence_id WHERE l.entity_kind='decision' AND r.entity_kind='decision' AND l.entity_id=${current.id} AND r.entity_id=${latest.id} LIMIT 1`;
          if (relatedOrigins.length) continue;
          const canonicalNote = canonical === current.id ? current : latest;
          const member = canonical === current.id ? latest : current;
          const memberships = yield* sql<{
            decision_id: C.DecisionId;
            group_id: string;
            canonical_decision_id: C.DecisionId;
            count: number;
          }>`SELECT m.decision_id,m.group_id,g.canonical_decision_id,(SELECT COUNT(*) FROM contextual_group_members c WHERE c.group_id=m.group_id) AS count FROM contextual_group_members m JOIN contextual_decision_groups g ON g.id=m.group_id WHERE m.decision_id IN (${canonicalNote.id},${member.id})`;
          // A-B and B-C never stand in for A-C. Compare only an actual canonical with
          // a singleton occurrence; never move a whole existing group via an alias.
          if (
            memberships.some((m) =>
              m.decision_id === canonicalNote.id
                ? m.canonical_decision_id !== canonicalNote.id
                : m.count > 1,
            )
          )
            continue;
          const groupId = yield* groups.value.ensure(canonicalNote);
          const group = yield* groups.value.group({ projectId: note.projectId, groupId, limit: 1 });
          yield* groups.value
            .mutateGroup({
              action: "merge",
              actionId: `automatic:${fingerprint([pair.id, equivalence.success.qualificationId])}`,
              suggestionId: fingerprint([pair.id, kind]),
              groupId,
              canonicalDecisionId: canonicalNote.id,
              occurrenceId: member.id,
              expectedRevision: group.revision,
              expectedOccurrenceRevision: member.revision,
            })
            .pipe(
              Effect.catch((error) =>
                error.code === "stale-revision" ? Effect.void : Effect.fail(error),
              ),
            );
        }
        yield* sql`UPDATE decision_relation_queue SET state='completed' WHERE decision_id=${note.id} AND revision=${row.revision}`;
        yield* repository.bumpRevision(note.projectId);
        yield* appendContextualEvent(sql, {
          threadId: note.threadId,
          revision: note.revision,
          kind: "group-changed",
          entityId: note.id,
        });
      }),
    );
  }).pipe(mutex.withPermits(1), Effect.mapError(contextualBoundary));
  return { drive };
});
export class DecisionRelations extends Context.Service<
  DecisionRelations,
  Effect.Success<typeof make>
>()("lecturn/threadDecisions/DecisionRelations") {}
export const layer = Layer.effect(DecisionRelations, make);
