import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SagaWorkbenchInferenceResult, SagaWorkbenchWorkflow } from "./sagaWorkbench.ts";

const decodeResult = Schema.decodeUnknownSync(SagaWorkbenchInferenceResult);

describe("Saga workbench inference", () => {
  it("accepts one bounded summary, phase and confidence", () => {
    const result = { summary: "Implementation is underway.", stage: "build", confidence: 0.8 };
    expect(decodeResult(result)).toEqual(result);
  });

  it.each([
    { summary: "Ready", stage: "completed", confidence: 1 },
    { summary: "Ready", stage: "accept", confidence: 1.1 },
    { summary: "Ready", stage: "accept", confidence: -0.1 },
    { summary: "Ready", stage: "accept", confidence: Number.NaN },
    { summary: "Ready", stage: "accept" },
    { summary: "", stage: "spec", confidence: 0 },
    { summary: "x".repeat(1201), stage: "spec", confidence: 0 },
  ])("rejects malformed inference without granting completion: %j", (result) => {
    expect(() => decodeResult(result)).toThrow();
  });

  it("continues reading saved workflows from before automation fields existed", () => {
    const previous = {
      identity: {
        projectId: "project-1",
        workspaceRoot: "/tmp/space",
        spaceId: "space",
        createdAt: "2026-09-10T00:00:00.000Z",
      },
      revision: 4,
      stage: "plan",
      accepted: null,
      completedAt: null,
      summary: null,
    };
    expect(Schema.decodeUnknownSync(SagaWorkbenchWorkflow)(previous)).toEqual(previous);
  });
});
