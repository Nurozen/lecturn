import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

// The last migration before Lecturn's app migrations at 79 and 80.
const BEFORE_APP_MIGRATIONS_ID = 78;
const LAST_APP_MIGRATION_ID = 80;
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const hasTable = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
    return rows.length > 0;
  });

const projectColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_projects')`;
  return rows.map((row) => row.name);
});

const ledger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
});

const assertAppSchema = Effect.gen(function* () {
  assert.isTrue(yield* hasTable("app_registrations"));
  assert.isTrue(yield* hasTable("app_pairing_requests"));
  assert.includeMembers(yield* projectColumns, ["app_id", "app_workspace_root"]);
});

// Upstream ids are remapped above Lecturn's latest id, so another build can
// record its own migrations at 79 and 80. The migrator would skip those ids,
// so the app schema has to arrive anyway.
describe("connected-app migrations on a divergent ledger", () => {
  it.effect(
    "adds the app schema when another build recorded different migrations at 79 and 80",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: BEFORE_APP_MIGRATIONS_ID });
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
        (79, 'UpstreamNext'), (80, 'UpstreamAfterNext')`;
        const before = yield* ledger;

        const executed = yield* runMigrations();

        assert.deepEqual(executed, [
          [81, "CanonicalizeThreadPullRequestLinks"],
          [82, "Squire"],
          [83, "CodexUsageNativeTurnIndex"],
          [84, "RepairClientSettlementTimestamps"],
          [85, "WebhookDedupe"],
          [86, "ShellStopRequestIndex"],
          [87, "ThreadMessageSearch"],
          [88, "PeerLinks"],
          [89, "PeerLinkFence"],
          [90, "WaitingLinkRequestIndex"],
          [91, "SquireChatFirst"],
          [92, "ActiveTurnItemIndexes"],
          [79, "AppRegistrations"],
          [80, "ProjectionProjectsAppBinding"],
        ]);
        yield* assertAppSchema;
        // Repairs record nothing: the other build's names stay at 79 and 80.
        assert.deepEqual(yield* ledger, [
          ...before,
          { migration_id: 81, name: "CanonicalizeThreadPullRequestLinks" },
          { migration_id: 82, name: "Squire" },
          { migration_id: 83, name: "CodexUsageNativeTurnIndex" },
          { migration_id: 84, name: "RepairClientSettlementTimestamps" },
          { migration_id: 85, name: "WebhookDedupe" },
          { migration_id: 86, name: "ShellStopRequestIndex" },
          { migration_id: 87, name: "ThreadMessageSearch" },
          { migration_id: 88, name: "PeerLinks" },
          { migration_id: 89, name: "PeerLinkFence" },
          { migration_id: 90, name: "WaitingLinkRequestIndex" },
          { migration_id: 91, name: "SquireChatFirst" },
          { migration_id: 92, name: "ActiveTurnItemIndexes" },
        ]);
        // Every later start repairs again; the SQL is idempotent, so that is a no-op.
        yield* runMigrations();
        yield* assertAppSchema;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds the app schema when a later id was recorded without 79 and 80", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: BEFORE_APP_MIGRATIONS_ID });
      // That build recorded the migrations after the app ones, which a skip
      // would otherwise fail on, and then its own.
      for (const [id, name] of migrationManifest) {
        if (id <= LAST_APP_MIGRATION_ID) continue;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')`;

      yield* runMigrations();

      yield* assertAppSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds the app schema to a ledger that recorded upstream 64 at 79", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: BEFORE_APP_MIGRATIONS_ID });
      // An unreleased integration build ran upstream 64 as 79.
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (79, 'CanonicalizeThreadPullRequestLinks')`;

      const executed = yield* runMigrations();

      assert.deepEqual(executed, [
        [80, "ProjectionProjectsAppBinding"],
        [81, "CanonicalizeThreadPullRequestLinks"],
        [82, "Squire"],
        [83, "CodexUsageNativeTurnIndex"],
        [84, "RepairClientSettlementTimestamps"],
        [85, "WebhookDedupe"],
        [86, "ShellStopRequestIndex"],
        [87, "ThreadMessageSearch"],
        [88, "PeerLinks"],
        [89, "PeerLinkFence"],
        [90, "WaitingLinkRequestIndex"],
        [91, "SquireChatFirst"],
        [92, "ActiveTurnItemIndexes"],
        [79, "AppRegistrations"],
      ]);
      yield* assertAppSchema;
      assert.deepEqual(yield* runMigrations(), [[79, "AppRegistrations"]]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("repairs nothing on a ledger that recorded the app migrations itself", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepEqual(yield* runMigrations(), []);
      yield* assertAppSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
