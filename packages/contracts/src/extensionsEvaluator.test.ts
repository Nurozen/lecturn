import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ExtensionEvaluatorIdentity,
  ExtensionEvaluatorRequest,
  ExtensionEvaluatorResponse,
} from "./extensionsEvaluator.ts";
const isIdentity = Schema.is(ExtensionEvaluatorIdentity);
const isRequest = Schema.is(ExtensionEvaluatorRequest);
const isResponse = Schema.is(ExtensionEvaluatorResponse);
const identity = {
  environmentId: "environment",
  attemptId: "100:attempt",
  featureId: "decisions",
  policyVersion: "decisions-v1",
  model: "extensions-v1",
  requestFingerprint: "a".repeat(64),
  admissibilityEpoch: 100,
};
const request = {
  requestId: "request",
  runId: "run",
  fundingGeneration: 1,
  targets: [{ id: "target", text: "Use SQLite" }],
  context: "",
  description: "",
  templateVersion: "decisions-v1",
};
describe("private evaluator binding contracts", () => {
  it("pins immutable attempt epoch and fixed feature policy", () => {
    expect(isIdentity(identity)).toBe(true);
    expect(isIdentity({ ...identity, admissibilityEpoch: 101 })).toBe(false);
    expect(isRequest({ ...identity, request })).toBe(true);
    expect(isRequest({ ...identity, featureId: "contextual", request })).toBe(false);
    expect(isRequest({ ...identity, model: "caller-model", request })).toBe(false);
  });
  it("keeps unknown outcomes distinct from a guaranteed undispatched refusal", () => {
    expect(
      isResponse({
        status: "unknown",
        attemptId: identity.attemptId,
        reason: "dispatch-unresolved",
      }),
    ).toBe(true);
    expect(
      isResponse({
        status: "refused",
        attemptId: identity.attemptId,
        dispatched: false,
        reason: "disabled",
      }),
    ).toBe(true);
    expect(
      isResponse({
        status: "refused",
        attemptId: identity.attemptId,
        dispatched: true,
        reason: "disabled",
      }),
    ).toBe(false);
  });
  it("returns actual nonnegative usage with policy-specific judgments", () => {
    const completed = {
      status: "completed",
      attemptId: identity.attemptId,
      replayed: true,
      result: {
        model: identity.model,
        policyVersion: identity.policyVersion,
        inputTokens: 537,
        judgments: [{ targetId: "target", exists: "yes", relevant: "uncertain" }],
      },
    };
    expect(isResponse(completed)).toBe(true);
    expect(
      isResponse({ ...completed, result: { ...completed.result, model: "backend-model" } }),
    ).toBe(false);
    expect(isResponse({ ...completed, result: { ...completed.result, inputTokens: 0 } })).toBe(
      true,
    );
    expect(isResponse({ ...completed, result: { ...completed.result, inputTokens: -1 } })).toBe(
      false,
    );
    expect(
      isResponse({
        ...completed,
        result: {
          model: identity.model,
          policyVersion: "contextual-v1",
          inputTokens: 0,
          judgments: [
            {
              targetId: "target",
              useful: 0,
              usableEvidence: 0,
              contradicts: 0,
              sufficientContext: 0,
              reasons: [],
              selectedEvidenceIds: [],
              selectedEvidenceSpans: [],
              evaluationComplete: false,
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isResponse({ ...completed, result: { ...completed.result, policyVersion: "contextual-v1" } }),
    ).toBe(false);
  });
});
