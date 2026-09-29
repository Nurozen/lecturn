import { describe, expect, it } from "@effect/vitest";
import { indexBaseWarren, initialState, queryMemory, WarrenView } from "./demoState.ts";
import {
  approxTokens,
  indexDoc,
  PATH_CAP,
  rankDocs,
  recallPath,
  tokenize,
} from "./lexicalScore.ts";
import { spikeFixture } from "./spikeFixture.ts";
import { buildWarren } from "./warren.ts";

describe("tokenize", () => {
  it("splits camelCase and paths, drops stopwords, folds plurals", () => {
    expect(tokenize("scheduleRetry in src/billing/webhooks for the Retries")).toEqual([
      "schedule",
      "retry",
      "src",
      "billing",
      "webhook",
      "retry",
    ]);
  });
});

describe("rankDocs", () => {
  it("weights the summary over the context", () => {
    const base = {
      scope: "warren",
      territoryId: "t",
      type: "concept",
      tags: [],
      namespace: "x",
      weight: 0,
    } as const;
    const ranked = rankDocs(
      [
        indexDoc({ ...base, id: "a", summary: "ledger entries", context: "retry" }),
        indexDoc({ ...base, id: "b", summary: "retry schedule", context: "ledger" }),
      ],
      "retry",
    );
    expect(ranked.map((hit) => hit.doc.id)).toEqual(["b", "a"]);
    expect(ranked[0]!.matched).toEqual(["retry"]);
  });
});

describe("recall over the warren", () => {
  const warren = buildWarren(spikeFixture());
  const baseIndex = indexBaseWarren(warren);

  it('ranks webhooks nodes first for "webhook retry"', () => {
    const state = initialState();
    const [result] = queryMemory(
      state,
      new WarrenView(warren, state),
      baseIndex,
      { text: "webhook retry" },
      0,
    );
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.slice(0, 3).every((hit) => hit.territoryId === "webhooks")).toBe(true);
    expect(result.pathIds.length).toBeLessThanOrEqual(PATH_CAP);
    expect(result.pathIds[0]).toBe(result.hits[0]!.nodeId);
    expect(result.approxTokens).toBeGreaterThan(0);
  });

  it("builds the path from hits and their best neighbors, capped at 10", () => {
    const docs = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      scope: "warren" as const,
      territoryId: "t",
      type: "concept" as const,
      summary: "x".repeat(40),
      context: "",
      tags: [],
      namespace: "t",
      weight: i,
    }));
    const hits = docs.slice(0, 8).map((doc) => ({ doc, score: 1, matched: [] }));
    const path = recallPath(hits, (id) => (id === "n0" ? [docs[10]!, docs[11]!] : []));
    expect(path.slice(0, 3)).toEqual(["n0", "n11", "n1"]);
    expect(path).toHaveLength(9);
    expect(approxTokens(docs.slice(0, 2))).toBe(20);
    const many = docs.map((doc) => ({ doc, score: 1, matched: [] }));
    expect(recallPath(many, () => [])).toHaveLength(PATH_CAP);
  });
});
