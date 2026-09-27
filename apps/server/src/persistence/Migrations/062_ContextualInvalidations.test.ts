import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { layer } from "@lecturn/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

for (const keepRow of [true, false]) {
  it.effect(`preserves outbox cursors across upgrade with retained rows: ${keepRow}`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`INSERT INTO contextual_outbox(sequence,thread_id,revision,kind,entity_id,occurred_at)
        VALUES (50,'thread',1,'settings-changed','thread','2026-09-25T00:00:00Z')`;
      if (!keepRow) yield* sql`DELETE FROM contextual_outbox`;
      assert.deepEqual(yield* runMigrations(), [[62, "ContextualInvalidations"]]);
      const retained = yield* sql`SELECT sequence,thread_id,project_id FROM contextual_outbox`;
      assert.deepEqual(
        [...retained],
        keepRow ? [{ sequence: 50, thread_id: "thread", project_id: null }] : [],
      );
      yield* sql`INSERT INTO contextual_outbox(thread_id,project_id,revision,kind,entity_id,occurred_at)
        VALUES (NULL,NULL,1,'funding-changed','contextual','2026-09-25T00:00:01Z')`;
      const rows = yield* sql<{
        sequence: number;
      }>`SELECT sequence FROM contextual_outbox WHERE sequence>50`;
      assert.equal(rows[0]?.sequence, 51);
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
  );
}
