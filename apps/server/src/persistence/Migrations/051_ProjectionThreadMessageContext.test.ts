import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import migrateMessageContext from "./051_ProjectionThreadMessageContext.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

// Lecturn's ledger runs upstream migration 51 through compatibility migration 67.
layer("051_ProjectionThreadMessageContext", (it) => {
  it.effect("accepts context added by an earlier development migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`
        ALTER TABLE projection_thread_messages
        ADD COLUMN context_json TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* migrateMessageContext;

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const context = columns.filter((column) => column.name === "context_json");
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id
        FROM effect_sql_migrations
        WHERE migration_id = 67
      `;

      assert.equal(context.length, 1);
      assert.equal(context[0]?.notnull, 0);
      assert.equal(migrations.length, 1);
    }),
  );
});
