export type WordDiffTokenType = "equal" | "insert" | "delete";

/** A run of whitespace-separated words that share one diff type. Join runs with
    a single space to rebuild the text. */
export interface WordDiffToken {
  readonly type: WordDiffTokenType;
  readonly text: string;
}

// Above this many LCS cells the diff is not worth computing for a card; the
// whole text renders as one replacement instead.
const MAX_CELLS = 400_000;

/**
 * Word-level LCS diff from `before` to `after`. Whitespace only separates words,
 * so reflowed text diffs as equal. Adjacent words of the same type merge into
 * one token.
 */
export function wordDiff(before: string, after: string): WordDiffToken[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const out: WordDiffToken[] = [];
  const push = (type: WordDiffTokenType, word: string) => {
    const last = out.at(-1);
    if (last?.type === type) out[out.length - 1] = { type, text: `${last.text} ${word}` };
    else out.push({ type, text: word });
  };
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    for (const word of a) push("delete", word);
    for (const word of b) push("insert", word);
    return out;
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const below = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("equal", a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push("delete", a[i++]!);
    else push("insert", b[j++]!);
  }
  while (i < n) push("delete", a[i++]!);
  while (j < m) push("insert", b[j++]!);
  return out;
}

/** True when the diff changes anything. */
export function wordDiffChanged(tokens: ReadonlyArray<WordDiffToken>): boolean {
  return tokens.some((token) => token.type !== "equal");
}
