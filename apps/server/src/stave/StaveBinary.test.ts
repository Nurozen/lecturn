// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { CommandResolutionCache } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as StaveBinary from "./StaveBinary.ts";

const STAVE_VERSION_OUTPUT = "stave v0.4.0\ncommit: 1a2b3c4\ndate: 2026-08-30T12:00:00Z\n";

const versionOutput = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** Records every spawn so tests can assert how often `stave version` ran. */
const makeFakeRunner = (
  respond: (input: ProcessRunner.ProcessRunInput) => ProcessRunner.ProcessRunOutput = () =>
    versionOutput(STAVE_VERSION_OUTPUT),
) => {
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const layer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return respond(input);
        }),
    }),
  );
  return { calls, layer };
};

interface HarnessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly stavePath?: string;
  readonly settingsBinaryPath?: string;
  readonly bundledBaseDir?: string;
  readonly runner?: ReturnType<typeof makeFakeRunner>;
}

/** Builds the service against a temp base dir with a linux-x64 host so the executable bit matters. */
const makeHarness = Effect.fn(function* (baseDir: string, options: HarnessOptions = {}) {
  const runner = options.runner ?? makeFakeRunner();
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return ServerConfig.make({ ...config, stavePath: options.stavePath });
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  const settingsLayer = ServerSettings.layerTest(
    options.settingsBinaryPath === undefined
      ? {}
      : { stave: { binaryPath: options.settingsBinaryPath } },
  );
  // Built once so the returned settings handle is the same instance the
  // service reads; a second `Effect.provide` would construct a fresh one.
  const context = yield* Layer.build(Layer.mergeAll(configLayer, settingsLayer, runner.layer));
  const service = yield* StaveBinary.make({
    ...(options.bundledBaseDir === undefined ? {} : { bundledBaseDir: options.bundledBaseDir }),
  }).pipe(
    Effect.provide(context),
    Effect.provideService(HostProcessPlatform, options.platform ?? "linux"),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provideService(HostProcessEnvironment, options.env ?? {}),
    Effect.provideService(CommandResolutionCache, new Map()),
  );
  const settings = Context.get(context, ServerSettings.ServerSettingsService);
  return { service, runner, settings };
});

const writeExecutable = Effect.fn(function* (filePath: string, mode = 0o755) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, "#!/bin/sh\necho stave v0.4.0\n");
  yield* fileSystem.chmod(filePath, mode);
  return filePath;
});

it.layer(NodeServices.layer)("StaveBinary", (it) => {
  const withTempDir = Effect.fn(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-stave-binary-" });
  });

  describe("candidate order", () => {
    it.effect("settings.binaryPath wins over every other source", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromSettings = yield* writeExecutable(path.join(baseDir, "settings", "stave"));
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));
        const fromBootstrap = yield* writeExecutable(path.join(baseDir, "bootstrap", "stave"));
        const bundledBaseDir = path.join(baseDir, "dist");
        yield* writeExecutable(path.join(bundledBaseDir, "stave", "linux-x64", "stave"));
        const pathBin = path.join(baseDir, "bin");
        yield* writeExecutable(path.join(pathBin, "stave"));

        const { service } = yield* makeHarness(baseDir, {
          settingsBinaryPath: fromSettings,
          env: { T3CODE_STAVE_PATH: fromEnv, PATH: pathBin },
          stavePath: fromBootstrap,
          bundledBaseDir,
        });
        const resolution = yield* service.resolve;

        assert.deepEqual(resolution, {
          path: fromSettings,
          source: "settings",
          version: "0.4.0",
          commit: "1a2b3c4",
        });
      }).pipe(Effect.scoped),
    );

    it.effect("env override wins over bootstrap, bundled and PATH", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));
        const fromBootstrap = yield* writeExecutable(path.join(baseDir, "bootstrap", "stave"));
        const bundledBaseDir = path.join(baseDir, "dist");
        yield* writeExecutable(path.join(bundledBaseDir, "stave", "linux-x64", "stave"));
        const pathBin = path.join(baseDir, "bin");
        yield* writeExecutable(path.join(pathBin, "stave"));

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: fromEnv, PATH: pathBin },
          stavePath: fromBootstrap,
          bundledBaseDir,
        });
        const resolution = yield* service.resolve;

        assert.equal(resolution.path, fromEnv);
        assert.equal(resolution.source, "env");
      }).pipe(Effect.scoped),
    );

    it.effect("bootstrap stavePath wins over bundled and PATH", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromBootstrap = yield* writeExecutable(path.join(baseDir, "bootstrap", "stave"));
        const bundledBaseDir = path.join(baseDir, "dist");
        yield* writeExecutable(path.join(bundledBaseDir, "stave", "linux-x64", "stave"));
        const pathBin = path.join(baseDir, "bin");
        yield* writeExecutable(path.join(pathBin, "stave"));

        const { service } = yield* makeHarness(baseDir, {
          env: { PATH: pathBin },
          stavePath: fromBootstrap,
          bundledBaseDir,
        });
        const resolution = yield* service.resolve;

        assert.equal(resolution.path, fromBootstrap);
        assert.equal(resolution.source, "bootstrap");
      }).pipe(Effect.scoped),
    );

    it.effect("bundled binary under <base>/stave/<platformKey> wins over PATH", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const bundledBaseDir = path.join(baseDir, "dist");
        const bundled = yield* writeExecutable(
          path.join(bundledBaseDir, "stave", "linux-x64", "stave"),
        );
        const pathBin = path.join(baseDir, "bin");
        yield* writeExecutable(path.join(pathBin, "stave"));

        const { service } = yield* makeHarness(baseDir, { env: { PATH: pathBin }, bundledBaseDir });
        const resolution = yield* service.resolve;

        assert.equal(resolution.path, bundled);
        assert.equal(resolution.source, "bundled");
      }).pipe(Effect.scoped),
    );

    it.effect("dev fallback finds <base>/../../dist/stave/<platformKey>", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        // Mirrors apps/server/src/stave → apps/server/dist/stave in a checkout.
        const bundledBaseDir = path.join(baseDir, "src", "stave");
        const bundled = yield* writeExecutable(
          path.join(baseDir, "dist", "stave", "linux-x64", "stave"),
        );

        const { service } = yield* makeHarness(baseDir, { bundledBaseDir });
        const resolution = yield* service.resolve;

        assert.equal(resolution.path, bundled);
        assert.equal(resolution.source, "bundled");
      }).pipe(Effect.scoped),
    );

    it.effect("falls back to `stave` on PATH", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const pathBin = path.join(baseDir, "bin");
        const onPath = yield* writeExecutable(path.join(pathBin, "stave"));

        const { service } = yield* makeHarness(baseDir, {
          env: { PATH: `${path.join(baseDir, "empty")}:${pathBin}` },
          bundledBaseDir: path.join(baseDir, "dist"),
        });
        const resolution = yield* service.resolve;

        assert.equal(resolution.path, onPath);
        assert.equal(resolution.source, "path");
      }).pipe(Effect.scoped),
    );
  });

  describe("failures", () => {
    it.effect("a configured settings path that does not exist is authoritative", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));
        const missing = path.join(baseDir, "missing", "stave");

        const { service } = yield* makeHarness(baseDir, {
          settingsBinaryPath: missing,
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
        });
        const error = yield* Effect.flip(service.resolve);

        assert.instanceOf(error, StaveBinary.StaveBinaryNotFound);
        assert.deepEqual(error.candidates, [missing]);
      }).pipe(Effect.scoped),
    );

    it.effect("expands ~ in the configured settings path", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();

        const { service } = yield* makeHarness(baseDir, {
          settingsBinaryPath: "~/t3-stave-binary-test/does-not-exist/stave",
          bundledBaseDir: path.join(baseDir, "dist"),
        });
        const error = yield* Effect.flip(service.resolve);

        assert.instanceOf(error, StaveBinary.StaveBinaryNotFound);
        assert.deepEqual(error.candidates, [
          path.join(NodeOS.homedir(), "t3-stave-binary-test/does-not-exist/stave"),
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("a configured settings path without the executable bit fails", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const notExecutable = yield* writeExecutable(
          path.join(baseDir, "settings", "stave"),
          0o644,
        );

        const { service } = yield* makeHarness(baseDir, {
          settingsBinaryPath: notExecutable,
          bundledBaseDir: path.join(baseDir, "dist"),
        });
        const error = yield* Effect.flip(service.resolve);

        assert.instanceOf(error, StaveBinary.StaveBinaryNotExecutable);
        assert.equal(error.path, notExecutable);
      }).pipe(Effect.scoped),
    );

    it.effect("an existing non-executable override fails instead of falling through", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const notExecutable = yield* writeExecutable(path.join(baseDir, "env", "stave"), 0o644);
        const pathBin = path.join(baseDir, "bin");
        yield* writeExecutable(path.join(pathBin, "stave"));

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: notExecutable, PATH: pathBin },
          bundledBaseDir: path.join(baseDir, "dist"),
        });
        const error = yield* Effect.flip(service.resolve);

        assert.instanceOf(error, StaveBinary.StaveBinaryNotExecutable);
        assert.equal(error.path, notExecutable);
      }).pipe(Effect.scoped),
    );

    it.effect("reports every candidate when nothing resolves", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = path.join(baseDir, "env", "stave");
        const fromBootstrap = path.join(baseDir, "bootstrap", "stave");
        const bundledBaseDir = path.join(baseDir, "dist");

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: fromEnv, PATH: path.join(baseDir, "empty") },
          stavePath: fromBootstrap,
          bundledBaseDir,
        });
        const error = yield* Effect.flip(service.resolve);

        assert.instanceOf(error, StaveBinary.StaveBinaryNotFound);
        assert.deepEqual(error.candidates, [
          fromEnv,
          fromBootstrap,
          path.resolve(bundledBaseDir, "stave", "linux-x64", "stave"),
          path.resolve(bundledBaseDir, "../stave", "linux-x64", "stave"),
          path.resolve(bundledBaseDir, "../../dist/stave", "linux-x64", "stave"),
          "stave",
        ]);
      }).pipe(Effect.scoped),
    );
  });

  describe("version probe", () => {
    it.effect("runs `<path> version` with a closed stdin and parses the three lines", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));
        const runner = makeFakeRunner();

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
          runner,
        });
        const resolution = yield* service.resolve;

        assert.equal(resolution.version, "0.4.0");
        assert.equal(resolution.commit, "1a2b3c4");
        assert.equal(runner.calls.length, 1);
        assert.equal(runner.calls[0]?.command, fromEnv);
        assert.deepEqual(runner.calls[0]?.args, ["version"]);
        assert.equal(runner.calls[0]?.stdin, "");
        assert.equal(runner.calls[0]?.timeoutBehavior, "timedOutResult");
      }).pipe(Effect.scoped),
    );

    it.effect("omits the commit when the binary does not report one", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));
        const runner = makeFakeRunner(() => versionOutput("stave dev\ncommit: unknown\n"));

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
          runner,
        });
        const resolution = yield* service.resolve;

        assert.equal(resolution.version, "dev");
        assert.equal(resolution.commit, null);
      }).pipe(Effect.scoped),
    );

    it.effect("still resolves with a null version when the probe exits non-zero", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));
        const runner = makeFakeRunner(() => versionOutput("boom", 1));

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
          runner,
        });
        const resolution = yield* service.resolve;

        assert.equal(resolution.path, fromEnv);
        assert.equal(resolution.version, null);
        assert.equal(resolution.commit, null);
      }).pipe(Effect.scoped),
    );

    it.effect("still resolves with a null version when the output is not stave's", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));
        const runner = makeFakeRunner(() => versionOutput("usage: something else\n"));

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
          runner,
        });
        const resolution = yield* service.resolve;

        assert.equal(resolution.version, null);
      }).pipe(Effect.scoped),
    );
  });

  describe("memoisation", () => {
    it.effect("probes once until invalidated", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));
        const runner = makeFakeRunner();

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
          runner,
        });
        yield* service.resolve;
        yield* service.resolve;
        yield* service.resolveRunnable;
        assert.equal(runner.calls.length, 1);

        yield* service.invalidate;
        yield* service.resolve;
        assert.equal(runner.calls.length, 2);
      }).pipe(Effect.scoped),
    );

    it.effect("re-resolves when settings.binaryPath changes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const first = yield* writeExecutable(path.join(baseDir, "first", "stave"));
        const second = yield* writeExecutable(path.join(baseDir, "second", "stave"));
        const runner = makeFakeRunner();

        const { service, settings } = yield* makeHarness(baseDir, {
          settingsBinaryPath: first,
          bundledBaseDir: path.join(baseDir, "dist"),
          runner,
        });
        assert.equal((yield* service.resolve).path, first);
        assert.equal((yield* service.resolve).path, first);
        assert.equal(runner.calls.length, 1);

        yield* settings.updateSettings({ stave: { binaryPath: second } });
        assert.equal((yield* service.resolve).path, second);
        assert.equal(runner.calls.length, 2);

        yield* settings.updateSettings({ stave: { binaryPath: "" } });
        const fallback = yield* Effect.flip(service.resolve);
        assert.instanceOf(fallback, StaveBinary.StaveBinaryNotFound);
      }).pipe(Effect.scoped),
    );

    it.effect("does not memoise a failed resolution", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = path.join(baseDir, "env", "stave");

        const { service } = yield* makeHarness(baseDir, {
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
        });
        assert.instanceOf(yield* Effect.flip(service.resolve), StaveBinary.StaveBinaryNotFound);

        yield* writeExecutable(fromEnv);
        assert.equal((yield* service.resolve).path, fromEnv);
      }).pipe(Effect.scoped),
    );
  });

  describe("resolveRunnable", () => {
    it.effect("ignores settings.binaryPath entirely", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromSettings = yield* writeExecutable(path.join(baseDir, "settings", "stave"));
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));

        const { service } = yield* makeHarness(baseDir, {
          settingsBinaryPath: fromSettings,
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
        });

        assert.equal((yield* service.resolve).source, "settings");
        const runnable = yield* service.resolveRunnable;
        assert.equal(runnable.path, fromEnv);
        assert.equal(runnable.source, "env");
      }).pipe(Effect.scoped),
    );

    it.effect("succeeds even when the configured settings path is broken", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* withTempDir();
        const fromEnv = yield* writeExecutable(path.join(baseDir, "env", "stave"));

        const { service } = yield* makeHarness(baseDir, {
          settingsBinaryPath: path.join(baseDir, "missing", "stave"),
          env: { T3CODE_STAVE_PATH: fromEnv },
          bundledBaseDir: path.join(baseDir, "dist"),
        });

        assert.instanceOf(yield* Effect.flip(service.resolve), StaveBinary.StaveBinaryNotFound);
        assert.equal((yield* service.resolveRunnable).path, fromEnv);
      }).pipe(Effect.scoped),
    );
  });

  it.effect("layerFixed serves the given resolution from both walks", () =>
    Effect.gen(function* () {
      const resolution = {
        path: "/opt/stave/stave",
        source: "bundled",
        version: "0.4.0",
        commit: null,
      } as const;
      const service = yield* StaveBinary.StaveBinary.pipe(
        Effect.provide(StaveBinary.layerFixed(resolution)),
      );

      assert.deepEqual(yield* service.resolve, resolution);
      assert.deepEqual(yield* service.resolveRunnable, resolution);
      yield* service.invalidate;
    }),
  );
});

it.layer(NodeServices.layer)("StaveBinary features and Windows", (it) => {
  it.effect("probes the authoritative binary nested help on stderr, caches and invalidates", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const selected = yield* writeExecutable(`${root}/selected-stave`);
      const runner = makeFakeRunner((input) =>
        input.args?.[0] === "version"
          ? versionOutput(STAVE_VERSION_OUTPUT)
          : {
              ...versionOutput("", 1),
              stderr: `Usage:\n  stave ${input.args?.slice(0, -1).join(" ")} [flags]\nFlags:\n --json bool\n --config string\n --dry-run bool\n`,
            },
      );
      const { service } = yield* makeHarness(root, { settingsBinaryPath: selected, runner });
      const first = yield* service.features;
      assert.equal(first.source, "help");
      assert.isTrue(first.commands.find((entry) => entry.verb === "space archive")?.available);
      assert.include(
        first.commands.find((entry) => entry.verb === "space archive")?.flags ?? [],
        "dry-run",
      );
      assert.include(first.unsupportedOperations, "createSpace");
      const count = runner.calls.length;
      assert.isAbove(count, 2);
      yield* service.features;
      assert.equal(runner.calls.length, count);
      assert.isTrue(
        runner.calls.every(
          (call) =>
            call.command === selected &&
            (call.args?.[0] === "version" || call.args?.at(-1) === "--help"),
        ),
      );
      yield* service.invalidate;
      yield* service.features;
      assert.equal(runner.calls.length, count * 2);
    }),
  );
  it.effect(
    "probes bootstrap binaries because bootstrap also selects developer installations",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const selected = yield* writeExecutable(`${root}/gobin/stave`);
        const runner = makeFakeRunner((input) =>
          input.args?.[0] === "version"
            ? versionOutput(STAVE_VERSION_OUTPUT)
            : versionOutput("unknown command", 1),
        );
        const { service } = yield* makeHarness(root, {
          stavePath: selected,
          runner,
          bundledBaseDir: `${root}/no-bundle`,
        });
        assert.equal((yield* service.resolve).source, "bootstrap");
        const features = yield* service.features;
        assert.equal(features.source, "help");
        assert.include(features.unsupportedOperations, "destroySpace");
        assert.isAbove(runner.calls.filter((call) => call.args?.at(-1) === "--help").length, 0);
      }),
  );
  it.effect("uses guaranteed bundled capabilities without help subprocesses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* writeExecutable(`${root}/dist/stave/linux-x64/stave`);
      const { service, runner } = yield* makeHarness(root, { bundledBaseDir: `${root}/dist` });
      const features = yield* service.features;
      assert.equal(features.source, "bundled");
      assert.deepEqual(features.unsupportedOperations, []);
      assert.equal(runner.calls.length, 1);
    }),
  );
  it.effect("rejects parent help and timed out command probes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const selected = yield* writeExecutable(`${root}/stave`);
      const runner = makeFakeRunner((input) =>
        input.args?.[0] === "version"
          ? versionOutput(STAVE_VERSION_OUTPUT)
          : {
              ...versionOutput("Usage:\n stave space [command]\n --json bool\n"),
              timedOut: input.args?.[1] === "archive",
            },
      );
      const { service } = yield* makeHarness(root, { settingsBinaryPath: selected, runner });
      const features = yield* service.features;
      assert.isTrue(features.commands.every((command) => !command.available));
    }),
  );
  it.effect("accepts Windows exe without executable bits and refuses cmd wrappers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const exe = yield* writeExecutable(`${root}/stave.exe`, 0o644);
      const cmd = yield* writeExecutable(`${root}/stave.cmd`, 0o644);
      const native = yield* makeHarness(root, { settingsBinaryPath: exe, platform: "win32" });
      assert.equal((yield* native.service.resolve).path, exe);
      const wrapper = yield* makeHarness(root, { settingsBinaryPath: cmd, platform: "win32" });
      const failure = yield* wrapper.service.resolve.pipe(Effect.flip);
      assert.equal(failure._tag, "StaveBinaryUnsupportedWrapper");
      assert.include(failure.message, "stave.exe");
      assert.equal(wrapper.runner.calls.length, 0);
    }),
  );
});

it.layer(NodeServices.layer)("StaveBinary live file changes", (it) => {
  it.effect(
    "refreshes version and help after in-place replacement, and rejects a removed override",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const selected = yield* writeExecutable(`${root}/stave`);
        let version = "0.4.0";
        const runner = makeFakeRunner((input) =>
          input.args?.[0] === "version"
            ? versionOutput(`stave v${version}\n`)
            : versionOutput(
                `Usage:\n stave ${input.args?.slice(0, -1).join(" ")} [flags]\n --json bool\n --config string\n`,
              ),
        );
        const { service } = yield* makeHarness(root, { settingsBinaryPath: selected, runner });
        assert.equal((yield* service.resolve).version, "0.4.0");
        yield* service.features;
        const count = runner.calls.length;
        yield* service.resolve;
        yield* service.features;
        assert.equal(runner.calls.length, count);
        version = "0.5.0";
        yield* fs.writeFileString(selected, "replacement native executable with a different size");
        assert.equal((yield* service.resolve).version, "0.5.0");
        yield* service.features;
        assert.equal(runner.calls.length, count * 2);
        yield* fs.remove(selected);
        assert.instanceOf(yield* Effect.flip(service.resolve), StaveBinary.StaveBinaryNotFound);
        assert.equal(runner.calls.length, count * 2);
      }),
  );
  it.effect("reselects PATH after a cached binary disappears", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const first = yield* writeExecutable(`${root}/first/stave`);
      const second = yield* writeExecutable(`${root}/second/stave`);
      const { service } = yield* makeHarness(root, {
        env: { PATH: `${root}/first:${root}/second` },
      });
      assert.equal((yield* service.resolve).path, first);
      yield* fs.remove(first);
      assert.equal((yield* service.resolve).path, second);
    }),
  );
});
