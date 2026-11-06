import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ServerSettings as ServerSettingsValue } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SquireSwitch from "./SquireSwitch.ts";

/** A read of the saved settings held mid-flight: it has its value and waits for `release`. */
interface HeldRead {
  readonly reading: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
class SettingsProbe extends Context.Service<
  SettingsProbe,
  {
    readonly held: Ref.Ref<Option.Option<HeldRead>>;
    /** While set, writes are not published, as if the settings stream lagged. */
    readonly muted: Ref.Ref<boolean>;
  }
>()("lecturn/squire/SquireSwitch.test/SettingsProbe") {}

/**
 * Test settings whose writes reach `subscribeChanges`, as the file-backed
 * service's do, steered through `SettingsProbe`.
 */
const layerSettings = (enabled: boolean) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const { held, muted } = yield* SettingsProbe;
      const changes = yield* PubSub.unbounded<ServerSettingsValue>();
      return ServerSettings.ServerSettingsService.of({
        ...base,
        getSettings: Effect.gen(function* () {
          const current = yield* base.getSettings;
          const hold = yield* Ref.getAndSet(held, Option.none());
          if (Option.isSome(hold)) {
            yield* Deferred.succeed(hold.value.reading, undefined);
            yield* Deferred.await(hold.value.release);
          }
          return current;
        }),
        updateSettings: (patch) =>
          base
            .updateSettings(patch)
            .pipe(
              Effect.tap((next) =>
                Effect.flatMap(Ref.get(muted), (silent) =>
                  silent ? Effect.void : PubSub.publish(changes, next),
                ),
              ),
            ),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        SettingsProbe,
        Effect.all({ held: Ref.make(Option.none<HeldRead>()), muted: Ref.make(false) }),
      ),
    ),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest({ squire: { enabled } })),
  );

const layerSwitch = (options: { readonly saved: boolean; readonly override?: boolean }) =>
  SquireSwitch.layer.pipe(
    Layer.provideMerge(layerSettings(options.saved)),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (config) =>
          ServerConfig.make({ ...config, squireEnabledOverride: options.override }),
        ),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-switch-" })),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const next = (squireSwitch: SquireSwitch.SquireSwitch["Service"], on: boolean) =>
  squireSwitch.changes.pipe(
    Stream.filter((value) => value === on),
    Stream.runHead,
  );

describe("SquireSwitch", () => {
  it.effect("follows the saved setting live, both ways", () =>
    Effect.gen(function* () {
      const squireSwitch = yield* SquireSwitch.SquireSwitch;
      const settings = yield* ServerSettings.ServerSettingsService;
      assert.isFalse(squireSwitch.pinned);
      assert.isFalse(yield* squireSwitch.isOn);

      yield* settings.updateSettings({ squire: { enabled: true } });
      yield* next(squireSwitch, true);
      assert.isTrue(yield* squireSwitch.isOn);

      yield* settings.updateSettings({ squire: { enabled: false } });
      yield* next(squireSwitch, false);
      assert.isFalse(yield* squireSwitch.isOn);
    }).pipe(Effect.provide(layerSwitch({ saved: false }))),
  );

  it.effect("refresh reads a write the stream has not applied yet", () =>
    Effect.gen(function* () {
      const squireSwitch = yield* SquireSwitch.SquireSwitch;
      // The plain test settings never publish, as if the stream lagged the write.
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ squire: { enabled: true } });
      assert.isFalse(yield* squireSwitch.isOn);
      assert.isTrue(yield* squireSwitch.refresh);
      assert.isTrue(yield* squireSwitch.isOn);
    }).pipe(
      Effect.provide(
        SquireSwitch.layer.pipe(
          Layer.provideMerge(
            ServerSettings.ServerSettingsService.layerTest({ squire: { enabled: false } }),
          ),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-switch-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("a refresh that read a saved on cannot outlast a later off", () =>
    Effect.gen(function* () {
      const squireSwitch = yield* SquireSwitch.SquireSwitch;
      const settings = yield* ServerSettings.ServerSettingsService;
      const probe = yield* SettingsProbe;
      // Saved on, but the stream has not applied it.
      yield* Ref.set(probe.muted, true);
      yield* settings.updateSettings({ squire: { enabled: true } });
      yield* Ref.set(probe.muted, false);
      const hold = {
        reading: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      yield* Ref.set(probe.held, Option.some(hold));
      // The RPC's refresh reads "on" and stalls before applying it.
      const refreshing = yield* Effect.forkChild(squireSwitch.refresh);
      yield* Deferred.await(hold.reading);
      yield* settings.updateSettings({ squire: { enabled: false } });

      yield* Deferred.succeed(hold.release, undefined);
      assert.isTrue(yield* Fiber.join(refreshing));
      // The later "off" still lands after it.
      yield* next(squireSwitch, false);
      assert.isFalse(yield* squireSwitch.isOn);
    }).pipe(Effect.provide(layerSwitch({ saved: false }))),
  );

  it.effect("LECTURN_SQUIRE pins it: the saved setting and its changes are ignored", () =>
    Effect.gen(function* () {
      const squireSwitch = yield* SquireSwitch.SquireSwitch;
      const settings = yield* ServerSettings.ServerSettingsService;
      assert.isTrue(squireSwitch.pinned);
      assert.isFalse(yield* squireSwitch.isOn);
      yield* settings.updateSettings({ squire: { enabled: true } });
      assert.isFalse(yield* squireSwitch.refresh);
      assert.isFalse(yield* squireSwitch.isOn);
    }).pipe(Effect.provide(layerSwitch({ saved: true, override: false }))),
  );
});
