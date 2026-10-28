import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

// Lecturn's ledger runs upstream's V2 migrations (published from 55) from 70.
const FIRST_V2_ID = 70;
const LAST_PRE_V2_ID = FIRST_V2_ID - 1;
const v2Migrations = migrationManifest.filter(([id]) => id >= FIRST_V2_ID);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("migrates a fresh database through the whole manifest", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${FIRST_V2_ID}, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        `${FIRST_V2_ID}_OrchestrationV2 (recorded: FutureMainMigration)`,
      );
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      // 79 and 80 run on their own instead (Migrations.divergentLedger.test.ts).
      for (const [id, name] of v2Migrations.filter(([id]) => id < 79)) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly the last pre-V2 id", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, LAST_PRE_V2_ID])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: FIRST_V2_ID });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${FIRST_V2_ID + 1}, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: FIRST_V2_ID }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: FIRST_V2_ID + 1 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        `${FIRST_V2_ID + 1}_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)`,
      );
      assert.notInclude(String(exit), `${FIRST_V2_ID + 2}_ScheduledTaskWebhooks`);
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the failure lookup index a database created under upstream's id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      // Upstream published this index as migration 62.
      yield* sql`
        CREATE INDEX orchestration_v2_projection_turn_items_failed_error_idx
        ON orchestration_v2_projection_turn_items(
          thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC
        )
        WHERE type = 'error' AND status = 'failed'
      `;

      assert.deepStrictEqual(yield* runMigrations(), [
        [77, "ThreadFailureLookupIndex"],
        [78, "DropUnusedV1Projections"],
        [79, "AppRegistrations"],
        [80, "ProjectionProjectsAppBinding"],
      ]);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
