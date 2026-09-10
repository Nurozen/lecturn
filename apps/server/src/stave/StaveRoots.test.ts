import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { StaveConfigReader } from "./StaveConfigReader.ts";
import * as StaveRoots from "./StaveRoots.ts";

describe("filesystem-only Git roots", () => {
  it.effect("does not invoke a configured executable when only legacy loading is available", () =>
    Effect.gen(function* () {
      const roots = yield* StaveRoots.StaveRootsProvider;
      expect(Option.isNone(yield* roots.agentWorkDir)).toBe(true);
    }).pipe(
      Effect.provide(
        StaveRoots.layer.pipe(
          Layer.provide(
            Layer.succeed(StaveConfigReader, {
              invalidate: Effect.void,
              load: Effect.die("Git must never probe a Stave executable"),
            }),
          ),
        ),
      ),
    ),
  );
  it.effect("reads the selected filesystem snapshot without executing Stave", () =>
    Effect.gen(function* () {
      const roots = yield* StaveRoots.StaveRootsProvider;
      expect(Option.getOrUndefined(yield* roots.agentWorkDir)).toBe("/spaces");
    }).pipe(
      Effect.provide(
        StaveRoots.layer.pipe(
          Layer.provide(
            Layer.succeed(StaveConfigReader, {
              invalidate: Effect.void,
              load: Effect.die("Git must never probe a Stave executable"),
              loadFilesystem: Effect.succeed({
                configPath: "/config",
                exists: true,
                agentWorkDir: "/spaces",
                repos: [],
                memory: { default: false },
                source: "fs-fallback" as const,
              }),
            }),
          ),
        ),
      ),
    ),
  );
});
