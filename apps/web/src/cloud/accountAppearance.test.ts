import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { bindActiveAccountClerk } from "./withActiveAccount";
import {
  initializeAccountAppearance,
  refreshAccountAppearance,
  saveAccountAppearance,
  type AppearanceUser,
} from "./accountAppearance";

const observed = vi.hoisted(() => vi.fn());
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./connectAccounts", () => ({ observeAccountProfiles: observed }));
afterEach(() => {
  bindActiveAccountClerk(null);
  vi.clearAllMocks();
});

function fixture() {
  const writes: string[] = [];
  const users: AppearanceUser[] = ["a", "b"].map((id) => ({
    id,
    primaryEmailAddress: { emailAddress: `${id}@${id}.example` },
    unsafeMetadata: { other: "kept" },
    reload: vi.fn(async () => users.find((user) => user.id === id)!),
    updateMetadata: vi.fn(
      async ({ unsafeMetadata }: { unsafeMetadata: Record<string, unknown> }) => {
        writes.push(id);
        const index = users.findIndex((user) => user.id === id);
        const updated = { ...users[index]!, unsafeMetadata };
        users[index] = updated;
        return updated;
      },
    ),
  }));
  const clerk = {
    user: users[0]!,
    client: {
      get signedInSessions() {
        return users.map((user) => ({ id: `s-${user.id}`, user }));
      },
    },
    setActive: vi.fn(async ({ session }: { session: string }) => {
      clerk.user = users.find((user) => `s-${user.id}` === session)!;
    }),
  };
  bindActiveAccountClerk(clerk);
  return { clerk, users, writes };
}

describe("account appearance writes", () => {
  it("serializes by account, preserves unrelated metadata and updates cached profiles", async () => {
    const { clerk, users, writes } = fixture();
    await Promise.all([
      saveAccountAppearance(clerk, "b", { label: " Work ", preset: "blue" }),
      saveAccountAppearance(clerk, "a", { label: "Personal", preset: "jade" }),
    ]);
    expect(writes).toEqual(["b", "a"]);
    expect(users[1]?.unsafeMetadata).toEqual({
      other: "kept",
      lecturn: { label: "Work", preset: "blue" },
    });
    expect(clerk.setActive.mock.calls).toEqual([[{ session: "s-b" }], [{ session: "s-a" }]]);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(clerk.user.id).toBe("a");
  });
  it("rejects another user's response without caching it", async () => {
    const { clerk, users } = fixture();
    vi.mocked(users[0]!.updateMetadata).mockResolvedValueOnce(users[1]!);
    await expect(saveAccountAppearance(clerk, "a", { label: "A", preset: "jade" })).rejects.toThrow(
      "account changed",
    );
    expect(observed).not.toHaveBeenCalled();
  });
  it("persists distinct defaults and leaves existing metadata untouched on later observations", async () => {
    const { clerk, users, writes } = fixture();
    await Promise.all([initializeAccountAppearance(clerk), initializeAccountAppearance(clerk)]);
    expect(writes).toEqual(["a", "b"]);
    expect(users.map((user) => user.unsafeMetadata)).toEqual([
      { other: "kept", lecturn: { label: "a.example", preset: "jade" } },
      { other: "kept", lecturn: { label: "b.example", preset: "teal" } },
    ]);
  });
  it("refreshes every session and keeps the cached profile when one is offline", async () => {
    const { clerk, users } = fixture();
    vi.mocked(users[1]!.reload).mockRejectedValueOnce(new Error("offline"));
    await refreshAccountAppearance(clerk);
    expect(users[0]!.reload).toHaveBeenCalledOnce();
    expect(users[1]!.reload).toHaveBeenCalledOnce();
    expect(clerk.setActive).toHaveBeenCalledWith({ session: "s-b" });
    expect(observed).toHaveBeenCalledWith({}, users);
  });
});
