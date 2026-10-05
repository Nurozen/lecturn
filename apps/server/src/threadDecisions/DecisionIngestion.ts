import { ThreadDecisionError } from "@lecturn/contracts";
import { Context, Effect, Layer, Ref, Semaphore, Stream, type Scope } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { DecisionJobRepository } from "./DecisionJobRepository.ts";

export class DecisionIngestion extends Context.Service<
  DecisionIngestion,
  {
    /** Ready after the captured high-water has been durably reconciled. */
    readonly start: Effect.Effect<void, ThreadDecisionError, Scope.Scope>;
    /** An explicit drain receipt useful for startup, retry and deterministic tests. */
    readonly drainThrough: (sequence: number) => Effect.Effect<void, ThreadDecisionError>;
    readonly catchUp: Effect.Effect<void, ThreadDecisionError>;
  }
>()("lecturn/threadDecisions/DecisionIngestion") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const jobs = yield* DecisionJobRepository;
  const mutex = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);
  const drainThrough = Effect.fn("DecisionIngestion.drainThrough")(function* (sequence: number) {
    while ((yield* jobs.cursor) < sequence) {
      const cursor = yield* jobs.cursor;
      const page = yield* engine.readEvents(cursor, 200).pipe(
        Stream.takeWhile((event) => event.sequence <= sequence),
        Stream.runCollect,
        Effect.mapError(
          () =>
            new ThreadDecisionError({
              code: "unavailable",
              message: "Decision history could not be read.",
            }),
        ),
      );
      if (page.length === 0)
        return yield* new ThreadDecisionError({
          code: "unavailable",
          message: "Decision history has a gap before its committed boundary.",
        });
      for (const event of page) yield* jobs.processEvent(event);
    }
  }, mutex.withPermits(1));
  const catchUp = Effect.gen(function* () {
    yield* drainThrough(yield* engine.latestSequence);
  });
  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    yield* Effect.addFinalizer(() => Ref.set(started, false));
    // Acquire the hot subscription first; commits during replay remain queued here.
    const events = yield* engine.subscribeDomainEvents;
    const wakes = yield* jobs.subscribeWake;
    const highWater = yield* engine.latestSequence;
    const failed = yield* Ref.make(false);
    const recover = (work: Effect.Effect<void, ThreadDecisionError>) =>
      work.pipe(
        Effect.tap(() => Ref.set(failed, false)),
        Effect.catch(() =>
          Effect.gen(function* () {
            if (!(yield* Ref.getAndSet(failed, true)))
              yield* Effect.logError(
                "Decision ingestion paused after a storage failure; the next source or explicit recovery wake will replay committed history.",
              );
          }),
        ),
      );
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) => recover(drainThrough(event.sequence))),
    );
    yield* Effect.forkScoped(Stream.runForEach(wakes, () => recover(catchUp)));
    yield* drainThrough(highWater);
    yield* jobs.notify;
  });
  return DecisionIngestion.of({ start, drainThrough, catchUp });
});
export const layer = Layer.effect(DecisionIngestion, make);
