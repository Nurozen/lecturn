import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Upstream48 from "./048_ProjectionThreadBranchPullRequest.ts";
import Upstream49 from "./049_ProjectionThreadsActiveOrderKey.ts";

const at = "2026-01-01T00:00:00.000Z";
const seedEvent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_events
    (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
    VALUES (42, 'historical-delete', 'project', 'project', 1, 'project.deleted', ${at}, 'user', '{}', '{}')`;
});
const seedThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, created_at, updated_at)
    VALUES ('child', 'project', 'Preserved', '{"instanceId":"codex","model":"fixture"}', ${at}, ${at})`;
});

describe("065 collision compatibility", () => {
  for (const upstreamId of [48, 49]) {
    it.effect(`upgrades upstream ${upstreamId} without replaying historical deletion intents`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 47 });
        yield* Upstream48;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (48, 'ProjectionThreadBranchPullRequest')`;
        if (upstreamId === 49) {
          yield* Upstream49;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (49, 'ProjectionThreadsActiveOrderKey')`;
        }
        yield* seedEvent;
        yield* seedThread;
        yield* sql`UPDATE projection_threads SET branch_pull_request_json = '{"number":42}'`;
        if (upstreamId === 49) yield* sql`UPDATE projection_threads SET active_order_key = 'gm'`;
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const executed = yield* runMigrations();
        assert.deepEqual(executed.at(-1), [
          69,
          "ProjectionThreadsAutoSettleDisabledAtCompatibility",
        ]);
        assert.deepEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= ${upstreamId} ORDER BY migration_id`,
          ledger,
        );
        assert.deepEqual(
          yield* sql`SELECT title, created_at, updated_at, active_order_key, branch_pull_request_json, forked_from_json, import_source_json FROM projection_threads`,
          [
            {
              title: "Preserved",
              created_at: at,
              updated_at: at,
              active_order_key: upstreamId === 49 ? "gm" : null,
              branch_pull_request_json: '{"number":42}',
              forked_from_json: null,
              import_source_json: null,
            },
          ],
        );
        assert.deepEqual(yield* sql`SELECT last_applied_sequence FROM stave_lifecycle_cursor`, [
          { last_applied_sequence: 42 },
        ]);
        assert.deepEqual(
          yield* sql`SELECT last_applied_sequence FROM projection_state WHERE projector = 'stave.project-lifecycle'`,
          [{ last_applied_sequence: 42 }],
        );
        assert.deepEqual(yield* sql`SELECT * FROM stave_project_lifecycle`, []);
        assert.deepEqual(yield* sql`SELECT * FROM stave_lifecycle_policy`, []);
        assert.deepEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  }
  for (const forkId of [49, 63, 64]) {
    it.effect(`preserves published fork ${forkId} lifecycle leases, journal and lineage`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: forkId });
        yield* seedThread;
        yield* sql`UPDATE projection_threads SET forked_from_json = '{"threadId":"parent"}', fork_source_json = '{"providerTurnRef":"anchor"}'`;
        yield* sql`UPDATE stave_lifecycle_cursor SET last_applied_sequence = 17`;
        yield* sql`UPDATE projection_state SET last_applied_sequence = 17 WHERE projector = 'stave.project-lifecycle'`;
        yield* sql`INSERT INTO stave_project_lifecycle
          (project_id, workspace_root, disposition, lease_epoch, owner_token, lease_until, updated_at)
          VALUES ('project', '/fixture', 'destroying', 7, 'owner', ${at}, ${at})`;
        if (forkId >= 50)
          yield* sql`UPDATE stave_project_lifecycle SET saga_teardown_json = '{"journal":"keep"}'`;
        const lifecycle =
          yield* sql`SELECT project_id, disposition, lease_epoch, owner_token, lease_until, updated_at FROM stave_project_lifecycle`;
        const cursor = yield* sql`SELECT * FROM stave_lifecycle_cursor`;
        const projector =
          yield* sql`SELECT * FROM projection_state WHERE projector = 'stave.project-lifecycle'`;
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        yield* runMigrations();
        assert.deepEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= ${forkId} ORDER BY migration_id`,
          ledger,
        );
        assert.deepEqual(
          yield* sql`SELECT project_id, disposition, lease_epoch, owner_token, lease_until, updated_at FROM stave_project_lifecycle`,
          lifecycle,
        );
        assert.deepEqual(yield* sql`SELECT * FROM stave_lifecycle_cursor`, cursor);
        assert.deepEqual(
          yield* sql`SELECT * FROM projection_state WHERE projector = 'stave.project-lifecycle'`,
          projector,
        );
        assert.deepEqual(yield* sql`SELECT saga_teardown_json FROM stave_project_lifecycle`, [
          { saga_teardown_json: forkId >= 50 ? '{"journal":"keep"}' : null },
        ]);
        assert.deepEqual(
          yield* sql`SELECT forked_from_json, fork_source_json, active_order_key, created_at, updated_at FROM projection_threads`,
          [
            {
              forked_from_json: '{"threadId":"parent"}',
              fork_source_json: '{"providerTurnRef":"anchor"}',
              active_order_key: null,
              created_at: at,
              updated_at: at,
            },
          ],
        );
        assert.deepEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  }
});
