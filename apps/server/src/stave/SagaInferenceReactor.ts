import { Context, Effect, Layer, Stream, SubscriptionRef, Cause } from "effect";
import { makeDrainableWorker } from "@lecturn/shared/DrainableWorker";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../serverActivation.ts";
import { SagaWorkbenchService, type SagaInferenceRequest } from "./SagaWorkbenchService.ts";

export class SagaInferenceReactor extends Context.Service<
  SagaInferenceReactor,
  {
    readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly drainThrough: (sequence: number) => Effect.Effect<void>;
  }
>()("lecturn/stave/SagaInferenceReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
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
    const events = yield* engine.subscribeDomainEvents;
    yield* SubscriptionRef.set(seen, yield* engine.latestSequence);
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        Effect.gen(function* () {
          if (event.type === "thread.turn-start-requested") {
            const request = yield* workbench.preparePromptInference(event);
            if (request) yield* worker.enqueue(request);
          }
        }).pipe(
          Effect.catchCause(recover),
          Effect.ensuring(
            SubscriptionRef.update(seen, (sequence) => Math.max(sequence, event.sequence)),
          ),
        ),
      ),
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
