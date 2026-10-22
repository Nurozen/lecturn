import { assert, it } from "@effect/vitest";
import * as C from "@lecturn/contracts";
import { Deferred, Effect, Fiber, Result } from "effect";
import type { LecturnTurnStartInput } from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import { make } from "./ProviderWorkAdmission.ts";
import { makeProviderWorkAdmissionContribution } from "./ProviderWorkAdmissionHooks.ts";

const provider = C.ProviderInstanceId.make("codex-qa");
const threadId = C.ThreadId.make("foreground-thread");
const start = (runId: string): LecturnTurnStartInput =>
  ({
    thread: { id: threadId } as unknown as C.OrchestrationV2AppThread,
    run: {
      id: C.RunId.make(runId),
      providerInstanceId: provider,
    } as unknown as C.OrchestrationV2Run,
    message: {} as LecturnTurnStartInput["message"],
    compaction: false,
  }) as LecturnTurnStartInput;
const terminal = (runId: string) => ({
  threadId,
  runId: C.RunId.make(runId),
  status: "completed" as const,
  sequence: 1,
  reconciled: false,
});

it.effect(
  "a V2 turn start interrupts a background writer and holds the provider until terminal",
  () =>
    Effect.gen(function* () {
      const admission = yield* make;
      const hooks = makeProviderWorkAdmissionContribution(admission);
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
      yield* hooks.beforeTurnStart!(start("run-1"));
      assert.isTrue(finalized);
      assert.isTrue(yield* admission.hasForeground(provider));
      assert.isTrue(
        Result.isFailure(
          yield* admission.runWriter(provider, Effect.succeed("blocked")).pipe(Effect.result),
        ),
      );
      yield* hooks.onRunTerminal!(terminal("run-1"));
      assert.isFalse(yield* admission.hasForeground(provider));
      assert.equal(yield* admission.runWriter(provider, Effect.succeed("ready")), "ready");
      yield* Fiber.await(writer);
    }).pipe(Effect.scoped),
);

it.effect("a stale terminal cannot release a newer run; retries keep one claim", () =>
  Effect.gen(function* () {
    const admission = yield* make;
    const hooks = makeProviderWorkAdmissionContribution(admission);
    yield* hooks.beforeTurnStart!(start("run-1"));
    yield* hooks.onRunTerminal!(terminal("run-1"));
    yield* hooks.beforeTurnStart!(start("run-2"));
    // A retried start attempt of the same run replaces its token.
    yield* hooks.beforeTurnStart!(start("run-2"));
    yield* hooks.onRunTerminal!(terminal("run-1"));
    assert.isTrue(yield* admission.hasForeground(provider));
    yield* hooks.onRunTerminal!(terminal("unknown-run"));
    assert.isTrue(yield* admission.hasForeground(provider));
    yield* hooks.onRunTerminal!(terminal("run-2"));
    assert.isFalse(yield* admission.hasForeground(provider));
  }),
);
