/**
 * Connected apps' contribution to the Lecturn orchestration hook registry.
 * server.ts registers it beside the other fork contributions, so it has no
 * hooks until A13a adds the first; later steps add theirs to this one
 * contribution.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LecturnOrchestrationHooks } from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks;
    yield* hooks.register({ name: "apps" });
  }),
);
