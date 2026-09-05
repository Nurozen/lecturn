/**
 * Pure helpers shared by every layer that talks about Stave: identifier
 * validation, the `space:<id>` base-ref sugar, release asset naming for the
 * bundled binary, and parsing of `stave version` output. No Node imports so
 * web and mobile can consume this module as-is.
 */

/** Stave's own rule for space, saga and repo names (see Stave `internal/space`). */
export const STAVE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidStaveSpaceId(id: string): boolean {
  return STAVE_NAME_PATTERN.test(id);
}

export type StaveBaseRef =
  | { readonly kind: "space"; readonly spaceId: string }
  | { readonly kind: "ref"; readonly ref: string };

const STAVE_SPACE_REF_PREFIX = "space:";

/**
 * Splits the `space:<id>` sugar off a base ref. Anything else is passed
 * through as a plain git ref; the space id is returned unvalidated so callers
 * can surface a precise error via `isValidStaveSpaceId`.
 */
export function parseStaveBaseRef(ref: string): StaveBaseRef {
  const trimmed = ref.trim();
  if (trimmed.startsWith(STAVE_SPACE_REF_PREFIX)) {
    return { kind: "space", spaceId: trimmed.slice(STAVE_SPACE_REF_PREFIX.length).trim() };
  }
  return { kind: "ref", ref: trimmed };
}

export const STAVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
] as const;

export type StavePlatformKey = (typeof STAVE_PLATFORM_KEYS)[number];

export interface StaveAssetTarget {
  readonly os: "darwin" | "linux" | "windows";
  readonly arch: "arm64" | "amd64";
  readonly ext: "zip" | "tar.gz";
}

export function isStavePlatformKey(value: string): value is StavePlatformKey {
  return (STAVE_PLATFORM_KEYS as ReadonlyArray<string>).includes(value);
}

/**
 * Maps a Lecturn platform key onto the goreleaser os/arch pair and archive
 * format Stave publishes (zip for darwin and windows, tar.gz for linux).
 */
export function staveAssetTarget(platformKey: StavePlatformKey): StaveAssetTarget {
  switch (platformKey) {
    case "darwin-arm64":
      return { os: "darwin", arch: "arm64", ext: "zip" };
    case "darwin-x64":
      return { os: "darwin", arch: "amd64", ext: "zip" };
    case "linux-x64":
      return { os: "linux", arch: "amd64", ext: "tar.gz" };
    case "linux-arm64":
      return { os: "linux", arch: "arm64", ext: "tar.gz" };
    case "win32-x64":
      return { os: "windows", arch: "amd64", ext: "zip" };
    case "win32-arm64":
      return { os: "windows", arch: "arm64", ext: "zip" };
  }
}

export function stripStaveVersionPrefix(version: string): string {
  return version.trim().replace(/^v/, "");
}

/**
 * Release asset file name for a Stave version, matching the goreleaser
 * template `{{ProjectName}}_{{Version}}_{{Os}}_{{Arch}}` (version without `v`).
 */
export function staveAssetName(version: string, platformKey: StavePlatformKey): string {
  const target = staveAssetTarget(platformKey);
  return `stave_${stripStaveVersionPrefix(version)}_${target.os}_${target.arch}.${target.ext}`;
}

export interface StaveVersionInfo {
  readonly version: string;
  readonly commit?: string;
  readonly date?: string;
}

const STAVE_VERSION_LINE = /^stave\s+(\S+)\s*$/;

/**
 * Parses `stave version` output:
 *
 *     stave v0.4.0
 *     commit: 1a2b3c4
 *     date: 2026-08-30T12:00:00Z
 *
 * The leading `v` is dropped from the version; dev builds report `dev`.
 * Missing or `unknown` commit/date lines are omitted. Returns null when the
 * first non-empty line is not a `stave <version>` header.
 */
export function parseStaveVersionOutput(text: string): StaveVersionInfo | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0];
  if (header === undefined) {
    return null;
  }
  const match = STAVE_VERSION_LINE.exec(header);
  const rawVersion = match?.[1];
  if (rawVersion === undefined) {
    return null;
  }

  const info: { version: string; commit?: string; date?: string } = {
    version: stripStaveVersionPrefix(rawVersion),
  };
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value.length === 0 || value === "unknown") {
      continue;
    }
    if (key === "commit") {
      info.commit = value;
    } else if (key === "date") {
      info.date = value;
    }
  }
  return info;
}

const PATH_SEPARATORS = /[\\/]+/;

function toPathSegments(path: string): ReadonlyArray<string> {
  return path.split(PATH_SEPARATORS).filter((segment) => segment.length > 0);
}

/**
 * Lexical "is `child` strictly inside `parent`" on already-normalized paths.
 * Compares whole segments across POSIX and Windows separators so `/a/bc` is
 * not a descendant of `/a/b`, and a path is never its own descendant.
 */
export function isPathSegmentDescendant(parent: string, child: string): boolean {
  const parentSegments = toPathSegments(parent);
  const childSegments = toPathSegments(child);
  if (childSegments.length <= parentSegments.length) {
    return false;
  }
  return parentSegments.every((segment, index) => childSegments[index] === segment);
}
