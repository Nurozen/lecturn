import { describe, expect, it } from "@effect/vitest";
import { extensionEvaluatorServiceBinding } from "./ExtensionsEvaluatorBinding.ts";

describe("private evaluator service addressing", () => {
  it("uses an external Worker service binding without an HTTP origin or private import", () => {
    expect(extensionEvaluatorServiceBinding("lecturn-extensions-evaluator-test")).toEqual({
      type: "service",
      name: "LECTURN_EXTENSIONS_EVALUATOR",
      service: "lecturn-extensions-evaluator-test",
    });
  });
  it("rejects URLs and malformed deployment names rather than enabling a network fallback", () => {
    for (const value of ["https://example.test", "../other", "", " bad ", "x".repeat(64)])
      expect(() => extensionEvaluatorServiceBinding(value)).toThrow();
  });
});
