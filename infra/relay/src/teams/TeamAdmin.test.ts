import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Effect } from "effect";
import { TeamError, type TeamAccount, type TeamStore } from "./TeamStore.ts";
import type { TeamDirectory } from "./TeamDirectory.ts";
import { makeTeamAdmin } from "./TeamAdmin.ts";
const account: TeamAccount = {
  organization_id: "org_team",
  owner_user_id: "owner",
  customer_id: "cus_team",
  subscription_id: "sub_team",
  purchased_seats: 5,
  access_until: 1000,
  access_window_start: 0,
  interval: "month",
  current_period_end: 1000,
  pending_seats: null,
  policy: { allowedProviders: null, publishAgentActivity: true },
  generation: 0,
  billing_lease_owner: null,
  billing_state: {},
  status: "active",
  suspended: false,
  reconcile_after: 0,
  billing_lease_expires_at: 0,
  created_at: 0,
  updated_at: 0,
};
function fixture() {
  const events: string[] = [];
  const memberships = new Map<string, string>([
    ["owner", "org:admin"],
    ["admin", "org:admin"],
    ["employee", "org:member"],
  ]);
  type Membership = NonNullable<Effect.Success<ReturnType<TeamDirectory["Service"]["membership"]>>>;
  const member = (userId: string): Membership | null =>
    memberships.has(userId)
      ? ({
          role: memberships.get(userId),
          organization: { id: "org_team", name: "Example Team" },
          publicUserData: {
            userId,
            identifier: `${userId}@example.test`,
            firstName: userId,
            lastName: "",
          },
        } as Membership)
      : null;
  const directory = {
    membership: vi.fn((org: string, user: string) =>
      Effect.succeed(org === "org_team" ? member(user) : null),
    ),
    organizations: vi.fn((user: string) => Effect.succeed(member(user) ? [member(user)!] : [])),
    members: vi.fn(() => Effect.succeed([...memberships.keys()].map((user) => member(user)!))),
    invitations: vi.fn(() => Effect.succeed([])),
    invite: vi.fn(() => Effect.succeed({ id: "invite" })),
    revokeInvitation: vi.fn(() => Effect.void),
    setRole: vi.fn(() => Effect.void),
    removeMember: vi.fn((): Effect.Effect<void, TeamError> =>
      Effect.sync(() => {
        events.push("directory.remove");
      }),
    ),
    create: vi.fn(() => Effect.succeed({ id: "org_team" })),
  };
  const store = {
    markUserDeleted: vi.fn(() => Effect.succeed({ ownedOrganizationIds: [], affectedUserIds: [] })),
    get: vi.fn((org: string) => Effect.succeed(org === "org_team" ? account : null)),
    seats: vi.fn(() =>
      Effect.succeed([{ organization_id: "org_team", user_id: "employee", assigned_at: 0 }]),
    ),
    audit: vi.fn(() => Effect.void),
    bootstrap: vi.fn(() => Effect.succeed(account)),
    inventory: vi.fn(() =>
      Effect.succeed([
        { user_id: "employee", environment_id: "env", name: "device", status: "linked" as const },
      ]),
    ),
    history: vi.fn(() => Effect.succeed([])),
    assignSeat: vi.fn(() => Effect.succeed(undefined)),
    revokeSeat: vi.fn(() =>
      Effect.sync(() => {
        events.push("seat.revoke");
        return ["env"];
      }),
    ),
    updatePolicy: vi.fn(() => Effect.void),
    funding: vi.fn(() => Effect.succeed(undefined)),
    access: vi.fn(() => Effect.succeed(undefined)),
    bindEnvironment: vi.fn(() => Effect.succeed(undefined)),
    unbindEnvironment: vi.fn(() => Effect.succeed(undefined)),
  } satisfies TeamStore["Service"];
  return {
    store,
    directory,
    memberships,
    events,
    directoryService: directory as unknown as TeamDirectory["Service"],
  };
}

describe("TeamAdmin authorization", () => {
  it.effect(
    "does not let stored ownership bypass missing live membership or a different organization",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const admin = makeTeamAdmin(f.store, f.directoryService);
        f.memberships.delete("owner");
        for (const org of ["org_team", "org_other"]) {
          const result = yield* admin.authorize(org, "owner", "owner").pipe(Effect.result);
          expect(result._tag === "Failure" && result.failure.code).toBe("forbidden");
        }
      }),
  );
  it.effect("keeps inventory, other members and billing private from ordinary members", () =>
    Effect.gen(function* () {
      const f = fixture();
      const admin = makeTeamAdmin(f.store, f.directoryService);
      const detail = yield* admin.detail("org_team", "employee", true);
      expect(detail.organization.hasAccess).toBe(true);
      expect(detail.members).toEqual([]);
      expect(detail.environments).toEqual([]);
      expect(detail.billing).toBeNull();
      expect(f.directory.members).not.toHaveBeenCalled();
      expect(f.store.inventory).not.toHaveBeenCalled();
      const billing = yield* admin.authorize("org_team", "employee", "owner").pipe(Effect.result);
      expect(billing._tag === "Failure" && billing.failure.code).toBe("forbidden");
    }),
  );
  it.effect("allows administrators to manage members without billing ownership", () =>
    Effect.gen(function* () {
      const f = fixture();
      const admin = makeTeamAdmin(f.store, f.directoryService);
      const detail = yield* admin.detail("org_team", "admin", true);
      expect(detail.members).toHaveLength(3);
      expect(detail.billing).toBeNull();
      expect((yield* admin.authorize("org_team", "admin", "owner").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
  );
  it.effect("invitations never assign seats or buy capacity and only owners invite admins", () =>
    Effect.gen(function* () {
      const f = fixture();
      const admin = makeTeamAdmin(f.store, f.directoryService);
      yield* admin.invite("org_team", "admin", "new@example.test", "member");
      expect(f.directory.invite).toHaveBeenCalledTimes(1);
      expect(f.store.assignSeat).not.toHaveBeenCalled();
      expect(
        (yield* admin.invite("org_team", "admin", "new@example.test", "admin").pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(f.directory.invite).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("protects owner membership and role, and prevents admins removing other admins", () =>
    Effect.gen(function* () {
      const f = fixture();
      const admin = makeTeamAdmin(f.store, f.directoryService);
      for (const effect of [
        admin.removeMember("org_team", "owner", "owner"),
        admin.setRole("org_team", "owner", "owner", "member"),
        admin.removeMember("org_team", "admin", "admin"),
      ]) {
        expect((yield* effect.pipe(Effect.result))._tag).toBe("Failure");
      }
      expect(f.store.revokeSeat).not.toHaveBeenCalled();
      expect(f.directory.setRole).not.toHaveBeenCalled();
    }),
  );
  it.effect("requires live membership before assigning paid access", () =>
    Effect.gen(function* () {
      const f = fixture();
      const admin = makeTeamAdmin(f.store, f.directoryService);
      expect(
        (yield* admin.seat("org_team", "admin", "outsider", true).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(f.store.assignSeat).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    "revokes the seat before deleting external membership, including when Clerk fails",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.directory.removeMember.mockImplementation(() =>
          Effect.sync(() => {
            f.events.push("directory.remove");
          }).pipe(
            Effect.andThen(
              Effect.fail(new TeamError({ code: "unavailable", message: "Clerk unavailable" })),
            ),
          ),
        );
        const result = yield* makeTeamAdmin(f.store, f.directoryService, () =>
          Effect.sync(() => {
            f.events.push("gateway.sync");
          }),
        )
          .removeMember("org_team", "owner", "employee")
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(f.events).toEqual(["seat.revoke", "gateway.sync", "directory.remove"]);
      }),
  );
});
