import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  pickProjectFavicon,
  saveTextFile,
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
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes the concrete running distro without replacing the stable instance id", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
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
      currentConfig: Effect.succeed(Option.some(retryingConfig)),
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
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(
        Option.some({
          ...readyWslConfig,
          preflightFailure: Option.some({
            reason: "WSL probe timed out",
            fatal: false,
            retryLimit: 12,
          }),
        }),
      ),
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
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])));
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        }),
      ),
    );
  });
});

describe("pickProjectFavicon", () => {
  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeed(Option.none()),
            }),
          ),
        ),
      );

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
                extensions: ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"],
              },
            ],
          },
        ],
      ]);
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
      const dialog = vi.fn(() => Effect.succeed(Option.some("/chosen/export.md")));
      const fiber = yield* saveTextFile
        .handler({ format: "markdown", content: "# Exact decision\nraw citation" })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ElectronDialog.ElectronDialog)({ saveFile: dialog }),
              Layer.mock(ElectronWindow.ElectronWindow)({
                focusedMainOrFirst: Effect.succeed(Option.none()),
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
              saveFile: () => Effect.succeed(Option.none()),
            }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeed(Option.none()),
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
                saveFile: () => Effect.succeed(Option.some("/chosen/export.json")),
              }),
              Layer.mock(ElectronWindow.ElectronWindow)({
                focusedMainOrFirst: Effect.succeed(Option.none()),
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
  for (const input of [
    { format: "html", content: "text" },
    { format: "markdown", content: "text", path: "/arbitrary/path" },
    { format: "json", content: "x".repeat(32 * 1024 * 1024 + 1) },
  ]) {
    it.effect("rejects invalid export input before opening a dialog", () =>
      Effect.gen(function* () {
        const dialog = vi.fn(() => Effect.succeed(Option.none<string>()));
        const result = yield* saveTextFile.handler(input).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ElectronDialog.ElectronDialog)({ saveFile: dialog }),
              Layer.mock(ElectronWindow.ElectronWindow)({
                focusedMainOrFirst: Effect.succeed(Option.none()),
              }),
              FileSystem.layerNoop({}),
            ),
          ),
        );
        assert.strictEqual(result.status, "error");
        assert.strictEqual(dialog.mock.calls.length, 0);
      }),
    );
  }
});
