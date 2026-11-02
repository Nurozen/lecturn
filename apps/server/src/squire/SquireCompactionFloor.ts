/**
 * A5.12, D47: compaction deletes intermediate `thread.pull-request-link-updated`
 * events, the one Squire input it removes, and the reactor classifies each PR
 * transition from its own event. While a Squire could still consume them, the
 * events above the reactor cursor stay. With the switch off or no active
 * Squire nothing will read them (the next enabling start fast-forwards), so
 * compaction runs as it always has.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import * as SquireRepository from "./SquireRepository.ts";

const makeFloor = (switchOn: (cursor: SquireRepository.SquireReactorCursor) => boolean) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    return Effect.gen(function* () {
      const cursor = yield* repository.readCursor;
      if (!switchOn(cursor)) return Option.none<number>();
      const squires = yield* repository.listSquires;
      const anyActive = squires.some(
        (row) => row.status === "active" && row.lifecycle !== "deleting",
      );
      return anyActive ? Option.some(cursor.sequence) : Option.none<number>();
    });
  });

// The running server knows its own switch. The cursor's `enabled` is only
// written by a start's cursor sync, which is a sibling layer with no ordering
// against the first compaction and whose failure is logged, not fatal, so it
// can lag the config.
export const layer = Layer.effect(
  ProjectionMaintenance.CompactionFloor,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pullRequestLinkFloor = yield* makeFloor(() => config.squireEnabled);
    return ProjectionMaintenance.CompactionFloor.of({ pullRequestLinkFloor });
  }),
);

/**
 * For `lecturn doctor`, which runs with no server config: the cursor's
 * `enabled` is the switch as of the last server start, the one the next start
 * compares against before it would fast-forward. A database older than the
 * Squire migration has no cursor and no Squire to keep events for.
 */
export const layerOffline = Layer.effect(
  ProjectionMaintenance.CompactionFloor,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const floor = yield* makeFloor((cursor) => cursor.enabled);
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
