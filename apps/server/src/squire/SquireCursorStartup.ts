/**
 * The reactor cursor records whether the switch was on when it was last
 * applied. An on period that turns it on moves the cursor to the log head
 * first, so nothing committed while every Squire was paused is delivered. An
 * off period writes `enabled: false` only after the reactor stopped, since the
 * reactor rewrites the flag it read at its start.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireSwitch from "./SquireSwitch.ts";

/**
 * True when the cursor jumped to the log head. The jump skips the off
 * period's project and thread deletes too, so the reactor then applies their
 * cascades from current state.
 */
export const syncCursorWithSwitch = Effect.fn("SquireCursorStartup.syncCursorWithSwitch")(
  function* (on: boolean) {
    const repository = yield* SquireRepository.SquireRepository;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const cursor = yield* repository.readCursor;
    if (!on) {
      if (cursor.enabled)
        yield* repository.writeCursor({ sequence: cursor.sequence, enabled: false });
      return false;
    }
    if (cursor.enabled) return false;
    // The reactor cursor shares the application event sequence space.
    const head = yield* events.latestApplicationSequence;
    yield* repository.writeCursor({ sequence: Math.max(head, cursor.sequence), enabled: true });
    return true;
  },
);

/**
 * The sync the server start made, before anything else could commit an event
 * a turn-on jump would skip. The first on period uses it instead of syncing
 * again, which would lose `turnedOn`.
 */
export class SquireCursorAtStart extends Context.Service<
  SquireCursorAtStart,
  { readonly on: boolean; readonly turnedOn: boolean }
>()("lecturn/squire/SquireCursorStartup/SquireCursorAtStart") {}

// Squire bookkeeping must not keep the server from starting. A cursor left
// disabled is fast-forwarded by the next on period that writes it.
export const layer = Layer.effect(
  SquireCursorAtStart,
  Effect.gen(function* () {
    const on = yield* (yield* SquireSwitch.SquireSwitch).isOn;
    const turnedOn = yield* syncCursorWithSwitch(on).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Squire cursor startup write failed", { cause }).pipe(Effect.as(false)),
      ),
    );
    return SquireCursorAtStart.of({ on, turnedOn });
  }),
);
