import type { OrchestrationProjectShell, ProjectId } from "@lecturn/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SquireSwitch from "./SquireSwitch.ts";

/**
 * A project's Stave containers. `unknown` means the project could not be read,
 * so no space or saga grant may cover it; project grants still do.
 */
export type SquireStaveMembership =
  | {
      readonly status: "known";
      readonly spaceId: string | null;
      readonly sagaId: string | null;
    }
  | { readonly status: "unknown" };

const noStave: SquireStaveMembership = { status: "known", spaceId: null, sagaId: null };

/** The Stave space and saga a project belongs to, read through `project.stave`. */
export class SquireContainers extends Context.Service<
  SquireContainers,
  {
    readonly ofProject: (projectId: ProjectId) => Effect.Effect<SquireStaveMembership>;
  }
>()("lecturn/squire/SquireContainers") {}

/**
 * Synthetic Stave memberships for fixture projects, which have no Stave
 * workspace for `project.stave` to read. Provided only with test providers on;
 * `loadSetup` registers them again after a restart.
 */
export class SquireFixtureStave extends Context.Service<
  SquireFixtureStave,
  {
    readonly set: (
      projectId: ProjectId,
      membership: { readonly spaceId: string | null; readonly sagaId: string | null },
    ) => Effect.Effect<void>;
    readonly ofProject: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<SquireStaveMembership>>;
    /** The fixture's own name for a synthetic space or saga, so views never show its id. */
    readonly setName: (containerId: string, name: string) => Effect.Effect<void>;
    readonly nameOf: (containerId: string) => Effect.Effect<Option.Option<string>>;
  }
>()("lecturn/squire/SquireContainers/SquireFixtureStave") {}

export const layerFixtureStave = Layer.effect(
  SquireFixtureStave,
  Effect.gen(function* () {
    const memberships = yield* Ref.make(new Map<ProjectId, SquireStaveMembership>());
    const names = yield* Ref.make(new Map<string, string>());
    return SquireFixtureStave.of({
      setName: Effect.fn("SquireFixtureStave.setName")(function (containerId, name) {
        return Ref.update(names, (current) => new Map(current).set(containerId, name));
      }),
      nameOf: Effect.fn("SquireFixtureStave.nameOf")(function (containerId) {
        return Ref.get(names).pipe(
          Effect.map((current) => Option.fromUndefinedOr(current.get(containerId))),
        );
      }),
      set: Effect.fn("SquireFixtureStave.set")(function (projectId, membership) {
        return Ref.update(memberships, (current) =>
          new Map(current).set(projectId, { status: "known", ...membership }),
        );
      }),
      ofProject: Effect.fn("SquireFixtureStave.ofProject")(function (projectId) {
        return Ref.get(memberships).pipe(
          Effect.map((current) => Option.fromUndefinedOr(current.get(projectId))),
        );
      }),
    });
  }),
);

/**
 * A Stave space's or saga's display name, as the Squire views show it: the
 * title of its own coordinating project, else a fixture's name for a
 * synthetic one. None when neither knows it.
 */
export const staveContainerName = (
  shells: ReadonlyArray<{
    readonly title: string;
    readonly stave?: { readonly spaceId: string } | null | undefined;
  }>,
  fixture: Option.Option<SquireFixtureStave["Service"]>,
  containerId: string,
): Effect.Effect<Option.Option<string>> => {
  const own = shells.find((shell) => shell.stave?.spaceId === containerId);
  if (own !== undefined) return Effect.succeedSome(own.title);
  return Option.isSome(fixture) ? fixture.value.nameOf(containerId) : Effect.succeedNone;
};

const fromShell = (shell: Option.Option<OrchestrationProjectShell>): SquireStaveMembership => {
  const stave = Option.isSome(shell) ? shell.value.stave : null;
  if (stave === null || stave === undefined) return noStave;
  // A saga's own coordinating space is inside the saga it coordinates.
  return {
    status: "known",
    spaceId: stave.spaceId,
    sagaId: stave.isSaga ? stave.spaceId : (stave.memberOf ?? null),
  };
};

// Matches StaveDisplayMembership's saga-list TTL, so a `stave` CLI change
// Lecturn never hears about still shows up within the same window.
const MEMBERSHIP_TTL = Duration.seconds(15);

const makeLive = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const squireSwitch = yield* SquireSwitch.SquireSwitch;
  const fixtureStave = yield* Effect.serviceOption(SquireFixtureStave);
  const cache = yield* Cache.makeWith(
    (projectId: ProjectId) => projects.getShell(projectId).pipe(Effect.map(fromShell)),
    {
      capacity: 512,
      timeToLive: Exit.match({
        onSuccess: () => MEMBERSHIP_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  // Project writes and Stave refreshes are project application events. They
  // are followed only while Squires are on; each on period first drops what
  // the off period may have left stale.
  yield* Effect.forkScoped(
    squireSwitch.whileOn(
      Effect.gen(function* () {
        const highWater = yield* events.latestApplicationSequence.pipe(Effect.option);
        yield* Cache.invalidateAll(cache);
        if (Option.isNone(highWater)) return;
        yield* Stream.runForEach(
          events.streamApplicationEvents({ afterSequence: highWater.value }),
          (event) =>
            "aggregateKind" in event && event.aggregateKind === "project"
              ? Cache.invalidate(cache, event.aggregateId)
              : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Squire container invalidation stopped; entries expire by TTL.", {
              cause,
            }),
          ),
        );
      }),
    ),
  );

  return SquireContainers.of({
    ofProject: Effect.fn("SquireContainers.ofProject")(function* (projectId) {
      if (Option.isSome(fixtureStave)) {
        const synthetic = yield* fixtureStave.value.ofProject(projectId);
        if (Option.isSome(synthetic)) return synthetic.value;
      }
      return yield* Cache.get(cache, projectId).pipe(
        Effect.orElseSucceed((): SquireStaveMembership => ({ status: "unknown" })),
      );
    }),
  });
});

/** Over `ProjectService` shells; never runs the Stave binary itself. */
export const layer = Layer.effect(SquireContainers, makeLive);

export interface SquireContainersTestSpace {
  readonly spaceId: string;
  readonly sagaId?: string;
  readonly projectIds: ReadonlyArray<ProjectId>;
}

/** Synthetic spaces and sagas; projects in neither list have no Stave space. */
export const layerTest = (input: {
  readonly spaces?: ReadonlyArray<SquireContainersTestSpace>;
  readonly unknownProjectIds?: ReadonlyArray<ProjectId>;
}) =>
  Layer.succeed(
    SquireContainers,
    SquireContainers.of({
      ofProject: Effect.fn("SquireContainers.ofProject")(
        function (projectId): Effect.Effect<SquireStaveMembership> {
          if (input.unknownProjectIds?.includes(projectId)) {
            return Effect.succeed({ status: "unknown" });
          }
          const space = input.spaces?.find((candidate) => candidate.projectIds.includes(projectId));
          return Effect.succeed(
            space === undefined
              ? noStave
              : { status: "known", spaceId: space.spaceId, sagaId: space.sagaId ?? null },
          );
        },
      ),
    }),
  );
