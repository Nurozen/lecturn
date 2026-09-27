import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { makeHelperRequestGate } from "./ExtensionsRuntime.ts";
it.effect("serializes overlapping polls and releases the helper after completion", () =>
  Effect.gen(function* () {
    const gate = yield* makeHelperRequestGate;
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    const sequence: string[] = [];
    const first = yield* gate(
      Effect.gen(function* () {
        sequence.push("first");
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        sequence.push("finished");
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* gate(
      Effect.sync(() => {
        sequence.push("second");
      }),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.deepEqual(sequence, ["first"]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.deepEqual(sequence, ["first", "finished", "second"]);
  }),
);
it.effect("a stuck helper request times out and cannot keep the gate locked", () =>
  Effect.gen(function* () {
    const gate = yield* makeHelperRequestGate;
    const first = yield* gate(Effect.never).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    assert.isTrue(Result.isFailure(yield* Fiber.join(first)));
    assert.equal(yield* gate(Effect.succeed("ready")), "ready");
  }),
);
