/**
 * RunExecutionService's one read of connected-app instructions. It reaches
 * the state optionally so focused orchestration tests, which build no apps
 * state, need no extra layer.
 */
import type { ProjectId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { AppRuntimeState } from "./AppRuntimeState.ts";

/** Spread into the turn input: an empty object keeps non-app turns byte-identical. */
export const appInstructionsTurnInput = (
  projectId: ProjectId,
): Effect.Effect<{ readonly appInstructions?: string }> =>
  Effect.gen(function* () {
    const state = yield* Effect.serviceOption(AppRuntimeState);
    if (Option.isNone(state)) return {};
    const lookup = yield* Ref.get(state.value.appInstructions);
    if (Option.isNone(lookup)) return {};
    const instructions = yield* lookup.value(projectId);
    return Option.isNone(instructions) ? {} : { appInstructions: instructions.value };
  });
