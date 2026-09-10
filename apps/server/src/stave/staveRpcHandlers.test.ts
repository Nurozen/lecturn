import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { StaveSagaStatus } from "@t3tools/contracts";
import { StaveCli } from "./StaveCli.ts";
import { StaveReadCache, layer as readCacheLayer } from "./StaveReadCache.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";
import { makeRuntime, toSagaStatusDto } from "./staveRpcHandlers.ts";
import { decodeStaveSagaStatus } from "./staveJson.ts";
import { SAMPLE_SAGA_STATUS } from "./testing/staveJsonSamples.ts";
import { StaveError } from "./StaveError.ts";

const decodeSagaStatus = Schema.decodeUnknownEffect(StaveSagaStatus);
const readerLayer = Layer.mock(StaveWorkspaceReader)({
  load: () =>
    Effect.succeed(
      Option.some({ spaceId: "s", isSaga: true, state: "live", repos: [], memories: [] }),
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
