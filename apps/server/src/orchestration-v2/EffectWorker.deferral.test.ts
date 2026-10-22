/**
 * Lecturn regression: a turn held by a fork hook (Contextual conflict awaiting
 * review) defers its provider-turn.start instead of waiting inside it, so held
 * turns never occupy the 4 global effect worker slots.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@lecturn/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";

const HELD_THREADS = 5;

const startEffect = (name: string): EffectOutbox.PendingOrchestrationEffectV2 => ({
  id: `effect:start:${name}`,
  commandId: CommandId.make(`command:start:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
  request: { type: "provider-turn.start", runId: RunId.make(`run:${name}`) },
});

/** Lets the worker fibers and SQLite make progress until `done` holds. */
const eventually = (label: string, done: () => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let step = 0; step < 2_000; step++) {
      if (yield* done()) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    assert.fail(`timed out waiting for: ${label}`);
  });

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const held = new Set<string>(
    Array.from({ length: HELD_THREADS }, (_, index) => `run:held-${index}`),
  );
  const attempts = new Map<string, number>();
  const started: Array<string> = [];
  const cleaned: Array<string> = [];
  const reviewResolved = yield* Deferred.make<void>();
  const executor = EffectWorker.OrchestrationEffectExecutorV2.of({
    execute: (effect) =>
      Effect.sync(() => {
        if (effect.request.type === "terminal.cleanup") {
          cleaned.push(effect.threadId);
          return;
        }
        if (effect.request.type !== "provider-turn.start") return;
        const runId = effect.request.runId;
        attempts.set(runId, (attempts.get(runId) ?? 0) + 1);
        if (held.has(runId)) {
          // What ProviderTurnStartService returns for a Contextual hold.
          return EffectOutbox.makeOrchestrationEffectDeferral({
            delayMs: 5_000,
            reason: "Contextual conflict awaits review",
            wake: Deferred.await(reviewResolved),
          });
        }
        started.push(runId);
      }),
  });
  const worker = yield* Effect.provide(
    Effect.service(EffectWorker.OrchestrationEffectWorkerV2),
    EffectWorker.layerWithOptions({ workerId: "deferral-test", maxAttempts: 2 }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
          Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, executor),
        ),
      ),
    ),
  );
  const daemon = yield* EffectWorker.runDaemonWithOptions({ concurrency: 4 }).pipe(
    Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
    Effect.forkChild,
  );
  const enqueue = (effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>) =>
    outbox.enqueue(effects).pipe(Effect.andThen(outbox.notifyAvailable(effects.length)));
  const row = (effectId: string) =>
    outbox.get(effectId).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);
  const resolveReview = Effect.sync(() => held.clear()).pipe(
    Effect.andThen(Deferred.succeed(reviewResolved, undefined)),
  );
  return { outbox, attempts, started, cleaned, enqueue, row, resolveReview, daemon };
});

const TestLayer = EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(TestLayer)("effect worker deferral (Lecturn)", (it) => {
  it.effect(
    "held turns release their slots: other threads start with 5 held on a 4-slot pool",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const heldEffects = Array.from({ length: HELD_THREADS }, (_, index) =>
          startEffect(`held-${index}`),
        );
        yield* h.enqueue(heldEffects);
        yield* eventually("every held turn attempted once", () =>
          Effect.sync(() => h.attempts.size === HELD_THREADS),
        );

        // A normal turn on another thread starts although 5 turns are held.
        yield* h.enqueue([startEffect("normal")]);
        yield* eventually("the normal turn started", () =>
          Effect.sync(() => h.started.includes("run:normal")),
        );
        // A held thread's other effects are not blocked by its deferred start.
        yield* h.enqueue([
          {
            id: "effect:cleanup:held-0",
            commandId: CommandId.make("command:cleanup:held-0"),
            threadId: ThreadId.make("thread:held-0"),
            request: { type: "terminal.cleanup" },
          },
        ]);
        yield* eventually("the held thread's cleanup ran", () =>
          Effect.sync(() => h.cleaned.includes("thread:held-0")),
        );
        for (const effect of heldEffects) {
          const current = yield* h.row(effect.id);
          assert.equal(current?.status, "pending");
          // Deferrals never spend retry attempts (maxAttempts is 2 here).
          assert.equal(current?.attemptCount, 0);
        }
        assert.deepEqual(h.started, ["run:normal"]);

        // Resolving the review wakes the deferred starts before their 5 s delay.
        yield* h.resolveReview;
        yield* eventually("every held turn started", () =>
          Effect.sync(() => h.started.length === HELD_THREADS + 1),
        );
        for (const effect of heldEffects) {
          yield* eventually(`${effect.id} settled`, () =>
            h.row(effect.id).pipe(Effect.map((current) => current?.status === "succeeded")),
          );
        }
        yield* Fiber.interrupt(h.daemon);
      }),
  );

  it.effect("a retry backoff keeps per-thread order; a held turn does not block", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const workerId = "order-test";
      const claim = outbox
        .claimNext({ workerId, leaseDurationMs: 30_000 })
        .pipe(Effect.map((claimed) => Option.getOrUndefined(claimed)?.id));
      const cleanup = (name: string): EffectOutbox.PendingOrchestrationEffectV2 => ({
        id: `effect:cleanup:${name}`,
        commandId: CommandId.make(`command:cleanup:${name}`),
        threadId: ThreadId.make(`thread:${name}`),
        request: { type: "terminal.cleanup" },
      });

      // Upstream ordering: a start waiting out a retry backoff blocks the
      // thread's later effects.
      yield* outbox.enqueue([startEffect("retrying")]);
      assert.equal(yield* claim, "effect:start:retrying");
      yield* outbox.retry({
        effectId: "effect:start:retrying",
        workerId,
        error: "failed once",
        delayMs: 60_000,
      });
      yield* outbox.enqueue([cleanup("retrying")]);
      assert.isUndefined(yield* claim);

      // Lecturn hold: a deferred start leaves the thread's later effects free.
      yield* outbox.enqueue([startEffect("held")]);
      assert.equal(yield* claim, "effect:start:held");
      yield* outbox.defer({
        effectId: "effect:start:held",
        workerId,
        reason: "Contextual conflict awaits review",
        delayMs: 60_000,
      });
      yield* outbox.enqueue([cleanup("held")]);
      assert.equal(yield* claim, "effect:cleanup:held");
      assert.isUndefined(yield* claim);
      yield* outbox.succeed({ effectId: "effect:cleanup:held", workerId });

      // Once the held start is claimed again it is an ordinary row: a later
      // effect waits for it while it runs.
      assert.isTrue(yield* outbox.expedite("effect:start:held"));
      assert.equal(yield* claim, "effect:start:held");
      yield* outbox.enqueue([{ ...cleanup("held"), id: "effect:cleanup:held-2" }]);
      assert.isUndefined(yield* claim);
    }),
  );

  it.effect("cancelling a held turn removes it without blocking the others", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const heldEffects = Array.from({ length: HELD_THREADS }, (_, index) =>
        startEffect(`held-${index}`),
      );
      yield* h.enqueue(heldEffects);
      yield* eventually("every held turn attempted once", () =>
        Effect.sync(() => h.attempts.size === HELD_THREADS),
      );
      // run.interrupt of a starting run cancels its unsettled start effect.
      const cancelled = yield* h.outbox.cancelUnsettled({
        threadId: ThreadId.make("thread:held-0"),
        effectTypes: ["provider-turn.start", "provider-turn.restart"],
        reason: "Run was interrupted before its provider turn started.",
      });
      assert.deepEqual(cancelled, ["effect:start:held-0"]);
      yield* h.outbox.signalCancellations(cancelled);
      yield* h.enqueue([startEffect("normal")]);
      yield* eventually("the normal turn started", () =>
        Effect.sync(() => h.started.includes("run:normal")),
      );
      yield* h.resolveReview;
      yield* eventually("the other held turns started", () =>
        Effect.sync(() => h.started.length === HELD_THREADS),
      );
      assert.isFalse(h.started.includes("run:held-0"));
      assert.equal((yield* h.row("effect:start:held-0"))?.status, "cancelled");
      // A late wake of the cancelled row never revives it.
      assert.isFalse(yield* h.outbox.expedite("effect:start:held-0"));
      yield* Fiber.interrupt(h.daemon);
    }),
  );
});
