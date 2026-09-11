/**
 * StaveWorkspaceReader - Effect service that projects a Stave space manifest
 * (`<workspace root>/.stave.yaml`) into the `StaveProjectInfo` read model.
 *
 * Loading is best-effort and never fails: a missing, unreadable, or invalid
 * manifest resolves to `Option.none` (logged at debug level) so a project that
 * is not a Stave space costs one stat per cache miss. Only the root itself is
 * consulted — there is no walk-up — so a project nested inside a space is not
 * mistaken for the space.
 *
 * Results are cached per root with separate positive/negative TTLs; Stave
 * lifecycle operations call `invalidate(root)` after mutating a space.
 *
 * @module StaveWorkspaceReader
 */
import type {
  RepositoryIdentity,
  StaveMemoryEntry,
  StaveProjectInfo,
  StaveRepoEntry,
  StaveRepoMode,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  STAVE_MANIFEST_FILE_NAME,
  STAVE_MANIFEST_KIND_SAGA,
  decodeStaveManifest,
  type ManifestScalar,
  type StaveManifest,
} from "./staveManifest.ts";

const DEFAULT_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.seconds(30);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.seconds(60);

/** Directory Stave moves archived spaces into: `<agentWorkDir>/.archive/<space>`. */
export const STAVE_ARCHIVE_DIRECTORY_NAME = ".archive";

export interface StaveWorkspaceReaderOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

export class StaveWorkspaceReader extends Context.Service<
  StaveWorkspaceReader,
  {
    /**
     * Read and project `<workspaceRoot>/.stave.yaml`.
     *
     * Never fails: missing, unreadable, or invalid manifests resolve to
     * `Option.none`. Cached per root (positive 30s / negative 60s by default).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<StaveProjectInfo>>;
    /** Drop the cached result for one root so the next `load` re-reads disk. */
    readonly invalidate: (workspaceRoot: string) => Effect.Effect<void>;
    /** Drop every cached result. */
    readonly invalidateAll: () => Effect.Effect<void>;
  }
>()("t3/stave/StaveWorkspaceReader") {}

/** Where the manifest was found, pre-split so the mapper stays path-library free. */
export interface StaveWorkspaceLocation {
  readonly workspaceRoot: string;
  /** Basename of the root's parent directory (`.archive` marks an archived space). */
  readonly parentBasename: string;
  /** Basename of the root itself (the archive entry name when archived). */
  readonly basename: string;
}

export interface MapManifestInput {
  readonly manifest: StaveManifest;
  readonly location: StaveWorkspaceLocation;
  /** Resolves a repo path relative to the workspace root (absolute paths pass through). */
  readonly resolveRepoPath: (repoPath: string) => string | null;
}

/**
 * Pure projection of a decoded manifest onto the read model, minus the
 * primary repository identity (resolved by the caller afterwards).
 *
 * Returns `null` when the manifest cannot describe a space (no usable `id`).
 * Repo entries with an unknown `mode` are dropped rather than failing the
 * whole manifest; optional keys are omitted (never set to `undefined`) so the
 * result decodes against `StaveProjectInfo`.
 */
export function mapManifestToProjectInfo(
  input: MapManifestInput,
): Omit<StaveProjectInfo, "primaryRepositoryIdentity"> | null {
  const { manifest, location, resolveRepoPath } = input;
  const spaceId = normalizeScalar(manifest.id);
  if (spaceId === undefined) {
    return null;
  }

  const kind = normalizeScalar(manifest.kind);
  const createdAt = normalizeScalar(manifest.createdAt);
  const repos = (manifest.repos ?? []).flatMap((repo) => {
    const entry = mapRepoEntry(repo);
    if (entry === null) return [];
    const resolvedPath = resolveRepoPath(entry.path);
    return resolvedPath === null ? [] : [{ ...entry, resolvedPath }];
  });
  const memories = (manifest.memories ?? []).flatMap((memory) => {
    const entry = mapMemoryEntry(memory);
    return entry === null ? [] : [entry];
  });
  const primaryRepo = repos.find((repo) => repo.mode === "edit");
  const archived = location.parentBasename === STAVE_ARCHIVE_DIRECTORY_NAME;

  return {
    spaceId,
    ...(kind === undefined ? {} : { kind }),
    ...(createdAt !== undefined && Number.isFinite(Date.parse(createdAt)) ? { createdAt } : {}),
    isSaga:
      kind === STAVE_MANIFEST_KIND_SAGA || (manifest.saga !== undefined && manifest.saga !== null),
    repos,
    memories,
    ...(primaryRepo === undefined ? {} : { primaryRepoPath: primaryRepo.resolvedPath }),
    ...(primaryRepo?.branch === undefined ? {} : { primaryBranch: primaryRepo.branch }),
    state: archived ? "archived" : "live",
    ...(archived ? { archiveBasename: location.basename } : {}),
  };
}

/** Coerce a YAML scalar to a trimmed string; blank, null and absent values collapse to `undefined`. */
function normalizeScalar(value: ManifestScalar | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text =
    typeof value === "string"
      ? value.trim()
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  return text.length === 0 ? undefined : text;
}

function mapRepoEntry(repo: NonNullable<StaveManifest["repos"]>[number]): StaveRepoEntry | null {
  const name = normalizeScalar(repo.name);
  const mode = normalizeScalar(repo.mode);
  const repoPath = normalizeScalar(repo.path);
  if (name === undefined || repoPath === undefined || !isStaveRepoMode(mode)) {
    return null;
  }
  const base = normalizeScalar(repo.base);
  const ref = normalizeScalar(repo.ref);
  const branch = normalizeScalar(repo.branch);
  const bareRepoPath = normalizeScalar(repo.bareRepoPath);
  return {
    name,
    mode,
    path: repoPath,
    ...(base === undefined ? {} : { base }),
    ...(ref === undefined ? {} : { ref }),
    ...(branch === undefined ? {} : { branch }),
    ...(bareRepoPath === undefined ? {} : { bareRepoPath }),
  };
}

function isStaveRepoMode(mode: string | undefined): mode is StaveRepoMode {
  return mode === "edit" || mode === "reference";
}

function mapMemoryEntry(
  memory: NonNullable<StaveManifest["memories"]>[number],
): StaveMemoryEntry | null {
  const name = normalizeScalar(memory.name);
  const provider = normalizeScalar(memory.provider);
  const id = normalizeScalar(memory.id);
  if (name === undefined || provider === undefined || id === undefined) {
    return null;
  }
  return { name, provider, id, owned: memory.owned === true || memory.owned === "true" };
}

/** Attach the resolved identity only when present (`optionalKey` field). */
export function withPrimaryRepositoryIdentity(
  info: Omit<StaveProjectInfo, "primaryRepositoryIdentity">,
  primaryRepositoryIdentity: RepositoryIdentity | null,
): StaveProjectInfo {
  return primaryRepositoryIdentity === null ? info : { ...info, primaryRepositoryIdentity };
}

/**
 * Read and decode the manifest at `<workspaceRoot>/.stave.yaml`.
 *
 * Any failure (missing file, unreadable root, YAML syntax error, schema
 * mismatch) resolves to `Option.none` with a debug log — a non-Stave project
 * must never surface a warning.
 */
export const readManifest = Effect.fn("StaveWorkspaceReader.readManifest")(function* (
  workspaceRoot: string,
): Effect.fn.Return<Option.Option<StaveManifest>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(workspaceRoot, STAVE_MANIFEST_FILE_NAME);
  const ignore = (reason: string) =>
    Effect.logDebug("Ignoring Stave manifest").pipe(
      Effect.annotateLogs({ workspaceRoot, filePath, reason }),
      Effect.as(Option.none<StaveManifest>()),
    );

  const raw = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        ignore(`read failed: ${error.reason._tag}`).pipe(Effect.as(Option.none<string>())),
    }),
  );
  if (Option.isNone(raw)) {
    return Option.none();
  }

  const parsed = yield* Effect.try({
    try: () => parseYamlDocument(raw.value) as unknown,
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.map(Option.some),
    Effect.catch((message) =>
      ignore(`yaml parse failed: ${message}`).pipe(Effect.as(Option.none<unknown>())),
    ),
  );
  if (Option.isNone(parsed)) {
    return Option.none();
  }
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return yield* ignore("manifest is not a mapping");
  }

  return yield* decodeStaveManifest(parsed.value).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      SchemaError: (error) => ignore(`schema mismatch: ${error.message}`),
    }),
  );
});

export const make = Effect.fn("StaveWorkspaceReader.make")(function* (
  options: StaveWorkspaceReaderOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const loadUncached = Effect.fn("StaveWorkspaceReader.loadUncached")(function* (
    workspaceRoot: string,
  ) {
    const manifest = yield* readManifest(workspaceRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (Option.isNone(manifest)) {
      return Option.none<StaveProjectInfo>();
    }
    const info = mapManifestToProjectInfo({
      manifest: manifest.value,
      location: {
        workspaceRoot,
        parentBasename: path.basename(path.dirname(workspaceRoot)),
        basename: path.basename(workspaceRoot),
      },
      resolveRepoPath: (repoPath) => {
        if (repoPath.includes("\0")) return null;
        if (path.isAbsolute(repoPath)) return path.normalize(repoPath);
        const resolved = path.resolve(workspaceRoot, repoPath);
        const relative = path.relative(workspaceRoot, resolved);
        return relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
          ? null
          : resolved;
      },
    });
    if (info === null) {
      yield* Effect.logDebug("Stave manifest has no usable space id; ignoring").pipe(
        Effect.annotateLogs({
          workspaceRoot,
          filePath: path.join(workspaceRoot, STAVE_MANIFEST_FILE_NAME),
        }),
      );
      return Option.none<StaveProjectInfo>();
    }
    const repos = yield* Effect.forEach(
      info.repos,
      Effect.fn("StaveWorkspaceReader.resolveRepoIdentity")(function* (repo) {
        if (repo.resolvedPath === undefined) return repo;
        const identity = yield* repositoryIdentityResolver.resolve(repo.resolvedPath);
        return identity === null ? repo : { ...repo, repositoryIdentity: identity };
      }),
      { concurrency: 4 },
    );
    const primaryRepositoryIdentity =
      repos.find((repo) => repo.mode === "edit")?.repositoryIdentity ?? null;
    return Option.some(
      withPrimaryRepositoryIdentity({ ...info, repos }, primaryRepositoryIdentity),
    );
  });

  const cache = yield* Cache.makeWith<string, Option.Option<StaveProjectInfo>>(loadUncached, {
    capacity: options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: (value) =>
        Option.isSome(value)
          ? (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL)
          : (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL),
      onFailure: () => Duration.zero,
    }),
  });

  return StaveWorkspaceReader.of({
    load: (workspaceRoot) => Cache.get(cache, workspaceRoot),
    invalidate: (workspaceRoot) => Cache.invalidate(cache, workspaceRoot),
    invalidateAll: () => Cache.invalidateAll(cache),
  });
});

export const layer = Layer.effect(StaveWorkspaceReader, make());

/** Reader that finds no manifest anywhere — for tests whose roots are not spaces. */
export const layerNoop = Layer.succeed(
  StaveWorkspaceReader,
  StaveWorkspaceReader.of({
    load: () => Effect.succeed(Option.none()),
    invalidate: () => Effect.void,
    invalidateAll: () => Effect.void,
  }),
);
