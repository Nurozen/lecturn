// @effect-diagnostics nodeBuiltinImport:off -- same default home as StaveConfigReader
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@lecturn/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary } from "./StaveBinary.ts";
import { defaultStaveConfigPath, expandStavePath } from "./StaveConfigReader.ts";
import { StaveError } from "./StaveError.ts";
import { StaveExecutionContext } from "./StaveExecutionContext.ts";

export class StaveExecution extends Context.Service<
  StaveExecution,
  {
    readonly withExecution: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: { readonly writableConfig?: boolean },
    ) => Effect.Effect<A, E | StaveError, R>;
  }
>()("lecturn/stave/StaveExecution") {}

export const layer = Layer.effect(
  StaveExecution,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = yield* ServerSettingsService;
    const binary = yield* StaveBinary;
    const fail = (message: string, code: StaveError["code"] = "not_setup") =>
      new StaveError({
        code,
        message,
        details: null,
        exitCode: null,
        stderrTail: null,
        verb: "execution",
      });
    const withExecution: StaveExecution["Service"]["withExecution"] = (effect, options) =>
      Effect.scoped(
        Effect.gen(function* () {
          if ((yield* StaveExecutionContext) !== undefined) return yield* effect;
          const current = yield* settings.getSettings.pipe(
            Effect.mapError((error) => fail(error.message)),
          );
          const selected = yield* binary
            .resolveForPath(current.stave.binaryPath)
            .pipe(Effect.mapError((error) => fail(error.message, "binary_missing")));
          const sourceConfigPath =
            current.stave.configPath.trim() === ""
              ? defaultStaveConfigPath(NodeOS.homedir(), path.join)
              : expandStavePath(current.stave.configPath, NodeOS.homedir(), path);
          let configPath = sourceConfigPath;
          let configurationIdentity: string | undefined;
          if (!options?.writableConfig) {
            const raw = yield* fs
              .readFileString(sourceConfigPath)
              .pipe(
                Effect.mapError(() => fail("The selected Stave configuration cannot be read.")),
              );
            configurationIdentity = NodeCrypto.createHash("sha256")
              .update(stableStringify({ sourceConfigPath, binary: selected, raw }))
              .digest("hex");
            const directory = yield* fs
              .makeTempDirectoryScoped({ prefix: "lecturn-stave-execution-" })
              .pipe(
                Effect.mapError(() =>
                  fail("A private Stave execution directory could not be created."),
                ),
              );
            yield* fs
              .chmod(directory, 0o700)
              .pipe(
                Effect.mapError(() => fail("The Stave execution directory could not be secured.")),
              );
            configPath = path.join(directory, "config.yaml");
            yield* fs
              .writeFileString(configPath, raw, { mode: 0o600 })
              .pipe(
                Effect.mapError(() =>
                  fail("The Stave execution configuration could not be captured."),
                ),
              );
          }
          return yield* effect.pipe(
            Effect.provideService(StaveExecutionContext, {
              binary: selected,
              configPath,
              sourceConfigPath,
              ...(configurationIdentity === undefined ? {} : { configurationIdentity }),
            }),
          );
        }),
      );
    return StaveExecution.of({ withExecution });
  }),
);

/** For operation tests whose CLI and configuration are fixed fakes. */
export const layerNoop = Layer.succeed(
  StaveExecution,
  StaveExecution.of({ withExecution: (effect) => effect }),
);
