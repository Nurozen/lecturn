#!/usr/bin/env node

import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  STAVE_PLATFORM_KEYS,
  type StavePlatformKey,
  staveAssetName,
  staveAssetTarget,
} from "@t3tools/shared/stave";

export const STAVE_REPOSITORY = "Nurozen/stave";
export const STAVE_VERSION_FILE_NAME = "stave.version";

const STAVE_USER_AGENT = "lecturn-fetch-stave";
const STAVE_LATEST_RELEASE_URL = `https://api.github.com/repos/${STAVE_REPOSITORY}/releases/latest`;
const STAVE_CHECKSUMS_FILE_NAME = "checksums.txt";
const STAVE_LICENSE_FILE_NAME = "LICENSE";
const STAVE_TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const CHECKSUM_LINE_PATTERN = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/;

export type StaveArchiveFormat = "zip" | "tar.gz";

export type StaveTagInput =
  | { readonly kind: "latest" }
  | { readonly kind: "tag"; readonly tag: string };

export class StaveTagInputError extends Schema.TaggedErrorClass<StaveTagInputError>()(
  "StaveTagInputError",
  {
    input: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Stave version '${this.input}': expected 'latest' or a release tag like v0.4.0.`;
  }
}

export class StaveLatestReleaseError extends Schema.TaggedErrorClass<StaveLatestReleaseError>()(
  "StaveLatestReleaseError",
  {
    operation: Schema.Literals(["config", "request", "status", "read", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the latest ${STAVE_REPOSITORY} release from ${STAVE_LATEST_RELEASE_URL}.`;
  }
}

export class StaveDownloadError extends Schema.TaggedErrorClass<StaveDownloadError>()(
  "StaveDownloadError",
  {
    operation: Schema.Literals(["request", "status", "read"]),
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${this.url}.`;
  }
}

export class StaveChecksumMissingError extends Schema.TaggedErrorClass<StaveChecksumMissingError>()(
  "StaveChecksumMissingError",
  {
    tag: Schema.String,
    assetName: Schema.String,
  },
) {
  override get message(): string {
    return `${STAVE_CHECKSUMS_FILE_NAME} for ${this.tag} has no entry for ${this.assetName}.`;
  }
}

export class StaveChecksumMismatchError extends Schema.TaggedErrorClass<StaveChecksumMismatchError>()(
  "StaveChecksumMismatchError",
  {
    assetName: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  },
) {
  override get message(): string {
    return `sha256 mismatch for ${this.assetName}: expected ${this.expected}, got ${this.actual}.`;
  }
}

export class StaveArchiveError extends Schema.TaggedErrorClass<StaveArchiveError>()(
  "StaveArchiveError",
  {
    format: Schema.Literals(["zip", "tar.gz"]),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read Stave ${this.format} archive: ${this.reason}.`;
  }
}

export class StaveBinaryMissingError extends Schema.TaggedErrorClass<StaveBinaryMissingError>()(
  "StaveBinaryMissingError",
  {
    platformKey: Schema.String,
    executableName: Schema.String,
    members: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Stave archive for ${this.platformKey} has no ${this.executableName} member (found: ${this.members.join(", ") || "none"}).`;
  }
}

export class StaveExtractWriteError extends Schema.TaggedErrorClass<StaveExtractWriteError>()(
  "StaveExtractWriteError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write extracted Stave file ${this.path}.`;
  }
}

export class StaveCliUsageError extends Schema.TaggedErrorClass<StaveCliUsageError>()(
  "StaveCliUsageError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `fetch-stave: ${this.reason}`;
  }
}

export class StaveGitHubOutputConfigError extends Schema.TaggedErrorClass<StaveGitHubOutputConfigError>()(
  "StaveGitHubOutputConfigError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve the GITHUB_OUTPUT path for the Stave tag.";
  }
}

export class StaveGitHubOutputAppendError extends Schema.TaggedErrorClass<StaveGitHubOutputAppendError>()(
  "StaveGitHubOutputAppendError",
  {
    outputPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append the Stave tag to ${this.outputPath}.`;
  }
}

export const staveExecutableName = (platformKey: StavePlatformKey) =>
  platformKey.startsWith("win32-") ? "stave.exe" : "stave";

/**
 * Accepts `latest`, a `vX.Y.Z[-pre]` tag, or a bare `X.Y.Z[-pre]` version
 * (normalised to the tag form Stave publishes).
 */
export const parseStaveTagInput = (input: string) => {
  const trimmed = input.trim();
  if (trimmed === "latest") {
    return Effect.succeed<StaveTagInput>({ kind: "latest" });
  }
  const match = STAVE_TAG_PATTERN.exec(trimmed);
  const version = match?.[1];
  if (version === undefined) {
    return Effect.fail(new StaveTagInputError({ input }));
  }
  return Effect.succeed<StaveTagInput>({ kind: "tag", tag: `v${version}` });
};

const LatestReleaseSchema = Schema.Struct({
  tag_name: Schema.NonEmptyString,
});
const decodeLatestRelease = Schema.decodeUnknownEffect(LatestReleaseSchema);

export const parseLatestReleaseResponse = (json: unknown) =>
  decodeLatestRelease(json).pipe(
    Effect.map((release) => release.tag_name),
    Effect.mapError((cause) => new StaveLatestReleaseError({ operation: "decode", cause })),
  );

const GitHubToken = Config.string("GITHUB_TOKEN").pipe(
  Config.option,
  Config.map((token) => Option.filter(token, (value) => value.length > 0)),
);

const fetchLatestStaveTag = Effect.fn("fetchLatestStaveTag")(function* () {
  const client = yield* HttpClient.HttpClient;
  const token = yield* GitHubToken.pipe(
    Effect.mapError((cause) => new StaveLatestReleaseError({ operation: "config", cause })),
  );
  const request = HttpClientRequest.get(STAVE_LATEST_RELEASE_URL).pipe(
    HttpClientRequest.setHeaders({
      Accept: "application/vnd.github+json",
      "User-Agent": STAVE_USER_AGENT,
    }),
    Option.isSome(token) ? HttpClientRequest.bearerToken(token.value) : (self) => self,
  );
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((cause) => new StaveLatestReleaseError({ operation: "request", cause })));
  yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.mapError((cause) => new StaveLatestReleaseError({ operation: "status", cause })),
  );
  const json = yield* response.json.pipe(
    Effect.mapError((cause) => new StaveLatestReleaseError({ operation: "read", cause })),
  );
  return yield* parseLatestReleaseResponse(json);
});

/** Explicit tags pass straight through; only `latest` consults the GitHub API. */
export const resolveStaveTag = (input: StaveTagInput) =>
  input.kind === "tag" ? Effect.succeed(input.tag) : fetchLatestStaveTag();

/**
 * Parses goreleaser `checksums.txt` lines (`<sha256>  <file>`), tolerating the
 * `*` binary-mode marker, CRLF line endings and blank lines.
 */
export const parseChecksums = (text: string): ReadonlyMap<string, string> => {
  const checksums = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const match = CHECKSUM_LINE_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const [, digest, fileName] = match;
    if (digest !== undefined && fileName !== undefined) {
      checksums.set(fileName.trim(), digest.toLowerCase());
    }
  }
  return checksums;
};

export const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const verifyChecksum = (bytes: Uint8Array, expectedHex: string) =>
  sha256Hex(bytes) === expectedHex.trim().toLowerCase();

/** Last path segment of an archive member name, so nested layouts still match by file name. */
const archiveBaseName = (name: string) =>
  name.split("/").findLast((segment) => segment.length > 0) ?? "";

interface ArchiveMember {
  readonly name: string;
  readonly data: Uint8Array;
}

const asciiDecoder = new TextDecoder("utf-8");

const readTarField = (header: Uint8Array, offset: number, length: number) => {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return asciiDecoder.decode(end === -1 ? field : field.subarray(0, end));
};

const readTarOctal = (header: Uint8Array, offset: number, length: number) => {
  const text = readTarField(header, offset, length).trim();
  if (text.length === 0) {
    return 0;
  }
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value)) {
    throw new StaveArchiveError({ format: "tar.gz", reason: `invalid octal field '${text}'` });
  }
  return value;
};

const TAR_BLOCK_SIZE = 512;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_LENGTH = 8;
const TAR_TYPEFLAG_OFFSET = 156;

const isZeroBlock = (block: Uint8Array) => block.every((byte) => byte === 0);

/** Sum of header bytes with the checksum field treated as eight spaces, per ustar. */
const tarHeaderChecksum = (header: Uint8Array) => {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    const inChecksumField =
      index >= TAR_CHECKSUM_OFFSET && index < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH;
    sum += inChecksumField ? 0x20 : (header[index] ?? 0);
  }
  return sum;
};

/**
 * Walks ustar headers and returns regular-file members. Directory, pax and
 * GNU long-name entries are skipped by consuming their payload blocks.
 */
const readTarMembers = (tar: Uint8Array): ReadonlyArray<ArchiveMember> => {
  const members: Array<ArchiveMember> = [];
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) {
      break;
    }
    const expectedChecksum = readTarOctal(header, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_LENGTH);
    if (tarHeaderChecksum(header) !== expectedChecksum) {
      throw new StaveArchiveError({
        format: "tar.gz",
        reason: `header checksum mismatch at offset ${offset}`,
      });
    }
    const size = readTarOctal(header, 124, 12);
    const typeflag = header[TAR_TYPEFLAG_OFFSET] ?? 0;
    const dataStart = offset + TAR_BLOCK_SIZE;
    if (dataStart + size > tar.length) {
      throw new StaveArchiveError({ format: "tar.gz", reason: "truncated member payload" });
    }
    // `\0` and `0` are regular files; `7` (contiguous) is treated the same by GNU tar.
    if (typeflag === 0 || typeflag === 0x30 || typeflag === 0x37) {
      const name = readTarField(header, 0, 100);
      const prefix = readTarField(header, 345, 155);
      members.push({
        name: prefix.length > 0 ? `${prefix}/${name}` : name,
        data: tar.slice(dataStart, dataStart + size),
      });
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return members;
};

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;

const locateZipEndOfCentralDirectory = (zip: Uint8Array, view: DataView) => {
  const lowest = Math.max(0, zip.length - ZIP_EOCD_MIN_LENGTH - ZIP_MAX_COMMENT_LENGTH);
  for (let index = zip.length - ZIP_EOCD_MIN_LENGTH; index >= lowest; index -= 1) {
    if (view.getUint32(index, true) === ZIP_EOCD_SIGNATURE) {
      return index;
    }
  }
  throw new StaveArchiveError({ format: "zip", reason: "end of central directory not found" });
};

/**
 * Walks the central directory (whose sizes are authoritative even when local
 * headers defer them to a data descriptor) and inflates stored/deflated members.
 */
const readZipMembers = (zip: Uint8Array): ReadonlyArray<ArchiveMember> => {
  if (zip.length < ZIP_EOCD_MIN_LENGTH) {
    throw new StaveArchiveError({ format: "zip", reason: "archive too small" });
  }
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = locateZipEndOfCentralDirectory(zip, view);
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const members: Array<ArchiveMember> = [];
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (cursor + 46 > zip.length || view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new StaveArchiveError({
        format: "zip",
        reason: `central directory entry ${entry} is malformed`,
      });
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = asciiDecoder.decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) {
      continue;
    }
    if (
      localOffset + 30 > zip.length ||
      view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE
    ) {
      throw new StaveArchiveError({
        format: "zip",
        reason: `local header for ${name} is malformed`,
      });
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > zip.length) {
      throw new StaveArchiveError({ format: "zip", reason: `member ${name} is truncated` });
    }
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === ZIP_METHOD_STORED) {
      members.push({ name, data: new Uint8Array(compressed) });
    } else if (method === ZIP_METHOD_DEFLATE) {
      members.push({ name, data: new Uint8Array(NodeZlib.inflateRawSync(compressed)) });
    } else {
      throw new StaveArchiveError({
        format: "zip",
        reason: `member ${name} uses unsupported compression method ${method}`,
      });
    }
  }
  return members;
};

const isStaveArchiveError = Schema.is(StaveArchiveError);

const readArchiveMembers = (archive: Uint8Array, format: StaveArchiveFormat) =>
  Effect.try({
    try: () =>
      format === "zip"
        ? readZipMembers(archive)
        : readTarMembers(new Uint8Array(NodeZlib.gunzipSync(archive))),
    catch: (cause) =>
      isStaveArchiveError(cause)
        ? cause
        : new StaveArchiveError({ format, reason: "archive could not be decoded", cause }),
  });

export interface ExtractStaveArchiveOptions {
  readonly archive: Uint8Array;
  readonly format: StaveArchiveFormat;
  readonly platformKey: StavePlatformKey;
  readonly outDir: string;
  readonly tag: string;
}

/**
 * Flattens the archive into `<outDir>/<platformKey>/`, keeping only the
 * binary and LICENSE, marks the binary executable and records the tag in
 * `stave.version`.
 */
export const extractStaveArchive = Effect.fn("extractStaveArchive")(function* (
  options: ExtractStaveArchiveOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executableName = staveExecutableName(options.platformKey);
  const members = yield* readArchiveMembers(options.archive, options.format);
  const byBaseName = new Map(members.map((member) => [archiveBaseName(member.name), member]));
  const executable = byBaseName.get(executableName);
  if (executable === undefined) {
    return yield* new StaveBinaryMissingError({
      platformKey: options.platformKey,
      executableName,
      members: members.map((member) => member.name),
    });
  }

  const directory = path.join(options.outDir, options.platformKey);
  const executablePath = path.join(directory, executableName);
  const versionPath = path.join(directory, STAVE_VERSION_FILE_NAME);
  const writeError = (target: string) => (cause: unknown) =>
    new StaveExtractWriteError({ path: target, cause });

  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError(writeError(directory)));
  yield* fs
    .writeFile(executablePath, executable.data)
    .pipe(Effect.mapError(writeError(executablePath)));
  const hostPlatform = yield* HostProcessPlatform;
  if (hostPlatform !== "win32") {
    yield* fs.chmod(executablePath, 0o755).pipe(Effect.mapError(writeError(executablePath)));
  }
  const license = byBaseName.get(STAVE_LICENSE_FILE_NAME);
  if (license !== undefined) {
    const licensePath = path.join(directory, STAVE_LICENSE_FILE_NAME);
    yield* fs.writeFile(licensePath, license.data).pipe(Effect.mapError(writeError(licensePath)));
  }
  yield* fs
    .writeFileString(versionPath, `${options.tag}\n`)
    .pipe(Effect.mapError(writeError(versionPath)));

  return { directory, executablePath, versionPath } as const;
});

const downloadReleaseFile = Effect.fn("downloadReleaseFile")(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeaders({ "User-Agent": STAVE_USER_AGENT }),
  );
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((cause) => new StaveDownloadError({ operation: "request", url, cause })));
  yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.mapError((cause) => new StaveDownloadError({ operation: "status", url, cause })),
  );
  return response;
});

const readResponseError = (url: string) => (cause: unknown) =>
  new StaveDownloadError({ operation: "read", url, cause });

export interface FetchStaveOptions {
  readonly tag: string;
  readonly platformKey: StavePlatformKey;
  readonly outDir: string;
}

/**
 * Downloads the release asset for one platform key, verifies it against the
 * published checksums and extracts it under `<outDir>/<platformKey>/`.
 */
export const fetchStave = Effect.fn("fetchStave")(function* (options: FetchStaveOptions) {
  const assetName = staveAssetName(options.tag, options.platformKey);
  const baseUrl = `https://github.com/${STAVE_REPOSITORY}/releases/download/${options.tag}`;
  const checksumsUrl = `${baseUrl}/${STAVE_CHECKSUMS_FILE_NAME}`;
  const assetUrl = `${baseUrl}/${assetName}`;

  const checksumsResponse = yield* downloadReleaseFile(checksumsUrl);
  const checksumsText = yield* checksumsResponse.text.pipe(
    Effect.mapError(readResponseError(checksumsUrl)),
  );
  const expected = parseChecksums(checksumsText).get(assetName);
  if (expected === undefined) {
    return yield* new StaveChecksumMissingError({ tag: options.tag, assetName });
  }

  const assetResponse = yield* downloadReleaseFile(assetUrl);
  const archive = new Uint8Array(
    yield* assetResponse.arrayBuffer.pipe(Effect.mapError(readResponseError(assetUrl))),
  );
  if (!verifyChecksum(archive, expected)) {
    return yield* new StaveChecksumMismatchError({
      assetName,
      expected,
      actual: sha256Hex(archive),
    });
  }

  const extracted = yield* extractStaveArchive({
    archive,
    format: staveAssetTarget(options.platformKey).ext,
    platformKey: options.platformKey,
    outDir: options.outDir,
    tag: options.tag,
  });
  yield* Console.error(
    `fetch-stave: ${options.platformKey} ${options.tag} (${assetName}) -> ${extracted.directory}`,
  );
  return extracted;
});

export type FetchStaveMode =
  | { readonly kind: "resolve-only" }
  | { readonly kind: "single"; readonly platformKey: StavePlatformKey; readonly outDir: string }
  | { readonly kind: "all"; readonly outDir: string };

export interface FetchStaveModeFlags {
  readonly platformKey: Option.Option<StavePlatformKey>;
  readonly all: boolean;
  readonly resolveOnly: boolean;
  readonly out: Option.Option<string>;
}

/** Exactly one of `--platform-key`, `--all` and `--resolve-only`; `--out` is required for the fetching modes. */
export const resolveFetchStaveMode = (flags: FetchStaveModeFlags) => {
  const selected = [Option.isSome(flags.platformKey), flags.all, flags.resolveOnly].filter(
    Boolean,
  ).length;
  if (selected !== 1) {
    return Effect.fail(
      new StaveCliUsageError({
        reason: "specify exactly one of --platform-key <key>, --all or --resolve-only.",
      }),
    );
  }
  if (flags.resolveOnly) {
    return Effect.succeed<FetchStaveMode>({ kind: "resolve-only" });
  }
  if (Option.isNone(flags.out)) {
    return Effect.fail(
      new StaveCliUsageError({ reason: "--out <dir> is required unless --resolve-only is set." }),
    );
  }
  const outDir = flags.out.value;
  return Effect.succeed<FetchStaveMode>(
    Option.isSome(flags.platformKey)
      ? { kind: "single", platformKey: flags.platformKey.value, outDir }
      : { kind: "all", outDir },
  );
};

export const writeStaveTagOutput = Effect.fn("writeStaveTagOutput")(function* (
  tag: string,
  writeGithubOutput: boolean,
) {
  yield* Console.log(`stave_tag=${tag}`);
  if (!writeGithubOutput) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError((cause) => new StaveGitHubOutputConfigError({ cause })),
  );
  yield* fs
    .writeFileString(githubOutputPath, `stave_tag=${tag}\n`, { flag: "a" })
    .pipe(
      Effect.mapError(
        (cause) => new StaveGitHubOutputAppendError({ outputPath: githubOutputPath, cause }),
      ),
    );
});

export interface RunFetchStaveOptions extends FetchStaveModeFlags {
  readonly version: string;
  readonly githubOutput: boolean;
}

export const runFetchStave = Effect.fn("runFetchStave")(function* (options: RunFetchStaveOptions) {
  const mode = yield* resolveFetchStaveMode(options);
  const path = yield* Path.Path;
  const tagInput = yield* parseStaveTagInput(options.version);
  const tag = yield* resolveStaveTag(tagInput);
  if (mode.kind === "single") {
    yield* fetchStave({ tag, platformKey: mode.platformKey, outDir: path.resolve(mode.outDir) });
  } else if (mode.kind === "all") {
    const outDir = path.resolve(mode.outDir);
    yield* Effect.forEach(
      STAVE_PLATFORM_KEYS,
      (platformKey) => fetchStave({ tag, platformKey, outDir }),
      { concurrency: 2, discard: true },
    );
  }
  yield* writeStaveTagOutput(tag, options.githubOutput);
  return tag;
});

const command = Command.make(
  "fetch-stave",
  {
    version: Flag.string("version").pipe(
      Flag.withDescription("Stave release tag (v0.4.0), bare version (0.4.0) or 'latest'."),
      Flag.withDefault("latest"),
    ),
    platformKey: Flag.choice("platform-key", STAVE_PLATFORM_KEYS).pipe(
      Flag.withDescription("Fetch the binary for a single Lecturn platform key."),
      Flag.optional,
    ),
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Fetch binaries for every supported platform key."),
      Flag.withDefault(false),
    ),
    resolveOnly: Flag.boolean("resolve-only").pipe(
      Flag.withDescription("Only resolve the release tag; download nothing."),
      Flag.withDefault(false),
    ),
    out: Flag.string("out").pipe(
      Flag.withDescription("Directory receiving <platform-key>/ subdirectories."),
      Flag.optional,
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Also append stave_tag=<tag> to GITHUB_OUTPUT."),
      Flag.withDefault(false),
    ),
  },
  (flags) => runFetchStave(flags),
).pipe(Command.withDescription(`Download the Stave binary from ${STAVE_REPOSITORY} releases.`));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
