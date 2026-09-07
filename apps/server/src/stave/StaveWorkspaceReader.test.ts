import type { RepositoryIdentity } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { STAVE_MANIFEST_FILE_NAME } from "./staveManifest.ts";
import * as StaveWorkspaceReader from "./StaveWorkspaceReader.ts";

// Stave's own indentation style (4-space sequences) as written by yaml.v3.
const V1_MANIFEST = `version: 1
id: t3code-threads
createdAt: 2026-09-01T07:32:05.38559Z
repos:
    - name: context-marmot
      mode: reference
      path: references/context-marmot
      ref: origin/main
      bareRepoPath: /Users/nurozen/stave/bare-repos/context-marmot.git
    - name: stave
      mode: reference
      path: references/stave
      ref: origin/weirwood
      bareRepoPath: /Users/nurozen/stave/bare-repos/stave.git
    - name: t3code
      mode: edit
      path: t3code
      base: origin/main
      branch: stave/t3code-threads/t3code
      bareRepoPath: /Users/nurozen/stave/bare-repos/t3code.git
`;

const V2_SAGA_MANIFEST = `version: 2
id: release-train
kind: saga
createdAt: 2026-09-02T10:00:00Z
repos: []
memories:
    - name: shared-notes
      provider: marmot
      id: mem-123
      owned: true
    - name: team-wiki
      provider: marmot
      id: mem-456
      owned: false
saga:
    members:
        - id: t3code-threads
          after: []
          createdAt: 2026-09-01T07:32:05.38559Z
          prs:
            - repo: t3code
              number: 12
`;

const VERSIONLESS_MANIFEST_WITH_UNKNOWN_KEYS = `id: legacy-space
createdAt: 2026-01-01T00:00:00Z
specPath: docs/spec.md
futureBlock:
    nested: true
repos:
    - name: app
      mode: edit
      path: app
      base: origin/main
      branch: stave/legacy-space/app
      bareRepoPath: /bare/app.git
      futureField: 1
    - name: mirror
      mode: mirror
      path: mirror
`;

const SAGA_BLOCK_WITHOUT_KIND = `version: 2
id: implicit-saga
createdAt: 2026-09-02T10:00:00Z
repos: []
saga:
    members: []
`;

const fakeIdentity = (rootPath: string): RepositoryIdentity => ({
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:T3Tools/t3code.git",
  },
  rootPath,
});

const nullResolverLayer = Layer.succeed(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  RepositoryIdentityResolver.RepositoryIdentityResolver.of({
    resolve: () => Effect.succeed(null),
  }),
);

const makeReaderLayer = <R>(
  resolverLayer: Layer.Layer<RepositoryIdentityResolver.RepositoryIdentityResolver, never, R>,
  options?: StaveWorkspaceReader.StaveWorkspaceReaderOptions,
) =>
  Layer.effect(StaveWorkspaceReader.StaveWorkspaceReader, StaveWorkspaceReader.make(options)).pipe(
    Layer.provide(resolverLayer),
  );

const readerLayer = makeReaderLayer(nullResolverLayer);

const makeTempRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-stave-reader-" });
});

const writeManifest = Effect.fn("writeManifest")(function* (root: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem
    .writeFileString(path.join(root, STAVE_MANIFEST_FILE_NAME), contents)
    .pipe(Effect.orDie);
});

const loadSome = Effect.fn("loadSome")(function* (root: string) {
  const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
  const loaded = yield* reader.load(root);
  expect(Option.isSome(loaded)).toBe(true);
  return Option.getOrThrow(loaded);
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({ command: "git", args: ["-C", cwd, ...args] });
  }).pipe(Effect.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("StaveWorkspaceReader", (it) => {
  describe("manifest projection", () => {
    it.effect("projects a version 1 manifest with an edit repo", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, V1_MANIFEST);

        const info = yield* loadSome(root);

        expect(info.spaceId).toBe("t3code-threads");
        expect(info.kind).toBeUndefined();
        expect(info.isSaga).toBe(false);
        expect(info.createdAt).toBe("2026-09-01T07:32:05.38559Z");
        expect(info.state).toBe("live");
        expect(info.archiveBasename).toBeUndefined();
        expect(info.memberOf).toBeUndefined();
        expect(info.memories).toEqual([]);
        expect(info.repos).toEqual([
          {
            name: "context-marmot",
            mode: "reference",
            path: "references/context-marmot",
            ref: "origin/main",
            bareRepoPath: "/Users/nurozen/stave/bare-repos/context-marmot.git",
          },
          {
            name: "stave",
            mode: "reference",
            path: "references/stave",
            ref: "origin/weirwood",
            bareRepoPath: "/Users/nurozen/stave/bare-repos/stave.git",
          },
          {
            name: "t3code",
            mode: "edit",
            path: "t3code",
            base: "origin/main",
            branch: "stave/t3code-threads/t3code",
            bareRepoPath: "/Users/nurozen/stave/bare-repos/t3code.git",
          },
        ]);
        expect(info.primaryRepoPath).toBe(path.join(root, "t3code"));
        expect(info.primaryBranch).toBe("stave/t3code-threads/t3code");
        expect("primaryRepositoryIdentity" in info).toBe(false);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("projects a version 2 saga manifest with memories and no primary repo", () =>
      Effect.gen(function* () {
        const root = yield* makeTempRoot;
        yield* writeManifest(root, V2_SAGA_MANIFEST);

        const info = yield* loadSome(root);

        expect(info.spaceId).toBe("release-train");
        expect(info.kind).toBe("saga");
        expect(info.isSaga).toBe(true);
        expect(info.repos).toEqual([]);
        expect(info.memories).toEqual([
          { name: "shared-notes", provider: "marmot", id: "mem-123", owned: true },
          { name: "team-wiki", provider: "marmot", id: "mem-456", owned: false },
        ]);
        expect(info.primaryRepoPath).toBeUndefined();
        expect(info.primaryBranch).toBeUndefined();
        expect("primaryRepositoryIdentity" in info).toBe(false);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("tolerates a version-less manifest, unknown keys and unknown repo modes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, VERSIONLESS_MANIFEST_WITH_UNKNOWN_KEYS);

        const info = yield* loadSome(root);

        expect(info.spaceId).toBe("legacy-space");
        expect(info.isSaga).toBe(false);
        expect(info.repos).toEqual([
          {
            name: "app",
            mode: "edit",
            path: "app",
            base: "origin/main",
            branch: "stave/legacy-space/app",
            bareRepoPath: "/bare/app.git",
          },
        ]);
        expect(info.primaryRepoPath).toBe(path.join(root, "app"));
        expect(info.primaryBranch).toBe("stave/legacy-space/app");
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("treats a saga block as a saga even without kind", () =>
      Effect.gen(function* () {
        const root = yield* makeTempRoot;
        yield* writeManifest(root, SAGA_BLOCK_WITHOUT_KIND);

        const info = yield* loadSome(root);

        expect(info.kind).toBeUndefined();
        expect(info.isSaga).toBe(true);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("marks a root under .archive as archived with its archive basename", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const base = yield* makeTempRoot;
        const root = path.join(base, ".archive", "t3code-threads-20260903T120000Z");
        yield* writeManifest(root, V1_MANIFEST);

        const info = yield* loadSome(root);

        expect(info.spaceId).toBe("t3code-threads");
        expect(info.state).toBe("archived");
        expect(info.archiveBasename).toBe("t3code-threads-20260903T120000Z");
      }).pipe(Effect.provide(readerLayer)),
    );
  });

  describe("failure tolerance", () => {
    it.effect("returns none when the manifest is missing", () =>
      Effect.gen(function* () {
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const root = yield* makeTempRoot;

        expect(Option.isNone(yield* reader.load(root))).toBe(true);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("returns none when the root does not exist", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const root = yield* makeTempRoot;

        expect(Option.isNone(yield* reader.load(path.join(root, "missing")))).toBe(true);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("returns none for corrupt YAML without failing", () =>
      Effect.gen(function* () {
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, "id: [unclosed\nrepos: - broken");

        expect(Option.isNone(yield* reader.load(root))).toBe(true);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("returns none for a manifest without a space id", () =>
      Effect.gen(function* () {
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, "version: 1\nrepos: []\n");

        expect(Option.isNone(yield* reader.load(root))).toBe(true);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("returns none for a manifest that is not a mapping", () =>
      Effect.gen(function* () {
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, "- just\n- a list\n");

        expect(Option.isNone(yield* reader.load(root))).toBe(true);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("does not walk up to a parent directory's manifest", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, V1_MANIFEST);
        const nested = path.join(root, "t3code");
        yield* fileSystem.makeDirectory(nested, { recursive: true });

        expect(Option.isNone(yield* reader.load(nested))).toBe(true);
      }).pipe(Effect.provide(readerLayer)),
    );
  });

  describe("primary repository identity", () => {
    it.effect("resolves the identity of the first edit repo only", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, V1_MANIFEST);
        const resolveCalls: string[] = [];
        const recordingResolver = Layer.succeed(
          RepositoryIdentityResolver.RepositoryIdentityResolver,
          RepositoryIdentityResolver.RepositoryIdentityResolver.of({
            resolve: (cwd) =>
              Effect.sync(() => {
                resolveCalls.push(cwd);
                return fakeIdentity(cwd);
              }),
          }),
        );

        const info = yield* loadSome(root).pipe(Effect.provide(makeReaderLayer(recordingResolver)));

        expect(resolveCalls).toEqual([path.join(root, "t3code")]);
        expect(info.primaryRepositoryIdentity).toEqual(fakeIdentity(path.join(root, "t3code")));
      }),
    );

    it.effect("does not consult the resolver when no repo is editable", () =>
      Effect.gen(function* () {
        const root = yield* makeTempRoot;
        yield* writeManifest(root, V2_SAGA_MANIFEST);
        const resolveCalls: string[] = [];
        const recordingResolver = Layer.succeed(
          RepositoryIdentityResolver.RepositoryIdentityResolver,
          RepositoryIdentityResolver.RepositoryIdentityResolver.of({
            resolve: (cwd) =>
              Effect.sync(() => {
                resolveCalls.push(cwd);
                return null;
              }),
          }),
        );

        yield* loadSome(root).pipe(Effect.provide(makeReaderLayer(recordingResolver)));

        expect(resolveCalls).toEqual([]);
      }),
    );

    it.effect("resolves a real git identity for the primary edit checkout", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, V1_MANIFEST);
        const checkout = path.join(root, "t3code");
        yield* fileSystem.makeDirectory(checkout, { recursive: true });
        yield* git(checkout, ["init"]);
        yield* git(checkout, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        const info = yield* loadSome(root).pipe(
          Effect.provide(makeReaderLayer(RepositoryIdentityResolver.layer)),
        );

        expect(info.primaryRepositoryIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(info.primaryRepositoryIdentity?.locator.remoteName).toBe("origin");
      }),
    );
  });

  describe("cache", () => {
    it.effect("serves a positive result from cache until the positive TTL expires", () =>
      Effect.gen(function* () {
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const root = yield* makeTempRoot;
        yield* writeManifest(root, V1_MANIFEST);

        expect((yield* loadSome(root)).spaceId).toBe("t3code-threads");
        yield* writeManifest(root, V1_MANIFEST.replace("id: t3code-threads", "id: renamed"));
        expect((yield* loadSome(root)).spaceId).toBe("t3code-threads");

        yield* TestClock.adjust(Duration.seconds(29));
        expect((yield* loadSome(root)).spaceId).toBe("t3code-threads");

        yield* TestClock.adjust(Duration.seconds(2));
        expect((yield* loadSome(root)).spaceId).toBe("renamed");
        expect(Option.isNone(yield* reader.load(`${root}-other`))).toBe(true);
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("caches a negative result until the negative TTL expires", () =>
      Effect.gen(function* () {
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const root = yield* makeTempRoot;

        expect(Option.isNone(yield* reader.load(root))).toBe(true);
        yield* writeManifest(root, V1_MANIFEST);
        expect(Option.isNone(yield* reader.load(root))).toBe(true);

        yield* TestClock.adjust(Duration.seconds(31));
        expect(Option.isNone(yield* reader.load(root))).toBe(true);

        yield* TestClock.adjust(Duration.seconds(30));
        expect((yield* loadSome(root)).spaceId).toBe("t3code-threads");
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("invalidate(root) forces a re-read of that root only", () =>
      Effect.gen(function* () {
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const rootA = yield* makeTempRoot;
        const rootB = yield* makeTempRoot;
        yield* writeManifest(rootA, V1_MANIFEST);
        yield* writeManifest(rootB, V1_MANIFEST);
        yield* loadSome(rootA);
        yield* loadSome(rootB);

        yield* writeManifest(rootA, V1_MANIFEST.replace("id: t3code-threads", "id: renamed-a"));
        yield* writeManifest(rootB, V1_MANIFEST.replace("id: t3code-threads", "id: renamed-b"));
        yield* reader.invalidate(rootA);

        expect((yield* loadSome(rootA)).spaceId).toBe("renamed-a");
        expect((yield* loadSome(rootB)).spaceId).toBe("t3code-threads");
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("invalidateAll() drops cached negatives and positives", () =>
      Effect.gen(function* () {
        const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
        const rootA = yield* makeTempRoot;
        const rootB = yield* makeTempRoot;
        yield* writeManifest(rootB, V1_MANIFEST);
        expect(Option.isNone(yield* reader.load(rootA))).toBe(true);
        yield* loadSome(rootB);

        yield* writeManifest(rootA, V2_SAGA_MANIFEST);
        yield* writeManifest(rootB, V1_MANIFEST.replace("id: t3code-threads", "id: renamed-b"));
        yield* reader.invalidateAll();

        expect((yield* loadSome(rootA)).spaceId).toBe("release-train");
        expect((yield* loadSome(rootB)).spaceId).toBe("renamed-b");
      }).pipe(Effect.provide(readerLayer)),
    );

    it.effect("honours custom TTL options", () =>
      Effect.gen(function* () {
        const root = yield* makeTempRoot;
        yield* writeManifest(root, V1_MANIFEST);
        const shortLived = makeReaderLayer(nullResolverLayer, {
          positiveCacheTtl: Duration.millis(100),
        });

        yield* Effect.gen(function* () {
          expect((yield* loadSome(root)).spaceId).toBe("t3code-threads");
          yield* writeManifest(root, V1_MANIFEST.replace("id: t3code-threads", "id: renamed"));
          yield* TestClock.adjust(Duration.millis(120));
          expect((yield* loadSome(root)).spaceId).toBe("renamed");
        }).pipe(Effect.provide(shortLived));
      }),
    );
  });

  it.effect("layerNoop never finds a manifest", () =>
    Effect.gen(function* () {
      const reader = yield* StaveWorkspaceReader.StaveWorkspaceReader;
      const root = yield* makeTempRoot;
      yield* writeManifest(root, V1_MANIFEST);

      expect(Option.isNone(yield* reader.load(root))).toBe(true);
      yield* reader.invalidate(root);
      yield* reader.invalidateAll();
    }).pipe(Effect.provide(StaveWorkspaceReader.layerNoop)),
  );
});
