// @effect-diagnostics preferSchemaOverJson:off - seeds raw V1 projection rows
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@lecturn/contracts";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import BranchPullRequest from "../../persistence/Migrations/048_ProjectionThreadBranchPullRequest.ts";
import ActiveOrderKey from "../../persistence/Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import ThreadPullRequests from "../../persistence/Migrations/050_ProjectionThreadPullRequests.ts";
import MessageContext from "../../persistence/Migrations/051_ProjectionThreadMessageContext.ts";
import TitleState from "../../persistence/Migrations/052_ProjectionThreadTitleState.ts";
import PullRequestFilesViewed from "../../persistence/Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "../../persistence/Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import { initializeV2Database } from "../../persistence/initializeV2Database.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

// Synthetic Lecturn databases only; never point this at live data.
const PROJECT_ID = "project:fork-ledger";
const ROOT_THREAD = "thread:fork-ledger:imported";
const CHILD_THREAD = "thread:fork-ledger:child";
const GRANDCHILD_THREAD = "thread:fork-ledger:grandchild";
const NOTED_MESSAGE = "message:fork-ledger:child:4";

const importedFrom = {
  providerInstanceId: "claudeAgent",
  driverKind: "claudeAgent",
  sessionId: "external-session-1",
  cwd: "/tmp/fork-ledger",
  title: "External session",
  importedAt: "2026-03-01T00:00:00.000Z",
  historyTruncated: false,
};
const importSource = {
  providerInstanceId: "claudeAgent",
  resumeCursor: { resume: "forked-external-session-1" },
};
const forkSource = {
  providerInstanceId: "claudeAgent",
  resumeCursor: { resume: "forked-child-session" },
  providerTurnRef: "provider-turn-ref-1",
  throughTurnOrdinal: 1,
  atEnd: true,
};

// Lecturn installations that once recorded upstream's 48-54 names before the
// fork ledger diverged; compatibility migrations 64-69 reconcile their schema.
const upstreamNamed48To54 = {
  "48_ProjectionThreadBranchPullRequest": BranchPullRequest,
  "49_ProjectionThreadsActiveOrderKey": ActiveOrderKey,
  "50_ProjectionThreadPullRequests": ThreadPullRequests,
  "51_ProjectionThreadMessageContext": MessageContext,
  "52_ProjectionThreadTitleState": TitleState,
  "53_PullRequestFilesViewed": PullRequestFilesViewed,
  "54_ProjectionThreadsAutoSettleDisabledAt": AutoSettleDisabledAt,
};

type LedgerVariant = "fork names" | "upstream names at 48-54";

const insertThread = (input: {
  readonly threadId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly forkedFrom: unknown;
  readonly forkSource: unknown;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, forked_from_json, fork_source_json, imported_from_json,
        import_source_json
      ) VALUES (
        ${input.threadId}, ${PROJECT_ID}, ${input.title},
        '{"instanceId":"claudeAgent","model":"claude-opus-4-6"}', 'full-access', 'default',
        ${input.createdAt}, ${input.createdAt},
        ${input.forkedFrom === null ? null : JSON.stringify(input.forkedFrom)},
        ${input.forkSource === null ? null : JSON.stringify(input.forkSource)},
        ${JSON.stringify(importedFrom)},
        ${input.threadId === ROOT_THREAD ? JSON.stringify(importSource) : null}
      )
    `;
  });

const insertMessages = (threadId: string, prefix: string, count: number, day: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let index = 1; index <= count; index++) {
      const at = `2026-03-0${day}T00:0${index}:00.000Z`;
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`${prefix}:${index}`}, ${threadId}, ${index % 2 === 1 ? "user" : "assistant"},
          ${`${threadId} message ${index}`}, 0, ${at}, ${at})
      `;
    }
  });

/** A V1 Lecturn database at fork migration 069 with fork-only columns and tables in use. */
const seedForkLedgerAt69 = (variant: LedgerVariant) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (variant === "fork names") {
      yield* runMigrations({ toMigrationInclusive: 69 });
    } else {
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* Migrator.make({})({ loader: Migrator.fromRecord(upstreamNamed48To54) });
      yield* runMigrations({ toMigrationInclusive: 69 });
    }
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${PROJECT_ID}, 'Fork ledger', '/tmp/fork-ledger', '[]',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')
    `;
    yield* insertThread({
      threadId: ROOT_THREAD,
      title: "Imported session",
      createdAt: "2026-03-01T00:00:00.000Z",
      forkedFrom: null,
      forkSource: null,
    });
    yield* insertThread({
      threadId: CHILD_THREAD,
      title: "Forked child",
      createdAt: "2026-03-02T00:00:00.000Z",
      forkedFrom: {
        threadId: ROOT_THREAD,
        turnId: "turn:fork-ledger:root:1",
        turnCount: 1,
        messageId: "message:fork-ledger:root:2",
      },
      forkSource,
    });
    yield* insertThread({
      threadId: GRANDCHILD_THREAD,
      title: "Forked grandchild",
      createdAt: "2026-03-03T00:00:00.000Z",
      forkedFrom: {
        threadId: CHILD_THREAD,
        turnId: "turn:fork-ledger:child:2",
        turnCount: 2,
        messageId: null,
      },
      forkSource: null,
    });
    yield* insertMessages(ROOT_THREAD, "message:fork-ledger:root", 2, 1);
    // V1 forks materialize the parent's history under fresh message ids.
    yield* insertMessages(CHILD_THREAD, "message:fork-ledger:child", 4, 2);
    yield* insertMessages(GRANDCHILD_THREAD, "message:fork-ledger:grandchild", 2, 3);
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, state, requested_at, checkpoint_files_json, provider_turn_ref
      ) VALUES (
        ${CHILD_THREAD}, 'turn:fork-ledger:child:2', 'completed', '2026-03-02T00:04:00.000Z', '[]',
        'provider-turn-ref-2'
      )
    `;
    yield* sql`
      INSERT INTO thread_notes (
        id, project_id, thread_id, message_id, message_role, quote_text, comment, anchor_json,
        created_at, updated_at
      ) VALUES (
        'note:fork-ledger', ${PROJECT_ID}, ${CHILD_THREAD}, ${NOTED_MESSAGE}, 'assistant',
        'message 4', 'Keep this', '{"start":0,"end":9}',
        '2026-03-02T01:00:00.000Z', '2026-03-02T01:00:00.000Z'
      )
    `;
  });

const ledgerFrom = (fromId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations
      WHERE migration_id >= ${fromId}
      ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });

const v2Layer = (dbPath: string) => {
  const database = SqlitePersistence.layerFromPath(dbPath);
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(database),
  );
  const sink = EventSink.layer.pipe(Layer.provide(stores));
  return LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(Layer.mergeAll(stores, sink)));
};

describe("Lecturn fork ledger upgrade to orchestration V2", () => {
  it.effect.each(["fork names", "upstream names at 48-54"] as const)(
    "migrates a %s ledger at 069 to 078 and imports fork lineage",
    (variant) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-fork-ledger-" });
        const sourcePath = path.join(directory, "state.sqlite");
        const destinationPath = path.join(directory, "statev2.sqlite");

        yield* seedForkLedgerAt69(variant).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })),
        );
        yield* initializeV2Database(destinationPath);

        const messages: Array<string> = [];
        const logger = Logger.make(({ message }) => {
          messages.push(String(message));
        });

        const result = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const tables = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
          `;
          const v1Tables = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN ('projection_threads', 'projection_turns')
          `;
          yield* importer.reconcileShells;
          yield* importer.ensureTranscript(ThreadId.make(CHILD_THREAD));
          const root = yield* projections.getThreadProjection(ThreadId.make(ROOT_THREAD));
          const child = yield* projections.getThreadProjection(ThreadId.make(CHILD_THREAD));
          const grandchild = yield* projections.getThreadProjection(
            ThreadId.make(GRANDCHILD_THREAD),
          );
          const notes = yield* sql<{ readonly thread_id: string; readonly message_id: string }>`
            SELECT thread_id, message_id FROM thread_notes
          `;
          return {
            ledger: yield* ledgerFrom(64),
            tableNames: new Set(tables.map((table) => table.name)),
            v1TableNames: v1Tables.map((table) => table.name),
            root,
            child,
            grandchild,
            notes,
          };
        }).pipe(
          Effect.provide(v2Layer(destinationPath)),
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );

        assert.deepStrictEqual(result.ledger, [
          [64, "ProjectionThreadMigrationCompatibility"],
          [65, "ProjectionThreadsActiveOrderCompatibility"],
          [66, "ProjectionThreadPullRequestsCompatibility"],
          [67, "MessageContextTitleStateCompatibility"],
          [68, "PullRequestFilesViewedCompatibility"],
          [69, "ProjectionThreadsAutoSettleDisabledAtCompatibility"],
          [70, "OrchestrationV2"],
          [71, "RemoveRedundantProjectionIndexes"],
          [72, "ScheduledTaskWebhooks"],
          [73, "WebhookRelayDeliveries"],
          [74, "McpAppModelContext"],
          [75, "ThreadSnapshotWindowIndexes"],
          [76, "PullRequestReviewGuides"],
          [77, "ThreadFailureLookupIndex"],
          [78, "DropUnusedV1Projections"],
        ]);
        for (const table of [
          "orchestration_v2_events",
          "orchestration_v2_projection_threads",
          "orchestration_v2_projection_runs",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_turn_item_positions",
        ]) {
          assert.isTrue(result.tableNames.has(table), table);
        }
        assert.isFalse(
          messages.some((message) => message.includes("migration history diverges")),
          messages.join("\n"),
        );
        // V1 turns are dropped; the import still reads the V1 threads it carries lineage on.
        assert.deepStrictEqual(result.v1TableNames, ["projection_threads"]);

        assert.deepStrictEqual(result.root.thread.lineage, {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make(ROOT_THREAD),
        });
        assert.deepStrictEqual(result.child.thread.lineage, {
          parentThreadId: ThreadId.make(ROOT_THREAD),
          relationshipToParent: "fork",
          rootThreadId: ThreadId.make(ROOT_THREAD),
        });
        assert.deepStrictEqual(result.grandchild.thread.lineage, {
          parentThreadId: ThreadId.make(CHILD_THREAD),
          relationshipToParent: "fork",
          rootThreadId: ThreadId.make(ROOT_THREAD),
        });
        // History was materialized into each V1 fork, so V2 must not inherit it again.
        assert.isNull(result.child.thread.forkedFrom);
        assert.isNull(result.grandchild.thread.forkedFrom);
        assert.isNull(result.root.thread.forkOrigin);
        assert.deepStrictEqual(result.child.thread.forkOrigin, {
          threadId: ThreadId.make(ROOT_THREAD),
          messageId: MessageId.make("message:fork-ledger:root:2"),
        });
        assert.deepStrictEqual(result.grandchild.thread.forkOrigin, {
          threadId: ThreadId.make(CHILD_THREAD),
          messageId: null,
        });
        for (const projection of [result.root, result.child, result.grandchild]) {
          assert.deepStrictEqual(projection.thread.importedFrom, importedFrom);
        }

        // Message ids survive, so thread note anchors still resolve.
        assert.deepStrictEqual(
          result.child.messages.map((message) => message.id),
          [1, 2, 3, 4].map((index) => `message:fork-ledger:child:${index}`),
        );
        assert.deepStrictEqual(result.notes, [
          { thread_id: CHILD_THREAD, message_id: NOTED_MESSAGE },
        ]);
        assert.isTrue(
          result.child.messages.some(
            (message) =>
              message.id === NOTED_MESSAGE && message.threadId === ThreadId.make(CHILD_THREAD),
          ),
        );

        // The V1 database stays at its own ledger.
        const sourceLedger = yield* ledgerFrom(69).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })),
        );
        assert.deepStrictEqual(sourceLedger, [
          [69, "ProjectionThreadsAutoSettleDisabledAtCompatibility"],
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
