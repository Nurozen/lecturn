import { assert, it } from "@effect/vitest";
import { Effect, Metric } from "effect";
import {
  observeDecisionEvaluation,
  recordDecisionAttempt,
  recordDecisionTokens,
} from "./DecisionsTelemetry.ts";

it.effect("records numeric usage and bounded outcomes without request or error content", () =>
  Effect.gen(function* () {
    const sentinel = "PRIVATE_CONVERSATION_API_KEY_SENTINEL";
    yield* Effect.succeed({ replayed: false, text: sentinel }).pipe(observeDecisionEvaluation);
    yield* Effect.succeed({ replayed: true }).pipe(observeDecisionEvaluation);
    yield* Effect.fail({ message: sentinel }).pipe(observeDecisionEvaluation, Effect.exit);
    yield* recordDecisionAttempt("unknown");
    yield* recordDecisionTokens(23);
    const snapshots = (yield* Metric.snapshot).filter((item) =>
      item.id.startsWith("lecturn_decisions_"),
    );
    assert.isTrue(snapshots.some((item) => item.attributes?.outcome === "replay"));
    assert.isTrue(snapshots.some((item) => item.attributes?.outcome === "failed"));
    assert.isTrue(snapshots.some((item) => item.id === "lecturn_decisions_input_tokens_total"));
    for (const snapshot of snapshots) {
      assert.notInclude(snapshot.id, sentinel);
      for (const [name, value] of Object.entries(snapshot.attributes ?? {})) {
        assert.include(["outcome", "time_unit"], name);
        assert.notInclude(value, sentinel);
      }
    }
  }),
);
