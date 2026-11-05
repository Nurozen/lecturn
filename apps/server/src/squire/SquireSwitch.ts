/**
 * The Squires switch. `LECTURN_SQUIRE` pins it for the process; otherwise it
 * follows the saved `squire.enabled` setting live. Squire services are built
 * either way: gates read `isOn` per call, and Squire background work runs only
 * during an on period (`startLecturnReactors` in serverRuntimeStartup.ts).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

export class SquireSwitch extends Context.Service<
  SquireSwitch,
  {
    /** The switch as last applied. */
    readonly isOn: Effect.Effect<boolean>;
    /** The current value, then each change. */
    readonly changes: Stream.Stream<boolean>;
    /** `LECTURN_SQUIRE` is set, so the saved setting is ignored. */
    readonly pinned: boolean;
    /**
     * `isOn`, re-reading the saved setting while the switch reads off. The
     * settings stream applies a write asynchronously, so a request a client
     * sends right after turning Squires on reads its own write here rather
     * than a refusal.
     */
    readonly refresh: Effect.Effect<boolean>;
    /** Runs `effect` through each on period; turning off interrupts it. */
    readonly whileOn: <R>(effect: Effect.Effect<void, never, R>) => Effect.Effect<void, never, R>;
  }
>()("lecturn/squire/SquireSwitch") {}

const fromRef = (
  ref: SubscriptionRef.SubscriptionRef<boolean>,
  pinned: boolean,
  readSaved: Effect.Effect<boolean>,
) => {
  const isOn = SubscriptionRef.get(ref);
  const changes = SubscriptionRef.changes(ref).pipe(Stream.changes);
  return SquireSwitch.of({
    isOn,
    changes,
    pinned,
    refresh: Effect.gen(function* () {
      if (pinned || (yield* isOn)) return yield* isOn;
      const saved = yield* readSaved;
      if (saved) yield* SubscriptionRef.set(ref, true);
      return saved;
    }),
    whileOn: (effect) =>
      changes.pipe(
        Stream.switchMap((on) => (on ? Stream.fromEffect(effect) : Stream.empty)),
        Stream.runDrain,
      ),
  });
};

const make = Effect.gen(function* () {
  const { squireEnabledOverride } = yield* ServerConfig.ServerConfig;
  if (squireEnabledOverride !== undefined) {
    const ref = yield* SubscriptionRef.make(squireEnabledOverride);
    return fromRef(ref, true, Effect.succeed(squireEnabledOverride));
  }
  const settings = yield* ServerSettings.ServerSettingsService;
  // An unreadable settings file reads as off, like a missing one.
  const readSaved = settings.getSettings.pipe(
    Effect.map((current) => current.squire.enabled),
    Effect.catchTags({
      ServerSettingsError: (cause) =>
        Effect.logWarning("Squire switch could not read settings; treating it as off", {
          cause,
        }).pipe(Effect.as(false)),
    }),
  );
  // Subscribed before the seed read, so no write falls between them.
  const saved = yield* settings.subscribeChanges;
  const ref = yield* SubscriptionRef.make(yield* readSaved);
  yield* Stream.runForEach(saved, (current) =>
    SubscriptionRef.set(ref, current.squire.enabled),
  ).pipe(Effect.forkScoped);
  return fromRef(ref, false, readSaved);
});

export const layer = Layer.effect(SquireSwitch, make);

/** The test switch's state; setting it flips the switch as a settings write would. */
export class SquireSwitchControl extends Context.Service<
  SquireSwitchControl,
  SubscriptionRef.SubscriptionRef<boolean>
>()("lecturn/squire/SquireSwitch/SquireSwitchControl") {}

/** An unpinned switch starting at `on`, flipped through `SquireSwitchControl`. */
export const layerTest = (on: boolean) =>
  Layer.effect(
    SquireSwitch,
    Effect.gen(function* () {
      const ref = yield* SquireSwitchControl;
      return fromRef(ref, false, SubscriptionRef.get(ref));
    }),
  ).pipe(Layer.provideMerge(Layer.effect(SquireSwitchControl, SubscriptionRef.make(on))));
