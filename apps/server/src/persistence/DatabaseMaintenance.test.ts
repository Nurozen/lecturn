import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SquireId } from "@lecturn/contracts";
import * as NodeSqliteClient from "@lecturn/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SquireRepository from "../squire/SquireRepository.ts";
import { squireRow } from "../squire/testkit/scopeHarness.ts";

type SquireState = {
  readonly squire: Partial<SquireRepository.SquireRow> | null;
  readonly cursorEnabled: boolean;
  readonly squireTables: boolean;
};

/**
 * A migrated database stopped with the Squire reactor cursor at sequence 2.
 * Thread A: five snapshots of one PR link. Thread B: three snapshots, then a
 * whole-thread event that would supersede them all.
 */
const seedSquireDatabase = (dbPath: string, state: SquireState) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const link = (thread: string, id: string, version: number) => sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${id}, 'thread', ${thread}, ${version}, 'thread.pull-request-link-updated',
        '2026-11-01T00:00:00.000Z', 'server',
        '{"host":"github.com","repository":"owner/repo","number":7}', '{}', 2
      )`;
    for (const n of [1, 2, 3, 4, 5]) yield* link("thread:a", `a${n}`, n);
    for (const n of [1, 2, 3]) yield* link("thread:b", `b${n}`, n);
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'b-meta', 'thread', 'thread:b', 4, 'thread.metadata-updated',
        '2026-11-01T00:00:00.000Z', 'server', '{}', '{}', 2
      )`;
    // These threads have no `thread.created`, so up-to-date projections are
    // just the metadata row.
    const throughSequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
    yield* sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      ) VALUES (
        'thread-projections', ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
        ${throughSequence}, '2026-11-01T00:00:00.000Z'
      )
      ON CONFLICT(projection_name) DO UPDATE SET
        schema_version = excluded.schema_version, last_sequence = excluded.last_sequence`;
    const repository = yield* SquireRepository.SquireRepository;
    if (state.squire !== null) {
      yield* repository.createSquire(squireRow(SquireId.make("squire:release"), state.squire));
    }
    yield* repository.writeCursor({ sequence: 2, enabled: state.cursorEnabled });
    if (!state.squireTables) {
      yield* sql`DROP TABLE squire`;
      yield* sql`DROP TABLE squire_reactor_cursor`;
    }
  }).pipe(
    Effect.provide(
      Layer.merge(EventStore.layer, SquireRepository.layer).pipe(
        Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
      ),
    ),
  );

const listEventIds = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly event_id: string }>`
      SELECT event_id FROM orchestration_events ORDER BY sequence ASC`;
    return rows.map((row) => row.event_id);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));

const compactedAsBefore = ["a1", "a5", "b-meta"];

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "DatabaseMaintenance",
  (it) => {
    it.effect("reports an unreadable database as an inspection failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-inspect-" }),
          "statev2.sqlite",
        );
        yield* fs.writeFileString(dbPath, "not a database");
        const failure = yield* Effect.flip(maintenance.inspect(dbPath));
        assert.equal(failure._tag, "DatabaseInspectError");
      }).pipe(Effect.scoped),
    );

    it.effect("reports and deletes only the V1 database", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-legacy-" });
        const dbPath = path.join(userdata, "statev2.sqlite");
        const legacy = path.join(userdata, "state.sqlite");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);

        const openLegacy = NodeSqliteClient.layer({ filename: legacy });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`CREATE TABLE v1_data (value TEXT)`;
        }).pipe(Effect.provide(openLegacy));
        assert.isAbove((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes ?? 0, 0);

        // Lecturn V1 still running against it keeps it.
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM v1_data`;
          return yield* Effect.flip(maintenance.removeLegacyDatabase(dbPath));
        }).pipe(Effect.provide(openLegacy));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.isTrue(yield* fs.exists(legacy));

        yield* maintenance.removeLegacyDatabase(dbPath);
        assert.isFalse(yield* fs.exists(legacy));
        assert.isFalse(yield* fs.exists(`${legacy}-wal`));
        assert.isTrue(yield* fs.exists(dbPath));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);
      }).pipe(Effect.scoped),
    );

    it.effect("compacts an existing database offline only once its server has stopped", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-compact-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        // A migrated database created before incremental auto_vacuum, with free pages.
        yield* Effect.flatMap(
          ProjectionMaintenance.ProjectionMaintenanceV2,
          (projections) => projections.rebuild,
        ).pipe(
          Effect.provide(
            ProjectionMaintenance.layer.pipe(
              Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
          yield* sql`CREATE TABLE discarded_data (value BLOB)`;
          yield* sql`INSERT INTO discarded_data VALUES (zeroblob(4194304))`;
          yield* sql`DROP TABLE discarded_data`;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        // A server that merely has the database open, like an idle one, is enough to refuse.
        const sizeBefore = (yield* fs.stat(dbPath)).size;
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM retained_data`;
          return yield* maintenance.compact(dbPath).pipe(Effect.flip);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

        const result = yield* maintenance.compact(dbPath);
        // The 4 MiB of free pages are returned to the filesystem.
        assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
      }).pipe(Effect.scoped),
    );

    it.effect(
      "keeps PR link events above the cursor of an active Squire's last enabled start",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
          const dbPath = path.join(
            yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-squire-floor-" }),
            "statev2.sqlite",
          );
          yield* seedSquireDatabase(dbPath, {
            squire: {},
            cursorEnabled: true,
            squireTables: true,
          });
          yield* maintenance.compact(dbPath);
          // a2 is at the cursor, so already consumed.
          assert.deepEqual(yield* listEventIds(dbPath), [
            "a1",
            "a3",
            "a4",
            "a5",
            "b1",
            "b2",
            "b3",
            "b-meta",
          ]);
        }).pipe(Effect.scoped),
    );

    it.effect.each([
      {
        label: "the switch off at the last start",
        squire: {},
        cursorEnabled: false,
        squireTables: true,
      },
      { label: "no Squire", squire: null, cursorEnabled: true, squireTables: true },
      {
        label: "only a paused Squire",
        squire: { status: "paused" },
        cursorEnabled: true,
        squireTables: true,
      },
      { label: "no Squire tables", squire: {}, cursorEnabled: true, squireTables: false },
    ] as const)("compacts PR link events as before with $label", (state) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-squire-floor-" }),
          "statev2.sqlite",
        );
        yield* seedSquireDatabase(dbPath, state);
        yield* maintenance.compact(dbPath);
        assert.deepEqual(yield* listEventIds(dbPath), compactedAsBefore);
      }).pipe(Effect.scoped),
    );
  },
);
