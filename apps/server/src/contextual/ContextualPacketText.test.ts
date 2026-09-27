import { describe, expect, it } from "vite-plus/test";
import type { ContextualEvidence, ContextualPacketGroup } from "@lecturn/contracts";
import {
  contextualEvidenceFits,
  renderContextualEvidence,
} from "../provider/ContextualDispatch.ts";
import {
  contextualEvidenceByteBound,
  contextualPacketByteBound,
  contextualPacketText,
  normalizeContextualPacketGroups,
} from "./ContextualPacketText.ts";
const evidence = (quote: string): ContextualEvidence => ({
  locator: {
    sourceKind: "slack",
    workspaceId: "workspace",
    channelId: "channel",
    messageTs: "1.000001",
    threadTs: null,
  },
  id: "e".repeat(64),
  sourceId: "s".repeat(64),
  sourceKind: "slack",
  occurrenceId: "o".repeat(64),
  sourceRevision: 1,
  sourceHash: "h".repeat(64),
  canonicalVersion: "slack-text-v1",
  coordinateSystem: "utf16",
  quote,
  start: 0,
  end: quote.length,
  prefix: "",
  suffix: "",
  author: "Alice",
  occurredAt: "2026-09-26T00:00:00.000Z",
  observedAt: "2026-09-26T00:00:00.000Z",
  sourceUrl: null,
  availability: "available",
  lineageIds: ["l".repeat(64)],
});

describe("shared source spans", () => {
  const group = (guidanceId: string, item: ContextualEvidence): ContextualPacketGroup => ({
    candidateId: guidanceId,
    occurrenceId: "exchange",
    guidanceId,
    contentFingerprint: "immutable-exchange",
    recordRevision: 1,
    evidence: [item],
    attribution: null,
    derivedSummary: null,
    reasons: [],
  });
  const span = (start: number, quote: string): ContextualEvidence => ({
    ...evidence(quote),
    start,
    end: start + quote.length,
  });
  it("unions exact overlapping UTF-16 slices without losing either guidance identity", () => {
    const groups = normalizeContextualPacketGroups([
      group("left", span(0, "Use 🚀 SQLite")),
      group("right", span(7, "SQLite locally.")),
    ])!;
    expect(groups.map((item) => item.guidanceId)).toEqual(["left", "right"]);
    expect(groups[0]!.evidence[0]).toEqual(groups[1]!.evidence[0]);
    expect(groups[0]!.evidence[0]!.quote).toBe("Use 🚀 SQLite locally.");
    expect(groups[0]!.evidence[0]!.end).toBe("Use 🚀 SQLite locally.".length);
    expect(
      contextualPacketText({ purpose: "new-context", resolutionIds: [], groups }).split(
        "Use 🚀 SQLite locally.",
      ),
    ).toHaveLength(2);
  });
  it("retains nested or adjacent exact slices and rejects missing or contradictory bytes", () => {
    for (const right of [span(1, "bc"), span(4, "ef")]) {
      const result = normalizeContextualPacketGroups([
        group("left", span(0, "abcd")),
        group("right", right),
      ]);
      expect(result?.[0]!.evidence[0]!.quote).toBe(right.start === 1 ? "abcd" : "abcdef");
    }
    for (const right of [span(5, "fg"), span(2, "XX"), { ...span(2, "cd"), sourceRevision: 2 }]) {
      expect(
        normalizeContextualPacketGroups([group("left", span(0, "abcd")), group("right", right)]),
      ).toBeNull();
    }
  });
});
describe("provider text budgeting", () => {
  it("admits a short two-message exchange despite large provenance metadata", () => {
    const exchange = [
      evidence("Use SQLite for the local archive."),
      evidence("Agreed; keep it on this host."),
    ];
    expect(new TextEncoder().encode(JSON.stringify(exchange)).length).toBeGreaterThan(1500);
    expect(contextualEvidenceByteBound(exchange)).toBeLessThan(1500);
  });
  it("bounds every rendered purpose and resolution including Unicode bytes and wrappers", () => {
    const groups = [
      {
        evidence: [evidence("Use 東京 🦫 café.")],
        attribution: "user-directed" as const,
        derivedSummary: "Keep the host scope.",
      },
    ];
    for (const purpose of [
      "new-context",
      "correction",
      "refresh",
      "restored-after-compaction",
    ] as const) {
      for (const resolutionIds of [[], ["resolution"]]) {
        const text = contextualPacketText({ purpose, resolutionIds, groups });
        expect(contextualPacketByteBound(groups)).toBeGreaterThanOrEqual(
          new TextEncoder().encode(renderContextualEvidence(text)).length,
        );
        expect(contextualEvidenceFits(text)).toBe(true);
      }
    }
    const oversized = [{ ...groups[0]!, evidence: [evidence("🦫".repeat(400))] }];
    expect(contextualPacketByteBound(oversized)).toBeGreaterThan(1500);
    expect(
      contextualEvidenceFits(
        contextualPacketText({ purpose: "new-context", resolutionIds: [], groups: oversized }),
      ),
    ).toBe(false);
  });
});
