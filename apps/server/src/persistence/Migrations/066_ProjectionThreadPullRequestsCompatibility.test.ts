import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Upstream48 from "./048_ProjectionThreadBranchPullRequest.ts";
import Upstream49 from "./049_ProjectionThreadsActiveOrderKey.ts";
import Upstream50 from "./050_ProjectionThreadPullRequests.ts";

const at = "2026-01-01T00:00:00.000Z";
const linkedPullRequest =
  '{"projectId":"project","repository":"example/fixture","number":42,"url":"https://github.com/example/fixture/pull/42"}';

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_events
    (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
    VALUES (42, 'historical-delete', 'project', 'project', 1, 'project.deleted', ${at}, 'user', '{}', '{}')`;
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, linked_pull_request_json, created_at, updated_at)
    VALUES ('thread', 'project', 'Preserved', '{"instanceId":"codex","model":"fixture"}', ${linkedPullRequest}, ${at}, ${at})`;
});

const linkRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT thread_id, host, repository, number, source FROM projection_thread_pull_requests`;
});

describe("066 collision compatibility", () => {
  it.effect("creates the thread pull request table on a fresh database", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();
      assert.deepEqual(executed.at(-1), [67, "MessageContextTitleStateCompatibility"]);
      assert.deepEqual(yield* linkRows, []);
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("backfills legacy links when upgrading a published Lecturn database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* seed;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepEqual(yield* runMigrations(), [
        [66, "ProjectionThreadPullRequestsCompatibility"],
        [67, "MessageContextTitleStateCompatibility"],
      ]);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 65 ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* linkRows, [
        {
          thread_id: "thread",
          host: "github.com",
          repository: "example/fixture",
          number: 42,
          source: "manual",
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("adds Lecturn schema to an upstream 50 database without replaying its links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* seed;
      yield* Upstream48;
      yield* Upstream49;
      yield* Upstream50;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
        (48, 'ProjectionThreadBranchPullRequest'),
        (49, 'ProjectionThreadsActiveOrderKey'),
        (50, 'ProjectionThreadPullRequests')`;
      // The user unlinked the backfilled pull request after upgrading upstream.
      yield* sql`DELETE FROM projection_thread_pull_requests`;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const executed = yield* runMigrations();
      assert.deepEqual(executed[0], [51, "SagaWorkbench"]);
      assert.deepEqual(executed.at(-1), [67, "MessageContextTitleStateCompatibility"]);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 50 ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* linkRows, []);
      assert.deepEqual(
        yield* sql`SELECT title, forked_from_json, linked_pull_request_json FROM projection_threads`,
        [
          {
            title: "Preserved",
            forked_from_json: null,
            linked_pull_request_json: linkedPullRequest,
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
      assert.deepEqual(yield* sql`SELECT * FROM stave_lifecycle_policy`, []);
      const lifecycleColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(stave_project_lifecycle)`;
      assert.ok(lifecycleColumns.some((column) => column.name === "saga_teardown_json"));
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
