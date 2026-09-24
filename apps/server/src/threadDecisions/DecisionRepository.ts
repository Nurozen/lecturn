import { formatAssistantCitationHref } from "@lecturn/shared/assistantCitations";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import type { EnvironmentId } from "@lecturn/contracts";
import * as NodeCrypto from "node:crypto";
import {
  DecisionEvidence,
  DecisionEvidenceId,
  DecisionId,
  DecisionProvenance,
  DecisionRelationship,
  ThreadDecision,
  ThreadDecisionError,
  ThreadDecisionListInput,
  ThreadDecisionMutateInput,
  type DecisionAttribution,
  ProjectId,
  type ThreadId,
  type ThreadDecisionGetInput,
  type ThreadDecisionListResult,
  type ThreadDecisionMutateResult,
  type ThreadDecisionExportInput,
  type ThreadDecisionExportResult,
} from "@lecturn/contracts";
import {
  canonicalDecisionText,
  decisionFingerprint,
  decisionSourceHash,
  DECISION_CANONICAL_VERSION,
} from "@lecturn/shared/decisionEvidence";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  requireDecisionProject,
  readDecisionRevision,
  bumpDecisionRevision,
} from "./DecisionRevisions.ts";

export interface CreateDecisionFromWriter {
  readonly id: DecisionId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly actionKey: string;
  readonly title: string;
  readonly body: string;
  readonly rationale: string | null;
  readonly attribution: DecisionAttribution;
  readonly occurredAt: string;
  readonly occurrence: number;
  readonly evidence: ReadonlyArray<DecisionEvidence>;
  readonly provenance: DecisionProvenance;
}
export interface AddDecisionEvidence {
  readonly projectId: ProjectId;
  readonly id: DecisionId;
  readonly expectedRevision: number;
  readonly evidence: ReadonlyArray<DecisionEvidence>;
}
interface StoredDecision {
  id: string;
  project_id: string;
  thread_id: string;
  thread_title: string;
  title: string;
  body: string;
  rationale: string | null;
  comment: string | null;
  attribution: string;
  review_state: string;
  lifecycle: string;
  user_edited: number;
  revision: number;
  source_sequence: number;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  provenance_json: string;
  action_key: string;
}
interface StoredEvidence {
  id: string;
  thread_id: string;
  message_id: string;
  role: string;
  source_hash: string;
  source_generation: number;
  canonical_version: string;
  quote: string;
  start_offset: number;
  end_offset: number;
  prefix: string;
  suffix: string;
  source_sequence: number;
  source_text: string | null;
  thread_deleted: string | null;
  thread_archived: string | null;
  live_thread_id: string | null;
  current_generation: number | null;
}
interface StoredRelationship {
  id: string;
  predecessor_id: string;
  successor_id: string;
  state: string;
  revision: number;
  predecessor_revision: number;
  successor_revision: number;
  created_at: string;
  updated_at: string;
}
const fail = (code: ThreadDecisionError["code"], message: string) =>
  new ThreadDecisionError({ code, message });
const isDecisionError = Schema.is(ThreadDecisionError);
const boundary = (error: unknown) =>
  isDecisionError(error) ? error : fail("unavailable", "Decisions are currently unavailable.");
const decodeDecision = Schema.decodeUnknownEffect(ThreadDecision);
const decodeEvidence = Schema.decodeUnknownEffect(DecisionEvidence);
const decodeRelationship = Schema.decodeUnknownEffect(DecisionRelationship);
const decodeProvenance = Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionProvenance));
const decodeList = Schema.decodeUnknownEffect(ThreadDecisionListInput);
const decodeMutation = Schema.decodeUnknownEffect(ThreadDecisionMutateInput);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const escapeLike = (value: string) => `%${value.replace(/[!%_]/g, (part) => `!${part}`)}%`;
const evidenceFingerprint = (evidence: ReadonlyArray<DecisionEvidence>) =>
  decisionFingerprint(
    evidence
      .map((e) => [e.threadId, e.messageId, e.sourceGeneration, e.sourceHash, e.start, e.end])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
const Cursor = Schema.Struct({
  scope: Schema.String,
  at: Schema.String,
  sequence: Schema.Number,
  id: Schema.String,
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(Cursor));
const encodeProvenance = Schema.encodeEffect(Schema.fromJsonString(DecisionProvenance));
const encodeExport = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      projectId: ProjectId,
      projectRevision: Schema.Number,
      decisions: Schema.Array(ThreadDecision),
    }),
  ),
);

const encodeDecisionJson = Schema.encodeEffect(Schema.fromJsonString(ThreadDecision));
const markdownDecision = (note: ThreadDecision, environmentId: EnvironmentId | null): string => {
  const lines = [
    `## ${note.title}`,
    "",
    note.body,
    "",
    `Review: ${note.reviewState}; lifecycle: ${note.lifecycle}; attribution: ${note.attribution}`,
    `Occurred: ${note.occurredAt}; source thread: ${note.threadTitle ?? note.threadId}`,
    `ID: ${note.id}; revision: ${note.revision}; user edited: ${note.userEdited}`,
  ];
  if (note.rationale) lines.push("", `Rationale: ${note.rationale}`);
  if (note.comment) lines.push("", `Comment: ${note.comment}`);
  for (const evidence of note.evidence)
    lines.push(
      "",
      ...evidence.quote.split("\n").map((line) => `> ${line}`),
      "",
      `Source: ${environmentId ? `[${evidence.messageRole} message](${formatAssistantCitationHref({ version: 1, coordinateSpace: "raw-message", environmentId, threadId: evidence.threadId, messageId: evidence.messageId, text: evidence.quote, start: evidence.start, end: evidence.end, prefix: "", suffix: "" })})` : `${evidence.threadId} / ${evidence.messageId}`} (${evidence.availability}; UTF-16 ${evidence.start}–${evidence.end})`,
    );
  lines.push("", `Provenance: ${JSON.stringify(note.provenance)}`);
  if (note.relationships.length)
    lines.push("", `Relationships: ${JSON.stringify(note.relationships)}`);
  return lines.join("\n");
};

export class DecisionRepository extends Context.Service<
  DecisionRepository,
  {
    readonly list: (
      input: ThreadDecisionListInput,
    ) => Effect.Effect<ThreadDecisionListResult, ThreadDecisionError>;
    readonly get: (
      input: ThreadDecisionGetInput,
    ) => Effect.Effect<ThreadDecision, ThreadDecisionError>;
    readonly mutate: (
      input: ThreadDecisionMutateInput,
    ) => Effect.Effect<ThreadDecisionMutateResult, ThreadDecisionError>;
    readonly export: (
      input: ThreadDecisionExportInput,
    ) => Effect.Effect<ThreadDecisionExportResult, ThreadDecisionError>;
    readonly createFromWriter: (
      input: CreateDecisionFromWriter,
    ) => Effect.Effect<ThreadDecision | null, ThreadDecisionError>;
    readonly addEvidence: (
      input: AddDecisionEvidence,
    ) => Effect.Effect<ThreadDecision, ThreadDecisionError>;
    readonly projectRevision: (projectId: ProjectId) => Effect.Effect<number, ThreadDecisionError>;
    readonly bumpRevision: (projectId: ProjectId) => Effect.Effect<number, ThreadDecisionError>;
  }
>()("lecturn/threadDecisions/DecisionRepository") {}

export const make = Effect.gen(function* () {
  const identity = yield* Effect.serviceOption(ServerEnvironmentIdentity);
  const environmentId = Option.isSome(identity) ? yield* identity.value.getEnvironmentId : null;
  const sql = yield* SqlClient.SqlClient;
  const requireProject = (projectId: ProjectId) => requireDecisionProject(sql, projectId);
  const revision = Effect.fn("Decisions.projectRevision")(function* (projectId: ProjectId) {
    yield* requireProject(projectId);
    return yield* readDecisionRevision(sql, projectId);
  });
  const bump = Effect.fn("Decisions.bumpRevision")(function* (projectId: ProjectId) {
    yield* requireProject(projectId);
    return yield* bumpDecisionRevision(sql, projectId);
  });
  const readRow = Effect.fn("Decisions.readRow")(function* (row: StoredDecision) {
    const anchors =
      yield* sql<StoredEvidence>`SELECT e.*, m.text AS source_text, t.thread_id AS live_thread_id, t.deleted_at AS thread_deleted, t.archived_at AS thread_archived, s.source_generation AS current_generation
      FROM decision_evidence e LEFT JOIN projection_threads t ON t.thread_id = e.thread_id
      LEFT JOIN projection_thread_messages m ON m.thread_id = e.thread_id AND m.message_id = e.message_id
      LEFT JOIN decision_thread_state s ON s.thread_id = e.thread_id
      WHERE e.decision_id = ${row.id} ORDER BY e.source_sequence, e.start_offset, e.id`;
    const evidence = yield* Effect.forEach(anchors, (anchor) =>
      decodeEvidence({
        id: anchor.id,
        threadId: anchor.thread_id,
        messageId: anchor.message_id,
        messageRole: anchor.role,
        sourceHash: anchor.source_hash,
        sourceGeneration: anchor.source_generation,
        canonicalVersion: anchor.canonical_version,
        quote: anchor.quote,
        start: anchor.start_offset,
        end: anchor.end_offset,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        occurrence: anchor.source_sequence,
        availability:
          anchor.live_thread_id === null || anchor.thread_deleted !== null
            ? "thread-deleted"
            : anchor.source_text === null
              ? "message-missing"
              : anchor.current_generation !== anchor.source_generation ||
                  decisionSourceHash(anchor.source_text) !== anchor.source_hash
                ? "changed"
                : anchor.thread_archived !== null
                  ? "thread-archived"
                  : "available",
      }),
    );
    const links =
      yield* sql<StoredRelationship>`SELECT * FROM decision_relationships WHERE project_id = ${row.project_id} AND (predecessor_id = ${row.id} OR successor_id = ${row.id}) ORDER BY created_at, id`;
    const relationships = yield* Effect.forEach(links, (link) =>
      decodeRelationship({
        id: link.id,
        predecessorId: link.predecessor_id,
        successorId: link.successor_id,
        state: link.state,
        revision: link.revision,
        createdAt: link.created_at,
        updatedAt: link.updated_at,
      }),
    );
    return yield* decodeDecision({
      id: row.id,
      projectId: row.project_id,
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      occurredAt: row.occurred_at,
      title: row.title,
      body: row.body,
      rationale: row.rationale,
      comment: row.comment,
      attribution: row.attribution,
      reviewState: row.review_state,
      lifecycle: row.lifecycle,
      userEdited: row.user_edited === 1,
      revision: row.revision,
      occurrence: row.source_sequence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      evidence,
      relationships,
      provenance: yield* decodeProvenance(row.provenance_json),
    });
  });
  const get = Effect.fn("Decisions.get")(function* (input: ThreadDecisionGetInput) {
    yield* requireProject(input.projectId);
    const rows =
      yield* sql<StoredDecision>`SELECT * FROM thread_decisions WHERE project_id = ${input.projectId} AND id = ${input.id}`;
    if (!rows[0]) return yield* fail("not-found", "The decision no longer exists.");
    return yield* readRow(rows[0]);
  });
  const list = Effect.fn("Decisions.list")(function* (input: ThreadDecisionListInput) {
    const valid = yield* decodeList(input).pipe(
      Effect.mapError(() => fail("invalid", "Invalid decision list request.")),
    );
    yield* requireProject(valid.projectId);
    const scope = decisionFingerprint([
      valid.projectId,
      valid.threadId ?? null,
      valid.search ?? "",
      valid.reviewState ?? null,
      valid.lifecycle ?? null,
    ]);
    const cursor =
      valid.cursor === undefined
        ? null
        : yield* decodeCursor(Buffer.from(valid.cursor, "base64url").toString("utf8")).pipe(
            Effect.mapError(() => fail("invalid", "Invalid decision cursor.")),
          );
    if (cursor && cursor.scope !== scope)
      return yield* fail("invalid", "The cursor belongs to different filters.");
    const limit = valid.limit ?? 50;
    const search = escapeLike(valid.search ?? "");
    const rows =
      yield* sql<StoredDecision>`SELECT d.* FROM thread_decisions d WHERE d.project_id = ${valid.projectId}
      AND ${valid.threadId ? sql`d.thread_id = ${valid.threadId}` : sql`1 = 1`}
      AND ${valid.reviewState === undefined ? sql`d.review_state <> 'dismissed'` : valid.reviewState === "all" ? sql`1 = 1` : sql`d.review_state = ${valid.reviewState}`}
      AND ${valid.lifecycle === undefined ? sql`d.lifecycle = 'current'` : valid.lifecycle === "all" ? sql`1 = 1` : sql`d.lifecycle = ${valid.lifecycle}`}
      AND ${valid.search ? sql`(d.title LIKE ${search} ESCAPE '!' OR d.body LIKE ${search} ESCAPE '!' OR d.rationale LIKE ${search} ESCAPE '!' OR EXISTS (SELECT 1 FROM decision_evidence e WHERE e.decision_id = d.id AND e.quote LIKE ${search} ESCAPE '!'))` : sql`1 = 1`}
      AND ${cursor ? sql`(d.occurred_at < ${cursor.at} OR (d.occurred_at = ${cursor.at} AND d.source_sequence < ${cursor.sequence}) OR (d.occurred_at = ${cursor.at} AND d.source_sequence = ${cursor.sequence} AND d.id < ${cursor.id}))` : sql`1 = 1`}
      ORDER BY d.occurred_at DESC, d.source_sequence DESC, d.id DESC LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      decisions: yield* Effect.forEach(page, readRow),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              yield* encodeCursor({
                scope,
                at: last.occurred_at,
                sequence: last.source_sequence,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
      projectRevision: yield* revision(valid.projectId),
    };
  });
  const checkRevision = Effect.fn("Decisions.checkRevision")(function* (
    input: ThreadDecisionGetInput,
    expected: number,
  ) {
    const note = yield* get(input);
    if (note.revision !== expected)
      return yield* fail("conflict", "The decision changed. Refresh and try again.");
    return note;
  });
  const validateEvidence = Effect.fn("Decisions.validateEvidence")(function* (
    projectId: ProjectId,
    evidence: ReadonlyArray<DecisionEvidence>,
  ) {
    if (evidence.length === 0 || evidence.length > 32)
      return yield* fail("invalid", "A decision needs between one and 32 evidence anchors.");
    for (const item of evidence) {
      const anchor = yield* decodeEvidence(item).pipe(
        Effect.mapError(() => fail("invalid", "Invalid decision evidence.")),
      );
      const rows = yield* sql<{
        text: string;
        role: string;
        source_hash: string;
        source_generation: number;
        current_generation: number;
        project_id: string;
      }>`SELECT m.text, m.role, s.source_hash, s.source_generation, ts.source_generation AS current_generation, t.project_id
        FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id = m.thread_id
        JOIN decision_sources s ON s.thread_id = m.thread_id AND s.message_id = m.message_id AND s.source_generation = ${anchor.sourceGeneration}
        JOIN decision_thread_state ts ON ts.thread_id = m.thread_id
        WHERE m.thread_id = ${anchor.threadId} AND m.message_id = ${anchor.messageId} AND m.is_streaming = 0 AND t.deleted_at IS NULL AND s.project_id = ${projectId}`;
      const source = rows[0];
      if (
        !source ||
        source.project_id !== projectId ||
        source.role !== anchor.messageRole ||
        source.current_generation !== anchor.sourceGeneration ||
        source.source_hash !== anchor.sourceHash ||
        decisionSourceHash(source.text) !== anchor.sourceHash ||
        anchor.canonicalVersion !== DECISION_CANONICAL_VERSION ||
        canonicalDecisionText(source.text).text.slice(anchor.start, anchor.end) !== anchor.quote
      )
        return yield* fail(
          "stale-source",
          "The decision's source changed before it could be saved.",
        );
    }
  });
  const insertEvidence = Effect.fn("Decisions.insertEvidence")(function* (
    id: DecisionId,
    evidence: ReadonlyArray<DecisionEvidence>,
  ) {
    for (const item of evidence) {
      const evidenceId = DecisionEvidenceId.make(
        decisionFingerprint([
          id,
          item.threadId,
          item.messageId,
          item.sourceGeneration,
          item.sourceHash,
          item.start,
          item.end,
        ]),
      );
      yield* sql`INSERT OR IGNORE INTO decision_evidence(id, decision_id, thread_id, message_id, role, source_hash, source_generation, canonical_version, quote, start_offset, end_offset, prefix, suffix, source_sequence) VALUES (${evidenceId}, ${id}, ${item.threadId}, ${item.messageId}, ${item.messageRole}, ${item.sourceHash}, ${item.sourceGeneration}, ${item.canonicalVersion}, ${item.quote}, ${item.start}, ${item.end}, ${item.prefix}, ${item.suffix}, ${item.occurrence})`;
    }
  });
  const createFromWriter = Effect.fn("Decisions.createFromWriter")(function* (
    input: CreateDecisionFromWriter,
  ) {
    yield* requireProject(input.projectId);
    const existing =
      yield* sql<StoredDecision>`SELECT * FROM thread_decisions WHERE action_key = ${input.actionKey} OR id = ${input.id}`;
    if (existing[0]) {
      const prior = existing[0];
      if (
        prior.project_id !== input.projectId ||
        prior.thread_id !== input.threadId ||
        prior.action_key !== input.actionKey ||
        prior.id !== input.id
      )
        return yield* fail("conflict", "This writer action already belongs to another decision.");
      return yield* readRow(prior);
    }
    yield* validateEvidence(input.projectId, input.evidence);
    const suppressed =
      yield* sql`SELECT 1 FROM decision_suppression WHERE project_id = ${input.projectId} AND fingerprint IN (${evidenceFingerprint(input.evidence)}, ${"action:" + input.actionKey})`;
    if (suppressed.length > 0) return null;
    const threads = yield* sql<{
      title: string;
    }>`SELECT title FROM projection_threads WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId} AND deleted_at IS NULL`;
    if (!threads[0]) return yield* fail("not-found", "The decision's thread no longer exists.");
    const at = yield* now;
    yield* decodeDecision({
      ...input,
      threadTitle: threads[0].title,
      comment: null,
      reviewState: "unreviewed",
      lifecycle: "current",
      userEdited: false,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      relationships: [],
    }).pipe(Effect.mapError(() => fail("invalid", "Invalid writer decision.")));
    yield* sql`INSERT INTO thread_decisions(id, project_id, thread_id, thread_title, title, body, rationale, comment, attribution, review_state, lifecycle, user_edited, revision, source_sequence, occurred_at, created_at, updated_at, provenance_json, action_key)
      VALUES (${input.id}, ${input.projectId}, ${input.threadId}, ${threads[0].title}, ${input.title}, ${input.body}, ${input.rationale}, NULL, ${input.attribution}, 'unreviewed', 'current', 0, 1, ${input.occurrence}, ${input.occurredAt}, ${at}, ${at}, ${yield* encodeProvenance(input.provenance)}, ${input.actionKey})`;
    yield* insertEvidence(input.id, input.evidence);
    yield* bump(input.projectId);
    return yield* get(input);
  });
  const addEvidence = Effect.fn("Decisions.addEvidence")(function* (input: AddDecisionEvidence) {
    const note = yield* checkRevision(input, input.expectedRevision);
    if (note.reviewState === "dismissed")
      return yield* fail("conflict", "Dismissed decisions cannot receive automatic updates.");
    yield* validateEvidence(input.projectId, input.evidence);
    const before = note.evidence.length;
    yield* insertEvidence(input.id, input.evidence);
    const count = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM decision_evidence WHERE decision_id = ${input.id}`;
    if ((count[0]?.count ?? 0) > 32)
      return yield* fail("invalid", "The decision already has the maximum evidence anchors.");
    if (count[0]?.count !== before) {
      yield* sql`UPDATE thread_decisions SET revision = revision + 1, updated_at = ${yield* now} WHERE id = ${input.id}`;
      yield* bump(input.projectId);
    }
    return yield* get(input);
  });
  const mutate = Effect.fn("Decisions.mutate")(function* (input: ThreadDecisionMutateInput) {
    const valid = yield* decodeMutation(input).pipe(
      Effect.mapError(() => fail("invalid", "Invalid decision mutation.")),
    );
    yield* requireProject(valid.projectId);
    const at = yield* now;
    let decision: ThreadDecision | null = null;
    if (
      valid.operation === "edit" ||
      valid.operation === "comment" ||
      valid.operation === "review" ||
      valid.operation === "delete"
    ) {
      const note = yield* checkRevision(valid, valid.expectedRevision);
      if (
        valid.operation === "delete" ||
        (valid.operation === "review" && valid.reviewState === "dismissed")
      ) {
        const stored = yield* sql<{
          action_key: string;
        }>`SELECT action_key FROM thread_decisions WHERE id = ${valid.id}`;
        if (stored[0])
          yield* sql`INSERT OR IGNORE INTO decision_suppression(project_id, fingerprint, decision_id, created_at) VALUES (${valid.projectId}, ${"action:" + stored[0].action_key}, ${valid.id}, ${at})`;
      }
      if (valid.operation === "edit") {
        yield* sql`UPDATE thread_decisions SET title = ${valid.title}, body = ${valid.body}, rationale = ${valid.rationale}, user_edited = 1, revision = revision + 1, updated_at = ${at} WHERE id = ${valid.id}`;
      } else if (valid.operation === "comment") {
        yield* sql`UPDATE thread_decisions SET comment = ${valid.comment}, revision = revision + 1, updated_at = ${at} WHERE id = ${valid.id}`;
      } else if (valid.operation === "review") {
        yield* sql`UPDATE thread_decisions SET review_state = ${valid.reviewState}, revision = revision + 1, updated_at = ${at} WHERE id = ${valid.id}`;
        if (valid.reviewState === "dismissed") {
          yield* sql`INSERT OR IGNORE INTO decision_suppression(project_id, fingerprint, decision_id, created_at) VALUES (${valid.projectId}, ${evidenceFingerprint(note.evidence)}, ${valid.id}, ${at})`;
        } else {
          yield* sql`DELETE FROM decision_suppression WHERE project_id = ${valid.projectId} AND decision_id = ${valid.id}`;
        }
      } else {
        yield* sql`INSERT OR IGNORE INTO decision_suppression(project_id, fingerprint, decision_id, created_at) VALUES (${valid.projectId}, ${evidenceFingerprint(note.evidence)}, ${valid.id}, ${at})`;
        // Removing an accepted successor restores the predecessor's active lifecycle.
        yield* sql`UPDATE thread_decisions SET lifecycle = 'current', revision = revision + 1, updated_at = ${at} WHERE project_id = ${valid.projectId} AND id IN (SELECT predecessor_id FROM decision_relationships WHERE successor_id = ${valid.id} AND state = 'accepted')`;
        yield* sql`DELETE FROM decision_relationships WHERE predecessor_id = ${valid.id} OR successor_id = ${valid.id}`;
        yield* sql`DELETE FROM decision_evidence WHERE decision_id = ${valid.id}`;
        yield* sql`DELETE FROM thread_decisions WHERE id = ${valid.id}`;
      }
      if (valid.operation !== "delete") decision = yield* get(valid);
    } else if (valid.operation === "propose-replacement") {
      yield* checkRevision(
        { projectId: valid.projectId, id: valid.predecessorId },
        valid.expectedPredecessorRevision,
      );
      yield* checkRevision(
        { projectId: valid.projectId, id: valid.successorId },
        valid.expectedSuccessorRevision,
      );
      const cycles =
        yield* sql`WITH RECURSIVE successors(id) AS (SELECT successor_id FROM decision_relationships WHERE predecessor_id = ${valid.successorId} AND project_id = ${valid.projectId} AND state IN ('proposed', 'accepted') UNION SELECT r.successor_id FROM decision_relationships r JOIN successors s ON r.predecessor_id = s.id WHERE r.project_id = ${valid.projectId} AND r.state IN ('proposed', 'accepted')) SELECT id FROM successors WHERE id = ${valid.predecessorId} LIMIT 1`;
      if (cycles.length > 0) return yield* fail("conflict", "This replacement would form a cycle.");
      const prior = yield* sql<{
        state: string;
      }>`SELECT state FROM decision_relationships WHERE predecessor_id = ${valid.predecessorId} AND successor_id = ${valid.successorId}`;
      if (prior[0]?.state === "accepted" || prior[0]?.state === "proposed")
        return yield* fail("conflict", "This replacement already exists.");
      yield* sql`INSERT INTO decision_relationships(id, project_id, predecessor_id, successor_id, state, predecessor_revision, successor_revision, revision, created_at, updated_at) VALUES (${NodeCrypto.randomUUID()}, ${valid.projectId}, ${valid.predecessorId}, ${valid.successorId}, 'proposed', ${valid.expectedPredecessorRevision + 1}, ${valid.expectedSuccessorRevision + 1}, 1, ${at}, ${at}) ON CONFLICT(predecessor_id, successor_id) DO UPDATE SET state = 'proposed', predecessor_revision = ${valid.expectedPredecessorRevision + 1}, successor_revision = ${valid.expectedSuccessorRevision + 1}, revision = revision + 1, updated_at = ${at}`;
      yield* sql`UPDATE thread_decisions SET revision = revision + 1, updated_at = ${at} WHERE id IN (${valid.predecessorId}, ${valid.successorId})`;
      decision = yield* get({ projectId: valid.projectId, id: valid.successorId });
    } else {
      const links =
        yield* sql<StoredRelationship>`SELECT * FROM decision_relationships WHERE id = ${valid.relationshipId} AND project_id = ${valid.projectId}`;
      const link = links[0];
      if (!link) return yield* fail("not-found", "This replacement no longer exists.");
      if (link.revision !== valid.expectedRevision)
        return yield* fail("conflict", "This replacement changed. Refresh and try again.");
      const predecessorId = DecisionId.make(link.predecessor_id);
      const successorId = DecisionId.make(link.successor_id);
      const predecessor = yield* checkRevision(
        { projectId: valid.projectId, id: predecessorId },
        valid.expectedPredecessorRevision,
      );
      yield* checkRevision(
        { projectId: valid.projectId, id: successorId },
        valid.expectedSuccessorRevision,
      );
      const accept = valid.operation === "accept-replacement";
      const undo = valid.operation === "undo-replacement";
      if ((undo && link.state !== "accepted") || (!undo && link.state !== "proposed"))
        return yield* fail("conflict", "This replacement cannot be changed in its current state.");
      if (accept && predecessor.lifecycle !== "current")
        return yield* fail("conflict", "This decision already has an accepted replacement.");
      if (accept || undo)
        yield* sql`UPDATE thread_decisions SET lifecycle = ${accept ? "superseded" : "current"} WHERE id = ${predecessorId}`;
      yield* sql`UPDATE thread_decisions SET revision = revision + 1, updated_at = ${at} WHERE id IN (${predecessorId}, ${successorId})`;
      yield* sql`UPDATE decision_relationships SET state = ${accept ? "accepted" : undo ? "undone" : "rejected"}, predecessor_revision = ${valid.expectedPredecessorRevision + 1}, successor_revision = ${valid.expectedSuccessorRevision + 1}, revision = revision + 1, updated_at = ${at} WHERE id = ${valid.relationshipId}`;
      decision = yield* get({ projectId: valid.projectId, id: successorId });
    }
    return { decision, projectRevision: yield* bump(valid.projectId) };
  });
  const exportDecisions = Effect.fn("Decisions.export")(function* (
    input: ThreadDecisionExportInput,
  ): Effect.fn.Return<
    ThreadDecisionExportResult,
    | ThreadDecisionError
    | import("effect/unstable/sql/SqlError").SqlError
    | import("effect/Schema").SchemaError
  > {
    if ((yield* revision(input.projectId)) !== input.expectedProjectRevision)
      return yield* fail(
        "conflict",
        "Decisions changed during export. Restart the export to capture a consistent revision.",
      );
    const page = yield* list({ ...input, limit: 50 });
    const selected: ThreadDecision[] = [];
    const markdown: string[] = [];
    let characters = 1000;
    for (const note of page.decisions) {
      const rendered =
        input.format === "json"
          ? yield* encodeDecisionJson(note)
          : markdownDecision(note, environmentId);
      if (characters + rendered.length > 1900000) break;
      selected.push(note);
      markdown.push(rendered);
      characters += rendered.length + 10;
    }
    if (page.decisions.length > 0 && selected.length === 0)
      return yield* fail("invalid", "This decision is too large to export.");
    const content =
      input.format === "json"
        ? yield* encodeExport({
            schemaVersion: 1,
            projectId: input.projectId,
            projectRevision: page.projectRevision,
            decisions: selected,
          })
        : markdown.join("\n\n---\n\n");
    const last = selected.at(-1);
    const nextCursor =
      selected.length < page.decisions.length && last
        ? Buffer.from(
            yield* encodeCursor({
              scope: decisionFingerprint([
                input.projectId,
                input.threadId ?? null,
                input.search ?? "",
                input.reviewState ?? null,
                input.lifecycle ?? null,
              ]),
              at: last.occurredAt,
              sequence: last.occurrence,
              id: last.id,
            }),
          ).toString("base64url")
        : page.nextCursor;
    return {
      format: input.format,
      schemaVersion: 1,
      projectRevision: page.projectRevision,
      content,
      nextCursor,
    };
  });
  return DecisionRepository.of({
    get: (input) => get(input).pipe(sql.withTransaction, Effect.mapError(boundary)),
    list: (input) => list(input).pipe(sql.withTransaction, Effect.mapError(boundary)),
    mutate: (input) => mutate(input).pipe(sql.withTransaction, Effect.mapError(boundary)),
    export: (input) => exportDecisions(input).pipe(sql.withTransaction, Effect.mapError(boundary)),
    createFromWriter: (input) =>
      createFromWriter(input).pipe(sql.withTransaction, Effect.mapError(boundary)),
    addEvidence: (input) => addEvidence(input).pipe(sql.withTransaction, Effect.mapError(boundary)),
    projectRevision: (projectId) => revision(projectId).pipe(Effect.mapError(boundary)),
    bumpRevision: (projectId) =>
      bump(projectId).pipe(sql.withTransaction, Effect.mapError(boundary)),
  });
});
export const layer = Layer.effect(DecisionRepository, make);
