import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Upstream48 from "./048_ProjectionThreadBranchPullRequest.ts";
import Upstream49 from "./049_ProjectionThreadsActiveOrderKey.ts";
import Upstream50 from "./050_ProjectionThreadPullRequests.ts";
import Upstream51 from "./051_ProjectionThreadMessageContext.ts";
import Upstream52 from "./052_ProjectionThreadTitleState.ts";
import Upstream53 from "./053_PullRequestFilesViewed.ts";
import Upstream54 from "./054_ProjectionThreadsAutoSettleDisabledAt.ts";

const at = "2026-01-01T00:00:00.000Z";
const latest = [69, "ProjectionThreadsAutoSettleDisabledAtCompatibility"] as const;

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

const autoSettleRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT thread_id, auto_settle_disabled_at FROM projection_threads ORDER BY thread_id`;
});

const assertReconciled = Effect.gen(function* () {
  const threadColumns = yield* columnNames("projection_threads");
  assert.include(threadColumns, "auto_settle_disabled_at");
  assert.include(threadColumns, "forked_from_json");
  assert.include(threadColumns, "imported_from_json");
  assert.include(threadColumns, "title_state_json");
  assert.includeMembers(yield* columnNames("thread_notes"), [
    "id",
    "project_id",
    "thread_id",
    "message_id",
    "anchor_json",
  ]);
  assert.include(yield* columnNames("pull_request_files_viewed"), "revision");
  assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 69 }), []);
});

describe("069 collision compatibility", () => {
  it.effect("adds the auto-settle column on a fresh database", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations({ toMigrationInclusive: 69 });
      assert.deepEqual(executed.at(-1), latest);
      assert.deepEqual(
        executed.find(([id]) => id === 54),
        [54, "ThreadNotes"],
      );
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds the auto-settle column to a published Lecturn database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, created_at, updated_at)
        VALUES ('thread', 'project', 'Preserved', '{"instanceId":"codex","model":"fixture"}', ${at}, ${at})`;
      yield* sql`INSERT INTO thread_notes
        (id, project_id, thread_id, message_id, message_role, quote_text, anchor_json, created_at, updated_at)
        VALUES ('note', 'project', 'thread', 'message', 'user', 'quote', '{}', ${at}, ${at})`;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 69 }), [latest]);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 68 ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* autoSettleRows, [
        { thread_id: "thread", auto_settle_disabled_at: null },
      ]);
      assert.deepEqual(yield* sql`SELECT id, quote_text FROM thread_notes`, [
        { id: "note", quote_text: "quote" },
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds Lecturn schema to an upstream 54 database and keeps auto-settle state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* Upstream48;
      yield* Upstream49;
      yield* Upstream50;
      yield* Upstream51;
      yield* Upstream52;
      yield* Upstream53;
      yield* Upstream54;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
        (48, 'ProjectionThreadBranchPullRequest'),
        (49, 'ProjectionThreadsActiveOrderKey'),
        (50, 'ProjectionThreadPullRequests'),
        (51, 'ProjectionThreadMessageContext'),
        (52, 'ProjectionThreadTitleState'),
        (53, 'PullRequestFilesViewed'),
        (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, auto_settle_disabled_at, created_at, updated_at)
        VALUES ('thread', 'project', 'Preserved', '{"instanceId":"codex","model":"fixture"}', ${at}, ${at}, ${at})`;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const executed = yield* runMigrations({ toMigrationInclusive: 69 });
      assert.deepEqual(executed[0], [55, "ThreadDecisions"]);
      assert.deepEqual(executed.at(-1), latest);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 54 ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* autoSettleRows, [
        { thread_id: "thread", auto_settle_disabled_at: at },
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
