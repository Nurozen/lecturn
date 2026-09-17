import { createClerkClient } from "@clerk/backend";
import { Context, Effect } from "effect";
import { TeamError } from "./TeamStore.ts";

export const makeTeamDirectory = (secretKey: string) => {
  const clerk = createClerkClient({ secretKey });
  const call = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: () =>
        new TeamError({
          code: "unavailable",
          message: "Organization directory is temporarily unavailable",
        }),
    });
  return {
    create: (input: { name: string; userId: string }) =>
      call(() =>
        clerk.organizations.createOrganization({ name: input.name, createdBy: input.userId }),
      ),
    organizations: (userId: string) =>
      call(async () => {
        const result = [];
        for (let offset = 0; ; offset += 100) {
          const page = await clerk.users.getOrganizationMembershipList({
            userId,
            limit: 100,
            offset,
          });
          result.push(...page.data);
          if (result.length >= page.totalCount || page.data.length === 0) return result;
        }
      }),
    membership: (organizationId: string, userId: string) =>
      call(async () => {
        const result = await clerk.organizations.getOrganizationMembershipList({
          organizationId,
          userId: [userId],
          limit: 1,
        });
        return result.data.find((member) => member.publicUserData?.userId === userId) ?? null;
      }),
    members: (organizationId: string) =>
      call(async () => {
        const result = [];
        for (let offset = 0; ; offset += 100) {
          const page = await clerk.organizations.getOrganizationMembershipList({
            organizationId,
            limit: 100,
            offset,
          });
          result.push(...page.data);
          if (result.length >= page.totalCount || page.data.length === 0) return result;
        }
      }),
    invite: (input: {
      organizationId: string;
      actorUserId: string;
      emailAddress: string;
      role: "admin" | "member";
    }) =>
      call(() =>
        clerk.organizations.createOrganizationInvitation({
          organizationId: input.organizationId,
          inviterUserId: input.actorUserId,
          emailAddress: input.emailAddress,
          role: `org:${input.role}`,
        }),
      ),
    invitations: (organizationId: string) =>
      call(async () => {
        const result = [];
        for (let offset = 0; ; offset += 100) {
          const page = await clerk.organizations.getOrganizationInvitationList({
            organizationId,
            status: ["pending"],
            limit: 100,
            offset,
          });
          result.push(...page.data);
          if (result.length >= page.totalCount || page.data.length === 0) return result;
        }
      }),
    revokeInvitation: (input: {
      organizationId: string;
      invitationId: string;
      actorUserId: string;
    }) =>
      call(() =>
        clerk.organizations.revokeOrganizationInvitation({
          organizationId: input.organizationId,
          invitationId: input.invitationId,
          requestingUserId: input.actorUserId,
        }),
      ),
    setRole: (input: { organizationId: string; userId: string; role: "admin" | "member" }) =>
      call(() =>
        clerk.organizations.updateOrganizationMembership({
          organizationId: input.organizationId,
          userId: input.userId,
          role: `org:${input.role}`,
        }),
      ),
    removeMember: (input: { organizationId: string; userId: string }) =>
      call(() => clerk.organizations.deleteOrganizationMembership(input)),
  };
};
export class TeamDirectory extends Context.Service<
  TeamDirectory,
  ReturnType<typeof makeTeamDirectory>
>()("lecturn-relay/teams/TeamDirectory") {}
