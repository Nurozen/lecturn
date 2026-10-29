import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SagaWorkbenchInferenceResult } from "@lecturn/contracts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  toCodexJsonSchemaObject,
} from "./textGenerationUtils.ts";

describe("Codex structured output dialect", () => {
  it("preserves data property names that resemble schema keywords", () => {
    expect(
      toCodexJsonSchemaObject(Schema.Struct({ allOf: Schema.String, if: Schema.Boolean })),
    ).toMatchObject({
      properties: { allOf: { type: "string" }, if: { type: "boolean" } },
      required: ["allOf", "if"],
    });
  });
  it("serializes the exact accepted workflow schema, retaining local numeric validation", () => {
    expect(JSON.stringify(toCodexJsonSchemaObject(SagaWorkbenchInferenceResult))).toBe(
      JSON.stringify({
        type: "object",
        properties: {
          summary: { type: "string" },
          stage: { type: "string", enum: ["spec", "plan", "build", "review", "accept"] },
          confidence: { type: "number" },
        },
        required: ["summary", "stage", "confidence"],
        additionalProperties: false,
      }),
    );
    const decode = Schema.decodeUnknownSync(SagaWorkbenchInferenceResult);
    for (const confidence of [-0.1, 1.1, NaN, Infinity, "NaN"]) {
      expect(() => decode({ summary: "Done", stage: "build", confidence })).toThrow();
    }
  });

  it("does not leak provider output or nested causes from auxiliary failures", () => {
    const sentinel = "PRIVATE_CONVERSATION_SENTINEL";
    for (const operation of [
      "generateWorkflowSummary",
      "generateDecisionNotes",
      "generateContextualSummary",
    ]) {
      for (const source of [
        new Error(`spawn codex ${sentinel}`),
        { stderr: sentinel },
        new Error("timeout", { cause: { prompt: sentinel } }),
      ]) {
        const result = normalizeCliError("codex", operation, source, "Background writing failed.");
        expect(JSON.stringify(result)).not.toContain(sentinel);
        expect(String(result)).not.toContain(sentinel);
        expect(result.cause).toBeUndefined();
      }
    }
  });
});

describe("sanitizeCommitSubject", () => {
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "an emoji with a skin tone", prefixLength: 70, character: "👍🏽" },
    { name: "a flag", prefixLength: 69, character: "🇮🇹" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });

  it("keeps a complete character that ends exactly at the limit", () => {
    const expected = `${"a".repeat(70)}🚀`;

    expect(sanitizeCommitSubject(`${expected} more`)).toBe(expected);
  });

  it("uses the existing fallback when a single character exceeds the limit", () => {
    expect(sanitizeCommitSubject(`a${"\u0301".repeat(72)} more`)).toBe("Update project files");
  });

  it("keeps the existing ASCII limit and subject normalization", () => {
    expect(sanitizeCommitSubject("a".repeat(80))).toBe("a".repeat(72));
    expect(sanitizeCommitSubject("  Fix tests...\nignored  ")).toBe("Fix tests");
    expect(sanitizeCommitSubject("...")).toBe("Update project files");
  });
});
