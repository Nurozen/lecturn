import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ServerSettings as ServerSettingsValue } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SquireSwitch from "./SquireSwitch.ts";

/** Test settings whose writes reach `subscribeChanges`, as the file-backed service's do. */
const layerSettings = (enabled: boolean) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<ServerSettingsValue>();
      return ServerSettings.ServerSettingsService.of({
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.ServerSettingsService.layerTest({ squire: { enabled } })));

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
