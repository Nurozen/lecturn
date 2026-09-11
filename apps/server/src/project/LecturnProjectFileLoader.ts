/**
 * LecturnProjectFileLoader - Effect service that loads the checked-in `lecturn.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module LecturnProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { LECTURN_PROJECT_FILE_NAME, type LecturnProjectFile } from "@lecturn/contracts";
import { LecturnProjectFileFromJson } from "@lecturn/shared/lecturnProjectFile";

const decodeLecturnProjectFileJson = Schema.decodeEffect(LecturnProjectFileFromJson);

export class LecturnProjectFileLoadError extends Schema.TaggedErrorClass<LecturnProjectFileLoadError>()(
  "LecturnProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${LECTURN_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for lecturn.json project file loading. */
export class LecturnProjectFileLoader extends Context.Service<
  LecturnProjectFileLoader,
  {
    /**
     * Load and decode `lecturn.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<LecturnProjectFile>>;
  }
>()("lecturn/project/LecturnProjectFileLoader") {}

const logLecturnProjectFileLoadError = (error: LecturnProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: LecturnProjectFileLoader["Service"]["load"] = Effect.fn(
    "LecturnProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, LECTURN_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logLecturnProjectFileLoadError(
                new LecturnProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<LecturnProjectFile>();
    }
    return yield* decodeLecturnProjectFileJson(raw.value).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        SchemaError: (error) =>
          logLecturnProjectFileLoadError(
            new LecturnProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<LecturnProjectFile>())),
      }),
    );
  });

  return LecturnProjectFileLoader.of({ load });
});

export const layer = Layer.effect(LecturnProjectFileLoader, make);
