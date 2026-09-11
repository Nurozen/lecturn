import { bundledStaveFeatures } from "./staveFeatures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import * as StaveBinary from "./StaveBinary.ts";
import * as StaveCli from "./StaveCli.ts";
import * as StaveConfigReader from "./StaveConfigReader.ts";
import { StaveError } from "./StaveError.ts";
import type { StaveConfigShow } from "./staveJson.ts";
import * as StaveRoots from "./StaveRoots.ts";

const FAKE_CONFIG_SHOW: StaveConfigShow = {
  configPath: "/fake/home/.config/stave/config.yaml",
  exists: true,
  root: "/fake/home/stave",
  bareReposDir: "/fake/home/stave/bare-repos",
  agentWorkDir: "/fake/home/stave/agent-work",
  defaultBase: "develop",
  repos: {
    zeta: {
      name: "zeta",
      url: "git@github.com:acme/zeta.git",
      bareRepoPath: "/fake/home/stave/bare-repos/zeta.git",
      defaultBranch: "main",
      marmotVault: "vault-1",
    },
    alpha: {
      name: "alpha",
      url: "git@github.com:acme/alpha.git",
      bareRepoPath: "/fake/home/stave/bare-repos/alpha.git",
      description: "The alpha service",
    },
  },
  memory: { provider: "marmot", binary: "/opt/marmot", default: true },
  tethers: { enabled: true, strongThreshold: 3 },
  summon: { default: "codex", commands: { codex: "codex" } },
};

const binaryFoundLayer = StaveBinary.layerFixed({
  path: "/fake/stave",
  source: "path",
  version: "0.4.0",
  commit: null,
});

const binaryMissing = Effect.fail(new StaveBinary.StaveBinaryNotFound({ candidates: ["stave"] }));
const binaryMissingLayer = Layer.mock(StaveBinary.StaveBinary)({
  resolve: binaryMissing,
  resolveForPath: () => binaryMissing,
  resolveRunnable: binaryMissing,
  features: Effect.succeed(bundledStaveFeatures()),
  featuresFor: () => Effect.succeed(bundledStaveFeatures()),
  invalidate: Effect.void,
});

const cliLayer = (configShow: Effect.Effect<StaveConfigShow, StaveError>) =>
  Layer.mock(StaveCli.StaveCli)({ configShow });

const configShowUnsupported = Effect.fail(
  new StaveError({
    code: "non_json_output",
    message: 'unknown command "show" for "stave config"',
    details: null,
    exitCode: 1,
    stderrTail: null,
    verb: "config show",
  }),
);

/** Reader wired to a temp home so `~` and the default paths stay inside the test. */
const makeReaderLayer = (input: {
  readonly homeDir: string;
  readonly binary?: Layer.Layer<StaveBinary.StaveBinary>;
  readonly cli?: Layer.Layer<StaveCli.StaveCli>;
  readonly configPath?: string;
  readonly enabled?: boolean;
}) =>
  Layer.effect(
    StaveConfigReader.StaveConfigReader,
    StaveConfigReader.make({ homeDir: input.homeDir }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        input.binary ?? binaryFoundLayer,
        input.cli ?? cliLayer(Effect.succeed(FAKE_CONFIG_SHOW)),
        ServerSettings.layerTest({
          stave: {
            ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          },
        }),
      ),
    ),
  );

const makeTempHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "lecturn-stave-config-" });
});

const writeConfig = Effect.fn("writeConfig")(function* (filePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

const load = Effect.gen(function* () {
  const reader = yield* StaveConfigReader.StaveConfigReader;
  return yield* reader.load;
});

it.layer(NodeServices.layer)("StaveConfigReader", (it) => {
  for (const enabled of [false, true]) {
    it.effect(
      `filesystem-only config loading never resolves or invokes Stave when enabled=${enabled}`,
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const homeDir = yield* makeTempHome;
          const configPath = path.join(homeDir, "custom.yaml");
          yield* writeConfig(configPath, "root: ~/guard-root\n");
          const forbidden = Effect.die("Filesystem-only Git guard must never invoke Stave");
          const binary = Layer.mock(StaveBinary.StaveBinary)({
            resolve: forbidden,
            resolveForPath: () => forbidden,
            resolveRunnable: forbidden,
            features: forbidden,
            featuresFor: () => forbidden,
          });
          yield* Effect.gen(function* () {
            const reader = yield* StaveConfigReader.StaveConfigReader;
            const roots = yield* StaveRoots.StaveRootsProvider;
            expect(yield* roots.agentWorkDir).toEqual(
              Option.some(path.join(homeDir, "guard-root", "agent-work")),
            );
            const snapshot = yield* (
              reader.loadFilesystem ?? Effect.die("Missing filesystem-only loader")
            );
            expect(snapshot.source).toBe("fs-fallback");
            expect(snapshot.agentWorkDir).toBe(path.join(homeDir, "guard-root", "agent-work"));
            yield* writeConfig(configPath, "root: ~/changed-root\n");
            const changed = yield* (
              reader.loadFilesystem ?? Effect.die("Missing filesystem-only loader")
            );
            expect(changed.agentWorkDir).toBe(path.join(homeDir, "changed-root", "agent-work"));
          }).pipe(
            Effect.provide(
              StaveRoots.layer.pipe(
                Layer.provideMerge(
                  makeReaderLayer({
                    homeDir,
                    configPath,
                    enabled,
                    binary,
                    cli: cliLayer(forbidden),
                  }),
                ),
              ),
            ),
          );
        }),
    );
  }

  describe("stave config show", () => {
    it.effect("mirrors the config show payload with repos sorted by name", () =>
      Effect.gen(function* () {
        const homeDir = yield* makeTempHome;

        const snapshot = yield* load.pipe(Effect.provide(makeReaderLayer({ homeDir })));

        expect(snapshot).toEqual({
          configPath: "/fake/home/.config/stave/config.yaml",
          exists: true,
          root: "/fake/home/stave",
          bareReposDir: "/fake/home/stave/bare-repos",
          agentWorkDir: "/fake/home/stave/agent-work",
          defaultBase: "develop",
          repos: [
            {
              name: "alpha",
              url: "git@github.com:acme/alpha.git",
              bareRepoPath: "/fake/home/stave/bare-repos/alpha.git",
              description: "The alpha service",
            },
            {
              name: "zeta",
              url: "git@github.com:acme/zeta.git",
              bareRepoPath: "/fake/home/stave/bare-repos/zeta.git",
              defaultBranch: "main",
            },
          ],
          memory: { provider: "marmot", binary: "/opt/marmot", default: true },
          source: "stave-config-show",
        });
        expect("description" in snapshot.repos[1]!).toBe(false);
        expect("defaultBranch" in snapshot.repos[0]!).toBe(false);
      }),
    );

    it.effect("falls back to the YAML when config show fails", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeDir = yield* makeTempHome;
        const configPath = StaveConfigReader.defaultStaveConfigPath(homeDir, path.join);
        yield* writeConfig(
          configPath,
          `root: ${path.join(homeDir, "elsewhere")}\ndefaultBase: trunk\n`,
        );

        const snapshot = yield* load.pipe(
          Effect.provide(makeReaderLayer({ homeDir, cli: cliLayer(configShowUnsupported) })),
        );

        expect(snapshot.source).toBe("fs-fallback");
        expect(snapshot.configPath).toBe(configPath);
        expect(snapshot.exists).toBe(true);
        expect(snapshot.root).toBe(path.join(homeDir, "elsewhere"));
        expect(snapshot.agentWorkDir).toBe(path.join(homeDir, "elsewhere", "agent-work"));
        expect(snapshot.defaultBase).toBe("trunk");
      }),
    );
  });

  describe("fs fallback", () => {
    it.effect("applies Stave's defaulting rules to a minimal YAML", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeDir = yield* makeTempHome;
        const configPath = StaveConfigReader.defaultStaveConfigPath(homeDir, path.join);
        yield* writeConfig(
          configPath,
          [
            "root: ~/work/stave",
            "repos:",
            "    api:",
            "        url: git@github.com:acme/api.git",
            "    web:",
            "        name: website",
            "        url: git@github.com:acme/web.git",
            "        bareRepoPath: ~/mirrors/web.git",
            "        defaultBranch: main",
            "        description: Marketing site",
            "    broken: just-a-string",
            "memory:",
            "    default: true",
            "",
          ].join("\n"),
        );

        const snapshot = yield* load.pipe(
          Effect.provide(makeReaderLayer({ homeDir, binary: binaryMissingLayer })),
        );

        const root = path.join(homeDir, "work", "stave");
        const bareReposDir = path.join(root, "bare-repos");
        expect(snapshot).toEqual({
          configPath,
          exists: true,
          root,
          bareReposDir,
          agentWorkDir: path.join(root, "agent-work"),
          defaultBase: "main",
          repos: [
            {
              name: "api",
              url: "git@github.com:acme/api.git",
              bareRepoPath: path.join(bareReposDir, "api.git"),
            },
            {
              name: "website",
              url: "git@github.com:acme/web.git",
              bareRepoPath: path.join(homeDir, "mirrors", "web.git"),
              defaultBranch: "main",
              description: "Marketing site",
            },
          ],
          memory: { provider: "marmot", binary: "marmot", default: true },
          source: "fs-fallback",
        });
      }),
    );

    it.effect("reports exists:false with defaults under home when the file is missing", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeDir = yield* makeTempHome;

        const snapshot = yield* load.pipe(
          Effect.provide(makeReaderLayer({ homeDir, binary: binaryMissingLayer })),
        );

        const root = path.join(homeDir, "stave");
        expect(snapshot).toEqual({
          configPath: path.join(homeDir, ".config", "stave", "config.yaml"),
          exists: false,
          root,
          bareReposDir: path.join(root, "bare-repos"),
          agentWorkDir: path.join(root, "agent-work"),
          defaultBase: "main",
          repos: [],
          memory: { provider: "marmot", binary: "marmot", default: false },
          source: "fs-fallback",
        });
      }),
    );

    it.effect("honours settings.stave.configPath with ~ expanded against home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeDir = yield* makeTempHome;

        const snapshot = yield* load.pipe(
          Effect.provide(
            makeReaderLayer({
              homeDir,
              binary: binaryMissingLayer,
              configPath: "~/custom/config.yaml",
            }),
          ),
        );

        expect(snapshot.configPath).toBe(path.join(homeDir, "custom", "config.yaml"));
        expect(snapshot.exists).toBe(false);
      }),
    );

    it.effect(
      "treats invalid YAML and non-mapping documents as an existing file with defaults",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const homeDir = yield* makeTempHome;
          const configPath = StaveConfigReader.defaultStaveConfigPath(homeDir, path.join);
          const readerLayer = makeReaderLayer({ homeDir, binary: binaryMissingLayer });

          yield* writeConfig(configPath, "root: [unclosed\nrepos: - broken");
          const corrupt = yield* load.pipe(Effect.provide(readerLayer));
          expect(corrupt.exists).toBe(true);
          expect(corrupt.root).toBe(path.join(homeDir, "stave"));

          yield* writeConfig(configPath, "- just\n- a list\n");
          const list = yield* load.pipe(Effect.provide(readerLayer));
          expect(list.exists).toBe(true);
          expect(list.repos).toEqual([]);
        }),
    );
  });

  describe("cache", () => {
    it.effect("serves from cache until the TTL elapses or invalidate is called", () =>
      Effect.gen(function* () {
        const homeDir = yield* makeTempHome;
        const calls = yield* Ref.make(0);
        const countingCli = cliLayer(
          Ref.update(calls, (count) => count + 1).pipe(Effect.as(FAKE_CONFIG_SHOW)),
        );

        yield* Effect.gen(function* () {
          const reader = yield* StaveConfigReader.StaveConfigReader;
          yield* reader.load;
          yield* reader.load;
          expect(yield* Ref.get(calls)).toBe(1);

          yield* TestClock.adjust("14 seconds");
          yield* reader.load;
          expect(yield* Ref.get(calls)).toBe(1);

          yield* TestClock.adjust("2 seconds");
          yield* reader.load;
          expect(yield* Ref.get(calls)).toBe(2);

          yield* reader.invalidate;
          yield* reader.load;
          expect(yield* Ref.get(calls)).toBe(3);
        }).pipe(Effect.provide(makeReaderLayer({ homeDir, cli: countingCli })));
      }),
    );
  });

  describe("layerFixed", () => {
    it.effect("answers with the given snapshot", () =>
      Effect.gen(function* () {
        const snapshot = StaveConfigReader.snapshotFromConfigShow(FAKE_CONFIG_SHOW);
        const reader = yield* StaveConfigReader.StaveConfigReader;

        expect(yield* reader.load).toEqual(snapshot);
        expect(
          yield* reader.loadFilesystem ?? Effect.die("Missing fixed filesystem loader"),
        ).toEqual(snapshot);
        yield* reader.invalidate;
      }).pipe(
        Effect.provide(
          StaveConfigReader.layerFixed(StaveConfigReader.snapshotFromConfigShow(FAKE_CONFIG_SHOW)),
        ),
      ),
    );
  });
});

describe("StaveRoots.layer", () => {
  const rootsFor = (snapshot: StaveConfigReader.StaveConfigSnapshot) =>
    StaveRoots.layer.pipe(Layer.provide(StaveConfigReader.layerFixed(snapshot)));

  it.effect("answers the agent-work directory when the config exists", () =>
    Effect.gen(function* () {
      const roots = yield* StaveRoots.StaveRootsProvider;
      expect(yield* roots.agentWorkDir).toEqual(Option.some("/fake/home/stave/agent-work"));
    }).pipe(Effect.provide(rootsFor(StaveConfigReader.snapshotFromConfigShow(FAKE_CONFIG_SHOW)))),
  );

  it.effect("answers none when the config does not exist yet", () =>
    Effect.gen(function* () {
      const roots = yield* StaveRoots.StaveRootsProvider;
      expect(Option.isNone(yield* roots.agentWorkDir)).toBe(true);
    }).pipe(
      Effect.provide(
        rootsFor({
          ...StaveConfigReader.snapshotFromConfigShow({ ...FAKE_CONFIG_SHOW, exists: false }),
        }),
      ),
    ),
  );
});
