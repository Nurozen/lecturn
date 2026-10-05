import { sha256 } from "@noble/hashes/sha2";
import { Encoding } from "effect";

export const DECISION_CANONICAL_VERSION = "1";

/** Markdown is retained as evidence. Only line endings change; offsets are UTF-16. */
export function canonicalDecisionText(source: string) {
  const offsets: number[] = [];
  let text = "";
  for (let index = 0; index < source.length; index++) {
    offsets.push(index);
    if (source[index] === "\r" && source[index + 1] === "\n") {
      text += "\n";
      index++;
    } else {
      text += source[index];
    }
  }
  offsets.push(source.length);
  return { text, sourceOffsets: offsets, version: DECISION_CANONICAL_VERSION };
}

export function decisionFingerprint(parts: ReadonlyArray<unknown>): string {
  return Encoding.encodeHex(sha256(new TextEncoder().encode(JSON.stringify(parts))));
}

export function decisionSourceHash(text: string): string {
  return decisionFingerprint([DECISION_CANONICAL_VERSION, canonicalDecisionText(text).text]);
}

export interface DecisionTextSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function safeBoundary(text: string, index: number): number {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? index - 1
    : index;
}

/** Partition without dropping whitespace, repeated text, or either half of a surrogate pair. */
export function splitDecisionText(text: string, maximumChars: number): DecisionTextSpan[] {
  if (!Number.isSafeInteger(maximumChars) || maximumChars < 2) {
    throw new RangeError("Decision chunk size must be an integer of at least two characters.");
  }
  const spans: DecisionTextSpan[] = [];
  let start = 0;
  while (start < text.length) {
    let end = safeBoundary(text, Math.min(start + maximumChars, text.length));
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n\n", end - 1);
      const line = text.lastIndexOf("\n", end - 1);
      const space = text.lastIndexOf(" ", end - 1);
      const minimum = start + Math.floor(maximumChars / 2);
      if (paragraph >= minimum) end = paragraph + 1;
      else if (line >= minimum) end = line + 1;
      else if (space >= minimum) end = space + 1;
    }
    spans.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return spans;
}

/** A binary subdivision never discards the parent; the traversal owns fallback decisions. */
export function bisectDecisionSpan(span: DecisionTextSpan): readonly DecisionTextSpan[] {
  if (span.text.length < 4) return [span];
  const middle = Math.floor(span.text.length / 2);
  const minimum = Math.floor(span.text.length / 4);
  let boundary = span.text.lastIndexOf("\n", middle);
  if (boundary < minimum) boundary = span.text.lastIndexOf(" ", middle);
  boundary = boundary >= minimum ? boundary + 1 : middle;
  boundary = safeBoundary(span.text, boundary);
  if (boundary <= 0 || boundary >= span.text.length) return [span];
  return [
    { start: span.start, end: span.start + boundary, text: span.text.slice(0, boundary) },
    { start: span.start + boundary, end: span.end, text: span.text.slice(boundary) },
  ];
}

export function resolveDecisionQuote(
  canonicalText: string,
  quote: string,
  within: { readonly start: number; readonly end: number } = {
    start: 0,
    end: canonicalText.length,
  },
): { start: number; end: number; prefix: string; suffix: string } | null {
  if (
    quote.trim().length === 0 ||
    !Number.isSafeInteger(within.start) ||
    !Number.isSafeInteger(within.end) ||
    within.start < 0 ||
    within.end > canonicalText.length ||
    within.end <= within.start
  )
    return null;
  const first = canonicalText.indexOf(quote, within.start);
  if (first < within.start || first + quote.length > within.end) return null;
  const another = canonicalText.indexOf(quote, first + 1);
  if (another >= 0 && another + quote.length <= within.end) return null;
  const end = first + quote.length;
  return {
    start: first,
    end,
    prefix: canonicalText.slice(Math.max(0, first - 80), first),
    suffix: canonicalText.slice(end, end + 80),
  };
}

/** Safe highlighting requires both the saved version and exact span to still agree. */
export function resolveDecisionSource(
  source: string | null,
  anchor: {
    readonly sourceHash: string;
    readonly quote: string;
    readonly start: number;
    readonly end: number;
  },
): "exact" | "message-only" | "unavailable" {
  if (source === null) return "unavailable";
  const { text } = canonicalDecisionText(source);
  return decisionSourceHash(source) === anchor.sourceHash &&
    anchor.start >= 0 &&
    anchor.end > anchor.start &&
    text.slice(anchor.start, anchor.end) === anchor.quote
    ? "exact"
    : "message-only";
}
