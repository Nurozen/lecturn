import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/**
 * One environment-wide lock that orders policy mutations against executions
 * (A9 step 2). Every policy mutation (update, setStatus, track, untrack,
 * delete, rule saves and removals, the reactor's grant cascades, Lead control
 * actions) holds it through its commit; an execution holds it from
 * re-validation through finalize. Not reentrant: code already inside it
 * calls the unlocked variant.
 */
export class SquirePolicyLock extends Context.Service<
  SquirePolicyLock,
  {
    readonly withPolicyLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("lecturn/squire/SquirePolicyLock") {}

export const layer = Layer.effect(
  SquirePolicyLock,
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    return SquirePolicyLock.of({ withPolicyLock: semaphore.withPermits(1) });
  }),
);
