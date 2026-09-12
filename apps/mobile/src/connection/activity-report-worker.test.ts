import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { runMobileActivityReports } from "./activity-report-worker";

describe("mobile activity reporting", () => {
  it.effect(
    "replaces stalled reports on repeated foreground transitions without accumulating work",
    () =>
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<void>();
        const started = yield* Queue.unbounded<boolean>();
        const visible = yield* Ref.make(false);
        const inFlight = yield* Ref.make(0);
        const report = Effect.gen(function* () {
          yield* Ref.update(inFlight, (count) => count + 1);
          yield* Queue.offer(started, yield* Ref.get(visible));
          yield* Effect.never;
        }).pipe(Effect.ensuring(Ref.update(inFlight, (count) => count - 1)));
        yield* runMobileActivityReports(Stream.fromQueue(requests), report).pipe(Effect.forkScoped);

        for (let cycle = 0; cycle < 8; cycle++) {
          for (const active of [false, true]) {
            yield* Ref.set(visible, active);
            yield* Queue.offer(requests, undefined);
            yield* TestClock.adjust("250 millis");
            expect(yield* Queue.take(started)).toBe(active);
            expect(yield* Ref.get(inFlight)).toBe(1);
          }
        }
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("bounds a stuck report and still accepts the next periodic refresh", () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<void>();
      const started = yield* Queue.unbounded<void>();
      const released = yield* Deferred.make<void>();
      const report = Queue.offer(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(released, undefined)),
      );
      yield* runMobileActivityReports(Stream.fromQueue(requests), report).pipe(Effect.forkScoped);
      yield* Queue.offer(requests, undefined);
      yield* TestClock.adjust("250 millis");
      yield* Queue.take(started);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(released);
      yield* Queue.offer(requests, undefined);
      yield* TestClock.adjust("250 millis");
      yield* Queue.take(started);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
