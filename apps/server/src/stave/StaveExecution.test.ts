import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary } from "./StaveBinary.ts";
import { layer, StaveExecution } from "./StaveExecution.ts";
import { StaveExecutionContext, type StaveExecutionSnapshot } from "./StaveExecutionContext.ts";

const originalConfig =
  "# keep these bytes\r\nroot: '/workspace/雪'\nagentWorkDir: '/workspace/A'\n";
const replacementConfig = "root: /workspace/B\nagentWorkDir: /workspace/B/spaces\n";
const currentSnapshot = StaveExecutionContext.pipe(
  Effect.flatMap((snapshot) =>
    snapshot === undefined
      ? Effect.die("Execution context must be bound inside withExecution")
      : Effect.succeed(snapshot),
  ),
);

const makeFixture = Effect.fn("StaveExecution.test.makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stave-execution-test-" });
  const configA = path.join(root, "source-a.yaml");
  const configB = path.join(root, "source-b.yaml");
  const binaryA = path.join(root, "stave-a");
  const binaryB = path.join(root, "stave-b");
  yield* fs.writeFileString(configA, originalConfig);
  yield* fs.writeFileString(configB, replacementConfig);
  const privateDirectories: string[] = [];
  const binarySelections: string[] = [];
  const executionFileSystem: FileSystem.FileSystem = {
    ...fs,
    makeTempDirectoryScoped: (options) =>
      fs.makeTempDirectoryScoped(options).pipe(
        Effect.tap((directory) =>
          Effect.sync(() => {
            privateDirectories.push(directory);
          }),
        ),
      ),
  };
  const services = yield* Layer.build(
    layer.pipe(
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          stave: { enabled: true, binaryPath: binaryA, configPath: configA },
        }),
      ),
      Layer.provide(
        Layer.mock(StaveBinary)({
          resolveForPath: (configuredPath) =>
            Effect.sync(() => {
              binarySelections.push(configuredPath);
              return {
                path: configuredPath,
                source: "settings" as const,
                version: configuredPath === binaryA ? "0.4.0" : "0.5.0",
                commit: null,
              };
            }),
        }),
      ),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, executionFileSystem)),
    ),
  );
  return {
    fs,
    path,
    configA,
    configB,
    binaryA,
    binaryB,
    privateDirectories,
    binarySelections,
    execution: Context.get(services, StaveExecution),
    settings: Context.get(services, ServerSettingsService),
  };
});

describe("Stave execution snapshots", () => {
  it.effect(
    "reuses cache identity for identical captures but changes it when the same source file changes",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const first = yield* f.execution.withExecution(currentSnapshot);
        const same = yield* f.execution.withExecution(currentSnapshot);
        expect(first.configurationIdentity).toEqual(expect.any(String));
        expect(first.configurationIdentity).toBe(same.configurationIdentity);
        expect(first.configPath).not.toBe(same.configPath);
        yield* f.fs.writeFileString(f.configA, replacementConfig);
        const changed = yield* f.execution.withExecution(currentSnapshot);
        expect(changed.configurationIdentity).not.toBe(first.configurationIdentity);
        expect(changed.sourceConfigPath).toBe(first.sourceConfigPath);
        expect(changed.binary).toEqual(first.binary);
        yield* f.fs.writeFileString(f.configA, originalConfig);
        const restored = yield* f.execution.withExecution(currentSnapshot);
        expect(restored.configurationIdentity).toBe(first.configurationIdentity);
        yield* f.settings.updateSettings({ stave: { binaryPath: f.binaryB } });
        const binaryChanged = yield* f.execution.withExecution(currentSnapshot);
        expect(binaryChanged.configurationIdentity).not.toBe(first.configurationIdentity);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "pins configuration bytes and selected binary until completion, then uses new settings",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const originalBytes = yield* f.fs.readFile(f.configA);
        const captured = yield* f.execution.withExecution(
          Effect.gen(function* () {
            const snapshot = yield* currentSnapshot;
            expect(snapshot.configPath).not.toBe(f.configA);
            expect(snapshot.sourceConfigPath).toBe(f.configA);
            expect(snapshot.binary).toEqual({
              path: f.binaryA,
              source: "settings",
              version: "0.4.0",
              commit: null,
            });
            expect((yield* f.fs.stat(f.path.dirname(snapshot.configPath))).mode & 0o777).toBe(
              0o700,
            );
            expect((yield* f.fs.stat(snapshot.configPath)).mode & 0o777).toBe(0o600);
            expect(yield* f.fs.readFile(snapshot.configPath)).toEqual(originalBytes);

            yield* f.settings.updateSettings({
              stave: { binaryPath: f.binaryB, configPath: f.configB },
            });
            yield* f.fs.writeFileString(f.configA, "root: /changed-on-disk\n");
            expect(yield* currentSnapshot).toBe(snapshot);
            expect(yield* f.fs.readFile(snapshot.configPath)).toEqual(originalBytes);
            expect(snapshot.binary.path).toBe(f.binaryA);
            return snapshot;
          }),
        );
        expect(yield* f.fs.exists(captured.configPath)).toBe(false);
        expect(yield* f.fs.exists(f.path.dirname(captured.configPath))).toBe(false);
        expect(yield* StaveExecutionContext).toBeUndefined();
        expect(yield* f.fs.readFileString(f.configA)).toBe("root: /changed-on-disk\n");

        const next = yield* f.execution.withExecution(
          Effect.gen(function* () {
            const snapshot = yield* currentSnapshot;
            expect(snapshot.sourceConfigPath).toBe(f.configB);
            expect(snapshot.binary.path).toBe(f.binaryB);
            expect(snapshot.binary.version).toBe("0.5.0");
            expect(yield* f.fs.readFileString(snapshot.configPath)).toBe(replacementConfig);
            return snapshot;
          }),
        );
        expect(next.configPath).not.toBe(captured.configPath);
        expect(yield* f.fs.exists(next.configPath)).toBe(false);
        expect(f.binarySelections).toEqual([f.binaryA, f.binaryB]);
        expect(f.privateDirectories).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses the enclosing execution snapshot through nested option and settings changes",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const captured = yield* f.execution.withExecution(
          Effect.gen(function* () {
            const outer = yield* currentSnapshot;
            yield* f.settings.updateSettings({
              stave: { binaryPath: f.binaryB, configPath: f.configB },
            });
            const inner = yield* f.execution.withExecution(currentSnapshot, {
              writableConfig: true,
            });
            expect(inner).toBe(outer);
            expect(yield* f.fs.exists(outer.configPath)).toBe(true);
            expect(yield* f.fs.readFileString(outer.configPath)).toBe(originalConfig);
            expect(f.privateDirectories).toHaveLength(1);
            expect(f.binarySelections).toEqual([f.binaryA]);
            return outer;
          }),
        );
        expect(yield* f.fs.exists(f.path.dirname(captured.configPath))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the private snapshot when the operation fails", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const captured = yield* Deferred.make<StaveExecutionSnapshot>();
      const failure = yield* f.execution
        .withExecution(
          Effect.gen(function* () {
            yield* Deferred.succeed(captured, yield* currentSnapshot);
            return yield* Effect.fail("operation-failed" as const);
          }),
        )
        .pipe(Effect.flip);
      expect(failure).toBe("operation-failed");
      const snapshot = yield* Deferred.await(captured);
      expect(yield* f.fs.exists(snapshot.configPath)).toBe(false);
      expect(yield* f.fs.exists(f.path.dirname(snapshot.configPath))).toBe(false);
      expect(yield* f.fs.readFileString(f.configA)).toBe(originalConfig);
      expect(yield* StaveExecutionContext).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the private snapshot when an in-flight operation is interrupted", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const captured = yield* Deferred.make<StaveExecutionSnapshot>();
      const running = yield* f.execution
        .withExecution(
          Effect.gen(function* () {
            yield* Deferred.succeed(captured, yield* currentSnapshot);
            return yield* Effect.never;
          }),
        )
        .pipe(Effect.forkChild);
      const snapshot = yield* Deferred.await(captured);
      expect(yield* f.fs.exists(snapshot.configPath)).toBe(true);
      yield* Fiber.interrupt(running);
      expect(yield* f.fs.exists(snapshot.configPath)).toBe(false);
      expect(yield* f.fs.exists(f.path.dirname(snapshot.configPath))).toBe(false);
      expect(yield* f.fs.readFileString(f.configA)).toBe(originalConfig);
      expect(yield* StaveExecutionContext).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps writable execution on the selected original path without making a private copy",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const captured = yield* f.execution.withExecution(
          Effect.gen(function* () {
            const snapshot = yield* currentSnapshot;
            yield* f.settings.updateSettings({
              stave: { binaryPath: f.binaryB, configPath: f.configB },
            });
            expect(snapshot.configPath).toBe(f.configA);
            expect(snapshot.sourceConfigPath).toBe(f.configA);
            expect(snapshot.binary.path).toBe(f.binaryA);
            expect(yield* f.execution.withExecution(currentSnapshot)).toBe(snapshot);
            yield* f.fs.writeFileString(snapshot.configPath, "root: /setup-output\n");
            return snapshot;
          }),
          { writableConfig: true },
        );
        expect(f.privateDirectories).toEqual([]);
        expect(f.binarySelections).toEqual([f.binaryA]);
        expect(yield* f.fs.readFileString(captured.configPath)).toBe("root: /setup-output\n");
        expect(yield* f.fs.readFileString(f.configB)).toBe(replacementConfig);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "allows writable setup before its source config exists but refuses an uncaptured read",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.fs.remove(f.configA);
        const failure = yield* f.execution
          .withExecution(Effect.die("must not run without config"))
          .pipe(Effect.flip);
        expect(failure.code).toBe("not_setup");
        const captured = yield* f.execution.withExecution(currentSnapshot, {
          writableConfig: true,
        });
        expect(captured.configPath).toBe(f.configA);
        expect(f.privateDirectories).toEqual([]);
        expect(yield* f.fs.exists(f.configA)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
