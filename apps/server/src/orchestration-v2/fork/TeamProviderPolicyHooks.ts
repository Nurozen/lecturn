/**
 * Lecturn: a Company Connect organization can restrict which providers its members use, checked
 * when a provider session opens and before every turn because the policy can change mid-session.
 * s-surface provides this registration layer with TeamPolicyLive next to
 * runtimeLayer.layerProduction.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TeamPolicy } from "../../cloud/TeamPolicy.ts";
import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import {
  LecturnHookRejectedError,
  LecturnOrchestrationHooks,
} from "./LecturnOrchestrationHooks.ts";

const CONTRIBUTION = "team-provider-policy";

export const layer: Layer.Layer<
  never,
  never,
  LecturnOrchestrationHooks | TeamPolicy | ProviderInstanceRegistry
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks;
    const teamPolicy = yield* TeamPolicy;
    const instances = yield* ProviderInstanceRegistry;
    const check = (hook: string, driverKind: string) =>
      teamPolicy.checkProvider(driverKind).pipe(
        Effect.mapError(
          (cause) =>
            new LecturnHookRejectedError({
              hook,
              contribution: CONTRIBUTION,
              reason: cause.message,
              cause,
            }),
        ),
      );
    yield* hooks.register({
      name: CONTRIBUTION,
      aroundProviderSessionOpen: (input, open) =>
        check("aroundProviderSessionOpen", input.driverKind).pipe(Effect.andThen(open)),
      beforeTurnStart: Effect.fn("TeamProviderPolicyHooks.beforeTurnStart")(function* (input) {
        const instance = yield* instances.getInstance(input.run.providerInstanceId);
        if (instance === undefined) return;
        yield* check("beforeTurnStart", instance.driverKind);
      }),
    });
  }),
);
