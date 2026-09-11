import type { StaveFeatures } from "@lecturn/contracts";
import {
  STAVE_FEATURE_VERBS,
  bundledStaveFeatures,
  makeStaveFeatures,
  parseStaveCommandHelp,
} from "./staveFeatures.ts";
/**
 * StaveBinary - Effect service that locates the `stave` executable the server
 * shells out to, and reports which of the candidate sources supplied it.
 *
 * Two walks share one candidate list:
 *
 * - `resolve` is what `StaveCli` uses. `settings.stave.binaryPath` comes first
 *   and, when set, is authoritative: a configured path that is missing or not
 *   executable fails naming that path rather than silently falling back to a
 *   different binary than the user asked for.
 * - `resolveRunnable` skips settings entirely. It answers "could Stave run on
 *   this machine at all" for settings-independent inventory only,
 *   while status and all execution gates use the authoritative `resolve`.
 *
 * After settings, the order is `LECTURN_STAVE_PATH` → the desktop bootstrap
 * `stavePath` → binaries bundled next to the server build → `stave` on PATH.
 * Each hit is probed with `stave version`; a failed probe leaves `version`
 * null and does not fail resolution. Successful resolutions are memoised per
 * settings key. Cached file identity is checked cheaply on every resolution;
 * replacement/removal refreshes version and features without re-running help on
 * unchanged files. Settings changes and explicit `invalidate` clear all caches.
 *
 * @module StaveBinary
 */
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@lecturn/shared/hostProcess";
import { CommandResolutionCache, resolveCommandPath } from "@lecturn/shared/shell";
import { isStavePlatformKey, parseStaveVersionOutput } from "@lecturn/shared/stave";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Environment override consulted right after the persisted settings path. */
export const STAVE_BINARY_ENV_VAR = "LECTURN_STAVE_PATH";
/** Command name searched on PATH as the last resort. */
export const STAVE_COMMAND_NAME = "stave";
/** Upper bound for the `stave version` probe; a hung binary is reported as version-less, not fatal. */
export const STAVE_VERSION_PROBE_TIMEOUT = "10 seconds";

export type StaveBinarySource = "settings" | "env" | "bootstrap" | "bundled" | "path";

export interface StaveBinaryResolution {
  readonly path: string;
  readonly source: StaveBinarySource;
  /** Semantic version without the `v` prefix (e.g. `0.4.0`); null when `stave version` failed. */
  readonly version: string | null;
  readonly commit: string | null;
}

export class StaveBinaryNotFound extends Schema.TaggedErrorClass<StaveBinaryNotFound>()(
  "StaveBinaryNotFound",
  {
    /** Every location tried, in order; the bare command name stands for the PATH search. */
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Stave binary was not found (tried: ${this.candidates.join(", ")}).`;
  }
}

export class StaveBinaryNotExecutable extends Schema.TaggedErrorClass<StaveBinaryNotExecutable>()(
  "StaveBinaryNotExecutable",
  {
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Stave binary at '${this.path}' is not executable.`;
  }
}

export class StaveBinaryUnsupportedWrapper extends Schema.TaggedErrorClass<StaveBinaryUnsupportedWrapper>()(
  "StaveBinaryUnsupportedWrapper",
  { path: Schema.String },
) {
  override get message(): string {
    return "Stave .cmd and .bat wrappers are unsupported; select the native stave.exe executable.";
  }
}
export type StaveBinaryError =
  | StaveBinaryNotFound
  | StaveBinaryNotExecutable
  | StaveBinaryUnsupportedWrapper;

export interface StaveBinaryShape {
  /**
   * Resolve the binary to use for CLI calls: `settings.stave.binaryPath`
   * first (authoritative when set), then env/bootstrap/bundled/PATH.
   * Memoised; invalidated on settings change or `invalidate`.
   */
  readonly resolve: Effect.Effect<StaveBinaryResolution, StaveBinaryError>;
  readonly resolveForPath: (
    configuredPath: string,
  ) => Effect.Effect<StaveBinaryResolution, StaveBinaryError>;
  /**
   * Same candidate walk WITHOUT `settings.stave.binaryPath` — the
   * settings-independent inventory probe; status and execution use `resolve`.
   */
  readonly resolveRunnable: Effect.Effect<StaveBinaryResolution, StaveBinaryError>;
  readonly features: Effect.Effect<StaveFeatures, StaveBinaryError>;
  /** Probe the same resolution the caller will execute, even across settings changes. */
  readonly featuresFor: (resolution: StaveBinaryResolution) => Effect.Effect<StaveFeatures>;
  /** Drop memoised resolutions so the next call re-probes disk and `stave version`. */
  readonly invalidate: Effect.Effect<void>;
}

export class StaveBinary extends Context.Service<StaveBinary, StaveBinaryShape>()(
  "lecturn/stave/StaveBinary",
) {}

export interface StaveBinaryOptions {
  /**
   * Directory the bundled candidates are resolved against. Defaults to the
   * server module directory (`dist/` in a build); tests point it at a temp dir.
   */
  readonly bundledBaseDir?: string;
}

interface StaveBinaryCandidate {
  readonly path: string;
  readonly source: Exclude<StaveBinarySource, "path">;
}

export function staveExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? `${STAVE_COMMAND_NAME}.exe` : STAVE_COMMAND_NAME;
}

export function stavePlatformKey(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): string | undefined {
  const key = `${platform}-${architecture}`;
  return isStavePlatformKey(key) ? key : undefined;
}

/**
 * Locations a bundled binary may occupy relative to the server module: the
 * published `dist/stave/<key>/` layout, a sibling directory for nested build
 * outputs, and the dev fallback from `src/stave/` to `apps/server/dist/stave/`
 * where `fetch-stave` extracts.
 */
export function bundledStaveCandidates(input: {
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly resolvePath: (...segments: ReadonlyArray<string>) => string;
}): ReadonlyArray<string> {
  const platformKey = stavePlatformKey(input.platform, input.architecture);
  if (platformKey === undefined) {
    return [];
  }
  const executableName = staveExecutableName(input.platform);
  return [
    input.resolvePath(input.baseDir, "stave", platformKey, executableName),
    input.resolvePath(input.baseDir, "../stave", platformKey, executableName),
    input.resolvePath(input.baseDir, "../../dist/stave", platformKey, executableName),
  ];
}

export const make = Effect.fn("StaveBinary.make")(function* (options: StaveBinaryOptions = {}) {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const processRunner = yield* ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const workingDirectory = yield* HostProcessWorkingDirectory;

  const envOverride = environment[STAVE_BINARY_ENV_VAR]?.trim();
  const runnableCandidates: ReadonlyArray<StaveBinaryCandidate> = [
    ...(envOverride
      ? [{ path: path.resolve(workingDirectory, envOverride), source: "env" as const }]
      : []),
    ...(config.stavePath
      ? [{ path: path.resolve(workingDirectory, config.stavePath), source: "bootstrap" as const }]
      : []),
    ...bundledStaveCandidates({
      baseDir: options.bundledBaseDir ?? import.meta.dirname,
      platform,
      architecture,
      resolvePath: path.resolve,
    }).map((candidatePath) => ({ path: candidatePath, source: "bundled" as const })),
  ];

  /**
   * `Some(path)` for an existing executable file, `None` when nothing is
   * there; an existing file without the executable bit is an error because
   * a user who put a file at that path expects it to be used, not skipped.
   */
  const probeCandidate = Effect.fn("StaveBinary.probeCandidate")(function* (
    candidatePath: string,
  ): Effect.fn.Return<
    Option.Option<string>,
    StaveBinaryNotExecutable | StaveBinaryUnsupportedWrapper
  > {
    const stat = yield* fileSystem.stat(candidatePath).pipe(Effect.option);
    if (Option.isNone(stat) || stat.value.type !== "File") {
      return Option.none();
    }
    if (platform === "win32" && /\.(?:cmd|bat)$/i.test(candidatePath))
      return yield* new StaveBinaryUnsupportedWrapper({ path: candidatePath });
    if (platform !== "win32" && (stat.value.mode & 0o111) === 0) {
      return yield* new StaveBinaryNotExecutable({ path: candidatePath });
    }
    return Option.some(candidatePath);
  });

  const resolveOnPath = Effect.suspend(() =>
    resolveCommandPath(STAVE_COMMAND_NAME, { env: environment }).pipe(
      Effect.provideService(CommandResolutionCache, new Map()),
    ),
  ).pipe(
    Effect.option,
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcessPlatform, platform),
  );

  const probeVersion = Effect.fn("StaveBinary.probeVersion")(function* (binaryPath: string) {
    const nothing = { version: null, commit: null } as const;
    const result = yield* processRunner
      .run({
        command: binaryPath,
        args: ["version"],
        stdin: "",
        timeout: STAVE_VERSION_PROBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logDebug("Stave version probe failed").pipe(
            Effect.annotateLogs({ binaryPath, reason: error.message }),
          ),
        ),
        Effect.option,
      );
    if (Option.isNone(result) || result.value.timedOut || result.value.code !== 0) {
      return nothing;
    }
    const parsed = parseStaveVersionOutput(result.value.stdout);
    if (parsed === null) {
      yield* Effect.logDebug("Stave version output was not recognised").pipe(
        Effect.annotateLogs({ binaryPath, stdout: result.value.stdout.slice(0, 200) }),
      );
      return nothing;
    }
    return { version: parsed.version, commit: parsed.commit ?? null };
  });

  const resolutionFingerprints = new WeakMap<StaveBinaryResolution, string>();
  const fileFingerprint = Effect.fn("StaveBinary.fileFingerprint")(function* (binaryPath: string) {
    const stat = yield* fileSystem.stat(binaryPath).pipe(Effect.option);
    if (Option.isNone(stat) || stat.value.type !== "File") return null;
    const info = stat.value;
    return `${info.dev}:${Option.getOrNull(info.ino)}:${info.size}:${info.mode}:${Option.match(info.mtime, { onNone: () => "", onSome: (date) => String(date.getTime()) })}`;
  });
  const resolutionIsFresh = Effect.fn("StaveBinary.resolutionIsFresh")(function* (
    resolution: StaveBinaryResolution,
  ) {
    const fingerprint = yield* fileFingerprint(resolution.path);
    return fingerprint !== null && resolutionFingerprints.get(resolution) === fingerprint;
  });

  const toResolution = Effect.fn("StaveBinary.toResolution")(function* (
    binaryPath: string,
    source: StaveBinarySource,
  ) {
    const fingerprint = yield* fileFingerprint(binaryPath);
    if (fingerprint === null) return yield* new StaveBinaryNotFound({ candidates: [binaryPath] });
    const probed = yield* probeVersion(binaryPath);
    const resolution = { path: binaryPath, source, ...probed } satisfies StaveBinaryResolution;
    resolutionFingerprints.set(resolution, fingerprint);
    return resolution;
  });

  const walkRunnableCandidates = Effect.fn("StaveBinary.walkRunnableCandidates")(function* () {
    for (const candidate of runnableCandidates) {
      const found = yield* probeCandidate(candidate.path);
      if (Option.isSome(found)) {
        return yield* toResolution(found.value, candidate.source);
      }
    }
    const onPath = yield* resolveOnPath;
    if (Option.isSome(onPath)) {
      const found = yield* probeCandidate(onPath.value);
      if (Option.isSome(found)) return yield* toResolution(found.value, "path");
    }
    return yield* new StaveBinaryNotFound({
      candidates: [...runnableCandidates.map((candidate) => candidate.path), STAVE_COMMAND_NAME],
    });
  });

  const resolveConfiguredPath = Effect.fn("StaveBinary.resolveConfiguredPath")(function* (
    configuredPath: string,
  ) {
    const expanded = yield* expandHomePath(configuredPath).pipe(
      Effect.provideService(Path.Path, path),
    );
    // A bare filename must execute the same local file that was validated,
    // rather than asking the process spawner to search PATH again.
    const absolutePath = path.resolve(workingDirectory, expanded);
    const found = yield* probeCandidate(absolutePath);
    if (Option.isNone(found)) {
      return yield* new StaveBinaryNotFound({ candidates: [absolutePath] });
    }
    return yield* toResolution(found.value, "settings");
  });

  // Settings may be read before the settings runtime is ready; an unreadable
  // settings file simply means "no override" rather than "Stave is broken".
  const readConfiguredPath = settings.getSettings.pipe(
    Effect.map((current) => current.stave.binaryPath.trim()),
    Effect.catch((error) =>
      Effect.logDebug("Stave binary path unavailable from settings").pipe(
        Effect.annotateLogs({ reason: error.message }),
        Effect.as(""),
      ),
    ),
  );

  const runnableCache = yield* Ref.make(Option.none<StaveBinaryResolution>());
  const configuredCache = yield* Ref.make(
    Option.none<{ readonly key: string; readonly resolution: StaveBinaryResolution }>(),
  );

  const resolveRunnable: StaveBinaryShape["resolveRunnable"] = Effect.gen(function* () {
    const cached = yield* Ref.get(runnableCache);
    if (Option.isSome(cached) && (yield* resolutionIsFresh(cached.value))) {
      return cached.value;
    }
    const resolution = yield* walkRunnableCandidates();
    yield* Ref.set(runnableCache, Option.some(resolution));
    return resolution;
  }).pipe(Effect.withSpan("StaveBinary.resolveRunnable"));

  const resolveForPath = Effect.fn("StaveBinary.resolveForPath")(function* (input: string) {
    const configuredPath = input.trim();
    if (configuredPath.length === 0) {
      return yield* resolveRunnable;
    }
    const cached = yield* Ref.get(configuredCache);
    if (
      Option.isSome(cached) &&
      cached.value.key === configuredPath &&
      (yield* resolutionIsFresh(cached.value.resolution))
    ) {
      return cached.value.resolution;
    }
    const resolution = yield* resolveConfiguredPath(configuredPath);
    yield* Ref.set(configuredCache, Option.some({ key: configuredPath, resolution }));
    return resolution;
  });
  const resolve = readConfiguredPath.pipe(Effect.flatMap(resolveForPath));

  const featureCache = yield* Ref.make(
    Option.none<{ readonly key: string; readonly value: StaveFeatures }>(),
  );
  const featuresFor = Effect.fn("StaveBinary.featuresFor")(function* (
    selected: StaveBinaryResolution,
  ) {
    const fingerprint = yield* fileFingerprint(selected.path);
    const key = `${selected.source}:${selected.path}:${fingerprint}`;
    const cached = yield* Ref.get(featureCache);
    if (Option.isSome(cached) && cached.value.key === key) return cached.value.value;
    const value =
      selected.source === "bundled"
        ? bundledStaveFeatures()
        : makeStaveFeatures(
            "help",
            yield* Effect.forEach(
              STAVE_FEATURE_VERBS,
              (verb) =>
                processRunner
                  .run({
                    command: selected.path,
                    args: [...verb.split(" "), "--help"],
                    stdin: "",
                    timeout: STAVE_VERSION_PROBE_TIMEOUT,
                    timeoutBehavior: "timedOutResult",
                  })
                  .pipe(
                    Effect.map((output) =>
                      output.timedOut
                        ? { verb, available: false, flags: [] }
                        : parseStaveCommandHelp(verb, `${output.stdout}\n${output.stderr}`),
                    ),
                    Effect.orElseSucceed(() => ({ verb, available: false, flags: [] })),
                  ),
              { concurrency: 4 },
            ),
          );
    yield* Ref.set(featureCache, Option.some({ key, value }));
    return value;
  });
  const features = resolve.pipe(Effect.flatMap(featuresFor));
  const invalidate = Effect.all(
    [
      Ref.set(runnableCache, Option.none()),
      Ref.set(configuredCache, Option.none()),
      Ref.set(featureCache, Option.none()),
    ],
    { discard: true },
  );

  // Any settings save re-probes: the key already tracks `binaryPath`, but a
  // save is also the natural "I installed it, look again" signal for the
  // settings-independent walk.
  yield* settings.streamChanges.pipe(
    Stream.runForEach(() => invalidate),
    Effect.forkScoped,
  );

  return StaveBinary.of({
    resolve,
    resolveForPath,
    resolveRunnable,
    features,
    featuresFor,
    invalidate,
  });
});

export const layer = Layer.effect(StaveBinary, make());

/** Binary that resolves to a known location without touching disk — for tests. */
export const layerFixed = (
  resolution: StaveBinaryResolution,
  features: StaveFeatures = bundledStaveFeatures(),
) =>
  Layer.succeed(
    StaveBinary,
    StaveBinary.of({
      resolve: Effect.succeed(resolution),
      resolveForPath: () => Effect.succeed(resolution),
      resolveRunnable: Effect.succeed(resolution),
      features: Effect.succeed(features),
      featuresFor: () => Effect.succeed(features),
      invalidate: Effect.void,
    }),
  );
