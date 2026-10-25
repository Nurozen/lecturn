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

// A link scheme of its own so markdown renders a reference as a chip without guessing at text.
export const APP_REFERENCE_PROTOCOL = "lecturn-app-ref";
const APP_REFERENCE_HREF_PREFIX = `${APP_REFERENCE_PROTOCOL}://v1/`;

export function formatAppReferenceHref(ref: string): string {
  return `${APP_REFERENCE_HREF_PREFIX}${encodeURIComponent(ref)}`;
}

export function parseAppReferenceHref(href: string): string | null {
  if (!href.startsWith(APP_REFERENCE_HREF_PREFIX)) return null;
  try {
    const ref = decodeURIComponent(href.slice(APP_REFERENCE_HREF_PREFIX.length));
    return ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}

export interface AppOpenUrlValues {
  readonly workspaceRoot: string;
  readonly threadId: string | null;
  readonly ref?: string;
}

const OPEN_URL_PLACEHOLDER = /\{(workspaceRoot|threadId|ref)\}/g;

/**
 * Fills an app's `openUrlTemplate`. Values are percent-encoded because the template is a URL and
 * a workspace path or reference may hold `&`, `#` or spaces. A template that does not yield a URL
 * opens nothing.
 */
export function expandAppOpenUrl(template: string, values: AppOpenUrlValues): string | null {
  const url = template.replace(OPEN_URL_PLACEHOLDER, (_match, key: keyof AppOpenUrlValues) =>
    encodeURIComponent(values[key] ?? ""),
  );
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

/**
 * The text a turn carries for references the user attached as chips: each one the prompt does not
 * already name, on a line ahead of the prompt, so the agent reads them as the subject.
 */
export function promptWithAppReferences(prompt: string, refs: ReadonlyArray<string>): string {
  const present = new Set(prompt.split(/\s+/u));
  const added = [...new Set(refs)].filter((ref) => ref.length > 0 && !present.has(ref));
  if (added.length === 0) return prompt;
  const line = added.join(" ");
  return prompt.trim().length === 0 ? line : `${line}\n\n${prompt}`;
}
