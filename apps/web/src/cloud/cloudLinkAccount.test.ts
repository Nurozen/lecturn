import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));

import { describePublishAccount } from "./cloudLinkAccount";

const base = {
  linked: true,
  accountId: "account-b",
  accountSignedIn: true,
  publisherId: "account-a",
  knownAccountIds: ["account-a", "account-b"],
  needsSignIn: [] as string[],
  profiles: new Map([["account-a", { email: "a@example.com" }]]),
  canChoose: true,
};

describe("describePublishAccount", () => {
  it("has nothing to say about the account's own link, or an unpublished computer", () => {
    const own = { mismatch: false, message: null, actAs: null };
    expect(describePublishAccount({ ...base, accountId: "account-a" })).toEqual({
      ...own,
      unlink: { allowed: true, tokenAccountId: "account-a" },
    });
    expect(describePublishAccount({ ...base, linked: false })).toMatchObject(own);
    // Signed out, a local unlink still works without a token.
    expect(describePublishAccount({ ...base, accountId: null, accountSignedIn: false })).toEqual({
      ...own,
      unlink: { allowed: true, tokenAccountId: null },
    });
  });

  it("names a known publisher by email and offers choosing it or unlinking with its token", () => {
    expect(describePublishAccount(base)).toEqual({
      mismatch: true,
      message:
        "a@example.com published this computer. Choose it to change publishing, or unlink this computer.",
      actAs: { accountId: "account-a", label: "Use a@example.com" },
      unlink: { allowed: true, tokenAccountId: "account-a" },
    });
    expect(describePublishAccount({ ...base, canChoose: false }).actAs).toBeNull();
  });

  it("offers sign-in, and a tokenless unlink, for a publisher that needs sign-in", () => {
    const state = describePublishAccount({ ...base, needsSignIn: ["account-a"] });
    expect(state.message).toContain("Sign in to it again");
    expect(state.actAs).toBeNull();
    expect(state.unlink).toEqual({ allowed: true, tokenAccountId: null });
  });

  it("keeps a stranger's link out of reach", () => {
    for (const input of [{ ...base, knownAccountIds: ["account-b"] }]) {
      const state = describePublishAccount(input);
      expect(state.message).toContain("Sign out to stop its local relay");
      expect(state.actAs).toBeNull();
      expect(state.unlink).toEqual({ allowed: false });
    }
  });
});
