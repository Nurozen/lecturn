import { assert, it } from "@effect/vitest";
import {
  DecisionEvidenceId,
  MessageId,
  ProjectId,
  ThreadId,
  type DecisionEvidence,
} from "@lecturn/contracts";
import { decisionSourceHash } from "@lecturn/shared/decisionEvidence";
import { Effect, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { decisionSourceWindow } from "./DecisionSourceWindow.ts";

const projectId = ProjectId.make("source-project");
const threadId = ThreadId.make("source-thread");
const at = "2026-01-01T00:00:00.000Z";
const text = "Context.\r\nUse **Postgres**. 😀";
const quote = "Use **Postgres**.";
const evidence: DecisionEvidence = {
  id: DecisionEvidenceId.make("evidence"),
  threadId,
  messageId: MessageId.make("target"),
  messageRole: "user",
  sourceHash: decisionSourceHash(text),
  sourceGeneration: 1,
  canonicalVersion: "1",
  quote,
  start: 9,
  end: 26,
  prefix: "Context.\n",
  suffix: " 😀",
  occurrence: 1,
  availability: "available",
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "projection_thread_messages",
    "projection_threads",
    "projection_projects",
    "decision_thread_state",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'QA','/tmp/qa','[]',${at},${at})`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES (${threadId},${projectId},'QA','{}',${at},${at},'full-access','default')`;
  yield* sql`INSERT INTO decision_thread_state(thread_id,project_id,source_generation,updated_at) VALUES (${threadId},${projectId},1,${at})`;
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('target',${threadId},'user',${text},0,${at},${at})`;
  return sql;
});
it.layer(SqlitePersistenceMemory)("Decision source windows", (it) => {
  it.effect("maps canonical UTF16 quotes to raw Markdown CRLF coordinates", () =>
    Effect.gen(function* () {
      yield* fixture;
      const result = yield* decisionSourceWindow(projectId, evidence);
      assert.equal(result.outcome, "exact");
      assert.equal(result.messages[0]?.text.slice(result.start!, result.end!), quote);
      assert.equal(result.start, 10);
    }),
  );
  it.effect(
    "never exact-matches a reused source generation and retains deleted evidence destination",
    () =>
      Effect.gen(function* () {
        const sql = yield* fixture;
        yield* sql`UPDATE decision_thread_state SET source_generation = 2`;
        const changed = yield* decisionSourceWindow(projectId, evidence);
        assert.equal(changed.outcome, "message-only");
        assert.isNull(changed.start);
        yield* sql`UPDATE projection_threads SET deleted_at = ${at}`;
        const deleted = yield* decisionSourceWindow(projectId, evidence);
        assert.equal(deleted.outcome, "unavailable");
        assert.equal(deleted.reason, "thread-deleted");
        assert.equal(evidence.quote, quote);
      }),
  );
  it.effect("rejects cross-project lookup and bounds huge source hydration", () =>
    Effect.gen(function* () {
      const sql = yield* fixture;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('other','Other','/tmp/other','[]',${at},${at})`;
      assert.isTrue(
        Result.isFailure(
          yield* decisionSourceWindow(ProjectId.make("other"), evidence).pipe(Effect.result),
        ),
      );
      yield* sql`UPDATE projection_thread_messages SET text = ${"x".repeat(64001)}`;
      const huge = yield* decisionSourceWindow(projectId, evidence);
      assert.equal(huge.outcome, "message-only");
      assert.deepEqual(huge.messages, []);
    }),
  );
});
