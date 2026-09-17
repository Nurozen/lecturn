import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Effect } from "effect";
import { createClerkClient } from "@clerk/backend";
import { makeTeamDirectory } from "./TeamDirectory.ts";
vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn() }));
const setup = () => {
  const membership = vi.fn();
  const users = vi.fn();
  vi.mocked(createClerkClient).mockReturnValue({
    organizations: { getOrganizationMembershipList: membership },
    users: { getOrganizationMembershipList: users },
  } as unknown as ReturnType<typeof createClerkClient>);
  return { membership, users, directory: makeTeamDirectory("test-secret") };
};
describe("TeamDirectory", () => {
  it.effect("looks up live exact user membership and never trusts another returned member", () =>
    Effect.gen(function* () {
      const { membership, directory } = setup();
      membership.mockResolvedValueOnce({
        data: [{ publicUserData: { userId: "other" }, role: "org:admin" }],
      });
      expect(yield* directory.membership("org", "employee")).toBeNull();
      expect(membership).toHaveBeenCalledWith({
        organizationId: "org",
        userId: ["employee"],
        limit: 1,
      });
      membership.mockResolvedValueOnce({
        data: [{ publicUserData: { userId: "employee" }, role: "org:member" }],
      });
      expect((yield* directory.membership("org", "employee"))?.role).toBe("org:member");
      expect(membership).toHaveBeenCalledTimes(2);
    }),
  );
  it.effect("includes memberships beyond the first directory page", () =>
    Effect.gen(function* () {
      const { users, directory } = setup();
      users.mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, id) => ({ id: String(id) })),
        totalCount: 101,
      });
      users.mockResolvedValueOnce({ data: [{ id: "last" }], totalCount: 101 });
      expect(yield* directory.organizations("employee")).toHaveLength(101);
      expect(users).toHaveBeenLastCalledWith({ userId: "employee", limit: 100, offset: 100 });
    }),
  );
  it.effect("fails closed on directory failures without leaking provider errors", () =>
    Effect.gen(function* () {
      const { membership, directory } = setup();
      membership.mockRejectedValue(new Error("private provider diagnostics"));
      const result = yield* directory.membership("org", "employee").pipe(Effect.result);
      expect(result._tag === "Failure" && result.failure.code).toBe("unavailable");
      expect(result._tag === "Failure" && result.failure.message).not.toContain("private");
    }),
  );
});
