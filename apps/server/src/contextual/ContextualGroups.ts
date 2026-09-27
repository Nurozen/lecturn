import * as NodeCrypto from "node:crypto";
import * as C from "@lecturn/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DecisionRepository } from "../threadDecisions/DecisionRepository.ts";
import { ExtensionsRuntime } from "../extensions/ExtensionsRuntime.ts";
import {
  contextualBoundary,
  contextualNow,
  staleContextual,
  appendContextualEvent,
} from "./ContextualSettings.ts";
import { fingerprint } from "./DecisionCandidates.ts";

const Undo = Schema.Struct({
  decisionId: C.DecisionId,
  projectId: C.ProjectId,
  priorGroupId: Schema.NullOr(Schema.String),
  newGroupId: Schema.String,
  revision: Schema.Number,
});
const encodeUndo = Schema.encodeSync(Schema.fromJsonString(Undo));
const decodeUndo = Schema.decodeUnknownEffect(Schema.fromJsonString(Undo));
const GroupReceipt = Schema.Struct({ projectId: C.ProjectId, groupId: Schema.String });
const encodeGroupReceipt = Schema.encodeSync(Schema.fromJsonString(GroupReceipt));
const decodeGroupReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(GroupReceipt));
export const occurrence = (note: C.ThreadDecision): C.ContextualDecisionOccurrence => ({
  decisionId: note.id,
  threadId: note.threadId,
  revision: note.revision,
  provenance: note.provenance,
  title: note.title,
  body: note.body,
  rationale: note.rationale,
  attribution: note.attribution,
  reviewState: note.reviewState,
  lifecycle: note.lifecycle,
  comment: note.comment,
  userEdited: note.userEdited,
  evidenceIds: note.evidence.map((e) => e.id),
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
});

/** Membership is presentation identity only. Original Decision authority is never rewritten. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decisions = yield* DecisionRepository;
  const runtime = yield* ExtensionsRuntime;
  const group = Effect.fn("Contextual.group")(function* (input: C.ContextualGroupReadRequest) {
    const rows = yield* sql<{
      project_id: C.ProjectId;
      canonical_decision_id: C.DecisionId;
      revision: number;
    }>`SELECT * FROM contextual_decision_groups WHERE id=${input.groupId} AND project_id=${input.projectId}`;
    const row = rows[0];
    if (!row)
      return yield* new C.ContextualError({
        code: "not-found",
        message: "Decision group unavailable.",
      });
    const canonical = yield* decisions.get({
      projectId: input.projectId,
      id: row.canonical_decision_id,
    });
    const members = yield* sql<{
      decision_id: C.DecisionId;
    }>`SELECT decision_id FROM contextual_group_members WHERE group_id=${input.groupId} AND ${input.cursor ? sql`decision_id>${input.cursor}` : sql`1=1`} ORDER BY decision_id LIMIT ${input.limit + 1}`;
    const totals = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM contextual_group_members WHERE group_id=${input.groupId}`;
    const occurrences = yield* Effect.forEach(members.slice(0, input.limit), (m) =>
      decisions.get({ projectId: input.projectId, id: m.decision_id }).pipe(Effect.map(occurrence)),
    );
    return C.ContextualDecisionGroup.make({
      id: input.groupId,
      environmentId: runtime.environmentId,
      projectId: input.projectId,
      canonicalDecisionId: canonical.id,
      guidanceId: `group:${input.groupId}`,
      contentFingerprint: fingerprint([
        canonical.title,
        canonical.body,
        canonical.rationale,
        canonical.attribution,
        canonical.lifecycle,
      ]),
      revision: row.revision,
      occurrenceCount: totals[0]?.count ?? 0,
      occurrences,
      nextCursor: members.length > input.limit ? occurrences.at(-1)!.decisionId : null,
      aliases: occurrences.map((o) => o.decisionId),
    });
  }, Effect.mapError(contextualBoundary));
  const ensure = Effect.fn("Contextual.group.ensure")(function* (note: C.ThreadDecision) {
    const existing = yield* sql<{
      group_id: string;
    }>`SELECT group_id FROM contextual_group_members WHERE decision_id=${note.id}`;
    if (existing[0]) return existing[0].group_id;
    const id = note.id;
    yield* sql`INSERT OR IGNORE INTO contextual_decision_groups(id,project_id,canonical_decision_id,revision,updated_at) VALUES(${id},${note.projectId},${note.id},0,${yield* contextualNow})`;
    yield* sql`INSERT OR IGNORE INTO contextual_group_members(decision_id,group_id,occurrence_revision,merge_id) VALUES(${note.id},${id},${note.revision},'original')`;
    return id;
  });
  const replay = Effect.fn("Contextual.group.replay")(function* (actionId: string, key: string) {
    const rows = yield* sql<{
      fingerprint: string;
      result_json: string;
    }>`SELECT fingerprint,result_json FROM contextual_actions WHERE action_id=${actionId}`;
    if (!rows[0]) return null;
    if (rows[0].fingerprint !== key) return yield* staleContextual();
    const receipt = yield* decodeGroupReceipt(rows[0].result_json);
    return yield* group({ ...receipt, limit: 50 });
  });
  const mutateGroup = Effect.fn("Contextual.mutateGroup")(
    function* (input: C.ContextualGroupMutationRequest) {
      const key = fingerprint(input);
      const previous = yield* replay(input.actionId, key);
      if (previous) return previous;
      const roots = yield* sql<{
        project_id: C.ProjectId;
        canonical_decision_id: C.DecisionId;
        revision: number;
      }>`SELECT * FROM contextual_decision_groups WHERE id=${input.groupId}`;
      let projectId = roots[0]?.project_id;
      if (!projectId) {
        // Canonical ids originate in the authorized local repository, not a second lifecycle store.
        const notes = yield* sql<{
          project_id: C.ProjectId;
        }>`SELECT project_id FROM thread_decisions WHERE id=${input.canonicalDecisionId}`;
        projectId = notes[0]?.project_id;
      }
      if (!projectId) return yield* staleContextual();
      const canonical = yield* decisions.get({ projectId, id: input.canonicalDecisionId });
      const member = yield* decisions.get({ projectId, id: input.occurrenceId });
      if (input.suggestionId) {
        const suggestions =
          yield* sql`SELECT 1 FROM decision_relation_suggestions WHERE id=${input.suggestionId} AND project_id=${projectId} AND kind='equivalent' AND state='suggested' AND canonical_id=${canonical.id} AND ((left_id=${canonical.id} AND left_revision=${canonical.revision} AND right_id=${member.id} AND right_revision=${member.revision}) OR (right_id=${canonical.id} AND right_revision=${canonical.revision} AND left_id=${member.id} AND left_revision=${member.revision}))`;
        if (!suggestions.length || input.action !== "merge") return yield* staleContextual();
      }
      const id = yield* ensure(canonical);
      const current = yield* group({ projectId, groupId: id, limit: 1 });
      if (
        id !== input.groupId ||
        current.revision !== input.expectedRevision ||
        current.canonicalDecisionId !== input.canonicalDecisionId ||
        member.revision !== input.expectedOccurrenceRevision
      )
        return yield* staleContextual();
      const membership = yield* sql<{
        group_id: string;
        merge_id: string;
      }>`SELECT group_id,merge_id FROM contextual_group_members WHERE decision_id=${member.id}`;
      const prior = membership[0]?.group_id ?? null;
      if (input.action === "detach" && prior !== id) return yield* staleContextual();
      if (input.action === "merge" && prior === id) return yield* staleContextual();
      // Only explicit human merge enters here. No semantic automatic merge gate is enabled.
      // Prevent transitive chain merging: a non-singleton occurrence group must first be detached explicitly.
      if (prior && prior !== id) {
        const counts = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM contextual_group_members WHERE group_id=${prior}`;
        if ((counts[0]?.count ?? 0) > 1)
          return yield* new C.ContextualError({
            code: "invalid",
            message: "Detach this occurrence from its existing group first.",
          });
      }
      const newGroup = input.action === "merge" ? id : `detached:${NodeCrypto.randomUUID()}`;
      if (input.action === "detach")
        yield* sql`INSERT INTO contextual_decision_groups(id,project_id,canonical_decision_id,revision,updated_at) VALUES(${newGroup},${projectId},${member.id},0,${yield* contextualNow})`;
      yield* sql`INSERT OR REPLACE INTO contextual_group_members(decision_id,group_id,occurrence_revision,merge_id) VALUES(${member.id},${newGroup},${member.revision},${input.actionId})`;
      yield* sql`UPDATE contextual_decision_groups SET revision=revision+1,updated_at=${yield* contextualNow} WHERE id=${id}`;
      if (input.action === "merge")
        yield* sql`UPDATE decision_relation_suggestions SET state='accepted' WHERE kind='equivalent' AND state='suggested' AND ((left_id=${canonical.id} AND left_revision=${canonical.revision} AND right_id=${member.id} AND right_revision=${member.revision}) OR (right_id=${canonical.id} AND right_revision=${canonical.revision} AND left_id=${member.id} AND left_revision=${member.revision}))`;
      const undo = encodeUndo({
        decisionId: member.id,
        projectId,
        priorGroupId: prior,
        newGroupId: newGroup,
        revision: member.revision,
      });
      yield* sql`INSERT INTO contextual_actions(action_id,fingerprint,result_json,created_at) VALUES(${`undo:${input.actionId}`},${key},${undo},${yield* contextualNow})`;
      const result = yield* group({ projectId, groupId: id, limit: 50 });
      yield* sql`INSERT INTO contextual_actions(action_id,fingerprint,result_json,created_at) VALUES(${input.actionId},${key},${encodeGroupReceipt({ projectId: result.projectId, groupId: result.id })},${yield* contextualNow})`;
      yield* decisions.bumpRevision(projectId);
      yield* appendContextualEvent(sql, {
        threadId: canonical.threadId,
        revision: result.revision,
        kind: "group-changed",
        entityId: id,
      });
      return result;
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  const undoGroup = Effect.fn("Contextual.undoGroup")(
    function* (input: C.ContextualGroupUndoRequest) {
      const key = fingerprint(input);
      const previous = yield* replay(input.actionId, key);
      if (previous) return previous;
      const rows = yield* sql<{
        result_json: string;
      }>`SELECT result_json FROM contextual_actions WHERE action_id=${`undo:${input.mergeId}`}`;
      if (!rows[0]) return yield* staleContextual();
      const undo = yield* decodeUndo(rows[0].result_json);
      const current = yield* group({ projectId: undo.projectId, groupId: input.groupId, limit: 1 });
      const member = yield* decisions.get({ projectId: undo.projectId, id: undo.decisionId });
      const memberships = yield* sql<{
        merge_id: string;
        group_id: string;
      }>`SELECT merge_id,group_id FROM contextual_group_members WHERE decision_id=${undo.decisionId}`;
      if (
        current.revision !== input.expectedRevision ||
        member.revision !== input.expectedOccurrenceRevision ||
        member.revision !== undo.revision ||
        memberships[0]?.merge_id !== input.mergeId ||
        memberships[0]?.group_id !== undo.newGroupId
      )
        return yield* staleContextual();
      if (undo.priorGroupId)
        yield* sql`UPDATE contextual_group_members SET group_id=${undo.priorGroupId},merge_id=${input.actionId} WHERE decision_id=${undo.decisionId}`;
      else yield* sql`DELETE FROM contextual_group_members WHERE decision_id=${undo.decisionId}`;
      yield* sql`UPDATE contextual_decision_groups SET revision=revision+1,updated_at=${yield* contextualNow} WHERE id=${input.groupId}`;
      const result = yield* group({ projectId: undo.projectId, groupId: input.groupId, limit: 50 });
      yield* sql`INSERT INTO contextual_actions(action_id,fingerprint,result_json,created_at) VALUES(${input.actionId},${key},${encodeGroupReceipt({ projectId: result.projectId, groupId: result.id })},${yield* contextualNow})`;
      yield* decisions.bumpRevision(undo.projectId);
      yield* appendContextualEvent(sql, {
        threadId: member.threadId,
        revision: result.revision,
        kind: "group-changed",
        entityId: input.groupId,
      });
      return result;
    },
    sql.withTransaction,
    Effect.mapError(contextualBoundary),
  );
  return { group, mutateGroup, undoGroup, ensure };
});
export class ContextualGroups extends Context.Service<
  ContextualGroups,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualGroups") {}
export const layer = Layer.effect(ContextualGroups, make);
