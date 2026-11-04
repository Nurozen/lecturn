import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ExtensionEvaluatorIdentity,
  ExtensionEvaluatorRequest,
  ExtensionEvaluatorResponse,
  SquireRoutingRequest,
  SquireRoutingResult,
  squireRoutingJudgmentMatches,
} from "./extensionsEvaluator.ts";
const isIdentity = Schema.is(ExtensionEvaluatorIdentity);
const isRequest = Schema.is(ExtensionEvaluatorRequest);
const isResponse = Schema.is(ExtensionEvaluatorResponse);
const encodeRouting = Schema.encodeSync(SquireRoutingRequest);
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
  describe("Squire routing", () => {
    const member = (squireId: string) => ({
      squireId,
      name: `Squire ${squireId}`,
      brief: "Watches release PRs",
      scope: { containers: ["billing-service"], threadTitles: ["Ship 2.1"], pullRequests: [321] },
      recentActivity: ["CI failed on PR 321"],
    });
    const routing = {
      featureId: "squires",
      requestId: "squire-route:room-post-1",
      runId: "squire-route:room-post-1",
      fundingGeneration: 3,
      templateVersion: "squire-routing-v1",
      members: [member("sq-release"), member("sq-research")],
      post: { body: "Who can look at the flaky invoice test?" },
    };
    const decodeRouting = Schema.decodeUnknownSync(SquireRoutingRequest, {
      onExcessProperty: "error",
    });
    const squireIdentity = {
      ...identity,
      featureId: "squires",
      policyVersion: "squire-routing-v1",
    };
    it("round-trips the members as choice options and refuses anything beyond them", () => {
      const decoded = decodeRouting(routing);
      expect(decodeRouting(encodeRouting(decoded))).toEqual(routing);
      const tooMany = Array.from({ length: 7 }, (_, index) => member(`sq-${index}`));
      expect(() => decodeRouting({ ...routing, members: tooMany })).toThrow();
      expect(() => decodeRouting({ ...routing, members: tooMany.slice(0, 6) })).not.toThrow();
      expect(() => decodeRouting({ ...routing, members: [] })).toThrow();
      expect(() => decodeRouting({ ...routing, members: [member("lead")] })).toThrow();
      expect(() =>
        decodeRouting({ ...routing, members: [member("sq-a"), member("sq-a")] }),
      ).toThrow();
      expect(() =>
        decodeRouting({ ...routing, members: [{ ...member("sq-a"), brief: "x".repeat(501) }] }),
      ).toThrow();
      expect(() =>
        decodeRouting({ ...routing, post: { body: "hi" }, transcript: "secret" }),
      ).toThrow();
      expect(() =>
        decodeRouting({ ...routing, post: { body: "hi", summary: "secret" } }),
      ).toThrow();
    });
    it("binds the routing request only to the squires feature and squire-routing-v1", () => {
      expect(isRequest({ ...squireIdentity, request: routing })).toBe(true);
      expect(
        isRequest({ ...squireIdentity, policyVersion: "contextual-v1", request: routing }),
      ).toBe(false);
      expect(isRequest({ ...squireIdentity, featureId: "contextual", request: routing })).toBe(
        false,
      );
      expect(isRequest({ ...squireIdentity, request })).toBe(false);
      expect(isRequest({ ...identity, request })).toBe(true);
    });
    it("returns exactly one choice and noul judgment", () => {
      const judgment = { choice: "sq-release", confidence: 0.9, noReplyConfidence: 0.1 };
      const completed = {
        status: "completed",
        attemptId: identity.attemptId,
        replayed: false,
        result: {
          model: identity.model,
          policyVersion: "squire-routing-v1",
          inputTokens: 300,
          judgments: [judgment],
        },
      };
      expect(isResponse(completed)).toBe(true);
      expect(
        isResponse({
          ...completed,
          result: { ...completed.result, judgments: [judgment, judgment] },
        }),
      ).toBe(false);
      expect(
        isResponse({
          ...completed,
          result: { ...completed.result, judgments: [{ ...judgment, confidence: 1.2 }] },
        }),
      ).toBe(false);
      expect(squireRoutingJudgmentMatches(routing, judgment)).toBe(true);
      expect(squireRoutingJudgmentMatches(routing, { choice: "lead" })).toBe(true);
      expect(squireRoutingJudgmentMatches(routing, { choice: "sq-stranger" })).toBe(false);
      const isResult = Schema.is(SquireRoutingResult);
      expect(
        isResult({
          requestId: routing.requestId,
          runId: routing.runId,
          templateVersion: "squire-routing-v1",
          policyVersion: "squire-routing-v1",
          model: "extensions-v1",
          judgments: [judgment],
          inputTokens: 300,
          allowance: {
            poolId: "pool",
            basis: "grant",
            windowStart: "2026-10-01T00:00:00Z",
            windowEnd: "2026-11-01T00:00:00Z",
            limitInputTokens: 1000,
            usedInputTokens: 300,
            reservedInputTokens: 0,
            remainingInputTokens: 700,
            byFeature: [{ featureId: "squires", usedInputTokens: 300, reservedInputTokens: 0 }],
          },
          replayed: false,
        }),
      ).toBe(true);
    });
  });
});
