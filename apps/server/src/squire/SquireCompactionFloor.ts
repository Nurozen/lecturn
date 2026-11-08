/**
 * Compaction deletes intermediate `thread.pull-request-link-updated` events, which the reactor classifies one by one,
 * so while a Squire could consume them the events above the reactor cursor stay. With the switch off or no active
 * Squire nothing reads them (the next on period fast-forwards), so compaction runs as usual.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireSwitch from "./SquireSwitch.ts";

const makeFloor = Effect.fn("SquireCompactionFloor.makeFloor")(function* (
  switchOn: (cursor: SquireRepository.SquireReactorCursor) => Effect.Effect<boolean>,
) {
  const repository = yield* SquireRepository.SquireRepository;
  return Effect.gen(function* () {
    const cursor = yield* repository.readCursor;
    if (!(yield* switchOn(cursor))) return Option.none<number>();
    const squires = yield* repository.listSquires;
    const anyActive = squires.some(
      (row) => row.status === "active" && row.lifecycle !== "deleting",
    );
    return anyActive ? Option.some(cursor.sequence) : Option.none<number>();
  });
});

// The running server reads its live switch. The cursor's `enabled` is only
// written by an on or off period's cursor sync, which runs in the background
// and logs its failures, so it can lag the switch.
export const layer = Layer.effect(
  ProjectionMaintenance.CompactionFloor,
  Effect.gen(function* () {
    const squireSwitch = yield* SquireSwitch.SquireSwitch;
    const pullRequestLinkFloor = yield* makeFloor(() => squireSwitch.isOn);
    return ProjectionMaintenance.CompactionFloor.of({ pullRequestLinkFloor });
  }),
);

/**
 * For `lecturn doctor`, which runs with no server config: the cursor's
 * `enabled` is the switch as the server last applied it, the one the next on
 * period compares against before it would fast-forward. A database older than the
 * Squire migration has no cursor and no Squire to keep events for.
 */
export const layerOffline = Layer.effect(
  ProjectionMaintenance.CompactionFloor,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const floor = yield* makeFloor((cursor) => Effect.succeed(cursor.enabled));
    const squireTablesExist = sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('squire', 'squire_reactor_cursor')`.pipe(
      Effect.map((rows) => rows.length === 2),
      Effect.mapError(toPersistenceSqlError("SquireCompactionFloor.squireTablesExist")),
    );
    const pullRequestLinkFloor = Effect.gen(function* () {
      if (!(yield* squireTablesExist)) return Option.none<number>();
      return yield* floor;
    });
    return ProjectionMaintenance.CompactionFloor.of({ pullRequestLinkFloor });
  }),
).pipe(Layer.provide(SquireRepository.layer));
