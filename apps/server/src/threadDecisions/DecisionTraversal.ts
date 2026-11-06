import type { DecisionEvaluationJudgment } from "@lecturn/contracts";
import { bisectDecisionSpan, type DecisionTextSpan } from "@lecturn/shared/decisionEvidence";
import { Effect } from "effect";

export interface DecisionTraversalResult {
  readonly spans: ReadonlyArray<DecisionTextSpan>;
  readonly judgments: number;
  readonly widened: boolean;
}
const qualifies = (judgment: DecisionEvaluationJudgment) =>
  judgment.exists !== "no" && judgment.relevant !== "no";

/** Keep every qualifying branch. A positive parent is retained when its children lose the commitment. */
export const localizeDecisionSpan = Effect.fn("DecisionTraversal.localizeDecisionSpan")(function* <
  E,
>(
  root: DecisionTextSpan,
  evaluate: (
    spans: ReadonlyArray<DecisionTextSpan>,
  ) => Effect.Effect<ReadonlyArray<DecisionEvaluationJudgment>, E>,
  limits: {
    readonly leafChars?: number;
    readonly depth?: number;
    readonly judgments?: number;
  } = {},
): Effect.fn.Return<DecisionTraversalResult, E> {
  let judgments = 0;
  let widened = false;
  const maximum = limits.judgments ?? 32;
  // Recursive per span; DecisionTraversal.localizeDecisionSpan owns the span.
  const visit = Effect.fnUntraced(function* (
    span: DecisionTextSpan,
    depth: number,
  ): Effect.fn.Return<ReadonlyArray<DecisionTextSpan>, E> {
    if (span.text.length <= (limits.leafChars ?? 2400)) return [span];
    if (depth >= (limits.depth ?? 4)) {
      widened = true;
      return [span];
    }
    const children = bisectDecisionSpan(span);
    if (children.length < 2) return [span];
    if (judgments + children.length > maximum) {
      widened = true;
      return [span];
    }
    const results = yield* evaluate(children);
    judgments += children.length;
    const matching = children.filter((_, index) => results[index] && qualifies(results[index]));
    if (matching.length === 0) return [span];
    const nested: DecisionTextSpan[] = [];
    for (const child of matching) nested.push(...(yield* visit(child, depth + 1)));
    return nested;
  });
  const rootJudgments = yield* evaluate([root]);
  judgments++;
  if (!rootJudgments[0] || !qualifies(rootJudgments[0])) return { spans: [], judgments, widened };
  return { spans: yield* visit(root, 0), judgments, widened };
});
