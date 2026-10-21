import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Upstream48 from "./048_ProjectionThreadBranchPullRequest.ts";
import Upstream49 from "./049_ProjectionThreadsActiveOrderKey.ts";
import Upstream50 from "./050_ProjectionThreadPullRequests.ts";
import Upstream51 from "./051_ProjectionThreadMessageContext.ts";
import Upstream52 from "./052_ProjectionThreadTitleState.ts";

const at = "2026-01-01T00:00:00.000Z";
const compatibility = [67, "MessageContextTitleStateCompatibility"] as const;
const latest = [68, "PullRequestFilesViewedCompatibility"] as const;

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const assertReconciled = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.include(yield* columnNames("projection_thread_messages"), "context_json");
  assert.include(yield* columnNames("projection_threads"), "title_state_json");
  assert.include(yield* columnNames("projection_threads"), "forked_from_json");
  const tables = yield* tableNames;
  for (const table of [
    "saga_workbench",
    "saga_workbench_receipts",
    "saga_workbench_activity",
    "pull_request_watches",
    "pull_request_watch_receipts",
    "pull_request_watch_settings",
    "projection_thread_pull_requests",
    "stave_project_lifecycle",
  ]) {
    assert.include(tables, table);
  }
  assert.deepEqual(yield* sql`SELECT id, mode FROM pull_request_watch_settings`, [
    { id: 1, mode: "follow-pr" },
  ]);
  assert.deepEqual(yield* runMigrations(), []);
});

describe("067 collision compatibility", () => {
  it.effect("adds upstream columns on a fresh database", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();
      assert.deepEqual(executed.at(-1), latest);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("adds upstream columns to a published Lecturn database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, created_at, updated_at)
        VALUES ('thread', 'project', 'Preserved', '{"instanceId":"codex","model":"fixture"}', ${at}, ${at})`;
      yield* sql`UPDATE pull_request_watch_settings SET mode = 'off'`;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      assert.deepEqual(yield* runMigrations(), [compatibility, latest]);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 66 ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* sql`SELECT title, title_state_json FROM projection_threads`, [
        { title: "Preserved", title_state_json: null },
      ]);
      // An existing watch setting is left alone.
      assert.deepEqual(yield* sql`SELECT mode FROM pull_request_watch_settings`, [{ mode: "off" }]);
      yield* sql`UPDATE pull_request_watch_settings SET mode = 'follow-pr'`;
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("adds Lecturn schema to an upstream 52 database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* Upstream48;
      yield* Upstream49;
      yield* Upstream50;
      yield* Upstream51;
      yield* Upstream52;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
        (48, 'ProjectionThreadBranchPullRequest'),
        (49, 'ProjectionThreadsActiveOrderKey'),
        (50, 'ProjectionThreadPullRequests'),
        (51, 'ProjectionThreadMessageContext'),
        (52, 'ProjectionThreadTitleState')`;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, title_state_json, created_at, updated_at)
        VALUES ('thread', 'project', 'Preserved', '{"instanceId":"codex","model":"fixture"}', '{"kind":"manual"}', ${at}, ${at})`;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const executed = yield* runMigrations();
      assert.deepEqual(executed[0], [53, "ProjectionThreadImportOrigin"]);
      assert.deepEqual(executed.at(-1), latest);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 52 ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* sql`SELECT title, title_state_json FROM projection_threads`, [
        { title: "Preserved", title_state_json: '{"kind":"manual"}' },
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
