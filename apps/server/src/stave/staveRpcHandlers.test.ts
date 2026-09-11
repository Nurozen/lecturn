import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Ref, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { DEFAULT_SERVER_SETTINGS, StaveSagaStatus, type ServerSettings } from "@lecturn/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../serverSettings.ts";
import { layerFixed as binaryLayerFixed } from "./StaveBinary.ts";
import { layer as executionLayer, StaveExecution } from "./StaveExecution.ts";
import { StaveExecutionContext } from "./StaveExecutionContext.ts";
import { StaveCli } from "./StaveCli.ts";
import { StaveReadCache, layer as readCacheLayer } from "./StaveReadCache.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";
import { makeRuntime, toSagaStatusDto, type StaveRpcRuntimeShape } from "./staveRpcHandlers.ts";
import { decodeStaveSagaStatus } from "./staveJson.ts";
import { SAMPLE_SAGA_STATUS } from "./testing/staveJsonSamples.ts";
import { StaveError } from "./StaveError.ts";

const decodeSagaStatus = Schema.decodeUnknownEffect(StaveSagaStatus);
const readerLayer = Layer.mock(StaveWorkspaceReader)({
  invalidate: () => Effect.void,
  load: () =>
    Effect.succeed(
      Option.some({
        spaceId: "s",
        createdAt: "2026-09-01T00:00:00Z",
        isSaga: true,
        state: "live",
        repos: [],
        memories: [],
      }),
    ),
});

describe("saga status RPC runtime", () => {
  it.effect("maps the frozen snake_case fixture into the public camelCase DTO", () =>
    Effect.gen(function* () {
      const decoded = decodeStaveSagaStatus(SAMPLE_SAGA_STATUS);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (Result.isFailure(decoded)) return;
      const raw = decoded.success;
      const dto = yield* decodeSagaStatus(toSagaStatusDto(raw));
      expect(dto).toEqual(raw);
      expect(dto.members.map((member) => member.id)).toEqual(
        raw.members.map((member) => member.id),
      );
    }),
  );
  it.effect("caches for fifteen seconds and invalidates immediately after mutation", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Effect.gen(function* () {
        const runtime = yield* makeRuntime();
        const invalidation = yield* StaveReadCache;
        expect((yield* runtime.sagaStatus("/spaces/s")).sagaId).toBe("s");
        yield* runtime.sagaStatus("/spaces/s");
        expect(calls).toBe(1);
        yield* invalidation.invalidate;
        yield* runtime.sagaStatus("/spaces/s");
        expect(calls).toBe(2);
        yield* TestClock.adjust("16 seconds");
        yield* runtime.sagaStatus("/spaces/s");
        expect(calls).toBe(3);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            readerLayer,
            readCacheLayer,
            Layer.mock(StaveCli)({
              spaceStatus: () =>
                Effect.succeed({
                  spaceId: "s",
                  spacePath: "/spaces/s",
                  manifest: {
                    id: "s",
                    version: 2,
                    createdAt: "2026-09-01T00:00:00Z",
                    repos: [],
                    memories: [],
                  },
                  repos: [],
                  memories: [],
                }),
              sagaStatus: () =>
                Effect.sync(() => {
                  calls++;
                  return { sagaId: "s", members: [], notes: [] };
                }),
            }),
          ),
        ),
      );
    }),
  );
  it.effect("does not cache failures", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Effect.gen(function* () {
        const runtime = yield* makeRuntime();
        yield* runtime.sagaStatus("/spaces/s").pipe(Effect.exit);
        expect((yield* runtime.sagaStatus("/spaces/s")).sagaId).toBe("s");
        expect(calls).toBe(2);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            readerLayer,
            Layer.mock(StaveCli)({
              spaceStatus: () =>
                Effect.succeed({
                  spaceId: "s",
                  spacePath: "/spaces/s",
                  manifest: {
                    id: "s",
                    version: 2,
                    createdAt: "2026-09-01T00:00:00Z",
                    repos: [],
                    memories: [],
                  },
                  repos: [],
                  memories: [],
                }),
              sagaStatus: () =>
                Effect.suspend(() =>
                  ++calls === 1
                    ? Effect.fail(
                        new StaveError({
                          verb: "saga status",
                          code: "unreadable",
                          message: "retry",
                          details: null,
                          exitCode: 1,
                          stderrTail: null,
                        }),
                      )
                    : Effect.succeed({ sagaId: "s", members: [], notes: [] }),
                ),
            }),
          ),
        ),
      );
    }),
  );
});

it.effect("does not resolve an archived saga root to a replacement live saga id", () =>
  Effect.gen(function* () {
    const runtime = yield* makeRuntime();
    const error = yield* Effect.flip(runtime.sagaStatus("/spaces/.archive/s"));
    expect(error).toMatchObject({ code: "archived_project" });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(StaveWorkspaceReader)({
          invalidate: () => Effect.void,
          load: () =>
            Effect.succeed(
              Option.some({
                spaceId: "s",
                isSaga: true,
                state: "archived",
                repos: [],
                memories: [],
                archiveBasename: "s",
              }),
            ),
        }),
        Layer.mock(StaveCli)({ sagaStatus: () => Effect.die("must not read replacement live id") }),
      ),
    ),
  ),
);

const root = "/spaces/s";
const stamp = "2026-09-01T00:00:00Z";
const rawStatus = (spacePath = root, createdAt = stamp) => ({
  spaceId: "s",
  spacePath,
  manifest: { id: "s", version: 2, createdAt, repos: [], memories: [] },
  repos: [],
  memories: [],
});

const readStatus = (runtime: StaveRpcRuntimeShape, method: "spaceStatus" | "sagaStatus") =>
  method === "spaceStatus"
    ? runtime.spaceStatus(root).pipe(Effect.asVoid)
    : runtime.sagaStatus(root).pipe(Effect.asVoid);

for (const method of ["spaceStatus", "sagaStatus"] as const) {
  for (const mismatch of ["root", "incarnation"] as const) {
    it.effect(`${method} refuses a same-ID ${mismatch} from another configuration`, () =>
      Effect.gen(function* () {
        let sagaReads = 0;
        yield* Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const failure = yield* Effect.flip(readStatus(runtime, method));
          expect(failure).toMatchObject({ code: "incarnation_mismatch" });
          expect(sagaReads).toBe(0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              readerLayer,
              Layer.mock(StaveCli)({
                spaceStatus: () =>
                  Effect.succeed(
                    rawStatus(
                      mismatch === "root" ? "/other/s" : root,
                      mismatch === "incarnation" ? "2026-09-02T00:00:00Z" : stamp,
                    ),
                  ),
                sagaStatus: () =>
                  Effect.sync(() => {
                    sagaReads++;
                    return { sagaId: "s", members: [], notes: [] };
                  }),
                sagaList: Effect.succeed([]),
              }),
            ),
          ),
        );
      }),
    );
  }
  for (const changedSetting of ["configPath", "binaryPath"] as const) {
    it.effect(`${method} invalidates cached identity when ${changedSetting} changes`, () =>
      Effect.gen(function* () {
        const current = yield* Ref.make<ServerSettings>({
          ...DEFAULT_SERVER_SETTINGS,
          stave: {
            ...DEFAULT_SERVER_SETTINGS.stave,
            configPath: "/config/a",
            binaryPath: "/binary/a",
          },
        });
        let reads = 0;
        yield* Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          yield* readStatus(runtime, method);
          yield* readStatus(runtime, method);
          expect(reads).toBe(1);
          yield* Ref.update(current, (value) => ({
            ...value,
            stave: { ...value.stave, [changedSetting]: "/selected/b" },
          }));
          const failure = yield* Effect.flip(readStatus(runtime, method));
          expect(failure).toMatchObject({ code: "incarnation_mismatch" });
          expect(reads).toBe(2);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              readerLayer,
              Layer.mock(ServerSettingsService)({ getSettings: Ref.get(current) }),
              Layer.mock(StaveCli)({
                spaceStatus: () => Effect.sync(() => rawStatus(++reads === 1 ? root : "/other/s")),
                sagaStatus: () => Effect.succeed({ sagaId: "s", members: [], notes: [] }),
                sagaList: Effect.succeed([]),
              }),
            ),
          ),
        );
      }),
    );
  }
}

it.effect("saga status uses fresh manifest identity after invalidating the workspace reader", () =>
  Effect.gen(function* () {
    let invalidated = false;
    const queried: string[] = [];
    yield* Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      expect((yield* runtime.sagaStatus(root)).sagaId).toBe("s");
      expect(queried).toEqual(["s"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(StaveWorkspaceReader)({
            invalidate: () =>
              Effect.sync(() => {
                invalidated = true;
              }),
            load: () =>
              Effect.sync(() =>
                Option.some({
                  spaceId: invalidated ? "s" : "stale",
                  createdAt: stamp,
                  isSaga: true,
                  state: "live" as const,
                  repos: [],
                  memories: [],
                }),
              ),
          }),
          Layer.mock(StaveCli)({
            spaceStatus: () => Effect.succeed(rawStatus()),
            sagaStatus: (id) =>
              Effect.sync(() => {
                queried.push(id);
                return { sagaId: id, members: [], notes: [] };
              }),
          }),
        ),
      ),
    );
  }),
);

it.effect(
  "saga read captures one execution config across status probes despite settings and source-file changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "stave-rpc-capture-" });
      const configA = `${directory}/a.yaml`;
      const configB = `${directory}/b.yaml`;
      yield* fs.writeFileString(configA, "root: /selected/a\n");
      yield* fs.writeFileString(configB, "root: /selected/b\n");
      const settings = yield* Ref.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        stave: { ...DEFAULT_SERVER_SETTINGS.stave, configPath: configA },
      });
      const settingsLayer = Layer.mock(ServerSettingsService)({ getSettings: Ref.get(settings) });
      const binary = binaryLayerFixed({
        path: "/fake/stave",
        source: "path",
        version: "0.4.0",
        commit: null,
      });
      const snapshots: string[] = [];
      yield* Effect.gen(function* () {
        const runtime = yield* makeRuntime();
        expect((yield* runtime.sagaStatus(root)).sagaId).toBe("s");
        expect(snapshots).toHaveLength(2);
        expect(snapshots[0]).toBe(snapshots[1]);
        expect(yield* fs.exists(snapshots[0]!)).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            readerLayer,
            settingsLayer,
            executionLayer.pipe(Layer.provide(Layer.mergeAll(settingsLayer, binary))),
            Layer.mock(StaveCli)({
              spaceStatus: () =>
                Effect.gen(function* () {
                  const context = yield* StaveExecutionContext;
                  expect(context?.sourceConfigPath).toBe(configA);
                  snapshots.push(context!.configPath);
                  expect(yield* fs.readFileString(context!.configPath)).toBe("root: /selected/a\n");
                  yield* Ref.update(settings, (value) => ({
                    ...value,
                    stave: { ...value.stave, configPath: configB },
                  }));
                  yield* fs.writeFileString(configA, "root: /overwritten\n");
                  return rawStatus();
                }).pipe(Effect.orDie),
              sagaStatus: () =>
                Effect.gen(function* () {
                  const context = yield* StaveExecutionContext;
                  snapshots.push(context!.configPath);
                  expect(context?.sourceConfigPath).toBe(configA);
                  expect(yield* fs.readFileString(context!.configPath)).toBe("root: /selected/a\n");
                  return { sagaId: "s", members: [], notes: [] };
                }).pipe(Effect.orDie),
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const makeCacheRaceFixture = Effect.fn("staveRpcHandlers.test.makeCacheRaceFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "stave-rpc-cache-race-" });
  const configA = `${directory}/a.yaml`;
  const configB = `${directory}/b.yaml`;
  yield* fs.writeFileString(configA, "root: /selected/a\n");
  yield* fs.writeFileString(configB, "root: /selected/b\n");
  const settings = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    stave: { ...DEFAULT_SERVER_SETTINGS.stave, configPath: configA },
  });
  const settingsLayer = Layer.mock(ServerSettingsService)({ getSettings: Ref.get(settings) });
  const binary = binaryLayerFixed({
    path: "/fake/stave",
    source: "path",
    version: "0.4.0",
    commit: null,
  });
  return {
    configA,
    configB,
    switchToB: Ref.update(settings, (value) => ({
      ...value,
      stave: { ...value.stave, configPath: configB },
    })),
    layer: Layer.mergeAll(
      readerLayer,
      settingsLayer,
      executionLayer.pipe(Layer.provide(Layer.mergeAll(settingsLayer, binary))),
    ),
  };
});

for (const method of ["spaceStatus", "sagaStatus"] as const) {
  it.effect(
    `${method} keys cached status by captured config when settings change before the first lookup`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeCacheRaceFixture();
        const reads: string[] = [];
        yield* Effect.gen(function* () {
          const execution = yield* StaveExecution;
          const runtime = yield* makeRuntime().pipe(
            Effect.provideService(StaveExecution, {
              withExecution: (body, options) =>
                execution.withExecution(fixture.switchToB.pipe(Effect.andThen(body)), options),
            }),
          );
          yield* readStatus(runtime, method);
          const failure = yield* Effect.flip(readStatus(runtime, method));
          expect(failure).toMatchObject({ code: "incarnation_mismatch" });
          expect(reads).toEqual([fixture.configA, fixture.configB]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              fixture.layer,
              Layer.mock(StaveCli)({
                spaceStatus: () =>
                  StaveExecutionContext.pipe(
                    Effect.map((context) => {
                      expect(context?.configurationIdentity).toEqual(expect.any(String));
                      reads.push(context!.sourceConfigPath);
                      return rawStatus(
                        context!.sourceConfigPath === fixture.configA ? root : "/other/s",
                      );
                    }),
                  ),
                sagaStatus: () => Effect.succeed({ sagaId: "s", members: [], notes: [] }),
                sagaList: Effect.succeed([]),
              }),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect(`${method} does not share an in-flight A lookup with a concurrent B capture`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeCacheRaceFixture();
      const aStarted = yield* Deferred.make<void>();
      const releaseA = yield* Deferred.make<void>();
      const reads: string[] = [];
      yield* Effect.gen(function* () {
        const execution = yield* StaveExecution;
        const runtime = yield* makeRuntime().pipe(
          Effect.provideService(StaveExecution, {
            withExecution: (body, options) =>
              execution.withExecution(fixture.switchToB.pipe(Effect.andThen(body)), options),
          }),
        );
        const a = yield* readStatus(runtime, method).pipe(Effect.forkChild);
        yield* Deferred.await(aStarted);
        const failure = yield* Effect.flip(readStatus(runtime, method));
        expect(failure).toMatchObject({ code: "incarnation_mismatch" });
        expect(reads).toEqual([fixture.configA, fixture.configB]);
        yield* Deferred.succeed(releaseA, undefined);
        yield* Fiber.join(a);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            fixture.layer,
            Layer.mock(StaveCli)({
              spaceStatus: () =>
                Effect.gen(function* () {
                  const context = yield* StaveExecutionContext;
                  reads.push(context!.sourceConfigPath);
                  if (context!.sourceConfigPath === fixture.configA) {
                    yield* Deferred.succeed(aStarted, undefined);
                    yield* Deferred.await(releaseA);
                    return rawStatus();
                  }
                  return rawStatus("/other/s");
                }),
              sagaStatus: () => Effect.succeed({ sagaId: "s", members: [], notes: [] }),
              sagaList: Effect.succeed([]),
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

it.effect("enriches saga members only with a uniquely verified enrolled incarnation", () =>
  Effect.gen(function* () {
    const stamp = "2026-09-01T00:00:00.000000001Z";
    const oldStamp = "2026-09-01T00:00:00.000000000Z";
    const readerSagaStamp = "2026-09-01T01:00:00.000000001+01:00";
    const statusMember = (id: string) => ({
      id,
      after: [],
      state: "live" as const,
      dirty: false,
      repos: [],
      prs: [],
    });
    const manifest = {
      id: "s",
      createdAt: stamp,
      repos: [],
      memories: [],
      saga: {
        members: ["a", "b", "c"].map((id) => ({ id, createdAt: stamp, after: [], prs: [] })),
      },
    };
    const row = (id: string, path: string, manifestCreatedAt = stamp) => ({
      id,
      path,
      isSaga: false,
      repos: [],
      archived: false,
      logicalId: id,
      manifestCreatedAt,
      manifestVersion: 2,
      memories: [],
    });
    const runtime = yield* makeRuntime().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(StaveWorkspaceReader)({
            invalidate: () => Effect.void,
            load: (root) =>
              Effect.succeed(
                Option.some({
                  spaceId: root === "/selected/s" ? "s" : "a",
                  createdAt: root === "/selected/s" ? readerSagaStamp : stamp,
                  isSaga: root === "/selected/s",
                  state: "live",
                  repos: [],
                  memories: [],
                }),
              ),
          }),
          Layer.mock(StaveCli)({
            spaceStatus: () =>
              Effect.succeed({
                spaceId: "s",
                spacePath: "/selected/s",
                manifest,
                repos: [],
                memories: [],
              }),
            sagaStatus: () =>
              Effect.succeed({
                sagaId: "s",
                members: ["a", "b", "c"].map(statusMember),
                notes: [],
              }),
            spaceList: () =>
              Effect.succeed([
                row("a", "/selected/a"),
                row("b", "/selected/b", oldStamp),
                row("c", "/selected/c"),
                row("c", "/other/c"),
              ]),
          }),
        ),
      ),
    );
    const result = yield* runtime.sagaStatus("/selected/s");
    const decoded = yield* decodeSagaStatus(result);
    expect(decoded.sagaCreatedAt).toBe(readerSagaStamp);
    expect(decoded.members).toEqual([
      { ...statusMember("a"), workspaceRoot: "/selected/a", createdAt: stamp },
      statusMember("b"),
      statusMember("c"),
    ]);
  }),
);
