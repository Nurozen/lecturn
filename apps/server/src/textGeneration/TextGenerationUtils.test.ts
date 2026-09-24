import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SagaWorkbenchInferenceResult } from "@lecturn/contracts";
import { normalizeCliError, toCodexJsonSchemaObject } from "./TextGenerationUtils.ts";

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
    for (const operation of ["generateWorkflowSummary", "generateDecisionNotes"]) {
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
