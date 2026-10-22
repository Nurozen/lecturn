import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import UpstreamMigration48 from "./048_ProjectionThreadBranchPullRequest.ts";

const timestamp = "2026-09-06T00:00:00.000Z";
const lineage = '{"threadId":"parent","turnId":"parent-turn","turnCount":1,"messageId":null}';
const forkSource =
  '{"providerInstanceId":"codex","resumeCursor":{"threadId":"native-parent"},"providerTurnRef":"provider-anchor","throughTurnOrdinal":1,"atEnd":true}';
const pullRequest =
  '{"projectId":"fixture-project","repository":"example/fixture","number":42,"url":"https://github.com/example/fixture/pull/42"}';

const seedThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, created_at, updated_at)
    VALUES ('fixture-thread', 'fixture-project', 'Preserved thread', '{"provider":"codex","model":"fixture-model"}', ${timestamp}, ${timestamp})
  `;
  yield* sql`
    INSERT INTO projection_turns
      (thread_id, turn_id, state, requested_at, checkpoint_files_json)
    VALUES ('fixture-thread', 'fixture-turn', 'completed', ${timestamp}, '[]')
  `;
});

const assertCompatible = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  for (const name of ["forked_from_json", "fork_source_json", "branch_pull_request_json"]) {
    assert.ok(threadColumns.some((column) => column.name === name));
  }
  const turnColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_turns)`;
  assert.ok(turnColumns.some((column) => column.name === "provider_turn_ref"));
  assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 69 }), []);
});

it.effect("creates a fresh schema with fork lineage and branch PR discovery", () =>
  Effect.gen(function* () {
    const executed = yield* runMigrations({ toMigrationInclusive: 69 });
    assert.deepStrictEqual(executed.at(-1), [
      69,
      "ProjectionThreadsAutoSettleDisabledAtCompatibility",
    ]);
    yield* seedThread;
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(
      yield* sql`SELECT forked_from_json, fork_source_json, branch_pull_request_json FROM projection_threads`,
      [{ forked_from_json: null, fork_source_json: null, branch_pull_request_json: null }],
    );
    yield* assertCompatible;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([48, 49, 63, 64])(
  "upgrades published Lecturn migration %s without rewriting its ledger or data",
  (throughId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: throughId });
      yield* seedThread;
      yield* sql`UPDATE projection_threads SET forked_from_json = ${lineage}, fork_source_json = ${forkSource}`;
      yield* sql`UPDATE projection_turns SET provider_turn_ref = 'provider-anchor'`;
      const ledgerBefore = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      yield* runMigrations({ toMigrationInclusive: 69 });
      const ledgerAfter =
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= ${throughId} ORDER BY migration_id`;
      assert.deepStrictEqual(ledgerAfter, ledgerBefore);
      assert.deepStrictEqual(
        yield* sql`SELECT title, forked_from_json, fork_source_json, branch_pull_request_json FROM projection_threads`,
        [
          {
            title: "Preserved thread",
            forked_from_json: lineage,
            fork_source_json: forkSource,
            branch_pull_request_json: null,
          },
        ],
      );
      assert.deepStrictEqual(yield* sql`SELECT provider_turn_ref FROM projection_turns`, [
        { provider_turn_ref: "provider-anchor" },
      ]);
      yield* assertCompatible;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "upgrades upstream's published migration 48 while preserving its identity and PR data",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* UpstreamMigration48;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (48, 'ProjectionThreadBranchPullRequest')`;
      yield* seedThread;
      yield* sql`UPDATE projection_threads SET branch_pull_request_json = ${pullRequest}`;
      const ledgerBefore = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      yield* runMigrations({ toMigrationInclusive: 69 });
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 48 ORDER BY migration_id`,
        ledgerBefore,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT title, forked_from_json, fork_source_json, branch_pull_request_json FROM projection_threads`,
        [
          {
            title: "Preserved thread",
            forked_from_json: null,
            fork_source_json: null,
            branch_pull_request_json: pullRequest,
          },
        ],
      );
      assert.deepStrictEqual(yield* sql`SELECT state, provider_turn_ref FROM projection_turns`, [
        { state: "completed", provider_turn_ref: null },
      ]);
      yield* assertCompatible;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
