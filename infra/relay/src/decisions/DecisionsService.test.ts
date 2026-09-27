import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Effect } from "effect";
import type { DecisionEvaluationRequest, DecisionEvaluationResult } from "@lecturn/contracts";
import { decisionError } from "./DecisionsAccess.ts";
import { parseDecisionsConfig } from "./DecisionsConfig.ts";
import { makeDecisionEvaluation, type DecisionEvaluationDependencies } from "./DecisionsService.ts";
const config = parseDecisionsConfig({
  DECISIONS_ENABLED: "true",
  DECISIONS_COHORT: "*",
  EXTENSIONS_EVALUATOR_WORKER: "fixture",
});
const principal = {
  credentialId: "credential",
  environmentId: "environment",
  environmentPublicKey: "key",
};
const request: DecisionEvaluationRequest = {
  requestId: "request",
  runId: "run",
  fundingGeneration: 1,
  targets: [{ id: "target", text: "We chose the documented API." }],
  context: "",
  description: "",
  templateVersion: "decisions-v1",
};
const allowance = {
  windowStart: "2026-09-01T00:00:00Z",
  windowEnd: "2026-10-01T00:00:00Z",
  limitInputTokens: 1000,
  usedInputTokens: 5,
  reservedInputTokens: 0,
  remainingInputTokens: 995,
};
const result: DecisionEvaluationResult = {
  requestId: "request",
  runId: "run",
  model: "extensions-v1",
  templateVersion: "decisions-v1",
  judgments: [{ targetId: "target", exists: "yes", relevant: "yes" }],
  inputTokens: 5,
  allowance,
  replayed: false,
};
function fixture() {
  const funding = {
    requireFunding: vi.fn(() =>
      Effect.succeed({
        payerId: "payer",
        funding: {
          feature_id: "decisions" as const,
          environment_id: "environment",
          public_key: "key",
          generation: 1,
          payer_id: "payer",
          state: "active" as const,
        },
        access: {
          enabled: true,
          eligible: true,
          reason: "eligible" as const,
          window: { start: 1, end: 2 },
          limitInputTokens: 1000,
        },
      }),
    ),
  };
  const usage = {
    requestBackend: vi.fn<DecisionEvaluationDependencies["usage"]["requestBackend"]>(() =>
      Effect.succeed(null),
    ),
    replayLegacy: vi.fn<DecisionEvaluationDependencies["usage"]["replayLegacy"]>(() =>
      Effect.succeed({ ...result, replayed: true }),
    ),
  };
  const evaluator = vi.fn<NonNullable<DecisionEvaluationDependencies["evaluator"]>>(() =>
    Effect.succeed(result),
  );
  const deps = {
    funding,
    usage,
    evaluator,
    fingerprint: () => Effect.succeed("content-fingerprint"),
  };
  return { funding, usage, evaluator, deps, evaluate: makeDecisionEvaluation(config, deps) };
}
describe("Decisions private service boundary", () => {
  it.effect("uses only the fixed evaluator after funding and preserves explicit retry", () =>
    Effect.gen(function* () {
      const f = fixture();
      const input = { ...request, explicitRetry: true };
      expect(yield* f.evaluate(principal, input)).toEqual(result);
      expect(f.evaluator).toHaveBeenCalledWith(principal, input);
      expect(f.funding.requireFunding.mock.invocationCallOrder[0]).toBeLessThan(
        f.evaluator.mock.invocationCallOrder[0]!,
      );
      expect(f.usage.replayLegacy).not.toHaveBeenCalled();
    }),
  );
  it.effect("fails closed without a private evaluator and never dispatches a retired attempt", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(
        (yield* Effect.flip(
          makeDecisionEvaluation(config, { ...f.deps, evaluator: null })(principal, request),
        )).code,
      ).toBe("unavailable");
      f.usage.requestBackend.mockImplementationOnce(() => Effect.succeed("opaque-retired-backend"));
      f.usage.replayLegacy.mockImplementationOnce(() =>
        Effect.fail(decisionError("in-progress", "Retired attempt unresolved")),
      );
      expect((yield* Effect.flip(f.evaluate(principal, request))).code).toBe("in-progress");
      expect(f.evaluator).not.toHaveBeenCalled();
    }),
  );
  it.effect("replays settled retired results without a new service call", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.usage.requestBackend.mockImplementationOnce(() => Effect.succeed("opaque-retired-backend"));
      expect(yield* f.evaluate(principal, request)).toEqual({ ...result, replayed: true });
      expect(f.usage.replayLegacy).toHaveBeenCalledWith(
        expect.objectContaining({ fingerprint: "content-fingerprint", runId: request.runId }),
      );
      expect(f.evaluator).not.toHaveBeenCalled();
    }),
  );
  it.effect("does not retry a private service failure", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.evaluator.mockImplementationOnce(() =>
        Effect.fail(decisionError("unavailable", "Private service unavailable")),
      );
      expect((yield* Effect.flip(f.evaluate(principal, request))).code).toBe("unavailable");
      expect(f.evaluator).toHaveBeenCalledTimes(1);
      expect(f.usage.replayLegacy).not.toHaveBeenCalled();
    }),
  );
  it.effect("rejects invalid templates before funding or service access", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(
        (yield* Effect.flip(f.evaluate(principal, { ...request, templateVersion: "untrusted" })))
          .code,
      ).toBe("invalid");
      expect(f.funding.requireFunding).not.toHaveBeenCalled();
      expect(f.evaluator).not.toHaveBeenCalled();
    }),
  );
});
