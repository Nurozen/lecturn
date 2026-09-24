import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Deferred, Effect, Fiber } from "effect";
import type { DecisionEvaluationRequest, DecisionEvaluationResult } from "@lecturn/contracts";
import { decisionError } from "./DecisionsAccess.ts";
import { parseDecisionsConfig } from "./DecisionsConfig.ts";
import { makeDecisionEvaluation, type DecisionEvaluationDependencies } from "./DecisionsService.ts";
const config = parseDecisionsConfig({
  DECISIONS_ENABLED: "true",
  DECISIONS_COHORT: "*",
  TYPESAFE_API_KEY: "fixture-key",
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
  model: "jev-1.13.0",
  templateVersion: "decisions-v1",
  judgments: [{ targetId: "target", exists: "yes", relevant: "yes" }],
  inputTokens: 5,
  allowance,
  replayed: false,
};
function fixture() {
  const funding: DecisionEvaluationDependencies["funding"] = {
    requireFunding: vi.fn(() =>
      Effect.succeed({
        payerId: "payer",
        funding: {
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
    reserve: vi.fn<DecisionEvaluationDependencies["usage"]["reserve"]>(() =>
      Effect.succeed({ kind: "admitted", attemptId: "attempt", allowance }),
    ),
    markDispatched: vi.fn<DecisionEvaluationDependencies["usage"]["markDispatched"]>(() =>
      Effect.succeed(true),
    ),
    settle: vi.fn<DecisionEvaluationDependencies["usage"]["settle"]>(() =>
      Effect.succeed({ kind: "settled", result }),
    ),
    failBeforeDispatch: vi.fn<DecisionEvaluationDependencies["usage"]["failBeforeDispatch"]>(() =>
      Effect.succeed(undefined),
    ),
    markUnknown: vi.fn<DecisionEvaluationDependencies["usage"]["markUnknown"]>(() =>
      Effect.succeed(undefined),
    ),
  };
  const jev = {
    evaluate: vi.fn<DecisionEvaluationDependencies["jev"]["evaluate"]>(() =>
      Effect.succeed({ inputTokens: 5, judgments: [...result.judgments] }),
    ),
  };
  const fingerprint = () => Effect.succeed("content-fingerprint");
  return {
    usage,
    jev,
    evaluate: makeDecisionEvaluation(config, { funding, usage, jev, fingerprint }),
  };
}
describe("Decisions metered dispatch", () => {
  it.effect("reserves before dispatch and settles one validated response", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(yield* f.evaluate(principal, request)).toEqual(result);
      expect(f.usage.reserve.mock.invocationCallOrder[0]).toBeLessThan(
        f.usage.markDispatched.mock.invocationCallOrder[0]!,
      );
      expect(f.usage.markDispatched.mock.invocationCallOrder[0]).toBeLessThan(
        f.jev.evaluate.mock.invocationCallOrder[0]!,
      );
      expect(f.usage.settle).toHaveBeenCalledWith("attempt", {
        inputTokens: 5,
        judgments: [...result.judgments],
      });
      expect(f.usage.markUnknown).not.toHaveBeenCalled();
    }),
  );
  it.effect("replays without calling Jev and rejects duplicate in-flight delivery", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.usage.reserve.mockImplementationOnce(() =>
        Effect.succeed({ kind: "replay", result: { ...result, replayed: true } }),
      );
      expect((yield* f.evaluate(principal, request)).replayed).toBe(true);
      expect(f.jev.evaluate).not.toHaveBeenCalled();
      f.usage.reserve.mockImplementationOnce(() => Effect.succeed({ kind: "in-progress" }));
      expect((yield* Effect.flip(f.evaluate(principal, request))).code).toBe("in-progress");
      expect(f.usage.markDispatched).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    "preserves unknown spending on upstream failure and releases only undispatched failures",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.jev.evaluate.mockImplementationOnce(() =>
          Effect.fail(decisionError("unavailable", "Fixture upstream unavailable")),
        );
        expect((yield* Effect.flip(f.evaluate(principal, request))).code).toBe("unavailable");
        expect(f.usage.markUnknown).toHaveBeenCalledWith("attempt");
        expect(f.usage.failBeforeDispatch).not.toHaveBeenCalled();
        const revoked = fixture();
        revoked.usage.markDispatched.mockImplementationOnce(() =>
          Effect.fail(decisionError("forbidden", "Revoked")),
        );
        expect((yield* Effect.flip(revoked.evaluate(principal, request))).code).toBe("forbidden");
        expect(revoked.usage.failBeforeDispatch).toHaveBeenCalledWith("attempt");
        expect(revoked.jev.evaluate).not.toHaveBeenCalled();
      }),
  );
  it.effect("records interrupted upstream work as unknown without an automatic retry", () =>
    Effect.gen(function* () {
      const f = fixture();
      const started = yield* Deferred.make<void>();
      f.jev.evaluate.mockImplementationOnce(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* f.evaluate(principal, request).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(f.usage.markUnknown).toHaveBeenCalledTimes(1);
      expect(f.usage.settle).not.toHaveBeenCalled();
      expect(f.jev.evaluate).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect(
    "rejects unsupported template before quota or upstream and preserves explicit retry intent",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        expect(
          (yield* Effect.flip(f.evaluate(principal, { ...request, templateVersion: "untrusted" })))
            .code,
        ).toBe("invalid");
        expect(f.usage.reserve).not.toHaveBeenCalled();
        yield* f.evaluate(principal, { ...request, explicitRetry: true });
        expect(f.usage.reserve).toHaveBeenCalledWith(
          expect.objectContaining({ explicitRetry: true }),
        );
      }),
  );
});
