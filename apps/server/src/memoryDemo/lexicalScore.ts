/**
 * lexicalScore - keyword recall for the memory demo: a small BM25 over
 * weighted fields (summary 2, id/tags/namespace 1.5, context 1), then a recall
 * path of the hits plus each hit's best one-hop neighbor.
 *
 * @module lexicalScore
 */
import type { MemoryNodeScope, MemoryNodeType } from "@lecturn/contracts";

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have how i if in into is it its of on or " +
    "so that the their then there these this to was we were what when where which who why " +
    "will with does do did can not no you your our they them than also about after before"
  ).split(" "),
);

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

/** Lowercase terms: splits camelCase, paths and punctuation, drops stopwords, light plural stemming. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

export interface LexicalDoc {
  readonly id: string;
  readonly scope: MemoryNodeScope;
  readonly territoryId: string;
  readonly type: MemoryNodeType;
  readonly summary: string;
  readonly context: string;
  readonly tags: readonly string[];
  readonly namespace: string;
  /** Tie-breaker and neighbor ranking when lexical scores are equal. */
  readonly weight: number;
}

export interface IndexedDoc {
  readonly doc: LexicalDoc;
  /** Field-weighted term frequency. */
  readonly tf: ReadonlyMap<string, number>;
  /** Weighted document length. */
  readonly length: number;
}

const FIELD_WEIGHTS = { summary: 2, meta: 1.5, context: 1 } as const;

export function indexDoc(doc: LexicalDoc): IndexedDoc {
  const tf = new Map<string, number>();
  let length = 0;
  const add = (text: string, weight: number) => {
    for (const token of tokenize(text)) {
      tf.set(token, (tf.get(token) ?? 0) + weight);
      length += weight;
    }
  };
  add(doc.summary, FIELD_WEIGHTS.summary);
  add(`${doc.id} ${doc.tags.join(" ")} ${doc.namespace}`, FIELD_WEIGHTS.meta);
  add(doc.context, FIELD_WEIGHTS.context);
  return { doc, tf, length };
}

export interface RankedDoc {
  readonly doc: LexicalDoc;
  readonly score: number;
  readonly matched: readonly string[];
}

const K1 = 1.2;
const B = 0.75;

/** BM25 over the weighted fields; only docs matching at least one term, best first. */
export function rankDocs(docs: readonly IndexedDoc[], query: string): RankedDoc[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || docs.length === 0) return [];
  const averageLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const idf = new Map(
    terms.map((term) => {
      const df = docs.reduce((count, d) => count + (d.tf.has(term) ? 1 : 0), 0);
      return [term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
    }),
  );
  const ranked: RankedDoc[] = [];
  for (const indexed of docs) {
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const tf = indexed.tf.get(term);
      if (!tf) continue;
      matched.push(term);
      const norm = K1 * (1 - B + (B * indexed.length) / averageLength);
      score += idf.get(term)! * ((tf * (K1 + 1)) / (tf + norm));
    }
    if (score > 0) ranked.push({ doc: indexed.doc, score, matched });
  }
  return ranked.sort(
    (a, b) => b.score - a.score || b.doc.weight - a.doc.weight || a.doc.id.localeCompare(b.doc.id),
  );
}

export const PATH_CAP = 10;

/**
 * Recall path: each hit in rank order, followed by its best neighbor (highest
 * lexical score, else highest weight) not already on the path. At most 10 ids.
 */
export function recallPath(
  hits: readonly RankedDoc[],
  neighborsOf: (id: string) => readonly LexicalDoc[],
): string[] {
  const lexical = new Map(hits.map((hit) => [hit.doc.id, hit.score]));
  const path: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (path.length < PATH_CAP && !seen.has(id)) {
      seen.add(id);
      path.push(id);
    }
  };
  for (const hit of hits) {
    push(hit.doc.id);
    const best = neighborsOf(hit.doc.id)
      .filter((neighbor) => !seen.has(neighbor.id))
      .sort(
        (a, b) =>
          (lexical.get(b.id) ?? 0) - (lexical.get(a.id) ?? 0) ||
          b.weight - a.weight ||
          a.id.localeCompare(b.id),
      )[0];
    if (best) push(best.id);
    if (path.length >= PATH_CAP) break;
  }
  return path;
}

/** Estimated tokens to hand an agent these nodes: (summary + context chars) / 4. */
export function approxTokens(docs: readonly Pick<LexicalDoc, "summary" | "context">[]): number {
  return Math.round(docs.reduce((sum, d) => sum + d.summary.length + d.context.length, 0) / 4);
}
