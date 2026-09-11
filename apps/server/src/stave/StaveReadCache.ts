/** Shared invalidation generation avoids a dependency cycle between operations and RPC reads. */
import { Context, Effect, Layer, Ref } from "effect";

export class StaveReadCache extends Context.Service<
  StaveReadCache,
  {
    readonly generation: Effect.Effect<number>;
    readonly invalidate: Effect.Effect<void>;
  }
>()("lecturn/stave/StaveReadCache") {}

export const layer = Layer.effect(
  StaveReadCache,
  Effect.gen(function* () {
    const generation = yield* Ref.make(0);
    return StaveReadCache.of({
      generation: Ref.get(generation),
      invalidate: Ref.update(generation, (value) => value + 1),
    });
  }),
);
