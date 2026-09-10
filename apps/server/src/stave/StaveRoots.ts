/**
 * StaveRootsProvider - where the Stave agent-work directory lives, for callers
 * that must never adopt an ancestor repository from inside it (git spawns
 * whose cwd sits under a space). `layer` reads the selected config directly from disk through `StaveConfigReader`
 * without invoking Stave and reports none
 * until a config file exists; `layerNoop` answers none for hosts and tests
 * without Stave.
 *
 * @module StaveRoots
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { StaveConfigReader } from "./StaveConfigReader.ts";

export class StaveRootsProvider extends Context.Service<
  StaveRootsProvider,
  {
    /** Absolute agent-work directory, or none when Stave is not configured. */
    readonly agentWorkDir: Effect.Effect<Option.Option<string>>;
  }
>()("t3/stave/StaveRoots/StaveRootsProvider") {}

export const layer: Layer.Layer<StaveRootsProvider, never, StaveConfigReader> = Layer.effect(
  StaveRootsProvider,
  Effect.gen(function* () {
    const configReader = yield* StaveConfigReader;
    // A config that does not exist yet has only Stave's defaults; nothing
    // lives under that directory, so it must not be treated as a root.
    const agentWorkDir =
      configReader.loadFilesystem === undefined
        ? Effect.succeed(Option.none<string>())
        : configReader.loadFilesystem.pipe(
            Effect.map((snapshot) =>
              snapshot.exists && snapshot.agentWorkDir !== undefined
                ? Option.some(snapshot.agentWorkDir)
                : Option.none<string>(),
            ),
          );
    return StaveRootsProvider.of({ agentWorkDir });
  }),
);

export const layerNoop: Layer.Layer<StaveRootsProvider> = Layer.succeed(
  StaveRootsProvider,
  StaveRootsProvider.of({ agentWorkDir: Effect.succeedNone }),
);

export const layerFixed = (agentWorkDir: string): Layer.Layer<StaveRootsProvider> =>
  Layer.succeed(
    StaveRootsProvider,
    StaveRootsProvider.of({ agentWorkDir: Effect.succeed(Option.some(agentWorkDir)) }),
  );
