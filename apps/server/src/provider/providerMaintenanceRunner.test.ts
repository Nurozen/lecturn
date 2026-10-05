import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@lecturn/contracts";
import { ServerProviderUpdateError } from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessEnvironment, HostProcessPlatform } from "@lecturn/shared/hostProcess";
import { SpawnExecutableResolution } from "@lecturn/shared/shell";

import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";
import {
  makeProviderMaintenanceCommandCoordinator,
  ProviderMaintenanceLockDirectory,
} from "./providerMaintenanceCommandCoordinator.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import {
  makeProviderMaintenanceCapabilities,
  ProviderVersionCache,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CURSOR_INSTANCE_ID = ProviderInstanceId.make("cursor");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const encoder = new TextEncoder();

// Pin a non-win32 platform so `resolveSpawnCommand` is a no-op and the raw
// `{ command, args }` assertions below hold deterministically on any host
// (including Windows). Windows-specific resolution is covered by the dedicated
// win32 case at the end of this suite.
const NonWindowsPlatform = Layer.succeed(HostProcessPlatform, "linux");

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === CURSOR_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "cursor-agent",
      updateArgs: ["update"],
      updateLockKey: "cursor-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseCursorProvider: ServerProvider = {
  ...baseProvider,
  instanceId: CURSOR_INSTANCE_ID,
  driver: CURSOR_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const latestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);

    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      return yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
    });

    const registry: ProviderRegistryShape = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    };

    return {
      registry,
      updateStatesRef,
    };
  });
}

// Only the file system and path services: NodeServices would also bring the
// real ChildProcessSpawner, and these tests must never run a real update.
const FileLockServices = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

// Each test locks inside its own temp directory so it never contends with the
// Lecturn servers running on the host.
const makeLockDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "lecturn-provider-maintenance-test-",
  });
}).pipe(Effect.provide(FileLockServices));

const makeTestRunner = (registry: ProviderRegistryShape) =>
  Effect.gen(function* () {
    const lockDirectory = yield* makeLockDirectory;
    return yield* Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
      Effect.provide(
        ProviderMaintenanceRunner.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProviderRegistry, registry),
              Layer.succeed(ProviderVersionCache, new Map()),
              Layer.succeed(ProviderMaintenanceLockDirectory, lockDirectory),
              FileLockServices,
            ),
          ),
        ),
      ),
    );
  });

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseCursorProvider);
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CURSOR_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "cursor-agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "running", "succeeded"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("uses the resolved provider capabilities when choosing the update executable", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "2.0.14",
          latestVersion: "2.1.123",
          updateCommand: "bun i -g @anthropic-ai/claude-code@latest",
          canUpdate: true,
          checkedAt: "2026-04-30T12:00:00.000Z",
          message: "Update available.",
        },
      });
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "bun",
              updateArgs: ["i", "-g", "@openai/codex@latest"],
              updateLockKey: "bun-global",
            }),
          ),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "bun",
          args: ["i", "-g", "@openai/codex@latest"],
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "runs update commands through Effect ChildProcess when no test runner is injected",
    () => {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        const runner = yield* makeTestRunner(registry);

        const result = yield* runner.updateProvider(CODEX_DRIVER);

        assert.deepStrictEqual(calls, [
          {
            command: "npm",
            args: ["install", "-g", "@openai/codex@latest"],
          },
        ]);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NonWindowsPlatform,
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer((command, args) => {
              calls.push({ command, args });
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    },
  );

  it.effect("updates a single provider instance without touching sibling instances", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const personalInstanceId = ProviderInstanceId.make("codex_personal");
      const workInstanceId = ProviderInstanceId.make("codex_work");
      const refreshedInstanceIds: Array<ProviderInstanceId> = [];
      const { registry } = yield* makeRegistry([
        {
          ...baseProvider,
          instanceId: personalInstanceId,
          version: "0.124.0-alpha.3",
        },
        {
          ...baseProvider,
          instanceId: workInstanceId,
          version: "0.124.0-alpha.3",
        },
      ]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex-instance-test",
              updateExecutable: "vp",
              updateArgs: ["i", "-g", "@openai/codex"],
              updateLockKey: "vite-plus-global",
            }),
          ).pipe(
            Effect.tap(() => Effect.sync(() => assert.strictEqual(instanceId, personalInstanceId))),
          ),
        refreshInstance: (instanceId) =>
          registry.refreshInstance(instanceId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                refreshedInstanceIds.push(instanceId);
              }),
            ),
          ),
      });

      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        instanceId: personalInstanceId,
      });

      assert.deepStrictEqual(calls, [
        {
          command: "vp",
          args: ["i", "-g", "@openai/codex"],
        },
      ]);
      assert.deepStrictEqual(refreshedInstanceIds, [personalInstanceId]);
      assert.strictEqual(result.providers[0]?.instanceId, personalInstanceId);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(result.providers[1]?.instanceId, workInstanceId);
      assert.strictEqual(result.providers[1]?.updateState, undefined);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.124.0-alpha.3"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("records command failure output in provider update state", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      const updateState = result.providers[0]?.updateState;

      assert.strictEqual(updateState?.status, "failed");
      assert.strictEqual(updateState?.message, "Update command exited with code 1.");
      assert.include(updateState?.output ?? "", "permission denied");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => ({ stderr: "permission denied", code: 1 })),
        ),
      ),
    ),
  );

  it.effect(
    "marks successful commands as unchanged when the refreshed provider is still outdated",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry({
          ...baseProvider,
          installed: true,
          version: "0.1.0",
        });
        const updater = yield* makeTestRunner(registry);

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
        assert.include(result.providers[0]?.updateState?.message ?? "", "still detects");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NonWindowsPlatform,
            latestVersionHttpClient("9.9.9"),
            mockSpawnerLayer(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("prevents concurrent updates for the same provider", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started);

      const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(second), true);
      if (Exit.isFailure(second)) {
        const error = Cause.squash(second.cause);
        assert.strictEqual(isServerProviderUpdateError(error), true);
        if (isServerProviderUpdateError(error)) {
          assert.include(error.reason, "already running");
        }
      }

      releaseLatch.resolve();
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect("serializes different providers that share the same update lock key", () => {
    const firstStartedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseFirstLatch: { resolve: () => void } = { resolve: () => {} };
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedLatch.resolve = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstLatch.resolve = resolve;
    });
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry([baseProvider, baseOpenCodeProvider]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
              updateExecutable: "npm",
              updateArgs:
                provider === OPENCODE_DRIVER
                  ? ["install", "-g", "opencode-ai@latest"]
                  : ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global",
            }),
          ),
      });

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => firstStarted);

      const second = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkScoped);
      let providersWhileQueued: ReadonlyArray<ServerProvider> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        providersWhileQueued = yield* registry.getProviders;
        const queuedStatus = providersWhileQueued.find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState?.status;
        if (queuedStatus === "queued") {
          break;
        }
        yield* Effect.yieldNow;
      }
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      assert.strictEqual(
        providersWhileQueued.find((provider) => provider.instanceId === OPENCODE_INSTANCE_ID)
          ?.updateState?.status,
        "queued",
      );

      releaseFirstLatch.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(calls, [
        "install -g @openai/codex@latest",
        "install -g opencode-ai@latest",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            if (calls.length === 1) {
              firstStartedLatch.resolve();
              return {
                stdout: "updated",
                exitCode: Effect.promise(() => releaseFirst).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("accepts arbitrary driver-provided update lock keys", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "unknown-lock-key",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "releases the running-provider marker when interrupted after queuing but before the lock run starts",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        let blockQueuedState = true;
        const queuedStateWrittenLatch: { resolve: () => void } = { resolve: () => {} };
        const releaseQueuedStateLatch: { resolve: () => void } = { resolve: () => {} };
        const queuedStateWritten = new Promise<void>((resolve) => {
          queuedStateWrittenLatch.resolve = resolve;
        });
        const releaseQueuedState = new Promise<void>((resolve) => {
          releaseQueuedStateLatch.resolve = resolve;
        });

        const updater = yield* makeTestRunner({
          ...registry,
          setProviderMaintenanceActionState: Effect.fn(
            "providerMaintenanceRunner.test.blockQueuedState",
          )(function* (input) {
            const providers = yield* registry.setProviderMaintenanceActionState(input);
            if (input.state?.status === "queued" && blockQueuedState) {
              queuedStateWrittenLatch.resolve();
              yield* Effect.promise(() => releaseQueuedState);
            }
            return providers;
          }),
        });

        const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
        yield* Effect.promise(() => queuedStateWritten);
        blockQueuedState = false;

        yield* Fiber.interrupt(first);
        releaseQueuedStateLatch.resolve();

        const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
        assert.strictEqual(Exit.isSuccess(second), true);
        if (Exit.isSuccess(second)) {
          assert.strictEqual(second.value.providers[0]?.updateState?.status, "succeeded");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NonWindowsPlatform,
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("skips the install when a queued update finds the provider already current", () => {
    const firstStartedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseFirstLatch: { resolve: () => void } = { resolve: () => {} };
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedLatch.resolve = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstLatch.resolve = resolve;
    });
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry([
        baseProvider,
        { ...baseOpenCodeProvider, version: "9.9.9" },
      ]);
      const updater = yield* makeTestRunner(registry);

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => firstStarted);
      const second = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkScoped);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const queuedStatus = (yield* registry.getProviders).find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState?.status;
        if (queuedStatus === "queued") {
          break;
        }
        yield* Effect.yieldNow;
      }

      releaseFirstLatch.resolve();
      yield* Fiber.join(first);
      const result = yield* Fiber.join(second);

      const updateState = result.providers.find(
        (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
      )?.updateState;
      assert.strictEqual(updateState?.status, "succeeded");
      assert.strictEqual(updateState?.message, "Provider is already up to date.");
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("9.9.9"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            firstStartedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => releaseFirst).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect("does not pass ELECTRON_RUN_AS_NODE to the update command", () => {
    const environments: Array<Record<string, string | undefined> | undefined> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const runner = yield* makeTestRunner(registry);

      yield* runner.updateProvider(CODEX_DRIVER);

      assert.deepStrictEqual(environments, [{ PATH: "/usr/bin" }]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          Layer.succeed(HostProcessEnvironment, {
            PATH: "/usr/bin",
            ELECTRON_RUN_AS_NODE: "1",
          }),
          latestVersionHttpClient("0.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const childProcess = command as unknown as {
                readonly options: {
                  readonly env?: Record<string, string | undefined>;
                  readonly extendEnv?: boolean;
                };
              };
              // Without `extendEnv: false` the spawner would merge the host
              // environment back in and undo the stripping.
              assert.strictEqual(childProcess.options.extendEnv, false);
              environments.push(childProcess.options.env);
              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });

  it.effect("resolves npm to a .cmd shim and routes through the shell on win32", () => {
    const captured: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly shell: boolean | string | undefined;
    }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const runner = yield* makeTestRunner(registry);

      const result = yield* runner.updateProvider(CODEX_DRIVER);

      // On win32, resolveSpawnCommand resolves `npm` to the `.cmd` shim and
      // routes the spawn through cmd.exe (shell: true), escaping every arg.
      assert.strictEqual(captured.length, 1);
      const call = captured[0];
      assert.ok(call, "expected the spawner to be invoked once");
      // The resolved command is the escaped `.cmd` path. Asserting the precise
      // escaped string is brittle, so verify it carries the resolved shim and
      // that shell mode was used.
      assert.match(call.command, /npm\.cmd/i);
      assert.strictEqual(call.shell, true);
      // Args are escaped for cmd.exe shell mode (each quoted) but still carry
      // the original install command (`install -g @openai/codex@latest`) in order.
      assert.strictEqual(call.args.length, 3);
      assert.match(call.args[0] ?? "", /install/);
      assert.match(call.args[1] ?? "", /-g/);
      assert.match(call.args[2] ?? "", /@openai\/codex@latest/);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessEnvironment, {
            PATH: "C:\\fake\\npm",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          Layer.succeed(SpawnExecutableResolution, (command) =>
            command === "npm" ? "C:\\fake\\npm\\npm.cmd" : undefined,
          ),
          latestVersionHttpClient("0.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const childProcess = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options: { readonly shell?: boolean | string | undefined };
              };
              captured.push({
                command: childProcess.command,
                args: childProcess.args,
                shell: childProcess.options.shell,
              });
              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });
});

describe("providerMaintenanceCommandCoordinator", () => {
  const DEAD_PROCESS_ID = 2 ** 31 - 1;
  const STALE_AFTER = Duration.minutes(7);
  const lockOwner = (pid: number) =>
    `{"pid":${pid},"token":"abandoned","acquiredAt":"2026-04-10T00:00:00.000Z"}`;

  const makeCoordinator = (lockDirectory: string) =>
    makeProviderMaintenanceCommandCoordinator({
      makeAlreadyRunningError: () => "already-running" as const,
      fileLockStaleAfter: STALE_AFTER,
    }).pipe(Effect.provideService(ProviderMaintenanceLockDirectory, lockDirectory));

  const lockFilePath = (lockDirectory: string) =>
    Effect.map(Path.Path, (path) =>
      path.join(lockDirectory, "lecturn-provider-maintenance-npm-global.lock"),
    );

  // The waiter polls with real file system calls between clock sleeps, so keep
  // advancing the test clock until it gets through.
  const advanceClockUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
    Effect.raceFirst(
      Fiber.join(fiber),
      TestClock.adjust("1 second").pipe(
        Effect.andThen(Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))),
        Effect.forever,
      ),
    );

  it.effect("serializes the same lock key across coordinators sharing a lock directory", () =>
    Effect.gen(function* () {
      const lockDirectory = yield* makeLockDirectory;
      const firstCoordinator = yield* makeCoordinator(lockDirectory);
      const secondCoordinator = yield* makeCoordinator(lockDirectory);
      const firstRunning = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const events: Array<string> = [];

      const first = yield* firstCoordinator
        .withCommandLock({
          targetKey: "instance:codex",
          lockKey: "npm-global",
          run: ({ waited }) =>
            Effect.gen(function* () {
              events.push(`first start waited=${waited}`);
              yield* Deferred.succeed(firstRunning, undefined);
              yield* Deferred.await(releaseFirst);
              events.push("first end");
            }),
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstRunning);

      const second = yield* secondCoordinator
        .withCommandLock({
          targetKey: "instance:codex",
          lockKey: "npm-global",
          run: ({ waited }) => Effect.sync(() => events.push(`second start waited=${waited}`)),
        })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(events, ["first start waited=false"]);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* advanceClockUntilDone(second);

      assert.deepStrictEqual(events, [
        "first start waited=false",
        "first end",
        "second start waited=true",
      ]);
      const fileSystem = yield* FileSystem.FileSystem;
      assert.strictEqual(yield* fileSystem.exists(yield* lockFilePath(lockDirectory)), false);
    }).pipe(Effect.provide(FileLockServices)),
  );

  it.effect("takes over a lock file left behind by a dead process", () =>
    Effect.gen(function* () {
      const lockDirectory = yield* makeLockDirectory;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        yield* lockFilePath(lockDirectory),
        lockOwner(DEAD_PROCESS_ID),
      );
      const coordinator = yield* makeCoordinator(lockDirectory);

      const waited = yield* coordinator.withCommandLock({
        targetKey: "instance:codex",
        lockKey: "npm-global",
        run: (context) => Effect.succeed(context.waited),
      });

      assert.strictEqual(waited, false);
    }).pipe(Effect.provide(FileLockServices)),
  );

  it.effect("takes over a lock file older than the stale window", () =>
    Effect.gen(function* () {
      const lockDirectory = yield* makeLockDirectory;
      const fileSystem = yield* FileSystem.FileSystem;
      const lockPath = yield* lockFilePath(lockDirectory);
      // A live pid, so only the file's age can mark it stale.
      yield* fileSystem.writeFileString(lockPath, lockOwner(process.pid));
      const lockInfo = yield* fileSystem.stat(lockPath);
      const writtenAt = Option.getOrThrow(lockInfo.mtime).getTime();
      yield* TestClock.setTime(writtenAt + Duration.toMillis(STALE_AFTER) + 1);
      const coordinator = yield* makeCoordinator(lockDirectory);

      const ran = yield* coordinator.withCommandLock({
        targetKey: "instance:codex",
        lockKey: "npm-global",
        run: () => Effect.succeed(true),
      });

      assert.strictEqual(ran, true);
    }).pipe(Effect.provide(FileLockServices)),
  );
});
