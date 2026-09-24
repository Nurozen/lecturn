import { describe, expect, it } from "vite-plus/test";
import { reconcileMobileAccounts } from "./knownAccounts.logic";
const a = { accountId: "a", email: "a@example.com", label: "Work", preset: "jade", signedIn: true };
const b = {
  accountId: "b",
  email: "b@example.net",
  label: "Personal",
  preset: "violet",
  signedIn: true,
};
const session = (id: string, status = "active") => ({ status, user: { id } });
describe("mobile known accounts", () => {
  it("preserves expired accounts and their appearance when another account signs in", () => {
    const next = reconcileMobileAccounts([a], [session("a", "expired"), session("b")]);
    expect(next[0]).toEqual({ ...a, signedIn: false });
    expect(next[1]).toMatchObject({ accountId: "b", signedIn: true, preset: "teal" });
  });
  it("does not treat an empty or revoked session list as permission to erase ownership", () => {
    expect(reconcileMobileAccounts([a, b], [])).toEqual([
      { ...a, signedIn: false },
      { ...b, signedIn: false },
    ]);
    expect(reconcileMobileAccounts([a], [session("a", "revoked")])).toEqual([
      { ...a, signedIn: false },
    ]);
  });
  it("preserves sign-in order and fallback colors across active-session flips", () => {
    expect(reconcileMobileAccounts([a, b], [session("b"), session("a")])).toEqual([a, b]);
  });
  it("refreshes remote metadata without losing other accounts", () => {
    expect(
      reconcileMobileAccounts(
        [a, b],
        [
          {
            status: "active",
            user: { id: "a", unsafeMetadata: { lecturn: { label: "Studio", preset: "cyan" } } },
          },
          session("b"),
        ],
      ),
    ).toEqual([{ ...a, label: "Studio", preset: "cyan" }, b]);
  });
});
