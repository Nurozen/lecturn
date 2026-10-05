import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { localizeDecisionSpan } from "./DecisionTraversal.ts";
const root = { start: 0, end: 80, text: "a".repeat(40) + "b".repeat(40) };
it.effect("retains every uncertain or positive branch within a deterministic judgment budget", () =>
  Effect.gen(function* () {
    const result = yield* localizeDecisionSpan(
      root,
      (spans) =>
        Effect.succeed(
          spans.map((_, index) => ({
            targetId: String(index),
            exists: "uncertain" as const,
            relevant: "yes" as const,
          })),
        ),
      { leafChars: 10, depth: 4, judgments: 7 },
    );
    assert.isAtMost(result.judgments, 7);
    assert.isTrue(result.widened);
    assert.equal(result.spans.map((span) => span.text).join(""), root.text);
  }),
);
it.effect("retains the positive parent when both children lose cross-boundary evidence", () =>
  Effect.gen(function* () {
    const result = yield* localizeDecisionSpan(
      root,
      (spans) =>
        Effect.succeed(
          spans.map((span, index) => ({
            targetId: String(index),
            exists: span.text.length === 80 ? ("yes" as const) : ("no" as const),
            relevant: "yes" as const,
          })),
        ),
      { leafChars: 10 },
    );
    assert.deepEqual(result.spans, [root]);
    assert.equal(result.judgments, 3);
  }),
);
it.effect("records clear negatives separately from evaluation failures", () =>
  Effect.gen(function* () {
    const result = yield* localizeDecisionSpan(root, () =>
      Effect.succeed([{ targetId: "root", exists: "no" as const, relevant: "yes" as const }]),
    );
    assert.equal(result.spans.length, 0);
    assert.equal(result.judgments, 1);
    const error = yield* localizeDecisionSpan(root, () => Effect.fail("unavailable")).pipe(
      Effect.flip,
    );
    assert.equal(error, "unavailable");
  }),
);
