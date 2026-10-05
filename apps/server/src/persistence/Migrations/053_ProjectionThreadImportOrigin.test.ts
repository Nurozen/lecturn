import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionThreadImportOrigin", (it) => {
  it.effect("adds the import origin and import source columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runMigrations({ toMigrationInclusive: 53 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(threadColumns.some((column) => column.name === "imported_from_json"));
      assert.ok(threadColumns.some((column) => column.name === "import_source_json"));
    }),
  );
});
