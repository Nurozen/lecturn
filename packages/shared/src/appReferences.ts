/**
 * Splits text into plain runs and app references such as `rw:c/fins`, for an
 * app's registered `refPrefixes`. Kept apart from `composerInlineTokens`, whose
 * tokens need a trailing space and carry composer-only kinds.
 */

export interface AppReferenceMatch {
  readonly ref: string;
  readonly prefix: string;
  readonly start: number;
  readonly end: number;
}

export type AppReferenceSegment =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "ref" } & AppReferenceMatch);

// A reference can open a sentence or a bracket, but not continue a word, path or URL.
const BOUNDARY_BEFORE = /[\s([{"'`]/u;
// Punctuation that closes a sentence or bracket around a reference, not part of it.
const BODY_CHARS = /[^\s()[\]{}<>"'`,;]+/uy;
const TRAILING_PUNCTUATION = /[.:!?]+$/u;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function prefixPattern(refPrefixes: ReadonlyArray<string>): RegExp | null {
  // Longest first, so a prefix that extends another wins at the same position.
  const prefixes = [...new Set(refPrefixes.filter((prefix) => prefix.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  return prefixes.length === 0 ? null : new RegExp(prefixes.map(escapeRegExp).join("|"), "gu");
}

export function findAppReferences(
  text: string,
  refPrefixes: ReadonlyArray<string>,
): AppReferenceMatch[] {
  const pattern = prefixPattern(refPrefixes);
  if (pattern === null) return [];
  const matches: AppReferenceMatch[] = [];
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    const start = found.index;
    const prefix = found[0];
    if (start > 0 && !BOUNDARY_BEFORE.test(text[start - 1] ?? "")) continue;
    BODY_CHARS.lastIndex = start + prefix.length;
    const body = (BODY_CHARS.exec(text)?.[0] ?? "").replace(TRAILING_PUNCTUATION, "");
    if (body.length === 0) continue;
    const end = start + prefix.length + body.length;
    matches.push({ ref: text.slice(start, end), prefix, start, end });
    pattern.lastIndex = end;
  }
  return matches;
}

export function splitAppReferences(
  text: string,
  refPrefixes: ReadonlyArray<string>,
): AppReferenceSegment[] {
  const segments: AppReferenceSegment[] = [];
  let cursor = 0;
  for (const match of findAppReferences(text, refPrefixes)) {
    if (match.start > cursor)
      segments.push({ type: "text", text: text.slice(cursor, match.start) });
    segments.push({ type: "ref", ...match });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return segments;
}
