import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import UpstreamWebhookDedupe from "./Migrations/067_WebhookDedupe.ts";
import UpstreamShellStopRequestIndex from "./Migrations/068_ShellStopRequestIndex.ts";
import UpstreamThreadMessageSearch from "./Migrations/069_ThreadMessageSearch.ts";
import UpstreamPeerLinks from "./Migrations/070_PeerLinks.ts";
import UpstreamPeerLinkFence from "./Migrations/071_PeerLinkFence.ts";
import UpstreamWaitingLinkRequestIndex from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Squire from "./Migrations/082_Squire.ts";

// Lecturn's ledger runs upstream's V2 migrations (published from 55) from 70.
const FIRST_V2_ID = 70;
const LAST_PRE_V2_ID = FIRST_V2_ID - 1;
const v2Migrations = migrationManifest.filter(([id]) => id >= FIRST_V2_ID);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const squireTableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'squire%'
  `;
  return rows.length;
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

const insertSearchMessage = (messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      )
      VALUES (
        ${messageId}, 'thread-1', NULL, NULL, 'user', 0,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
        ${JSON.stringify({ text: "needle", createdBy: "user" })}
      )
    `;
  });

const searchedMessageIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly messageId: string }>`
    SELECT messages.message_id AS "messageId"
    FROM orchestration_v2_message_search AS search
    INNER JOIN orchestration_v2_projection_messages AS messages
      ON messages.rowid = search.rowid
    WHERE orchestration_v2_message_search MATCH '"needle"'
    ORDER BY messages.message_id
  `;
  return rows.map((row) => row.messageId);
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${FIRST_V2_ID}, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        `${FIRST_V2_ID}_OrchestrationV2 (recorded: FutureMainMigration)`,
      );
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      // 79 and 80 run on their own instead (Migrations.divergentLedger.test.ts).
      for (const [id, name] of v2Migrations.filter(([id]) => id < 79)) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly the last pre-V2 id", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, LAST_PRE_V2_ID])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: LAST_PRE_V2_ID });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: FIRST_V2_ID });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${FIRST_V2_ID + 1}, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: FIRST_V2_ID }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: FIRST_V2_ID + 1 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        `${FIRST_V2_ID + 1}_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)`,
      );
      assert.notInclude(String(exit), `${FIRST_V2_ID + 2}_ScheduledTaskWebhooks`);
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the failure lookup index a database created under upstream's id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      // Upstream published this index as migration 62.
      yield* sql`
        CREATE INDEX orchestration_v2_projection_turn_items_failed_error_idx
        ON orchestration_v2_projection_turn_items(
          thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC
        )
        WHERE type = 'error' AND status = 'failed'
      `;

      assert.deepStrictEqual(yield* runMigrations(), [
        [77, "ThreadFailureLookupIndex"],
        [78, "DropUnusedV1Projections"],
        [79, "AppRegistrations"],
        [80, "ProjectionProjectsAppBinding"],
        [81, "CanonicalizeThreadPullRequestLinks"],
        [82, "Squire"],
        [83, "CodexUsageNativeTurnIndex"],
        [84, "RepairClientSettlementTimestamps"],
        [85, "WebhookDedupe"],
        [86, "ShellStopRequestIndex"],
        [87, "ThreadMessageSearch"],
        [88, "PeerLinks"],
        [89, "PeerLinkFence"],
        [90, "WaitingLinkRequestIndex"],
        [91, "SquireChatFirst"],
      ]);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the webhook dedupe schema a database created under upstream's id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 84 });
      // Upstream published this schema as migration 67.
      yield* UpstreamWebhookDedupe;
      yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json,
        project_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Task', 'Prompt', 1, '{}', 'project-1', '{}', '{}', 'full-access',
        'default', 'user', 'user', 'now', 'now', 'idle', 0)`;
      yield* sql`INSERT INTO scheduled_task_webhook_pending
        (delivery_id, task_id, coalesce_key, due_at, task_json, request_json, delivery_ids_json)
        VALUES ('delivery-1', 'task-1', 'key', 1, '{}', '{}', '[]')`;

      assert.deepStrictEqual(yield* runMigrations(), [
        [85, "WebhookDedupe"],
        [86, "ShellStopRequestIndex"],
        [87, "ThreadMessageSearch"],
        [88, "PeerLinks"],
        [89, "PeerLinkFence"],
        [90, "WaitingLinkRequestIndex"],
        [91, "SquireChatFirst"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT delivery_id FROM scheduled_task_webhook_pending`, [
        { delivery_id: "delivery-1" },
      ]);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("builds message search from the history of a released database at 85", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      yield* insertSearchMessage("before-upgrade");

      assert.deepStrictEqual(yield* runMigrations(), [
        [86, "ShellStopRequestIndex"],
        [87, "ThreadMessageSearch"],
        [88, "PeerLinks"],
        [89, "PeerLinkFence"],
        [90, "WaitingLinkRequestIndex"],
        [91, "SquireChatFirst"],
      ]);
      yield* insertSearchMessage("after-upgrade");

      assert.deepStrictEqual(yield* searchedMessageIds, ["after-upgrade", "before-upgrade"]);
      assert.deepStrictEqual(
        yield* sql`
          SELECT name FROM sqlite_master
          WHERE name = 'orchestration_v2_projection_turn_items_stop_request_idx'
        `,
        [{ name: "orchestration_v2_projection_turn_items_stop_request_idx" }],
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the stop index and message search a database built under upstream's ids", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 85 });
      // Upstream published these as migrations 68 and 69.
      yield* UpstreamShellStopRequestIndex;
      yield* UpstreamThreadMessageSearch;
      yield* insertSearchMessage("under-upstream-id");

      assert.deepStrictEqual(yield* runMigrations(), [
        [86, "ShellStopRequestIndex"],
        [87, "ThreadMessageSearch"],
        [88, "PeerLinks"],
        [89, "PeerLinkFence"],
        [90, "WaitingLinkRequestIndex"],
        [91, "SquireChatFirst"],
      ]);

      assert.deepStrictEqual(yield* searchedMessageIds, ["under-upstream-id"]);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the peer link schema a database built under upstream's ids", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 87 });
      // Upstream published these as migrations 70 to 72.
      yield* UpstreamPeerLinks;
      yield* UpstreamPeerLinkFence;
      yield* UpstreamWaitingLinkRequestIndex;

      assert.deepStrictEqual(yield* runMigrations(), [
        [88, "PeerLinks"],
        [89, "PeerLinkFence"],
        [90, "WaitingLinkRequestIndex"],
        [91, "SquireChatFirst"],
      ]);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs the Squire migration again without touching its rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO squire_event (squire_id, kind, state_key, status, not_before, created_at)
        VALUES ('squire-1', 'message', 'key-1', 'pending', 'now', 'now')`;
      yield* sql`UPDATE squire_reactor_cursor SET sequence = 7, enabled = 1`;

      yield* Squire;

      assert.deepStrictEqual(yield* sql`SELECT state_key FROM squire_event`, [
        { state_key: "key-1" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT id, sequence, enabled FROM squire_reactor_cursor`, [
        { id: 1, sequence: 7, enabled: 1 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds the Squire schema when another build recorded a different migration at 82", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (82, 'UpstreamNext')`;

      assert.deepStrictEqual(yield* runMigrations(), [
        [83, "CodexUsageNativeTurnIndex"],
        [84, "RepairClientSettlementTimestamps"],
        [85, "WebhookDedupe"],
        [86, "ShellStopRequestIndex"],
        [87, "ThreadMessageSearch"],
        [88, "PeerLinks"],
        [89, "PeerLinkFence"],
        [90, "WaitingLinkRequestIndex"],
        [91, "SquireChatFirst"],
        [82, "Squire"],
      ]);
      assert.equal(yield* squireTableCount, 13);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 82`,
        [{ name: "UpstreamNext" }],
      );
      // Every later start repairs again, which the idempotent SQL makes a no-op.
      assert.deepStrictEqual(yield* runMigrations(), [[82, "Squire"]]);
      assert.equal(yield* squireTableCount, 13);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
