import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { DEFAULT_SERVER_SETTINGS, type StaveProjectInfo } from "@lecturn/contracts";
import { Effect, Layer } from "effect";
import { layerTest } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary } from "./StaveBinary.ts";
import { StaveCli } from "./StaveCli.ts";
import { make } from "./StaveDisplayMembership.ts";
import { StaveReadCache, layer as cacheLayer } from "./StaveReadCache.ts";

const info: StaveProjectInfo = {
  spaceId: "m",
  isSaga: false,
  state: "live",
  repos: [],
  memories: [],
};
describe("Stave display membership", () => {
  it.effect(
    "enriches exact root identities and invalidates joined membership after mutations",
    () =>
      Effect.gen(function* () {
        let memberOf = "s";
        let reads = 0;
        yield* Effect.gen(function* () {
          const display = yield* make;
          const cache = yield* StaveReadCache;
          expect((yield* display.enrich("/spaces/m", info)).memberOf).toBe("s");
          memberOf = "next";
          expect((yield* display.enrich("/spaces/m", info)).memberOf).toBe("s");
          expect(reads).toBe(1);
          yield* cache.invalidate;
          expect((yield* display.enrich("/spaces/m", info)).memberOf).toBe("next");
          expect((yield* display.enrich("/other/m", info)).memberOf).toBeUndefined();
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerTest(process.cwd(), { prefix: "stave-display-" }),
              cacheLayer,
              Layer.mock(ServerSettingsService)({
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  stave: { ...DEFAULT_SERVER_SETTINGS.stave, enabled: true },
                }),
              }),
              Layer.mock(StaveBinary)({
                resolve: Effect.succeed({
                  path: "/bin/stave",
                  source: "path",
                  version: "v0.4.0",
                  commit: null,
                }),
              }),
              Layer.mock(StaveCli)({
                sagaList: Effect.sync(() => {
                  reads++;
                  return [
                    {
                      id: "m",
                      logicalId: "m",
                      path: "/spaces/m",
                      isSaga: false,
                      members: [],
                      memberOf,
                    },
                  ];
                }),
              }),
            ).pipe(Layer.provide(NodeServices.layer)),
          ),
        );
      }),
  );
  it.effect("keeps manifest recognition intact with integration disabled", () =>
    Effect.gen(function* () {
      const display = yield* make;
      expect(yield* display.enrich("/spaces/m", info)).toEqual(info);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerTest(process.cwd(), { prefix: "stave-display-disabled-" }),
          cacheLayer,
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              stave: { ...DEFAULT_SERVER_SETTINGS.stave, enabled: false },
            }),
          }),
          Layer.mock(StaveBinary)({ resolve: Effect.die("disabled must not probe") }),
          Layer.mock(StaveCli)({ sagaList: Effect.die("disabled must not list") }),
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
});
