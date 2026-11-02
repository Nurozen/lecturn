import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadId,
} from "@lecturn/contracts";

import * as TextGenerationOperations from "./textGenerationOperations.ts";

const input = {
  cwd: "/checkout",
  outcome: "finished" as const,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "small" },
  summaryInput: {
    thread: {
      threadId: ThreadId.make("thread-1"),
      title: "Fix login",
      project: "web",
      provider: ProviderDriverKind.make("codex"),
    },
    turnId: RunId.make("run-1"),
    session: { status: "completed" as const, pendingRuntimeRequest: null, interruptedBy: null },
    messages: [{ role: "user" as const, text: "Fix the login redirect" }],
    toolCalls: [],
    files: [],
    diffStats: { added: 0, modified: 0, deleted: 0, insertions: 0, deletions: 0 },
    pullRequest: null,
  },
};

const replying =
  (reply: unknown, requests: Array<TextGenerationOperations.Request<Schema.Top>> = []) =>
  <S extends Schema.Top>(request: TextGenerationOperations.Request<S>) => {
    requests.push(request);
    return TextGenerationOperations.decodeJsonReply(request, "Test", JSON.stringify(reply));
  };

it.effect("clamps and normalizes the model-written fields", () =>
  Effect.gen(function* () {
    const requests: Array<TextGenerationOperations.Request<Schema.Top>> = [];
    const generate = TextGenerationOperations.squireTurnSummaryFromRunner(
      "Test",
      replying(
        {
          goal: "  Fix the\n login redirect  ",
          completed: ["one", " ", "two", "three", "four", "five", "six", "seven"],
          remaining: ["a", "b", "", "c", "d"],
          blocked: [
            { item: " Deploy ", reason: " Needs credentials " },
            { item: "", reason: "no item" },
            { item: "b", reason: "r" },
            { item: "c", reason: "r" },
            { item: "d", reason: "r" },
          ],
          pendingQuestion: "   ",
          suggestedNextStep: " Review the diff ",
        },
        requests,
      ),
    );
    expect(yield* generate(input)).toEqual({
      goal: "Fix the login redirect",
      completed: ["one", "two", "three", "four", "five"],
      remaining: ["a", "b", "c"],
      blocked: [
        { item: "Deploy", reason: "Needs credentials" },
        { item: "b", reason: "r" },
        { item: "c", reason: "r" },
      ],
      pendingQuestion: null,
      suggestedNextStep: "Review the diff",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.operation).toBe("generateSquireTurnSummary");
    expect(requests[0]?.investigate).toBeUndefined();
  }),
);

it.effect("rejects an empty summary and hides provider failures behind one private error", () =>
  Effect.gen(function* () {
    const empty = yield* TextGenerationOperations.squireTurnSummaryFromRunner(
      "Test",
      replying({
        goal: " ",
        completed: [" "],
        remaining: ["a"],
        blocked: [],
        pendingQuestion: null,
        suggestedNextStep: null,
      }),
    )(input).pipe(Effect.flip);
    const sentinel = "PRIVATE_CONVERSATION_SENTINEL";
    const failed = yield* TextGenerationOperations.squireTurnSummaryFromRunner("Test", () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateSquireTurnSummary",
          detail: `Codex CLI command failed: ${sentinel}`,
          cause: new Error(sentinel),
        }),
      ),
    )(input).pipe(Effect.flip);
    for (const error of [empty, failed]) {
      expect(error.operation).toBe("generateSquireTurnSummary");
      expect(error.detail).toBe("Squire turn summary generation is unavailable.");
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
  }),
);
