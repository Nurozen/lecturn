import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades an already applied early scan migration and preserves accepted work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO decision_scans(id,project_id,preview_key,state,from_sequence,through_sequence,created_at,updated_at,config_revision,description,project_cancellation_epoch) VALUES ('legacy-scan','project','preview','queued',0,1,'now','now',4,'Original scope',2)`;
    for (const column of [
      "prepared",
      "source_fingerprint",
      "preparation_fingerprint",
      "preparation_thread",
      "preparation_message",
      "expected_message_count",
      "prepared_message_count",
    ])
      yield* sql.unsafe(`ALTER TABLE decision_scans DROP COLUMN ${column}`);
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 57`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 57 }), [
      [57, "DecisionScanPreparation"],
    ]);
    const rows = yield* sql<{
      prepared: number;
      description: string;
      config_revision: number;
    }>`SELECT prepared,description,config_revision FROM decision_scans WHERE id = 'legacy-scan'`;
    assert.deepEqual(
      [...rows],
      [{ prepared: 1, description: "Original scope", config_revision: 4 }],
    );
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 57 }), []);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
