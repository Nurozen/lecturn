import type { SquireRole, SquireThreadMarker } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SquireRepository } from "../SquireRepository.ts";
import { LEAD_SKILL_SECTIONS } from "./lead.ts";
import { SQUIRE_SKILL_SECTIONS } from "./squire.ts";

export const squireSkillSections = (role: SquireRole): ReadonlyArray<string> =>
  role === "lead" ? LEAD_SKILL_SECTIONS : SQUIRE_SKILL_SECTIONS;

/**
 * RunExecutionService's one read of the Squire skill. Only a home
 * thread gets it; a probe answers as the forked thread's own agent. The
 * repository is reached optionally, as ProviderSessionManager does, and a
 * missing or unreadable record reads as the narrower Squire role.
 */
export const squireInstructionsTurnInput = (appThread: {
  readonly squire?: SquireThreadMarker | undefined;
}): Effect.Effect<{ readonly squireInstructions?: ReadonlyArray<string> }> =>
  Effect.gen(function* () {
    const marker = appThread.squire;
    if (marker === undefined || marker.role !== "home") return {};
    const repository = yield* Effect.serviceOption(SquireRepository);
    const role = Option.isNone(repository)
      ? "squire"
      : yield* repository.value.getSquire(marker.squireId).pipe(
          Effect.map((row): SquireRole => (Option.isSome(row) ? row.value.role : "squire")),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to read the Squire role for its skill.", { cause }).pipe(
              Effect.as<SquireRole>("squire"),
            ),
          ),
        );
    return { squireInstructions: squireSkillSections(role) };
  });
