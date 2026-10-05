import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.layer(NodeSqliteClient.layerMemory())("054_ThreadNotes", (it) => {
  it.effect("upgrades a previous database with typed note columns and lookup indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runMigrations({ toMigrationInclusive: 54 });
      const columns = yield* sql<{ name: string; type: string }>`PRAGMA table_info(thread_notes)`;
      assert.deepEqual(
        columns.map((c) => c.name),
        [
          "id",
          "project_id",
          "thread_id",
          "message_id",
          "message_role",
          "quote_text",
          "comment",
          "anchor_json",
          "created_at",
          "updated_at",
        ],
      );
      const indexes = yield* sql<{ name: string }>`PRAGMA index_list(thread_notes)`;
      assert.isTrue(indexes.some((i) => i.name === "thread_notes_project"));
      assert.isTrue(indexes.some((i) => i.name === "thread_notes_thread"));
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
    }),
  );
});
