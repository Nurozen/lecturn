import type {
  ContextualCandidate,
  ContextualJudgment,
  ContextualEvidence,
} from "@lecturn/contracts";

/** Apply only validated original UTF-16 spans; selection policy belongs to the private service. */
export function applyContextualSelection(
  candidate: ContextualCandidate,
  judgment: ContextualJudgment,
): ContextualCandidate | null {
  const spans = judgment.selectedEvidenceSpans;
  if (spans === undefined) return candidate;
  if (
    spans.length !== judgment.selectedEvidenceIds.length ||
    new Set(spans.map((s) => s.evidenceId)).size !== spans.length
  )
    return null;
  const evidence = [];
  for (const span of spans) {
    const original = candidate.evidence.find((e) => e.id === span.evidenceId);
    if (
      !original ||
      !judgment.selectedEvidenceIds.includes(span.evidenceId) ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < original.start ||
      span.end > original.end ||
      span.end <= span.start
    )
      return null;
    const start = span.start - original.start,
      end = span.end - original.start;
    const splitsPair = (offset: number) =>
      offset > 0 &&
      /[\uD800-\uDBFF]/u.test(original.quote[offset - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(original.quote[offset] ?? "");
    if (splitsPair(start) || splitsPair(end)) return null;
    evidence.push({
      ...original,
      start: span.start,
      end: span.end,
      quote: original.quote.slice(start, end),
      prefix: (original.prefix + original.quote.slice(0, start)).slice(-128),
      suffix: (original.quote.slice(end) + original.suffix).slice(0, 128),
    });
  }
  if (!evidence.length) return null;
  // Saved Decision justification remains intact; partial Decision anchors are not supported.
  if (
    candidate.sourceKind === "lecturn-decision" &&
    (evidence.length !== candidate.evidence.length ||
      evidence.some(
        (e, i) => e.start !== candidate.evidence[i]?.start || e.end !== candidate.evidence[i]?.end,
      ))
  )
    return null;
  return { ...candidate, evidence };
}

/** Previously supplied exact source ranges cover a selection even when earlier packets split it. */
export function contextualEvidenceCovered(
  evidence: readonly ContextualEvidence[],
  supplied: readonly ContextualEvidence[],
): boolean {
  return evidence.every((e) => {
    const spans = supplied
      .filter(
        (prior) =>
          prior.id === e.id &&
          prior.sourceHash === e.sourceHash &&
          prior.sourceId === e.sourceId &&
          prior.canonicalVersion === e.canonicalVersion &&
          prior.start < e.end &&
          prior.end > e.start &&
          prior.quote.slice(
            Math.max(e.start, prior.start) - prior.start,
            Math.min(e.end, prior.end) - prior.start,
          ) ===
            e.quote.slice(
              Math.max(e.start, prior.start) - e.start,
              Math.min(e.end, prior.end) - e.start,
            ),
      )
      .sort((a, b) => a.start - b.start);
    let through = e.start;
    for (const span of spans) {
      if (span.start > through) return false;
      through = Math.max(through, span.end);
    }
    return through >= e.end;
  });
}
