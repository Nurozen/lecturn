import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SquireCursorStartup from "./SquireCursorStartup.ts";
import * as SquireRepository from "./SquireRepository.ts";

const testLayer = Layer.mergeAll(SquireRepository.layer, OrchestrationEventStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "squire-cursor-" })),
  Layer.provide(NodeServices.layer),
);

const appendEvents = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let n = 0; n < count; n++) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        )
        SELECT 'event:' || next, 'thread', 'thread:cursor', next, 'thread.metadata-updated',
          '2026-11-01T00:00:00.000Z', 'server', '{}', '{}', 2
        FROM (SELECT COALESCE(MAX(stream_version), 0) + 1 AS next FROM orchestration_events)`;
    }
  });

const start = (squireEnabled: boolean) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    yield* SquireCursorStartup.syncCursorWithSwitch.pipe(
      Effect.provideService(ServerConfig.ServerConfig, { ...config, squireEnabled }),
    );
    return yield* (yield* SquireRepository.SquireRepository).readCursor;
  });

it.effect("a start that turns the switch on skips everything committed while it was off", () =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* appendEvents(3);
    assert.deepEqual(yield* start(false), { sequence: 0, enabled: false });

    assert.deepEqual(yield* start(true), { sequence: 3, enabled: true });

    // While on, the reactor owns the sequence: a restart leaves it alone.
    yield* repository.writeCursor({ sequence: 4, enabled: true });
    yield* appendEvents(3);
    assert.deepEqual(yield* start(true), { sequence: 4, enabled: true });

    // Off keeps the sequence; the next enabling start jumps past the off period.
    assert.deepEqual(yield* start(false), { sequence: 4, enabled: false });
    yield* appendEvents(2);
    assert.deepEqual(yield* start(true), { sequence: 8, enabled: true });
  }).pipe(Effect.provide(testLayer)),
);
