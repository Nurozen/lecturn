import { Clock, Effect } from "effect";
import type { RelayTeamOrganization, RelayTeamPolicy } from "@lecturn/contracts";
import { TeamError, teamHasAccess, type TeamStore } from "./TeamStore.ts";
import type { TeamDirectory } from "./TeamDirectory.ts";

const forbidden = () =>
  new TeamError({ code: "forbidden", message: "You do not have permission to manage this team." });
export function makeTeamAdmin(
  store: TeamStore["Service"],
  directory: TeamDirectory["Service"],
  syncUser: (userId: string) => Effect.Effect<void, TeamError> = () => Effect.void,
) {
  const authorize = Effect.fn("TeamAdmin.authorize")(function* (
    organizationId: string,
    userId: string,
    level: "member" | "admin" | "owner" = "member",
  ) {
    const member = yield* directory.membership(organizationId, userId);
    const account = yield* store.get(organizationId);
    if (!member || !account) return yield* forbidden();
    const role =
      account.owner_user_id === userId
        ? ("owner" as const)
        : member.role === "org:admin"
          ? ("admin" as const)
          : ("member" as const);
    if ((level === "owner" && role !== "owner") || (level === "admin" && role === "member"))
      return yield* forbidden();
    return { account, member, role };
  });
  const summary = Effect.fn("TeamAdmin.summary")(function* (
    organizationId: string,
    userId: string,
  ): Effect.fn.Return<RelayTeamOrganization, TeamError> {
    const { account, member, role } = yield* authorize(organizationId, userId);
    const seats = yield* store.seats(organizationId);
    const hasSeat = seats.some((seat) => seat.user_id === userId);
    return {
      organizationId,
      name: member.organization.name,
      role,
      purchasedSeats: account.purchased_seats,
      assignedSeats: seats.length,
      hasSeat,
      hasAccess:
        hasSeat && teamHasAccess(account, Math.floor((yield* Clock.currentTimeMillis) / 1000)),
      policy: account.policy,
    };
  });
  return {
    authorize,
    summary,
    list: Effect.fn("TeamAdmin.list")(function* (userId: string) {
      const memberships = yield* directory.organizations(userId);
      const organizations: RelayTeamOrganization[] = [];
      for (const membership of memberships) {
        if (yield* store.get(membership.organization.id))
          organizations.push(yield* summary(membership.organization.id, userId));
      }
      return { organizations };
    }),
    create: Effect.fn("TeamAdmin.create")(function* (userId: string, name: string) {
      const org = yield* directory.create({ name, userId });
      yield* store.bootstrap({ organizationId: org.id, ownerUserId: userId });
      yield* store.audit({
        organizationId: org.id,
        actorUserId: userId,
        action: "organization.created",
      });
      return yield* summary(org.id, userId);
    }),
    detail: Effect.fn("TeamAdmin.detail")(function* (
      organizationId: string,
      userId: string,
      checkoutEnabled: boolean,
    ) {
      const { account, role } = yield* authorize(organizationId, userId);
      const organization = yield* summary(organizationId, userId);
      // Members see their own seat status. The company directory, inventory and billing are administrative.
      if (role === "member")
        return {
          organization,
          members: [],
          invitations: [],
          environments: [],
          audit: [],
          billing: null,
        };
      const seats = yield* store.seats(organizationId);
      const members = (yield* directory.members(organizationId)).map((member) => ({
        userId: member.publicUserData?.userId ?? "",
        email: member.publicUserData?.identifier ?? "",
        name: [member.publicUserData?.firstName, member.publicUserData?.lastName]
          .filter(Boolean)
          .join(" "),
        role:
          account.owner_user_id === member.publicUserData?.userId
            ? ("owner" as const)
            : member.role === "org:admin"
              ? ("admin" as const)
              : ("member" as const),
        hasSeat: seats.some((seat) => seat.user_id === member.publicUserData?.userId),
      }));
      return {
        organization,
        members,
        invitations: (yield* directory.invitations(organizationId)).map((invite) => ({
          id: invite.id,
          email: invite.emailAddress,
          role: invite.role === "org:admin" ? ("admin" as const) : ("member" as const),
        })),
        environments: (yield* store.inventory(organizationId)).map((env) => ({
          userId: env.user_id,
          environmentId: env.environment_id,
          name: env.name,
          status: env.status,
        })),
        audit: (yield* store.history(organizationId)).map((entry) => ({
          id: entry.id,
          action: entry.action,
          actorUserId: entry.actor_user_id,
          createdAt: entry.created_at,
        })),
        billing:
          role === "owner"
            ? {
                currentPeriodEnd: account.current_period_end,
                interval: account.interval,
                pendingSeats: account.pending_seats,
                state: account.status,
                checkoutEnabled,
                portalEnabled: !!account.customer_id,
              }
            : null,
      };
    }),
    invite: Effect.fn("TeamAdmin.invite")(function* (
      organizationId: string,
      actorUserId: string,
      email: string,
      role: "admin" | "member",
    ) {
      yield* authorize(organizationId, actorUserId, role === "admin" ? "owner" : "admin");
      const invitation = yield* directory.invite({
        organizationId,
        actorUserId,
        emailAddress: email,
        role,
      });
      yield* store.audit({
        organizationId,
        actorUserId,
        action: "member.invited",
        subjectId: invitation.id,
      });
    }),
    revokeInvitation: Effect.fn("TeamAdmin.revokeInvitation")(function* (
      organizationId: string,
      actorUserId: string,
      invitationId: string,
    ) {
      yield* authorize(organizationId, actorUserId, "admin");
      yield* directory.revokeInvitation({ organizationId, actorUserId, invitationId });
      yield* store.audit({
        organizationId,
        actorUserId,
        action: "invitation.revoked",
        subjectId: invitationId,
      });
    }),
    setRole: Effect.fn("TeamAdmin.setRole")(function* (
      organizationId: string,
      actorUserId: string,
      userId: string,
      role: "admin" | "member",
    ) {
      const { account } = yield* authorize(organizationId, actorUserId, "owner");
      if (userId === account.owner_user_id) return yield* forbidden();
      yield* directory.setRole({ organizationId, userId, role });
      yield* store.audit({
        organizationId,
        actorUserId,
        action: `role.${role}`,
        subjectId: userId,
      });
    }),
    removeMember: Effect.fn("TeamAdmin.removeMember")(function* (
      organizationId: string,
      actorUserId: string,
      userId: string,
    ) {
      const { account, role } = yield* authorize(organizationId, actorUserId, "admin");
      const target = yield* directory.membership(organizationId, userId);
      if (userId === account.owner_user_id || (target?.role === "org:admin" && role !== "owner"))
        return yield* forbidden();
      // Revoke the paid seat before external membership deletion. Retrying either operation is safe.
      const environments = yield* store.revokeSeat({ organizationId, actorUserId, userId });
      yield* syncUser(userId);
      if (target) yield* directory.removeMember({ organizationId, userId });
      yield* store.audit({
        organizationId,
        actorUserId,
        action: "member.removed",
        subjectId: userId,
      });
      return environments;
    }),
    seat: Effect.fn("TeamAdmin.seat")(function* (
      organizationId: string,
      actorUserId: string,
      userId: string,
      assigned: boolean,
    ) {
      yield* authorize(organizationId, actorUserId, "admin");
      if (assigned) {
        if (!(yield* directory.membership(organizationId, userId))) return yield* forbidden();
        yield* store.assignSeat({ organizationId, actorUserId, userId });
        return [];
      }
      return yield* store.revokeSeat({ organizationId, actorUserId, userId });
    }),
    policy: Effect.fn("TeamAdmin.policy")(function* (
      organizationId: string,
      actorUserId: string,
      policy: RelayTeamPolicy,
    ) {
      yield* authorize(organizationId, actorUserId, "admin");
      yield* store.updatePolicy({ organizationId, actorUserId, policy });
    }),
  };
}
