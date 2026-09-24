import { describe, expect, it } from "vitest";
import {
  bisectDecisionSpan,
  canonicalDecisionText,
  decisionFingerprint,
  decisionSourceHash,
  resolveDecisionQuote,
  resolveDecisionSource,
  splitDecisionText,
} from "./decisionEvidence.ts";

describe("decision evidence", () => {
  it("retains Markdown and quotation provenance while mapping CRLF offsets", () => {
    const raw = '> "Use SQLite"\r\n\r\nI disagree. **Use Postgres**. 😀';
    const normalized = canonicalDecisionText(raw);
    expect(normalized.text).toBe(raw.replaceAll("\r\n", "\n"));
    const start = normalized.text.indexOf("Use Postgres");
    expect(raw.slice(normalized.sourceOffsets[start], normalized.sourceOffsets[start + 12])).toBe(
      "Use Postgres",
    );
    expect(decisionSourceHash(raw)).toBe(decisionSourceHash(normalized.text));
    expect(decisionFingerprint(["ab", "c"])).not.toBe(decisionFingerprint(["a", "bc"]));
  });
  it("partitions oversized messages without gaps, truncation or broken emoji", () => {
    const text = "😀a\n\nChoose A. ".repeat(100);
    for (const size of [2, 7, 19, 80]) {
      const chunks = splitDecisionText(text, size);
      expect(chunks.map((span) => span.text).join("")).toBe(text);
      expect(chunks.every((span) => span.text.length <= size && span.text.isWellFormed())).toBe(
        true,
      );
      chunks.forEach((span, index) => expect(span.start).toBe(index ? chunks[index - 1]!.end : 0));
    }
  });
  it("retains a proposal and acceptance in a lossless binary subdivision", () => {
    const text = "assistant: We could use SQLite.\nuser: Yes, do that.";
    const parts = bisectDecisionSpan({ text, start: 100, end: 100 + text.length });
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts[0]!.end).toBe(parts[1]!.start);
    expect(parts[1]!.end).toBe(100 + text.length);
  });
  it("rejects ambiguous quotes unless the candidate span disambiguates them", () => {
    const text = "Use SQLite. No. Use SQLite.";
    expect(resolveDecisionQuote(text, "Use SQLite.")).toBeNull();
    expect(resolveDecisionQuote(text, "Use SQLite.", { start: 0, end: 11 })?.start).toBe(0);
    expect(resolveDecisionQuote(text, " ")).toBeNull();
    expect(resolveDecisionQuote(text, "Postgres")).toBeNull();
  });
  it("never redirects a stale or removed source to another matching passage", () => {
    const source = "Use SQLite.";
    const anchor = {
      sourceHash: decisionSourceHash(source),
      quote: source,
      start: 0,
      end: source.length,
    };
    expect(resolveDecisionSource(source, anchor)).toBe("exact");
    expect(resolveDecisionSource("Earlier: Use SQLite.", anchor)).toBe("message-only");
    expect(resolveDecisionSource(null, anchor)).toBe("unavailable");
  });
});
