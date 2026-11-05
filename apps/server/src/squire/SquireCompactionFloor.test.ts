import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SquireId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LayerSquire from "./layerSquire.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireSwitch from "./SquireSwitch.ts";
import { squireRow } from "./testkit/scopeHarness.ts";

const storageLayer = (squireEnabled: boolean) =>
  Layer.mergeAll(LayerSquire.layerDatabaseStorage, SquireRepository.layer).pipe(
    Layer.provide(OrchestrationEventStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(SquireSwitch.layerTest(squireEnabled)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "squire-floor-" })),
    Layer.provide(NodeServices.layer),
  );

/**
 * Thread A: five snapshots of one PR link. Thread B: three snapshots, then a
 * whole-thread event that would supersede them all.
 */
const seedHistory = Effect.gen(function* () {
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
});

const compactAndList = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  yield* maintenance.compactEventStore;
  const rows = yield* sql<{ readonly event_id: string }>`
    SELECT event_id FROM orchestration_events ORDER BY sequence ASC`;
  return rows.map((row) => row.event_id);
});

const squireId = SquireId.make("squire:release");

const withSquire = (overrides: Partial<SquireRepository.SquireRow>) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.createSquire(squireRow(squireId, overrides));
    // a1 and a2 consumed.
    yield* repository.writeCursor({ sequence: 2, enabled: true });
  });

const compactedAsToday = ["a1", "a5", "b-meta"];

describe("SquireCompactionFloor", () => {
  it.effect("keeps PR link events above the cursor while an active Squire may read them", () =>
    Effect.gen(function* () {
      yield* seedHistory;
      yield* withSquire({});
      assert.deepEqual(yield* compactAndList, ["a1", "a3", "a4", "a5", "b1", "b2", "b3", "b-meta"]);
    }).pipe(Effect.provide(storageLayer(true))),
  );

  it.effect("compacts as today with the switch off", () =>
    Effect.gen(function* () {
      yield* seedHistory;
      yield* withSquire({});
      assert.deepEqual(yield* compactAndList, compactedAsToday);
    }).pipe(Effect.provide(storageLayer(false))),
  );

  it.effect.each([
    { label: "no Squire", overrides: null },
    { label: "only a paused Squire", overrides: { status: "paused" } },
    { label: "only a Squire being deleted", overrides: { lifecycle: "deleting" } },
  ] as const)("compacts as today with $label", ({ overrides }) =>
    Effect.gen(function* () {
      yield* seedHistory;
      if (overrides !== null) yield* withSquire(overrides);
      assert.deepEqual(yield* compactAndList, compactedAsToday);
    }).pipe(Effect.provide(storageLayer(true))),
  );
});
