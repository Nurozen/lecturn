import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const { focusedWebContents, ownerWindow } = vi.hoisted(() => ({
  focusedWebContents: vi.fn(),
  ownerWindow: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow },
}));

import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  getLocalEnvironmentBootstraps,
  getRelayTelemetryEnabled,
  pickProjectFavicon,
  saveTextFile,
  probeRemoteEditors,
} from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeedSome(readyWslConfig),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

const backendConfigurationLayer = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
    currentBootstrapToken: Effect.succeed("current-window-token"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const bootstrapsLayer = (instances: ReadonlyArray<DesktopBackendManager.DesktopBackendInstance>) =>
  Layer.merge(DesktopBackendPool.layerTest([...instances]), backendConfigurationLayer);

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("hands out the current window's token to a backend launched with the secret", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "current-window-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        bootstrapsLayer([
          {
            ...defaultWslInstance,
            currentConfig: Effect.succeedSome({
              ...readyWslConfig,
              bootstrap: {
                ...readyWslConfig.bootstrap,
                desktopBootstrapSecret: "desktop-secret",
              },
            }),
          },
        ]),
      ),
    ),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome(retryingConfig),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(bootstrapsLayer([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome({
        ...readyWslConfig,
        preflightFailure: Option.some({
          reason: "WSL probe timed out",
          fatal: false,
          retryLimit: 12,
        }),
      }),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(bootstrapsLayer([stoppedInstance])));
  });
});

describe("getRelayTelemetryEnabled", () => {
  it.effect("reads the desktop host opt-out before returning the renderer policy", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* getRelayTelemetryEnabled.handler().pipe(
          Effect.provideService(HostProcess.Environment, {
            LECTURN_TELEMETRY_ENABLED: "false",
          }),
        ),
      );
      assert.isTrue(
        yield* getRelayTelemetryEnabled
          .handler()
          .pipe(Effect.provideService(HostProcess.Environment, {})),
      );
    }),
  );
});

describe("saveTextFile", () => {
  it.effect("writes only the selected path and reports success after the write completes", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const writeFileString = vi.fn((path: string, content: string) =>
        Effect.gen(function* () {
          assert.strictEqual(path, "/chosen/export.md");
          assert.strictEqual(content, "# Exact decision\nraw citation");
          yield* Deferred.succeed(writing, undefined);
          yield* Deferred.await(finish);
        }),
      );
      const dialog = vi.fn(() => Effect.succeedSome("/chosen/export.md"));
      const fiber = yield* saveTextFile
        .handler({ format: "markdown", content: "# Exact decision\nraw citation" })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ElectronDialog.ElectronDialog)({ saveFile: dialog }),
              Layer.mock(ElectronWindow.ElectronWindow)({
                focusedMainOrFirst: Effect.succeedNone,
              }),
              FileSystem.layerNoop({ writeFileString }),
            ),
          ),
          Effect.forkChild,
        );
      yield* Deferred.await(writing);
      assert.isUndefined(fiber.pollUnsafe());
      yield* Deferred.succeed(finish, undefined);
      assert.deepEqual(yield* Fiber.join(fiber), {
        status: "saved",
        filePath: "/chosen/export.md",
      });
      assert.strictEqual(dialog.mock.calls.length, 1);
    }),
  );
  it.effect("cancel writes nothing", () =>
    Effect.gen(function* () {
      const writeFileString = vi.fn(() => Effect.void);
      const result = yield* saveTextFile.handler({ format: "json", content: "{}" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronDialog.ElectronDialog)({
              saveFile: () => Effect.succeedNone,
            }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeedNone,
            }),
            FileSystem.layerNoop({ writeFileString }),
          ),
        ),
      );
      assert.deepEqual(result, { status: "canceled" });
      assert.strictEqual(writeFileString.mock.calls.length, 0);
    }),
  );
  it.effect("write failure returns error without exposing content or native error", () =>
    Effect.gen(function* () {
      const result = yield* saveTextFile
        .handler({ format: "json", content: "private sentinel" })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ElectronDialog.ElectronDialog)({
                saveFile: () => Effect.succeedSome("/chosen/export.json"),
              }),
              Layer.mock(ElectronWindow.ElectronWindow)({
                focusedMainOrFirst: Effect.succeedNone,
              }),
              FileSystem.layerNoop({
                writeFileString: () =>
                  Effect.fail(
                    new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "writeFileString",
                        description: "private sentinel",
                      }),
                    ),
                  ),
              }),
            ),
          ),
        );
      assert.strictEqual(result.status, "error");
      assert.deepEqual(result, {
        status: "error",
        message: "Could not save the export. Choose a writable destination and try again.",
      });
    }),
  );
  it.effect.each([
    { format: "html", content: "text" },
    { format: "markdown", content: "text", path: "/arbitrary/path" },
    { format: "json", content: "x".repeat(32 * 1024 * 1024 + 1) },
  ])("rejects invalid export input before opening a dialog", (input) =>
    Effect.gen(function* () {
      const dialog = vi.fn(() => Effect.succeed(Option.none<string>()));
      const result = yield* saveTextFile.handler(input).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronDialog.ElectronDialog)({ saveFile: dialog }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeedNone,
            }),
            FileSystem.layerNoop({}),
          ),
        ),
      );
      assert.strictEqual(result.status, "error");
      assert.strictEqual(dialog.mock.calls.length, 0);
    }),
  );
});

describe("pickProjectFavicon", () => {
  const pickerLayer = (
    pickFiles: () => Effect.Effect<Array<string>>,
    settings?: DesktopAppSettings.DesktopSettings,
  ) =>
    Layer.mergeAll(
      Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
      Layer.mock(ElectronWindow.ElectronWindow)({
        focusedMainOrFirst: Effect.succeedNone,
      }),
      DesktopAppSettings.layerTest(settings),
    );

  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon
        .handler("/project")
        .pipe(Effect.provide(pickerLayer(pickFiles)));

      assert.strictEqual(result, "/pictures/icon.png");
      assert.deepEqual(pickFiles.mock.calls, [
        [
          {
            owner: Option.none(),
            defaultPath: Option.some("/project"),
            multiple: false,
            filters: [
              {
                name: "Images",
                extensions: [
                  "avif",
                  "bmp",
                  "gif",
                  "ico",
                  "heic",
                  "heif",
                  "jpeg",
                  "jpg",
                  "png",
                  "svg",
                  "tif",
                  "tiff",
                  "webp",
                  "icns",
                ],
              },
            ],
          },
        ],
      ]);
    }),
  );

  it.effect("does not open a picker while the local environment is off", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          pickerLayer(pickFiles, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          }),
        ),
      );

      assert.strictEqual(result, null);
      assert.strictEqual(pickFiles.mock.calls.length, 0);
    }),
  );
});

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "finds remote editors installed without PATH launchers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-remote-editors-" });
      for (const app of ["Cursor", "Visual Studio Code", "WebStorm"]) {
        const executable = path.join(
          home,
          "Applications",
          `${app}.app`,
          app === "WebStorm" ? "Contents/MacOS/webstorm" : "Contents/Resources/app/bin/code",
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
      }
      const editors = yield* probeRemoteEditors.handler(undefined).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          PATH: path.join(home, "empty"),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.include(editors, "cursor");
      assert.include(editors, "vscode");
      assert.include(editors, "webstorm");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
