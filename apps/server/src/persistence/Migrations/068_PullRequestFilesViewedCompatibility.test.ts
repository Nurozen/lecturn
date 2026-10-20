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
import Upstream53 from "./053_PullRequestFilesViewed.ts";

const at = "2026-01-01T00:00:00.000Z";
const latest = [68, "PullRequestFilesViewedCompatibility"] as const;

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

const viewedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT provider, host, repository, number, viewer, path, revision FROM pull_request_files_viewed`;
});

const assertReconciled = Effect.gen(function* () {
  const threadColumns = yield* columnNames("projection_threads");
  assert.include(threadColumns, "imported_from_json");
  assert.include(threadColumns, "import_source_json");
  assert.include(threadColumns, "forked_from_json");
  assert.include(threadColumns, "title_state_json");
  assert.includeMembers(yield* columnNames("pull_request_files_viewed"), [
    "provider",
    "host",
    "repository",
    "number",
    "viewer",
    "path",
    "revision",
    "viewed_at",
  ]);
  assert.deepEqual(yield* runMigrations(), []);
});

describe("068 collision compatibility", () => {
  it.effect("creates the viewed files table on a fresh database", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();
      assert.deepEqual(executed.at(-1), latest);
      assert.deepEqual(yield* viewedRows, []);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("adds the viewed files table to a published Lecturn database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, imported_from_json, created_at, updated_at)
        VALUES ('thread', 'project', 'Preserved', '{"instanceId":"codex","model":"fixture"}', '{"kind":"fixture"}', ${at}, ${at})`;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      assert.deepEqual(yield* runMigrations(), [latest]);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 67 ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* sql`SELECT title, imported_from_json FROM projection_threads`, [
        { title: "Preserved", imported_from_json: '{"kind":"fixture"}' },
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("adds Lecturn schema to an upstream 53 database and keeps viewed files", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* Upstream48;
      yield* Upstream49;
      yield* Upstream50;
      yield* Upstream51;
      yield* Upstream52;
      yield* Upstream53;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
        (48, 'ProjectionThreadBranchPullRequest'),
        (49, 'ProjectionThreadsActiveOrderKey'),
        (50, 'ProjectionThreadPullRequests'),
        (51, 'ProjectionThreadMessageContext'),
        (52, 'ProjectionThreadTitleState'),
        (53, 'PullRequestFilesViewed')`;
      yield* sql`INSERT INTO pull_request_files_viewed
        (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'example/fixture', 7, 'reader', 'src/a.ts', 'abc', ${at})`;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const executed = yield* runMigrations();
      assert.deepEqual(executed[0], [54, "ThreadNotes"]);
      assert.deepEqual(executed.at(-1), latest);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 53 ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* viewedRows, [
        {
          provider: "github",
          host: "github.com",
          repository: "example/fixture",
          number: 7,
          viewer: "reader",
          path: "src/a.ts",
          revision: "abc",
        },
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
