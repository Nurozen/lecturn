import { StaveExecutionContext } from "./StaveExecutionContext.ts";
/**
 * StaveConfigReader - Effect service that answers "where does Stave keep its
 * things on this machine": the config file, the root, the bare-repo and
 * agent-work directories, the registered repos and the memory defaults.
 *
 * `stave config show --json` is the source of truth because it applies the
 * same defaulting every other verb does (deviation 21: Stave alone defines
 * what "set up" means). When Stave cannot answer — no binary, or an older
 * Stave without `config show --json` — the reader reads the YAML itself and
 * mirrors Stave's `ApplyDefaults` (root under `~/stave`, dirs derived from the
 * root, `~` expansion, repo names and bare paths from the map key). Either way
 * the snapshot says which `source` produced it.
 *
 * Loading never fails and never mutates: `stave setup` is not run here, and a
 * missing config simply reports `exists: false` with the defaults Stave would
 * use. Results are cached for 15s and dropped on any settings change or an
 * explicit `invalidate`.
 *
 * @module StaveConfigReader
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";
import { parse as parseYamlDocument } from "yaml";

import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary } from "./StaveBinary.ts";
import { StaveCli } from "./StaveCli.ts";
import type { StaveConfigShow } from "./staveJson.ts";

export interface StaveConfigRepoSnapshot {
  readonly name: string;
  readonly url: string;
  readonly bareRepoPath: string;
  readonly defaultBranch?: string;
  readonly description?: string;
}

export type StaveConfigSource = "stave-config-show" | "fs-fallback";

export interface StaveConfigSnapshot {
  readonly configPath: string;
  readonly exists: boolean;
  readonly root?: string;
  readonly bareReposDir?: string;
  readonly agentWorkDir?: string;
  readonly defaultBase?: string;
  readonly repos: ReadonlyArray<StaveConfigRepoSnapshot>;
  readonly memory?: {
    readonly provider?: string;
    readonly binary?: string;
    readonly default: boolean;
  };
  readonly source: StaveConfigSource;
}

export class StaveConfigReader extends Context.Service<
  StaveConfigReader,
  {
    /** Never fails; falls back to reading the YAML when Stave cannot answer. Cached 15s. */
    readonly load: Effect.Effect<StaveConfigSnapshot>;
    /** Drop the cached snapshot so the next `load` asks Stave (or disk) again. */
    readonly invalidate: Effect.Effect<void>;
  }
>()("t3/stave/StaveConfigReader") {}

export const STAVE_CONFIG_CACHE_TTL = Duration.seconds(15);

/** Stave's `DefaultBase` when the config omits it. */
export const STAVE_DEFAULT_BASE = "main";
/** Stave's `DefaultMemoryConfig`: inert provider settings, ambient memory off. */
export const STAVE_DEFAULT_MEMORY = {
  provider: "marmot",
  binary: "marmot",
  default: false,
} as const;

export interface StaveConfigReaderOptions {
  /** Home directory `~` and the default config/root resolve against; defaults to `os.homedir()`. */
  readonly homeDir?: string;
  readonly cacheTtl?: Duration.Input;
}

/** `<home>/.config/stave/config.yaml`, matching Stave's `DefaultConfigPath`. */
export function defaultStaveConfigPath(
  homeDir: string,
  joinPath: (...segments: string[]) => string,
): string {
  return joinPath(homeDir, ".config", "stave", "config.yaml");
}

interface PathOps {
  readonly join: (...segments: string[]) => string;
  readonly resolve: (...segments: string[]) => string;
}

/** Stave's `ExpandPath`: `~` and `~/x` map onto the home directory, everything else is made absolute. */
export function expandStavePath(raw: string, homeDir: string, path: PathOps): string {
  if (raw === "~") {
    return homeDir;
  }
  if (raw.startsWith("~/")) {
    return path.join(homeDir, raw.slice(2));
  }
  return path.resolve(raw);
}

const byName = (a: StaveConfigRepoSnapshot, b: StaveConfigRepoSnapshot) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Project `config show --json` onto the snapshot; the repo map becomes a name-sorted array. */
export function snapshotFromConfigShow(show: StaveConfigShow): StaveConfigSnapshot {
  const repos = Object.values(show.repos)
    .map((repo): StaveConfigRepoSnapshot => ({
      name: repo.name,
      url: repo.url,
      bareRepoPath: repo.bareRepoPath,
      ...(repo.defaultBranch === undefined ? {} : { defaultBranch: repo.defaultBranch }),
      ...(repo.description === undefined ? {} : { description: repo.description }),
    }))
    .sort(byName);
  return {
    configPath: show.configPath,
    exists: show.exists,
    root: show.root,
    bareReposDir: show.bareReposDir,
    agentWorkDir: show.agentWorkDir,
    defaultBase: show.defaultBase,
    repos,
    memory: {
      ...(show.memory.provider === undefined ? {} : { provider: show.memory.provider }),
      ...(show.memory.binary === undefined ? {} : { binary: show.memory.binary }),
      default: show.memory.default,
    },
    source: "stave-config-show",
  };
}

type YamlMapping = Record<string, unknown>;

function isMapping(value: unknown): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty trimmed string, or `undefined` for anything else (Stave treats "" as unset). */
function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export interface SnapshotFromYamlInput {
  readonly configPath: string;
  readonly exists: boolean;
  /** Parsed YAML document; anything that is not a mapping yields the defaults. */
  readonly document: unknown;
  readonly homeDir: string;
  readonly path: PathOps;
}

/**
 * Mirror Stave's `Config.ApplyDefaults` over a parsed YAML document. Fields of
 * the wrong type are ignored rather than failing, so a hand-edited config
 * still yields the directories Stave would derive.
 */
export function snapshotFromYaml(input: SnapshotFromYamlInput): StaveConfigSnapshot {
  const { homeDir, path } = input;
  const expand = (raw: string) => expandStavePath(raw, homeDir, path);
  const mapping: YamlMapping = isMapping(input.document) ? input.document : {};

  const root = expand(readString(mapping.root) ?? path.join(homeDir, "stave"));
  const bareReposDir = expand(readString(mapping.bareReposDir) ?? path.join(root, "bare-repos"));
  const agentWorkDir = expand(readString(mapping.agentWorkDir) ?? path.join(root, "agent-work"));
  const defaultBase = readString(mapping.defaultBase) ?? STAVE_DEFAULT_BASE;

  const repos = (isMapping(mapping.repos) ? Object.entries(mapping.repos) : [])
    .flatMap(([key, value]): ReadonlyArray<StaveConfigRepoSnapshot> => {
      if (!isMapping(value)) {
        return [];
      }
      const defaultBranch = readString(value.defaultBranch);
      const description = readString(value.description);
      return [
        {
          name: readString(value.name) ?? key,
          url: readString(value.url) ?? "",
          bareRepoPath: expand(
            readString(value.bareRepoPath) ?? path.join(bareReposDir, `${key}.git`),
          ),
          ...(defaultBranch === undefined ? {} : { defaultBranch }),
          ...(description === undefined ? {} : { description }),
        },
      ];
    })
    .sort(byName);

  const memoryMapping: YamlMapping = isMapping(mapping.memory) ? mapping.memory : {};
  const memory = {
    provider: readString(memoryMapping.provider) ?? STAVE_DEFAULT_MEMORY.provider,
    binary: readString(memoryMapping.binary) ?? STAVE_DEFAULT_MEMORY.binary,
    default: memoryMapping.default === true,
  };

  return {
    configPath: input.configPath,
    exists: input.exists,
    root,
    bareReposDir,
    agentWorkDir,
    defaultBase,
    repos,
    memory,
    source: "fs-fallback",
  };
}

interface CachedSnapshot {
  readonly snapshot: StaveConfigSnapshot;
  readonly loadedAtMillis: number;
}

export const make = Effect.fn("StaveConfigReader.make")(function* (
  options: StaveConfigReaderOptions = {},
) {
  const staveBinary = yield* StaveBinary;
  const staveCli = yield* StaveCli;
  const settings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = options.homeDir ?? NodeOS.homedir();
  const cacheTtlMillis = Duration.toMillis(options.cacheTtl ?? STAVE_CONFIG_CACHE_TTL);
  const pathOps: PathOps = { join: path.join, resolve: path.resolve };

  // Settings may be unreadable before the settings runtime is ready; that
  // means "no override", not "Stave is broken".
  const readConfiguredPath = settings.getSettings.pipe(
    Effect.map((current) => current.stave.configPath.trim()),
    Effect.catch((error) =>
      Effect.logDebug("Stave config path unavailable from settings").pipe(
        Effect.annotateLogs({ reason: error.message }),
        Effect.as(""),
      ),
    ),
  );

  const resolveConfigPath = readConfiguredPath.pipe(
    Effect.map((configured) =>
      configured.length === 0
        ? defaultStaveConfigPath(homeDir, path.join)
        : expandStavePath(configured, homeDir, pathOps),
    ),
  );

  const loadFromDisk = Effect.fn("StaveConfigReader.loadFromDisk")(function* () {
    const execution = yield* StaveExecutionContext;
    const configPath = execution?.configPath ?? (yield* resolveConfigPath);
    const fromDefaults = (exists: boolean, document: unknown) =>
      snapshotFromYaml({
        configPath: execution?.sourceConfigPath ?? configPath,
        exists,
        document,
        homeDir,
        path: pathOps,
      });

    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logDebug("Stave config file not readable; using defaults").pipe(
          Effect.annotateLogs({ configPath, reason: error.reason._tag }),
          Effect.as(Option.none<string>()),
        ),
      ),
    );
    if (Option.isNone(raw)) {
      return fromDefaults(false, undefined);
    }

    const document = yield* Effect.try({
      try: () => parseYamlDocument(raw.value) as unknown,
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.catch((message) =>
        Effect.logDebug("Stave config file is not valid YAML; using defaults").pipe(
          Effect.annotateLogs({ configPath, reason: message }),
          Effect.as(undefined),
        ),
      ),
    );
    if (document !== undefined && !isMapping(document)) {
      yield* Effect.logDebug("Stave config file is not a mapping; using defaults").pipe(
        Effect.annotateLogs({ configPath }),
      );
    }
    return fromDefaults(true, document);
  });

  const loadFromStave = Effect.fn("StaveConfigReader.loadFromStave")(function* () {
    const execution = yield* StaveExecutionContext;
    const binary = yield* (
      execution === undefined ? staveBinary.resolve : Effect.succeed(execution.binary)
    ).pipe(Effect.option);
    if (Option.isNone(binary)) {
      yield* Effect.logDebug("Stave binary unavailable; reading config from disk");
      return Option.none<StaveConfigSnapshot>();
    }
    return yield* staveCli.configShow.pipe(
      Effect.map((show) =>
        Option.some({
          ...snapshotFromConfigShow(show),
          ...(execution === undefined ? {} : { configPath: execution.sourceConfigPath }),
        }),
      ),
      Effect.catch((error) =>
        Effect.logDebug("stave config show failed; reading config from disk").pipe(
          Effect.annotateLogs({ code: error.code, verb: error.verb, reason: error.message }),
          Effect.as(Option.none<StaveConfigSnapshot>()),
        ),
      ),
    );
  });

  const loadUncached = Effect.fn("StaveConfigReader.loadUncached")(function* () {
    const fromStave = yield* loadFromStave();
    return Option.isSome(fromStave) ? fromStave.value : yield* loadFromDisk();
  });

  const cache = yield* Ref.make(Option.none<CachedSnapshot>());

  const load: StaveConfigReader["Service"]["load"] = Effect.gen(function* () {
    if ((yield* StaveExecutionContext) !== undefined) return yield* loadUncached();
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    if (Option.isSome(cached) && now - cached.value.loadedAtMillis < cacheTtlMillis) {
      return cached.value.snapshot;
    }
    const snapshot = yield* loadUncached();
    yield* Ref.set(cache, Option.some({ snapshot, loadedAtMillis: now }));
    return snapshot;
  }).pipe(Effect.withSpan("StaveConfigReader.load"));

  const invalidate = Ref.set(cache, Option.none());

  // A settings save may change `configPath` or `binaryPath`, either of which
  // changes the answer; StaveBinary drops its own memo independently.
  yield* settings.streamChanges.pipe(
    Stream.runForEach(() => invalidate),
    Effect.forkScoped,
  );

  return StaveConfigReader.of({ load, invalidate });
});

export const layer = Layer.effect(StaveConfigReader, make());

/** Reader that always answers with `snapshot` — for tests and fixed hosts. */
export const layerFixed = (snapshot: StaveConfigSnapshot): Layer.Layer<StaveConfigReader> =>
  Layer.succeed(
    StaveConfigReader,
    StaveConfigReader.of({ load: Effect.succeed(snapshot), invalidate: Effect.void }),
  );
