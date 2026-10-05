import { Clock, Duration, Effect, Exit, Metric } from "effect";

const evaluations = Metric.counter("lecturn_decisions_evaluations_total");
const latency = Metric.timer("lecturn_decisions_evaluation_duration");
const tokens = Metric.counter("lecturn_decisions_input_tokens_total");
const attempts = Metric.counter("lecturn_decisions_attempts_total");

/** Only bounded outcome labels and numeric usage leave the inference boundary. */
export const recordDecisionAttempt = (outcome: "dispatched" | "unknown" | "late") =>
  Metric.update(Metric.withAttributes(attempts, [["outcome", outcome]]), 1);
export const recordDecisionTokens = (inputTokens: number) => Metric.update(tokens, inputTokens);
export const observeDecisionEvaluation = <A extends { readonly replayed: boolean }, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    const exit = yield* Effect.exit(effect);
    const end = yield* Clock.currentTimeNanos;
    yield* Metric.update(latency, Duration.nanos(end > start ? end - start : 0n));
    const outcome = Exit.isSuccess(exit) ? (exit.value.replayed ? "replay" : "success") : "failed";
    yield* Metric.update(Metric.withAttributes(evaluations, [["outcome", outcome]]), 1);
    return Exit.isSuccess(exit) ? exit.value : yield* Effect.failCause(exit.cause);
  });
