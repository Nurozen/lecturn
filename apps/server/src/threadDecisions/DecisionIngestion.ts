import { ThreadDecisionError } from "@lecturn/contracts";
import { Context, Effect, Layer, Ref, Semaphore, Stream, type Scope } from "effect";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { DecisionJobRepository } from "./DecisionJobRepository.ts";
import { decisionSourceEvent } from "./DecisionSourceEvents.ts";

const PAGE_SIZE = 200;

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

const unavailable = (message: string) => new ThreadDecisionError({ code: "unavailable", message });

/**
 * Tails the V2 application event log (project events and
 * application_event_version = 2 thread events). `decision_ingestion_cursor`
 * shares the log's global sequence space, so a cursor left by the V1 ingestion
 * resumes exactly at the first V2 event; V1 events are never decoded.
 */
export const make = Effect.gen(function* () {
  const events = yield* OrchestrationEventStore;
  const jobs = yield* DecisionJobRepository;
  const mutex = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);
  const latestSequence = events.latestApplicationSequence.pipe(
    Effect.mapError(() => unavailable("Decision history could not be read.")),
  );
  const drainThrough = Effect.fn("DecisionIngestion.drainThrough")(function* (sequence: number) {
    while ((yield* jobs.cursor) < sequence) {
      const cursor = yield* jobs.cursor;
      const page = yield* events
        .readApplicationEvents({ afterSequence: cursor, throughSequence: sequence })
        .pipe(
          Stream.take(PAGE_SIZE),
          Stream.runCollect,
          Effect.mapError(() => unavailable("Decision history could not be read.")),
        );
      if (page.length === 0)
        return yield* unavailable("Decision history has a gap before its committed boundary.");
      const sources = Array.from(page, decisionSourceEvent);
      // Ignored events only move the cursor; one write at the end of a run of
      // them keeps a large legacy-import backlog from costing a write each.
      for (const [index, source] of sources.entries()) {
        if (source.kind === "ignored" && index < sources.length - 1) continue;
        yield* jobs.processEvent(source);
      }
    }
  }, mutex.withPermits(1));
  const catchUp = Effect.gen(function* () {
    yield* drainThrough(yield* latestSequence);
  });
  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    yield* Effect.addFinalizer(() => Ref.set(started, false));
    const wakes = yield* jobs.subscribeWake;
    const highWater = yield* latestSequence;
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
    // The application stream replays from the captured high-water before going
    // live, so commits racing startup are delivered rather than dropped.
    yield* Effect.forkScoped(
      Stream.runForEach(events.streamApplicationEvents({ afterSequence: highWater }), (event) =>
        recover(drainThrough(event.sequence)),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Decision ingestion live tail stopped.", { cause }),
        ),
      ),
    );
    yield* Effect.forkScoped(Stream.runForEach(wakes, () => recover(catchUp)));
    yield* drainThrough(highWater);
    yield* jobs.notify;
  });
  return DecisionIngestion.of({ start, drainThrough, catchUp });
});
export const layer = Layer.effect(DecisionIngestion, make);
