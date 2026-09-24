import { assert, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  EnvironmentId,
  DecisionId,
  DecisionEvidenceId,
  DecisionRelationshipId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type ThreadDecision,
} from "@lecturn/contracts";
import { decisionSourceHash } from "@lecturn/shared/decisionEvidence";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { parseAssistantCitationHref } from "@lecturn/shared/assistantCitations";
import { make, type CreateDecisionFromWriter } from "./DecisionRepository.ts";

const decodeExport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ decisions: Schema.Array(Schema.Unknown) })),
);

const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const input: CreateDecisionFromWriter = {
  id: DecisionId.make("decision"),
  projectId,
  threadId,
  actionKey: "action",
  title: "Use Postgres",
  body: "Use Postgres for storage.",
  rationale: "Transactions",
  attribution: "user-directed",
  occurredAt: "2026-09-23",
  occurrence: 1,
  evidence: [
    {
      id: DecisionEvidenceId.make("evidence"),
      threadId,
      messageId: MessageId.make("message"),
      messageRole: "user",
      sourceHash: decisionSourceHash("Use Postgres for storage."),
      sourceGeneration: 0,
      canonicalVersion: "1",
      quote: "Use Postgres",
      start: 0,
      end: 12,
      prefix: "",
      suffix: " for storage.",
      occurrence: 1,
      availability: "available",
    },
  ],
  provenance: {
    descriptionRevision: 1,
    sourceFingerprint: "fingerprint",
    canonicalVersion: "1",
    templateVersion: "1",
    detectorModel: "jev-1.13.0",
    writerSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" },
    writerConfigurationGeneration: "1",
    identityConfidence: "configuration-only",
  },
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "decision_suppression",
    "decision_relationships",
    "decision_evidence",
    "thread_decisions",
    "decision_sources",
    "decision_thread_state",
    "decision_outbox",
    "projection_thread_messages",
    "projection_threads",
    "projection_projects",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/tmp/decisions','[]','now','now'), ('other','Other','/tmp/other','[]','now','now')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES ('thread','project','Saved thread title','{}','now','now','full-access','default')`;
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('message','thread','user','Use Postgres for storage.',0,'now','now')`;
  yield* sql`INSERT INTO decision_thread_state(thread_id,project_id,source_generation,updated_at) VALUES ('thread','project',0,'now')`;
  yield* sql`INSERT INTO decision_sources(thread_id,message_id,source_generation,project_id,source_hash,source_sequence,role,created_at) VALUES ('thread','message',0,'project',${input.evidence[0]!.sourceHash},1,'user','now')`;
  return {
    sql,
    service: yield* make.pipe(
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-environment")),
      }),
    ),
  };
});
const relationshipInput = (
  predecessor: ThreadDecision,
  successor: ThreadDecision,
  operation: "accept-replacement" | "reject-replacement" | "undo-replacement",
) => ({
  operation,
  projectId,
  relationshipId: DecisionRelationshipId.make(successor.relationships[0]!.id),
  expectedRevision: successor.relationships[0]!.revision,
  expectedPredecessorRevision: predecessor.revision,
  expectedSuccessorRevision: successor.revision,
});

it.layer(SqlitePersistenceMemory)("DecisionRepository", (it) => {
  it.effect(
    "preserves edits and comments on writer replay and handles independent review state",
    () =>
      Effect.gen(function* () {
        const { service } = yield* fixture;
        const created = yield* service.createFromWriter(input);
        assert.isNotNull(created);
        assert.equal(created!.revision, 1);
        const edit = yield* service.mutate({
          operation: "edit",
          projectId,
          id: input.id,
          expectedRevision: 1,
          title: "Prefer Postgres",
          body: "Edited body",
          rationale: null,
        });
        assert.equal(edit.decision?.userEdited, true);
        assert.equal(edit.decision?.reviewState, "unreviewed");
        const comment = yield* service.mutate({
          operation: "comment",
          projectId,
          id: input.id,
          expectedRevision: 2,
          comment: "Personal comment",
        });
        assert.equal(comment.decision?.comment, "Personal comment");
        assert.equal((yield* service.createFromWriter(input))?.body, "Edited body");
        assert.equal((yield* service.get({ projectId, id: input.id })).comment, "Personal comment");
        const stale = yield* service
          .mutate({
            operation: "review",
            projectId,
            id: input.id,
            expectedRevision: 1,
            reviewState: "confirmed",
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(stale));
        if (Result.isFailure(stale)) assert.equal(stale.failure.code, "conflict");
      }),
  );
  it.effect(
    "scopes ownership and blocks current source mismatch while retaining deleted sources",
    () =>
      Effect.gen(function* () {
        const { sql, service } = yield* fixture;
        yield* service.createFromWriter(input);
        const denied = yield* service
          .get({ projectId: ProjectId.make("other"), id: input.id })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(denied));
        const forged = yield* service
          .createFromWriter({
            ...input,
            id: DecisionId.make("forged"),
            actionKey: "forged",
            projectId: ProjectId.make("other"),
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(forged));
        yield* sql`UPDATE projection_thread_messages SET text = 'Use SQLite'`;
        const changed = yield* service
          .createFromWriter({ ...input, id: DecisionId.make("changed"), actionKey: "changed" })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(changed));
        if (Result.isFailure(changed)) assert.equal(changed.failure.code, "stale-source");
        assert.equal(
          (yield* service.get({ projectId, id: input.id })).evidence[0]?.availability,
          "changed",
        );
        yield* sql`UPDATE projection_thread_messages SET text = 'Use Postgres for storage.'`;
        yield* sql`UPDATE decision_thread_state SET source_generation = 1`;
        const oldGeneration = yield* service
          .createFromWriter({
            ...input,
            id: DecisionId.make("generation"),
            actionKey: "generation",
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(oldGeneration));
        if (Result.isFailure(oldGeneration))
          assert.equal(oldGeneration.failure.code, "stale-source");
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_threads`;
        const retained = yield* service.get({ projectId, id: input.id });
        assert.equal(retained.threadTitle, "Saved thread title");
        assert.equal(retained.evidence[0]?.quote, "Use Postgres");
        assert.equal(retained.evidence[0]?.availability, "thread-deleted");
        yield* sql`UPDATE projection_projects SET deleted_at = 'now' WHERE project_id = 'project'`;
        assert.isTrue(Result.isFailure(yield* service.list({ projectId }).pipe(Effect.result)));
      }),
  );
  it.effect("dismissal is reversible and deletion suppresses later automatic recreation", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture;
      yield* service.createFromWriter(input);
      yield* service.mutate({
        operation: "review",
        projectId,
        id: input.id,
        expectedRevision: 1,
        reviewState: "dismissed",
      });
      assert.equal((yield* service.list({ projectId })).decisions.length, 0);
      assert.equal(
        (yield* service.list({ projectId, reviewState: "dismissed" })).decisions.length,
        1,
      );
      assert.isNull(
        yield* service.createFromWriter({ ...input, id: DecisionId.make("new"), actionKey: "new" }),
      );
      yield* service.mutate({
        operation: "review",
        projectId,
        id: input.id,
        expectedRevision: 2,
        reviewState: "unreviewed",
      });
      assert.equal((yield* service.list({ projectId })).decisions.length, 1);
      yield* service.mutate({ operation: "delete", projectId, id: input.id, expectedRevision: 3 });
      assert.isNull(yield* service.createFromWriter(input));
      assert.equal(
        (yield* service.list({ projectId, reviewState: "all", lifecycle: "all" })).decisions.length,
        0,
      );
    }),
  );
  it.effect("accepts and reverses replacements atomically and rejects cycles and stale edits", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture;
      const secondId = DecisionId.make("successor");
      yield* service.createFromWriter(input);
      yield* service.createFromWriter({
        ...input,
        id: secondId,
        actionKey: "second",
        title: "Use SQLite",
      });
      yield* service.mutate({
        operation: "propose-replacement",
        projectId,
        predecessorId: input.id,
        successorId: secondId,
        expectedPredecessorRevision: 1,
        expectedSuccessorRevision: 1,
      });
      let predecessor = yield* service.get({ projectId, id: input.id });
      let successor = yield* service.get({ projectId, id: secondId });
      assert.equal(predecessor.lifecycle, "current");
      const cycle = yield* service
        .mutate({
          operation: "propose-replacement",
          projectId,
          predecessorId: secondId,
          successorId: input.id,
          expectedPredecessorRevision: successor.revision,
          expectedSuccessorRevision: predecessor.revision,
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(cycle));
      yield* service.mutate(relationshipInput(predecessor, successor, "accept-replacement"));
      predecessor = yield* service.get({ projectId, id: input.id });
      successor = yield* service.get({ projectId, id: secondId });
      assert.equal(predecessor.lifecycle, "superseded");
      assert.equal((yield* service.list({ projectId })).decisions.length, 1);
      yield* service.mutate(relationshipInput(predecessor, successor, "undo-replacement"));
      predecessor = yield* service.get({ projectId, id: input.id });
      successor = yield* service.get({ projectId, id: secondId });
      assert.equal(predecessor.lifecycle, "current");
      assert.equal(successor.relationships[0]?.state, "undone");
      yield* service.mutate({
        operation: "propose-replacement",
        projectId,
        predecessorId: input.id,
        successorId: secondId,
        expectedPredecessorRevision: predecessor.revision,
        expectedSuccessorRevision: successor.revision,
      });
      predecessor = yield* service.get({ projectId, id: input.id });
      successor = yield* service.get({ projectId, id: secondId });
      yield* service.mutate(relationshipInput(predecessor, successor, "reject-replacement"));
      assert.equal((yield* service.get({ projectId, id: input.id })).lifecycle, "current");
    }),
  );
  it.effect(
    "paginates and exports more than 500 decisions without duplicates and fences changed exports",
    () =>
      Effect.gen(function* () {
        const { sql, service } = yield* fixture;
        yield* service.createFromWriter(input);
        yield* sql`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 510) INSERT INTO thread_decisions SELECT 'note-' || printf('%04d', n), project_id, thread_id, thread_title, title, body, rationale, comment, attribution, review_state, lifecycle, user_edited, revision, n, occurred_at, created_at, updated_at, provenance_json, 'action-' || n FROM thread_decisions CROSS JOIN numbers WHERE id = 'decision'`;
        yield* sql`INSERT INTO decision_evidence SELECT d.id || '-e', d.id, e.thread_id, e.message_id, e.role, e.source_hash, e.source_generation, e.canonical_version, e.quote, e.start_offset, e.end_offset, e.prefix, e.suffix, d.source_sequence FROM thread_decisions d CROSS JOIN decision_evidence e WHERE d.id <> 'decision' AND e.decision_id = 'decision'`;
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = yield* service.list({
            projectId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          ids.push(...page.decisions.map((note) => note.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assert.equal(ids.length, 511);
        assert.equal(new Set(ids).size, 511);
        assert.equal(ids[0], "note-0510");
        let exported = 0;
        let pages = 0;
        do {
          const page = yield* service.export({
            projectId,
            format: "json",
            expectedProjectRevision: 1,
            ...(cursor ? { cursor } : {}),
          });
          exported += (yield* decodeExport(page.content)).decisions.length;
          pages++;
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assert.equal(exported, 511);
        assert.equal(pages, 11);
        const markdown = yield* service.export({
          projectId,
          format: "markdown",
          expectedProjectRevision: 1,
        });
        assert.include(markdown.content, "> Use Postgres");
        assert.include(markdown.content, "configuration-only");
        const href = markdown.content.match(/lecturn-citation:\/\/v1\/[^)]+/)?.[0];
        assert.isDefined(href);
        assert.equal(parseAssistantCitationHref(href!)?.environmentId, "fixture-environment");
        assert.equal(parseAssistantCitationHref(href!)?.messageId, "message");
        yield* service.bumpRevision(projectId);
        const stale = yield* service
          .export({ projectId, format: "json", expectedProjectRevision: 1 })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(stale));
        if (Result.isFailure(stale)) assert.equal(stale.failure.code, "conflict");
        yield* sql`UPDATE decision_evidence SET quote = ${"\u0001".repeat(8000)}, start_offset = 0, end_offset = 8000`;
        const large = yield* service.export({
          projectId,
          format: "json",
          expectedProjectRevision: 2,
        });
        assert.isBelow(large.content.length, 2000000);
        assert.isNotNull(large.nextCursor);
        assert.isBelow((yield* decodeExport(large.content)).decisions.length, 50);
      }),
  );
  it.effect("search treats wildcards literally and evidence insertion is idempotent", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture;
      yield* service.createFromWriter(input);
      assert.equal((yield* service.list({ projectId, search: "Postgres" })).decisions.length, 1);
      assert.equal((yield* service.list({ projectId, search: "%" })).decisions.length, 0);
      assert.equal((yield* service.list({ projectId, search: "_" })).decisions.length, 0);
      const same = yield* service.addEvidence({
        projectId,
        id: input.id,
        expectedRevision: 1,
        evidence: input.evidence,
      });
      assert.equal(same.revision, 1);
      const expanded = {
        ...input.evidence[0]!,
        id: DecisionEvidenceId.make("expanded"),
        quote: "for storage.",
        start: 13,
        end: 25,
        prefix: "Use Postgres ",
        suffix: "",
      };
      const invalid = yield* service
        .addEvidence({
          projectId,
          id: input.id,
          expectedRevision: 1,
          evidence: [{ ...expanded, start: 12, end: 24 }],
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(invalid));
      assert.equal((yield* service.get({ projectId, id: input.id })).revision, 1);
      const updated = yield* service.addEvidence({
        projectId,
        id: input.id,
        expectedRevision: 1,
        evidence: [expanded],
      });
      assert.equal(updated.evidence.length, 2);
      assert.equal(updated.revision, 2);
    }),
  );
});
