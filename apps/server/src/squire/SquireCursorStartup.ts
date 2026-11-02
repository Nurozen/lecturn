/**
 * The reactor cursor records whether the switch was on at the last
 * start. A start that turns it on moves the cursor to the log head first, so
 * nothing committed while every Squire was paused is delivered. Always on:
 * a switch-off start is what marks the next enabling start as a turn-on.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SquireRepository from "./SquireRepository.ts";

/**
 * Whether this start jumped the cursor. The jump skips the off period's
 * project and thread deletes too, so the reactor then applies their
 * cascades from current state.
 */
export class SquireSwitchTurnedOn extends Context.Service<
  SquireSwitchTurnedOn,
  { readonly turnedOn: boolean }
>()("lecturn/squire/SquireCursorStartup/SquireSwitchTurnedOn") {}

/** True when the cursor jumped to the log head. */
export const syncCursorWithSwitch = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const repository = yield* SquireRepository.SquireRepository;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const cursor = yield* repository.readCursor;
  if (!config.squireEnabled) {
    if (cursor.enabled)
      yield* repository.writeCursor({ sequence: cursor.sequence, enabled: false });
    return false;
  }
  if (cursor.enabled) return false;
  // The reactor cursor shares the application event sequence space.
  const head = yield* events.latestApplicationSequence;
  yield* repository.writeCursor({ sequence: Math.max(head, cursor.sequence), enabled: true });
  return true;
}).pipe(Effect.withSpan("SquireCursorStartup.syncCursorWithSwitch"));

// Squire bookkeeping must not keep the server from starting. A cursor left
// disabled is fast-forwarded by the next start that writes it.
export const layer = Layer.effect(
  SquireSwitchTurnedOn,
  syncCursorWithSwitch.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Squire cursor startup write failed", { cause }).pipe(Effect.as(false)),
    ),
    Effect.map((turnedOn) => SquireSwitchTurnedOn.of({ turnedOn })),
  ),
);
