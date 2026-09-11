import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { HostProcessPlatform } from "@lecturn/shared/hostProcess";
import { STAVE_PLATFORM_KEYS, staveAssetName } from "@lecturn/shared/stave";

import {
  STAVE_REPOSITORY,
  STAVE_VERSION_FILE_NAME,
  extractStaveArchive,
  parseChecksums,
  parseLatestReleaseResponse,
  parseStaveTagInput,
  resolveFetchStaveMode,
  resolveStaveTag,
  sha256Hex,
  staveExecutableName,
  verifyChecksum,
} from "./fetch-stave.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FixtureMember {
  readonly name: string;
  readonly data: Uint8Array;
  readonly kind?: "file" | "directory" | "pax";
  readonly method?: 0 | 8;
}

const writeAscii = (target: Uint8Array, offset: number, text: string) => {
  target.set(encoder.encode(text), offset);
};

const tarOctal = (value: number, width: number) =>
  `${value.toString(8).padStart(width - 1, "0")}\0`;

/** Hand-rolls a ustar header block with a valid checksum for one member. */
const tarHeader = (member: FixtureMember) => {
  const header = new Uint8Array(512);
  writeAscii(header, 0, member.name);
  writeAscii(header, 100, tarOctal(member.kind === "directory" ? 0o755 : 0o644, 8));
  writeAscii(header, 108, tarOctal(0, 8));
  writeAscii(header, 116, tarOctal(0, 8));
  writeAscii(header, 124, tarOctal(member.data.length, 12));
  writeAscii(header, 136, tarOctal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = member.kind === "directory" ? 0x35 : member.kind === "pax" ? 0x78 : 0x30;
  writeAscii(header, 257, "ustar\0");
  writeAscii(header, 263, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
};

const buildTarGz = (members: ReadonlyArray<FixtureMember>) => {
  const blocks: Array<Uint8Array> = [];
  for (const member of members) {
    blocks.push(tarHeader(member));
    const padded = new Uint8Array(Math.ceil(member.data.length / 512) * 512);
    padded.set(member.data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.length;
  }
  return new Uint8Array(NodeZlib.gzipSync(tar));
};

const u16 = (view: DataView, offset: number, value: number) => view.setUint16(offset, value, true);
const u32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value, true);

/** Hand-rolls a zip with local headers, a central directory and an EOCD record. */
const buildZip = (members: ReadonlyArray<FixtureMember>) => {
  const locals: Array<Uint8Array> = [];
  const centrals: Array<Uint8Array> = [];
  let localOffset = 0;
  for (const member of members) {
    const name = encoder.encode(member.name);
    const method = member.method ?? 0;
    const payload =
      method === 8 ? new Uint8Array(NodeZlib.deflateRawSync(member.data)) : member.data;
    const crc = NodeZlib.crc32(member.data);

    const local = new Uint8Array(30 + name.length + payload.length);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x04034b50);
    u16(localView, 4, 20);
    u16(localView, 6, 0);
    u16(localView, 8, method);
    u16(localView, 10, 0);
    u16(localView, 12, 0x21);
    u32(localView, 14, crc);
    u32(localView, 18, payload.length);
    u32(localView, 22, member.data.length);
    u16(localView, 26, name.length);
    u16(localView, 28, 0);
    local.set(name, 30);
    local.set(payload, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x02014b50);
    u16(centralView, 4, 20);
    u16(centralView, 6, 20);
    u16(centralView, 8, 0);
    u16(centralView, 10, method);
    u16(centralView, 12, 0);
    u16(centralView, 14, 0x21);
    u32(centralView, 16, crc);
    u32(centralView, 20, payload.length);
    u32(centralView, 24, member.data.length);
    u16(centralView, 28, name.length);
    u16(centralView, 30, 0);
    u16(centralView, 32, 0);
    u16(centralView, 34, 0);
    u16(centralView, 36, 0);
    u32(centralView, 38, 0);
    u32(centralView, 42, localOffset);
    central.set(name, 46);
    centrals.push(central);

    localOffset += local.length;
  }

  const centralSize = centrals.reduce((sum, block) => sum + block.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  u32(eocdView, 0, 0x06054b50);
  u16(eocdView, 4, 0);
  u16(eocdView, 6, 0);
  u16(eocdView, 8, members.length);
  u16(eocdView, 10, members.length);
  u32(eocdView, 12, centralSize);
  u32(eocdView, 16, localOffset);
  u16(eocdView, 20, 0);

  const zip = new Uint8Array(localOffset + centralSize + eocd.length);
  let offset = 0;
  for (const block of [...locals, ...centrals, eocd]) {
    zip.set(block, offset);
    offset += block.length;
  }
  return zip;
};

const binaryBytes = encoder.encode("#!/bin/sh\necho stave v9.9.9\n");
const licenseBytes = encoder.encode("MIT License\n");
const readmeBytes = encoder.encode("# stave\n");

const checksumsFixture = [
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  stave_0.4.0_darwin_arm64.zip\r",
  "",
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB *stave_0.4.0_linux_amd64.tar.gz\r",
  "not a checksum line",
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  stave_0.4.0_windows_arm64.zip",
  "",
].join("\n");

it("exposes the Stave repository and version file constants", () => {
  assert.equal(STAVE_REPOSITORY, "Nurozen/stave");
  assert.equal(STAVE_VERSION_FILE_NAME, "stave.version");
});

it("names the executable per platform family", () => {
  assert.equal(staveExecutableName("darwin-arm64"), "stave");
  assert.equal(staveExecutableName("linux-x64"), "stave");
  assert.equal(staveExecutableName("win32-x64"), "stave.exe");
  assert.equal(staveExecutableName("win32-arm64"), "stave.exe");
});

it.effect("parses latest, prefixed, bare and prerelease tag inputs", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseStaveTagInput("latest"), { kind: "latest" });
    assert.deepStrictEqual(yield* parseStaveTagInput(" latest "), { kind: "latest" });
    assert.deepStrictEqual(yield* parseStaveTagInput("v0.4.0"), { kind: "tag", tag: "v0.4.0" });
    assert.deepStrictEqual(yield* parseStaveTagInput("0.4.0"), { kind: "tag", tag: "v0.4.0" });
    assert.deepStrictEqual(yield* parseStaveTagInput("v1.2.3-rc.1"), {
      kind: "tag",
      tag: "v1.2.3-rc.1",
    });
  }),
);

it.effect("rejects tag inputs that are neither latest nor a release tag", () =>
  Effect.gen(function* () {
    for (const input of ["", "main", "v1.2", "1.2.3.4", "latest-ish", "v0.4.0/../x"]) {
      const error = yield* parseStaveTagInput(input).pipe(Effect.flip);
      assert.equal(error._tag, "StaveTagInputError");
      assert.equal(error.input, input);
      assert.include(error.message, "expected 'latest' or a release tag");
    }
  }),
);

it.effect("decodes the tag name from a latest release payload", () =>
  Effect.gen(function* () {
    const tag = yield* parseLatestReleaseResponse({
      url: "https://api.github.com/repos/Nurozen/stave/releases/1",
      tag_name: "v0.4.0",
      name: "v0.4.0",
      assets: [],
    });
    assert.equal(tag, "v0.4.0");

    const error = yield* parseLatestReleaseResponse({ name: "no tag" }).pipe(Effect.flip);
    assert.equal(error._tag, "StaveLatestReleaseError");
    assert.equal(error.operation, "decode");
  }),
);

it("derives goreleaser asset names for every platform key", () => {
  assert.deepStrictEqual(
    STAVE_PLATFORM_KEYS.map((key) => [key, staveAssetName("v0.4.0", key)]),
    [
      ["darwin-arm64", "stave_0.4.0_darwin_arm64.zip"],
      ["darwin-x64", "stave_0.4.0_darwin_amd64.zip"],
      ["linux-x64", "stave_0.4.0_linux_amd64.tar.gz"],
      ["linux-arm64", "stave_0.4.0_linux_arm64.tar.gz"],
      ["win32-x64", "stave_0.4.0_windows_amd64.zip"],
      ["win32-arm64", "stave_0.4.0_windows_arm64.zip"],
    ],
  );
});

it("parses checksums with CRLF endings, binary markers and blank lines", () => {
  const checksums = parseChecksums(checksumsFixture);
  assert.equal(checksums.size, 3);
  assert.equal(checksums.get("stave_0.4.0_darwin_arm64.zip"), "a".repeat(64));
  assert.equal(checksums.get("stave_0.4.0_linux_amd64.tar.gz"), "b".repeat(64));
  assert.equal(checksums.get("stave_0.4.0_windows_arm64.zip"), "c".repeat(64));
});

it("verifies sha256 digests case-insensitively", () => {
  const digest = sha256Hex(binaryBytes);
  assert.equal(digest.length, 64);
  assert.isTrue(verifyChecksum(binaryBytes, digest));
  assert.isTrue(verifyChecksum(binaryBytes, digest.toUpperCase()));
  assert.isFalse(verifyChecksum(binaryBytes, "0".repeat(64)));
  assert.isFalse(verifyChecksum(licenseBytes, digest));
});

it.effect("resolves the CLI mode from exactly one selector", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* resolveFetchStaveMode({
        platformKey: Option.some("linux-x64"),
        all: false,
        resolveOnly: false,
        out: Option.some("dist"),
      }),
      { kind: "single", platformKey: "linux-x64", outDir: "dist" },
    );
    assert.deepStrictEqual(
      yield* resolveFetchStaveMode({
        platformKey: Option.none(),
        all: true,
        resolveOnly: false,
        out: Option.some("dist"),
      }),
      { kind: "all", outDir: "dist" },
    );
    assert.deepStrictEqual(
      yield* resolveFetchStaveMode({
        platformKey: Option.none(),
        all: false,
        resolveOnly: true,
        out: Option.none(),
      }),
      { kind: "resolve-only" },
    );

    const none = yield* resolveFetchStaveMode({
      platformKey: Option.none(),
      all: false,
      resolveOnly: false,
      out: Option.some("dist"),
    }).pipe(Effect.flip);
    assert.equal(none._tag, "StaveCliUsageError");
    assert.include(none.message, "exactly one of");

    const both = yield* resolveFetchStaveMode({
      platformKey: Option.some("darwin-x64"),
      all: true,
      resolveOnly: false,
      out: Option.some("dist"),
    }).pipe(Effect.flip);
    assert.equal(both._tag, "StaveCliUsageError");

    const missingOut = yield* resolveFetchStaveMode({
      platformKey: Option.none(),
      all: true,
      resolveOnly: false,
      out: Option.none(),
    }).pipe(Effect.flip);
    assert.equal(missingOut._tag, "StaveCliUsageError");
    assert.include(missingOut.message, "--out <dir> is required");
  }),
);

it.layer(NodeServices.layer)("extractStaveArchive", (it) => {
  const assertExtracted = Effect.fn(function* (
    directory: string,
    executableName: string,
    tag: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const executable = yield* fs.readFile(path.join(directory, executableName));
    assert.equal(decoder.decode(executable), decoder.decode(binaryBytes));
    const license = yield* fs.readFileString(path.join(directory, "LICENSE"));
    assert.equal(license, "MIT License\n");
    const version = yield* fs.readFileString(path.join(directory, STAVE_VERSION_FILE_NAME));
    assert.equal(version, `${tag}\n`);
    assert.isFalse(yield* fs.exists(path.join(directory, "README.md")));
    assert.isFalse(yield* fs.exists(path.join(directory, "docs")));

    const hostPlatform = yield* HostProcessPlatform;
    if (hostPlatform !== "win32") {
      const info = yield* fs.stat(path.join(directory, executableName));
      assert.notEqual(info.mode & 0o111, 0);
    }
  });

  it.effect("extracts only the binary and LICENSE from a flat tar.gz", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "fetch-stave-tar-" });
      const archive = buildTarGz([
        { name: "pax-header", data: encoder.encode("30 mtime=1700000000.000\n"), kind: "pax" },
        { name: "docs/", data: new Uint8Array(0), kind: "directory" },
        { name: "stave", data: binaryBytes },
        { name: "LICENSE", data: licenseBytes },
        { name: "README.md", data: readmeBytes },
      ]);

      const result = yield* extractStaveArchive({
        archive,
        format: "tar.gz",
        platformKey: "linux-arm64",
        outDir,
        tag: "v9.9.9",
      });

      assert.equal(result.directory, path.join(outDir, "linux-arm64"));
      assert.equal(result.executablePath, path.join(outDir, "linux-arm64", "stave"));
      yield* assertExtracted(result.directory, "stave", "v9.9.9");
    }).pipe(Effect.scoped),
  );

  it.effect("extracts stored and deflated members from a zip, flattening nested paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "fetch-stave-zip-" });
      const archive = buildZip([
        { name: "docs/", data: new Uint8Array(0) },
        { name: "stave", data: binaryBytes, method: 8 },
        { name: "LICENSE", data: licenseBytes, method: 0 },
        { name: "docs/README.md", data: readmeBytes, method: 8 },
      ]);

      const result = yield* extractStaveArchive({
        archive,
        format: "zip",
        platformKey: "darwin-arm64",
        outDir,
        tag: "v9.9.9",
      });

      assert.equal(result.directory, path.join(outDir, "darwin-arm64"));
      yield* assertExtracted(result.directory, "stave", "v9.9.9");
    }).pipe(Effect.scoped),
  );

  it.effect("looks for stave.exe on windows platform keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "fetch-stave-win-" });
      const archive = buildZip([
        { name: "stave.exe", data: binaryBytes, method: 8 },
        { name: "LICENSE", data: licenseBytes },
      ]);

      const result = yield* extractStaveArchive({
        archive,
        format: "zip",
        platformKey: "win32-x64",
        outDir,
        tag: "v0.4.0",
      });

      assert.equal(result.executablePath, path.join(outDir, "win32-x64", "stave.exe"));
      const version = yield* fs.readFileString(result.versionPath);
      assert.equal(version, "v0.4.0\n");
    }).pipe(Effect.scoped),
  );

  it.effect("fails with a typed error when the binary member is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "fetch-stave-missing-" });
      const archive = buildTarGz([{ name: "LICENSE", data: licenseBytes }]);

      const error = yield* extractStaveArchive({
        archive,
        format: "tar.gz",
        platformKey: "linux-x64",
        outDir,
        tag: "v0.4.0",
      }).pipe(Effect.flip);

      assert.equal(error._tag, "StaveBinaryMissingError");
      if (error._tag !== "StaveBinaryMissingError") {
        return;
      }
      assert.equal(error.executableName, "stave");
      assert.deepStrictEqual(error.members, ["LICENSE"]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects zip members with unsupported compression methods", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "fetch-stave-bad-" });
      const archive = buildZip([{ name: "stave", data: binaryBytes }]);
      // Rewrite the central directory method field (offset 10 in the entry) to bzip2 (12).
      const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
      const centralOffset = view.getUint32(archive.length - 22 + 16, true);
      view.setUint16(centralOffset + 10, 12, true);

      const error = yield* extractStaveArchive({
        archive,
        format: "zip",
        platformKey: "darwin-x64",
        outDir,
        tag: "v0.4.0",
      }).pipe(Effect.flip);

      assert.equal(error._tag, "StaveArchiveError");
      assert.include(error.message, "unsupported compression method 12");
    }).pipe(Effect.scoped),
  );
});

const latestReleaseClient = (onRequest: (request: HttpClientRequest.HttpClientRequest) => void) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      onRequest(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ tag_name: "v0.4.0" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );

const configFromEnv = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

it.effect("passes explicit tags through without touching the network", () =>
  Effect.gen(function* () {
    let requests = 0;
    const tag = yield* resolveStaveTag({ kind: "tag", tag: "v0.4.1" }).pipe(
      Effect.provide(
        latestReleaseClient(() => {
          requests += 1;
        }),
      ),
    );
    assert.equal(tag, "v0.4.1");
    assert.equal(requests, 0);
  }),
);

it.effect("rejects bundle pins older than the required JSON mutation protocol", () =>
  Effect.gen(function* () {
    for (const tag of ["v0.3.0", "v0.3.99", "v0.4.0-rc.1"]) {
      const error = yield* resolveStaveTag({ kind: "tag", tag }).pipe(Effect.flip);
      assert.equal(error._tag, "StaveBundleVersionError");
      assert.include(error.message, "v0.4.0 or newer");
    }
    for (const tag of ["v0.4.0", "v0.4.1", "v0.5.0", "v1.0.0"]) {
      assert.equal(yield* resolveStaveTag({ kind: "tag", tag }), tag);
    }
  }).pipe(
    Effect.provide(
      latestReleaseClient(() => assert.fail("explicit pins must not use the network")),
    ),
  ),
);

it.effect("rejects an incompatible latest release before downloading assets", () =>
  Effect.gen(function* () {
    const error = yield* resolveStaveTag({ kind: "latest" }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify({ tag_name: "v0.3.0" }), {
                    headers: { "content-type": "application/json" },
                  }),
                ),
              ),
            ),
          ),
          configFromEnv({}),
        ),
      ),
      Effect.flip,
    );
    assert.equal(error._tag, "StaveBundleVersionError");
  }),
);

it.effect("resolves latest via the GitHub API with a bearer token when GITHUB_TOKEN is set", () =>
  Effect.gen(function* () {
    let seen: HttpClientRequest.HttpClientRequest | undefined;
    const tag = yield* resolveStaveTag({ kind: "latest" }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestReleaseClient((request) => {
            seen = request;
          }),
          configFromEnv({ GITHUB_TOKEN: "ghp_test_token" }),
        ),
      ),
    );

    assert.equal(tag, "v0.4.0");
    if (seen === undefined) {
      return assert.fail("expected the latest release request to be sent");
    }
    assert.equal(seen.method, "GET");
    assert.equal(seen.url, "https://api.github.com/repos/Nurozen/stave/releases/latest");
    assert.equal(seen.headers.accept, "application/vnd.github+json");
    assert.isString(seen.headers["user-agent"]);
    assert.equal(seen.headers.authorization, "Bearer ghp_test_token");
  }),
);

it.effect("omits the Authorization header when GITHUB_TOKEN is unset or empty", () =>
  Effect.gen(function* () {
    for (const env of [{}, { GITHUB_TOKEN: "" }]) {
      let seen: HttpClientRequest.HttpClientRequest | undefined;
      const tag = yield* resolveStaveTag({ kind: "latest" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestReleaseClient((request) => {
              seen = request;
            }),
            configFromEnv(env),
          ),
        ),
      );
      assert.equal(tag, "v0.4.0");
      assert.isUndefined(seen?.headers.authorization);
      assert.equal(seen?.headers.accept, "application/vnd.github+json");
    }
  }),
);

it.effect("surfaces non-success latest release responses as typed errors", () =>
  Effect.gen(function* () {
    const failingClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("rate limited", { status: 403 })),
        ),
      ),
    );
    const error = yield* resolveStaveTag({ kind: "latest" }).pipe(
      Effect.provide(Layer.mergeAll(failingClient, configFromEnv({}))),
      Effect.flip,
    );
    assert.equal(error._tag, "StaveLatestReleaseError");
    assert.equal(error._tag === "StaveLatestReleaseError" ? error.operation : undefined, "status");
  }),
);
