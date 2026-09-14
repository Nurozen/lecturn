import { Clock, Context, Effect, Layer } from "effect";
import { TeamStore, TeamError } from "./TeamStore.ts";
import { TeamDirectory } from "./TeamDirectory.ts";
import type { RelayEnvironmentLinkRequest } from "@lecturn/contracts/relay";

export const makeTeamRuntime = (
  store: TeamStore["Service"],
  directory: TeamDirectory["Service"],
) => ({
  prepareLink: Effect.fn("TeamRuntime.prepareLink")(function* (
    userId: string,
    environmentId: string,
    request: RelayEnvironmentLinkRequest,
  ) {
    const existing = yield* store.funding(userId, environmentId);
    if (existing && existing.organizationId !== request.organizationId)
      return yield* new TeamError({
        code: "conflict",
        message: "Unlink this environment before changing its funding account.",
      });
    if (!request.organizationId) return;
    if (!(yield* directory.membership(request.organizationId, userId)))
      return yield* new TeamError({
        code: "forbidden",
        message: "You are no longer a member of this team.",
      });
    const account = yield* store.get(request.organizationId);
    if (!account) return yield* new TeamError({ code: "not_found", message: "Team not found." });
    if (
      (request.notificationsEnabled || request.liveActivitiesEnabled) &&
      !account.policy.publishAgentActivity
    )
      return yield* new TeamError({
        code: "forbidden",
        message: "Agent activity publishing is disabled by your organization.",
      });
    // Called exclusively after EnvironmentLinker has validated the environment-signed proof.
    yield* store.bindEnvironment({
      organizationId: request.organizationId,
      userId,
      actorUserId: userId,
      environmentId,
      proofVerified: true,
    });
  }),
  access: store.access,
  funding: store.funding,
  unlinked: Effect.fn("TeamRuntime.unlinked")(function* (userId: string, environmentId: string) {
    const funding = yield* store.funding(userId, environmentId);
    if (funding) yield* store.unbindEnvironment({ ...funding, actorUserId: userId });
  }),
  policy: Effect.fn("TeamRuntime.policy")(function* (userId: string, environmentId: string) {
    const access = yield* store.access(
      userId,
      environmentId,
      Math.floor((yield* Clock.currentTimeMillis) / 1000),
    );
    return access
      ? { organizationId: access.organizationId, hasAccess: access.allowed, ...access.policy }
      : null;
  }),
});
export class TeamRuntime extends Context.Service<TeamRuntime, ReturnType<typeof makeTeamRuntime>>()(
  "lecturn-relay/teams/TeamRuntime",
) {
  static readonly layer = Layer.effect(
    TeamRuntime,
    Effect.gen(function* () {
      return makeTeamRuntime(yield* TeamStore, yield* TeamDirectory);
    }),
  );
}
