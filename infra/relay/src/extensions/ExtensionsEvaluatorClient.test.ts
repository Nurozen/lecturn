import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeExtensionsEvaluatorClient,
  type ExtensionEvaluatorIdentity,
} from "./ExtensionsEvaluatorClient.ts";
import { extensionCanonicalJson, extensionJudgmentsMatch } from "./ExtensionsService.ts";
const identity: ExtensionEvaluatorIdentity = {
  environmentId: "fixture",
  attemptId: "1:attempt",
  featureId: "decisions",
  policyVersion: "decisions-v1",
  model: "extensions-v1",
  requestFingerprint: "a".repeat(64),
  admissibilityEpoch: 1,
};
const completed = {
  status: "completed",
  attemptId: identity.attemptId,
  replayed: false,
  result: {
    inputTokens: 20,
    model: "extensions-v1",
    policyVersion: "decisions-v1",
    judgments: [{ targetId: "target", exists: "yes", relevant: "yes" }],
  },
};
describe("Extensions binding boundary", () => {
  it.effect("cannot fall back to public fetch when the private binding is absent", () =>
    Effect.gen(function* () {
      const client = makeExtensionsEvaluatorClient(Effect.succeed(undefined), 1000);
      expect(yield* client.available).toBe(false);
      expect((yield* client.evaluate(identity, {}).pipe(Effect.flip)).code).toBe("unavailable");
    }),
  );
  it.effect("rejects replies for another attempt and policy", () =>
    Effect.gen(function* () {
      for (const response of [
        { ...completed, attemptId: "1:other" },
        { ...completed, result: { ...completed.result, policyVersion: "contextual-v1" } },
      ]) {
        const client = makeExtensionsEvaluatorClient(
          Effect.succeed({ fetch: async () => Response.json(response) }),
          1000,
        );
        expect((yield* client.evaluate(identity, {}).pipe(Effect.flip)).code).toBe("unavailable");
      }
    }),
  );
  it.effect("enforces response byte limits even when content length is omitted", () =>
    Effect.gen(function* () {
      let canceled = false;
      const client = makeExtensionsEvaluatorClient(
        Effect.succeed({
          fetch: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(129 * 1024));
                },
                cancel() {
                  canceled = true;
                },
              }),
            ),
        }),
        1000,
      );
      expect((yield* client.status(identity).pipe(Effect.flip)).code).toBe("unavailable");
      expect(canceled).toBe(true);
    }),
  );
  it.effect(
    "keeps dispatch identity unchanged and routes reconciliation without another evaluation",
    () =>
      Effect.gen(function* () {
        const requests: Request[] = [];
        const client = makeExtensionsEvaluatorClient(
          Effect.succeed({
            fetch: async (request) => {
              requests.push(request);
              return Response.json(completed);
            },
          }),
          1000,
        );
        expect((yield* client.status(identity)).status).toBe("completed");
        expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/status"]);
        expect(yield* Effect.promise(() => requests[0]!.json())).toEqual(identity);
      }),
  );
  it("canonicalizes object order but preserves array meaning and validates complete target coverage", () => {
    expect(extensionCanonicalJson({ b: 2, a: [{ d: 4, c: 3 }] })).toBe(
      extensionCanonicalJson({ a: [{ c: 3, d: 4 }], b: 2 }),
    );
    expect(extensionCanonicalJson([1, 2])).not.toBe(extensionCanonicalJson([2, 1]));
    const request = {
      requestId: "r",
      runId: "r",
      fundingGeneration: 1,
      templateVersion: "decisions-v1",
      targets: [{ id: "target", text: "Use Postgres" }],
      context: "",
      description: "",
    };
    const result = {
      inputTokens: 1,
      model: "extensions-v1",
      policyVersion: "decisions-v1",
      judgments: [{ targetId: "foreign", exists: "yes", relevant: "yes" }],
    } as const;
    expect(extensionJudgmentsMatch(request, result)).toBe(false);
    expect(
      extensionJudgmentsMatch(request, {
        ...result,
        judgments: [{ targetId: "target", exists: "yes", relevant: "yes" }],
      }),
    ).toBe(true);
  });
});
