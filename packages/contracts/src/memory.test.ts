import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";
import {
  ContributionPlan,
  MemoryGraph,
  MemoryLandInput,
  MemoryReceipt,
  MemoryWriteInput,
} from "./memory.ts";

const decodePlan = Schema.decodeUnknownSync(ContributionPlan);
const decodeReceipt = Schema.decodeUnknownSync(MemoryReceipt);
const isReceipt = Schema.is(MemoryReceipt);
const decodeGraph = Schema.decodeUnknownSync(MemoryGraph);
const isGraph = Schema.is(MemoryGraph);
const isLand = Schema.is(MemoryLandInput);
const isWrite = Schema.is(MemoryWriteInput);

const judgments = {
  method: "recorded-jev",
  model: "jev-1.13.0",
  standards: [
    { kind: "noul", id: "S1", title: "Is a fact", p: 0.03, verdict: "fail" },
    { kind: "score", id: "S5", title: "Specific", score: 2.4, confidence: 0.8, verdict: "pass" },
    { kind: "choice", id: "S6", title: "Audience", choice: "backend", confidence: 0.7 },
  ],
  duplicate: {
    targetId: "web/cart-flaky-test",
    level: "same",
    probabilities: { different: 0.01, related: 0.03, same: 0.96 },
  },
};
const receipt = {
  id: "a3f9c2e",
  projectId: "project",
  at: "2026-09-29T12:00:00.000Z",
  counts: { added: 3, updated: 1, superseded: 1, merged: 1, distinct: 1, skipped: 1 },
  landedNodeIds: ["infra/ci-runners"],
  skippedNodeIds: ["infra/rotate-staging-password"],
  territoriesGrown: [{ territoryId: "infra", count: 3 }],
  reverted: false,
};

describe("memory demo contracts", () => {
  it("decodes a Gate plan with every judgment kind", () => {
    const plan = decodePlan({
      planId: "plan-1",
      projectId: "project",
      denRevision: 12,
      cards: [
        {
          nodeId: "web/cart-test-timers",
          op: "update",
          tier: "review",
          type: "concept",
          territoryId: "web",
          destination: "web/cart-flaky-test",
          den: { summary: "Cart test uses fake timers", context: "", sourcePath: null },
          target: { id: "web/cart-flaky-test", summary: "Cart test is flaky", context: "" },
          flags: [{ kind: "duplicate-suspect", reason: "D1 same 0.96" }],
          judgments,
        },
      ],
      counts: { silent: 0, auto: 0, review: 1 },
    });
    expect(plan.cards[0]?.judgments.standards.map((s) => s.kind)).toEqual([
      "noul",
      "score",
      "choice",
    ]);
  });

  it("decodes receipts and graphs, and rejects non-hex receipt ids", () => {
    expect(decodeReceipt(receipt).id).toBe("a3f9c2e");
    expect(isReceipt({ ...receipt, id: "A3F9C2E" })).toBe(false);
    const graph = decodeGraph({
      revision: 4,
      territories: [
        {
          id: "webhooks",
          label: "webhooks",
          project: "billing",
          nodeCount: 131,
          dominantType: "function",
          recalled: true,
          x: 0.5,
          y: -1,
        },
      ],
      territoryEdges: [{ a: "webhooks", b: "billing", weight: 3 }],
      nodes: [
        {
          id: "billing/event-ledger",
          territoryId: "webhooks",
          type: "module",
          label: "event ledger",
          score: 0.9,
          x: 1,
          y: 2,
          stale: false,
          landedReceiptId: "a3f9c2e",
        },
      ],
      edges: [[0, 0]],
    });
    expect(graph.edges[0]).toEqual([0, 0]);
    expect(isGraph({ ...graph, edges: [[0, -1]] })).toBe(false);
  });

  it("rejects unknown verdicts and out-of-range write input", () => {
    const land = { projectId: "project", planId: "plan-1", verdicts: [] as unknown[] };
    expect(isLand({ ...land, verdicts: [{ nodeId: "a/b", verdict: "merge" }] })).toBe(true);
    expect(isLand({ ...land, verdicts: [{ nodeId: "a/b", verdict: "approve" }] })).toBe(false);
    expect(isWrite({ projectId: "project", summary: "fact" })).toBe(true);
    expect(isWrite({ projectId: "project", summary: "" })).toBe(false);
    expect(isWrite({ projectId: "project", summary: "fact", tags: Array(9).fill("t") })).toBe(
      false,
    );
  });
});
