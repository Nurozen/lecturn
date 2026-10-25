/**
 * Connected apps' contribution to the Lecturn orchestration hook registry.
 * server.ts registers it beside the other fork contributions; later steps add
 * their hooks to this one contribution.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  type LecturnCommandAdmissionInput,
  LecturnHookRejectedError,
  LecturnOrchestrationHooks,
} from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

const CONTRIBUTION = "apps";

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;

  /**
   * An app project's root is the app's own folder: the app finds the project
   * by it and its tools run there, so moving it would orphan both. The planner
   * stays upstream-shaped; the refusal lives here, inside the project lock.
   */
  const refuseAppWorkspaceMove = (input: LecturnCommandAdmissionInput) =>
    Effect.gen(function* () {
      if (input.scope !== "project") return;
      const { command } = input;
      if (command.type !== "project.meta.update" || command.workspaceRoot === undefined) return;
      const project = yield* projects.get(command.projectId).pipe(
        Effect.mapError(
          (cause) =>
            new LecturnHookRejectedError({
              hook: "aroundCommand",
              contribution: CONTRIBUTION,
              reason: "Could not read the project to check its app binding.",
              cause,
            }),
        ),
      );
      if (Option.isNone(project) || project.value.appBinding === undefined) return;
      return yield* new LecturnHookRejectedError({
        hook: "aroundCommand",
        contribution: CONTRIBUTION,
        reason: `This project belongs to the connected app ${project.value.appBinding.appId}; its folder cannot be changed.`,
      });
    });

  return {
    name: CONTRIBUTION,
    aroundCommand: <A, E, R>(input: LecturnCommandAdmissionInput, commit: Effect.Effect<A, E, R>) =>
      refuseAppWorkspaceMove(input).pipe(Effect.andThen(commit)),
  };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks;
    yield* hooks.register(yield* make);
  }),
);
