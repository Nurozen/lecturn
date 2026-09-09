import * as Output from "alchemy/Output";
import { State } from "alchemy/State/State";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

// Regression for alchemy-run/alchemy#1094, backported to our pinned beta.65.
describe("Alchemy dependency traversal", () => {
  it("terminates cyclic props while retaining nested resource dependencies", () => {
    const first = { Type: "Test", FQN: "first" };
    const second = { Type: "Test", FQN: "second" };
    const cyclic: Record<string, unknown> = { first };
    cyclic.self = cyclic;
    for (const walk of [Output.upstreamAny, Output.resolveUpstream]) {
      expect(Object.keys(walk({ items: [cyclic, second], again: cyclic })).sort()).toEqual([
        "first",
        "second",
      ]);
      expect(walk(Context.empty())).toEqual({});
    }
  });

  it.effect("preserves opaque contexts and shared data when evaluating props", () =>
    Effect.gen(function* () {
      const context = Context.empty();
      const shared = { value: 1 };
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const evaluated = yield* Output.evaluate(
        { context, cyclic, first: shared, second: shared },
        {},
      ).pipe(
        Effect.provideService(State, Effect.die("Plain props must not read deployment state")),
      );
      expect(evaluated.context).toBe(context);
      expect(evaluated.first).toEqual(shared);
      expect(evaluated.second).toEqual(shared);
      expect(evaluated.cyclic.self).toBeUndefined();
    }),
  );
});
