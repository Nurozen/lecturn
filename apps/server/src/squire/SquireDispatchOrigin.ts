import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Set only by Squire modules around their own orchestration dispatches
 * (lifecycle, delivery, auto-decline, probe, provider change). The command
 * allowlist on marked threads passes such commands. Command ids
 * cannot carry this authority: clients choose their own (`server:squire:`
 * names receipts only). The orchestrator runs `aroundCommand` in the
 * dispatching fiber, so the reference reaches the hook.
 */
export class SquireDispatchOrigin extends Context.Reference<boolean>(
  "lecturn/squire/SquireDispatchOrigin",
  { defaultValue: () => false },
) {}

export const withSquireDispatchOrigin = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.provideService(effect, SquireDispatchOrigin, true);
