/**
 * Stops headless tool processes that have sat idle. There is no
 * "provider session released" signal, so the existing onRunTerminal hook arms
 * a watch for the run's app project; the watch closes each of the project's
 * processes once no run is active there and the last call ended long enough
 * ago. A run that starts meanwhile ends the watch, and its own end re-arms it.
 */
import type { ProjectId } from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Ref from "effect/Ref";

import { AppRuntimeState, type HeadlessProcessKey } from "./AppRuntimeState.ts";

const HEADLESS_IDLE_TIMEOUT = Duration.seconds(60);

export interface HeadlessReaper {
  readonly onProjectRunEnded: (projectId: ProjectId) => Effect.Effect<void>;
  /** Resolves once every armed watch has finished; for tests. */
  readonly awaitIdle: Effect.Effect<void>;
}

export const makeHeadlessReaper = Effect.fn("headlessReaper.make")(function* (
  isProjectBusy: (projectId: ProjectId) => Effect.Effect<boolean>,
) {
  const { headlessProcesses } = yield* AppRuntimeState;
  const watches = yield* FiberMap.make<HeadlessProcessKey, void, never>();

  const watch = (key: HeadlessProcessKey) =>
    Effect.gen(function* () {
      const armedAt = yield* DateTime.now;
      while (true) {
        const entry = (yield* Ref.get(headlessProcesses)).get(key);
        if (entry === undefined || (yield* isProjectBusy(entry.projectId))) return;
        if (entry.inFlightCalls > 0) {
          // A call outside any run (an MCP App card) ends without a run
          // terminal, so the watch outlives it instead of waiting for one.
          yield* Effect.sleep(HEADLESS_IDLE_TIMEOUT);
          continue;
        }
        const idleFor = DateTime.distance(entry.lastCallEndedAt ?? armedAt, yield* DateTime.now);
        const remaining = Duration.subtract(HEADLESS_IDLE_TIMEOUT, idleFor);
        if (Duration.toMillis(remaining) <= 0) return yield* entry.close;
        yield* Effect.sleep(remaining);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Headless tool process idle check failed", { key, cause }),
      ),
    );

  const onProjectRunEnded = (projectId: ProjectId) =>
    Ref.get(headlessProcesses).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          [...entries].filter(([, entry]) => entry.projectId === projectId),
          ([key]) => FiberMap.run(watches, key, watch(key), { onlyIfMissing: true }),
          { discard: true },
        ),
      ),
    );

  return {
    onProjectRunEnded,
    awaitIdle: FiberMap.awaitEmpty(watches),
  } satisfies HeadlessReaper;
});
