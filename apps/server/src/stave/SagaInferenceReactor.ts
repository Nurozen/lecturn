import { Context, Effect, Layer, Stream, SubscriptionRef, Cause } from "effect";
import { makeDrainableWorker } from "@lecturn/shared/DrainableWorker";
import type { ApplicationStoredEvent } from "@lecturn/contracts";
import { forkParked } from "../serverActivation.ts";
import { SagaWorkbenchService, type SagaInferenceRequest } from "./SagaWorkbenchService.ts";
import type { PromptInferenceEvent } from "./SagaWorkbenchService.ts";
import { StaveOrchestration } from "./StaveOrchestration.ts";

/**
 * A user-started V2 run is the turn-start signal V1 carried as
 * `thread.turn-start-requested`. Server-generated runs (restart
 * continuations, plan implementations) do not feed saga inference.
 */
export function promptInferenceEventOf(event: ApplicationStoredEvent): PromptInferenceEvent | null {
  if (!("event" in event) || event.event.type !== "run.created") return null;
  const run = event.event.payload;
  if (run.restartContinuationOfRunId !== undefined || run.sourcePlanRef !== undefined) return null;
  return {
    eventId: event.event.id,
    sequence: event.sequence,
    threadId: run.threadId,
    messageId: run.userMessageId,
    modelSelection: run.modelSelection,
  };
}

export class SagaInferenceReactor extends Context.Service<
  SagaInferenceReactor,
  {
    readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly drainThrough: (sequence: number) => Effect.Effect<void>;
  }
>()("lecturn/stave/SagaInferenceReactor") {}

export const make = Effect.gen(function* () {
  const orchestration = yield* StaveOrchestration;
  const workbench = yield* SagaWorkbenchService;
  const seen = yield* SubscriptionRef.make(0);
  const recover = (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning("Saga inference failed; the conversation continues unchanged", {
          cause: Cause.pretty(cause),
        });
  const worker = yield* makeDrainableWorker((request: SagaInferenceRequest) =>
    workbench.inferFromPrompt(request).pipe(Effect.asVoid, Effect.catchCause(recover)),
  );
  const start = Effect.fn("SagaInferenceReactor.start")(function* () {
    // Live tail only: a restart does not re-infer turns that were requested before it.
    const from = yield* orchestration.latestSequence.pipe(Effect.orElseSucceed(() => 0));
    yield* SubscriptionRef.set(seen, from);
    yield* forkParked(
      Stream.runForEach(orchestration.streamEvents(from), (event) =>
        Effect.gen(function* () {
          const prompt = promptInferenceEventOf(event);
          if (prompt === null) return;
          const request = yield* workbench.preparePromptInference(prompt);
          if (request) yield* worker.enqueue(request);
        }).pipe(
          Effect.catchCause(recover),
          Effect.ensuring(
            SubscriptionRef.update(seen, (sequence) => Math.max(sequence, event.sequence)),
          ),
        ),
      ).pipe(Effect.catchCause(recover)),
    );
  });
  const drainThrough = (sequence: number) =>
    SubscriptionRef.changes(seen).pipe(
      Stream.filter((seenSequence) => seenSequence >= sequence),
      Stream.runHead,
      Effect.andThen(worker.drain),
      Effect.asVoid,
    );
  return SagaInferenceReactor.of({ start, drainThrough });
});
export const layer = Layer.effect(SagaInferenceReactor, make);
