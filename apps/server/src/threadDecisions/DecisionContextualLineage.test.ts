import { assert, it } from "@effect/vitest";
import { DecisionId, ThreadId } from "@lecturn/contracts";
import { Effect, Result, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { emptyPolicy } from "../contextual/ContextualPurge.ts";
import {
  assertContextualOrigins,
  readContextualOrigins,
  recordContextualLineage,
} from "./DecisionContextualLineage.ts";

const threadId = ThreadId.make("lineage-thread");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "contextual_host_state",
    "contextual_thread_settings",
    "contextual_project_settings",
    "contextual_packets",
    "contextual_supply",
    "contextual_lineage",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT INTO contextual_host_state(singleton,source_policy_json,updated_at) VALUES(1,${encode(emptyPolicy)},'now')`;
  yield* sql`INSERT INTO contextual_project_settings(project_id,source_ids_json,updated_at) VALUES('lineage-project','["slack:original"]','now')`;
  yield* sql`INSERT INTO contextual_thread_settings(thread_id,project_id,enabled,source_ids_json,updated_at) VALUES(${threadId},'lineage-project',1,'["slack:original"]','now')`;
  return sql;
});

it.layer(SqlitePersistenceMemory)("Decision Contextual lineage", (it) => {
  it.effect(
    "keeps flattened source identities after packet expiry without recovering source quotes",
    () =>
      Effect.gen(function* () {
        const sql = yield* fixture;
        yield* sql`INSERT INTO contextual_packets(id,preparation_id,thread_id,packet_json,payload_bytes,retention,created_at) VALUES('expired','old-preparation',${threadId},NULL,0,'expired','now')`;
        yield* sql`INSERT INTO contextual_supply(thread_id,guidance_id,fingerprint,context_epoch,packet_id,dispatch_id,message_id,source_revision,acceptance,supplied_at) VALUES(${threadId},'guidance','fingerprint','initial','expired','dispatch','message',1,'accepted','now')`;
        yield* sql`INSERT INTO contextual_lineage(source_id,source_evidence_id,entity_kind,entity_id) VALUES
        ('slack:original','original-evidence','packet','expired'),
        ('slack:original','occurrence:original-message','packet','expired'),
        ('decisions:lineage-project','paraphrase-anchor','packet','expired'),
        ('decisions:lineage-project','paraphrase-anchor','packet-origin','expired'),
        ('decisions:lineage-project','paraphrase-anchor','origin','paraphrase-anchor'),
        ('slack:original','original-evidence','origin','paraphrase-anchor'),
        ('slack:original','occurrence:original-message','origin','paraphrase-anchor')`;
        const snapshot = yield* readContextualOrigins(sql, threadId, "job");
        assert.deepEqual(snapshot.origins, [
          {
            sourceId: "decisions:lineage-project",
            evidenceId: "paraphrase-anchor",
            sourceHash: null,
            quote: null,
          },
        ]);
        yield* assertContextualOrigins(sql, snapshot.generation, snapshot);
        const decisionId = DecisionId.make("derived-note");
        yield* recordContextualLineage(sql, "job", decisionId, ["paraphrase-anchor"]);
        yield* recordContextualLineage(sql, "job", decisionId, ["paraphrase-anchor"]);
        assert.deepEqual(
          yield* sql`SELECT source_id,source_evidence_id FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${decisionId} ORDER BY source_id,source_evidence_id`,
          [
            { source_id: "decisions:lineage-project", source_evidence_id: "paraphrase-anchor" },
            { source_id: "slack:original", source_evidence_id: "occurrence:original-message" },
            { source_id: "slack:original", source_evidence_id: "original-evidence" },
          ],
        );
        yield* recordContextualLineage(sql, "job", DecisionId.make("independent-choice"), []);
        assert.deepEqual(
          yield* sql`SELECT * FROM contextual_lineage WHERE entity_kind='decision' AND entity_id='independent-choice'`,
          [],
        );
        yield* sql`INSERT INTO contextual_lineage VALUES('slack:unrelated','unrelated-origin','job-origin','job'),('slack:unrelated','unrelated-ancestor','origin','unrelated-origin')`;
        yield* recordContextualLineage(sql, "job", DecisionId.make("other-choice"), [
          "unrelated-origin",
        ]);
        assert.deepEqual(
          yield* sql`SELECT source_id,source_evidence_id FROM contextual_lineage WHERE entity_kind='decision' AND entity_id='other-choice'`,
          [{ source_id: "slack:unrelated", source_evidence_id: "unrelated-ancestor" }],
        );
        assert.isTrue(
          Result.isFailure(
            yield* recordContextualLineage(sql, "job", DecisionId.make("invalid-choice"), [
              "invented",
            ]).pipe(Effect.result),
          ),
        );
        assert.deepEqual(
          yield* sql`SELECT packet_json FROM contextual_packets WHERE id='expired'`,
          [{ packet_json: null }],
        );
      }),
  );

  for (const change of ["thread", "project", "policy", "purge"] as const) {
    it.effect(`rejects a writer result after ${change} scope changes`, () =>
      Effect.gen(function* () {
        const sql = yield* fixture;
        const snapshot = yield* readContextualOrigins(sql, threadId, "job");
        yield* assertContextualOrigins(sql, snapshot.generation, snapshot);
        if (change === "thread")
          yield* sql`UPDATE contextual_thread_settings SET enabled=0 WHERE thread_id=${threadId}`;
        if (change === "project")
          yield* sql`UPDATE contextual_project_settings SET source_ids_json='[]' WHERE project_id='lineage-project'`;
        if (change === "policy")
          yield* sql`UPDATE contextual_host_state SET source_policy_json=${encode({ ...emptyPolicy, allowedSourceIds: ["slack:original"], revision: 1 })} WHERE singleton=1`;
        if (change === "purge")
          yield* sql`UPDATE contextual_host_state SET purge_generation=1 WHERE singleton=1`;
        const result = yield* assertContextualOrigins(sql, snapshot.generation, snapshot).pipe(
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure._tag, "ThreadDecisionError");
          if (result.failure._tag === "ThreadDecisionError")
            assert.equal(result.failure.code, "stale-source");
        }
      }),
    );
  }
});
