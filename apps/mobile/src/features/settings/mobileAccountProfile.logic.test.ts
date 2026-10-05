import { describe, expect, it, vi } from "vite-plus/test";
import {
  mobileProfileOwnerMatches,
  selectMobileProfileAccount,
} from "./mobileAccountProfile.logic";
function fixture() {
  const a = { id: "session-a", user: { id: "a" } };
  const b = { id: "session-b", user: { id: "b" } };
  const clerk = {
    session: a,
    client: { signedInSessions: [a, b] },
    setActive: vi.fn(async ({ session }: { session: string }) => {
      clerk.session = clerk.client.signedInSessions.find((entry) => entry.id === session)!;
    }),
  };
  return { clerk, a, b };
}
describe("mobile account profile ownership", () => {
  it("selects the requested session before opening a non-active account profile", async () => {
    const { clerk, b } = fixture();
    await selectMobileProfileAccount(clerk, "b");
    expect(clerk.setActive).toHaveBeenCalledExactlyOnceWith({ session: "session-b" });
    expect(clerk.session).toBe(b);
  });
  it("keeps the current session when it already belongs to the requested account", async () => {
    const { clerk } = fixture();
    await selectMobileProfileAccount(clerk, "a");
    expect(clerk.setActive).not.toHaveBeenCalled();
  });
  it("rejects an expired account without falling back to a signed-in account", async () => {
    const { clerk } = fixture();
    clerk.client.signedInSessions = clerk.client.signedInSessions.slice(0, 1);
    await expect(selectMobileProfileAccount(clerk, "b")).rejects.toThrow("Sign in to this account");
    expect(clerk.setActive).not.toHaveBeenCalled();
  });
  it("fails closed when native session sync does not select the expected owner", async () => {
    const { clerk } = fixture();
    clerk.setActive.mockResolvedValueOnce(undefined);
    await expect(selectMobileProfileAccount(clerk, "b")).rejects.toThrow("Could not switch");
  });
  it("hides profile writes immediately if either rendered or resource identity changes", () => {
    expect(mobileProfileOwnerMatches("a", "a", "a")).toBe(true);
    expect(mobileProfileOwnerMatches("a", "b", "a")).toBe(false);
    expect(mobileProfileOwnerMatches("a", "a", "b")).toBe(false);
    expect(mobileProfileOwnerMatches("a", null, null)).toBe(false);
  });
});
