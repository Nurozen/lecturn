import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0080 from "./080_ProjectionProjectsAppBinding.ts";

it.effect("adds the app binding columns and index, and runs again without change", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 78 });
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Kept', '/work', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;

    yield* Migration0080;
    yield* Migration0080;

    const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
      PRAGMA table_info(projection_projects)
    `;
    for (const name of ["app_id", "app_workspace_root"]) {
      assert.strictEqual(columns.find((column) => column.name === name)?.notnull, 0);
    }
    const indexed = yield* sql<{ readonly name: string }>`
      PRAGMA index_info('idx_projection_projects_app_workspace')
    `;
    assert.deepStrictEqual(
      indexed.map((column) => column.name),
      ["app_id", "app_workspace_root", "deleted_at"],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT title, app_id, app_workspace_root FROM projection_projects`,
      [{ title: "Kept", app_id: null, app_workspace_root: null }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
