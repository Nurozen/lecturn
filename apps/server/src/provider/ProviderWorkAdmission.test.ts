import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, TurnId } from "@lecturn/contracts";
import { Deferred, Effect, Fiber, Result } from "effect";
import { make } from "./ProviderWorkAdmission.ts";

const provider = ProviderInstanceId.make("codex-qa");
const thread = ThreadId.make("foreground-qa");

it.effect("foreground cancels an admitted writer and waits for its finalizer", () =>
  Effect.gen(function* () {
    const admission = yield* make;
    const started = yield* Deferred.make<void>();
    let finalized = false;
    const writer = yield* admission
      .runWriter(
        provider,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const token = yield* admission.beginForeground(provider, thread);
    assert.isTrue(finalized);
    assert.isTrue(yield* admission.hasForeground(provider));
    assert.isTrue(
      Result.isFailure(
        yield* admission.runWriter(provider, Effect.succeed("blocked")).pipe(Effect.result),
      ),
    );
    yield* admission.acknowledgeForeground(thread, token, TurnId.make("turn"));
    yield* admission.finishForeground(thread, TurnId.make("turn"));
    assert.equal(yield* admission.runWriter(provider, Effect.succeed("ready")), "ready");
    yield* Fiber.await(writer);
  }).pipe(Effect.scoped),
);

it.effect(
  "an early completion is matched to its acknowledgement; stale events cannot release a new turn",
  () =>
    Effect.gen(function* () {
      const admission = yield* make;
      const token = yield* admission.beginForeground(provider, thread);
      yield* admission.finishForeground(thread, TurnId.make("old"));
      yield* admission.acknowledgeForeground(thread, token, TurnId.make("new"));
      assert.isTrue(yield* admission.hasForeground(provider));
      yield* admission.finishForeground(thread, TurnId.make("old"));
      assert.isTrue(yield* admission.hasForeground(provider));
      yield* admission.finishForeground(thread, TurnId.make("new"));
      const second = yield* admission.beginForeground(provider, thread);
      yield* admission.finishForeground(thread, TurnId.make("fast"));
      yield* admission.acknowledgeForeground(thread, second, TurnId.make("fast"));
      assert.isFalse(yield* admission.hasForeground(provider));
    }),
);

it.effect("permits one helper per instance while leaving another account independent", () =>
  Effect.gen(function* () {
    const admission = yield* make;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const writer = yield* admission
      .runWriter(
        provider,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    assert.isTrue(
      Result.isFailure(yield* admission.runWriter(provider, Effect.void).pipe(Effect.result)),
    );
    assert.equal(
      yield* admission.runWriter(ProviderInstanceId.make("other"), Effect.succeed(1)),
      1,
    );
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(writer);
    assert.equal(yield* admission.runWriter(provider, Effect.succeed(2)), 2);
  }).pipe(Effect.scoped),
);

it.effect("interrupting foreground admission cannot strand a provider-busy marker", () =>
  Effect.gen(function* () {
    const admission = yield* make;
    const started = yield* Deferred.make<void>();
    const cleaning = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const writer = yield* admission
      .runWriter(
        provider,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const foreground = yield* admission.beginForeground(provider, thread).pipe(Effect.forkChild);
    yield* Deferred.await(cleaning);
    const interrupted = yield* Fiber.interrupt(foreground).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupted);
    assert.isFalse(yield* admission.hasForeground(provider));
    yield* Fiber.await(writer);
    assert.equal(yield* admission.runWriter(provider, Effect.succeed("ready")), "ready");
  }).pipe(Effect.scoped),
);
