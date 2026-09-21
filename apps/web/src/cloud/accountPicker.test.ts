import { describe, expect, it } from "vite-plus/test";

import {
  NEEDS_SIGN_IN_REASON,
  UNKNOWN_PICKER_ACCOUNT_NAME,
  accountPickerVisible,
  buildAccountPickerRows,
  resolvePickedAccount,
} from "./accountPicker";

const two = {
  multiAccountEnabled: true,
  knownAccountIds: ["account-a", "account-b", "account-c"],
  needsSignIn: [] as string[],
  activeAccountId: "account-a",
};

describe("accountPickerVisible", () => {
  it("needs the feature on and two known accounts", () => {
    expect(accountPickerVisible(two)).toBe(true);
    expect(accountPickerVisible({ ...two, multiAccountEnabled: false })).toBe(false);
    expect(accountPickerVisible({ ...two, knownAccountIds: ["account-a"] })).toBe(false);
  });
});

describe("resolvePickedAccount", () => {
  it("is Clerk's active account, whatever else is known, without a picker", () => {
    const everything = {
      selectedAccountId: "account-b",
      preferredAccountId: "account-b",
      threadOwnerAccountId: "account-b",
      lastUsedAccountId: "account-b",
    };
    expect(resolvePickedAccount({ ...two, ...everything, multiAccountEnabled: false })).toBe(
      "account-a",
    );
    expect(resolvePickedAccount({ ...two, ...everything, knownAccountIds: ["account-a"] })).toBe(
      "account-a",
    );
    expect(
      resolvePickedAccount({ ...two, multiAccountEnabled: false, activeAccountId: null }),
    ).toBeNull();
  });

  it("defaults to the open thread's owner, then the last used account, then the active one", () => {
    expect(
      resolvePickedAccount({
        ...two,
        threadOwnerAccountId: "account-b",
        lastUsedAccountId: "account-c",
      }),
    ).toBe("account-b");
    expect(resolvePickedAccount({ ...two, lastUsedAccountId: "account-c" })).toBe("account-c");
    expect(resolvePickedAccount(two)).toBe("account-a");
  });

  it("puts the choice made here first, and a surface's own account before the thread's", () => {
    const base = { ...two, threadOwnerAccountId: "account-b" };
    expect(resolvePickedAccount({ ...base, preferredAccountId: "account-c" })).toBe("account-c");
    expect(
      resolvePickedAccount({
        ...base,
        preferredAccountId: "account-c",
        selectedAccountId: "account-a",
      }),
    ).toBe("account-a");
  });

  it("never answers with an account that needs sign-in or is no longer known", () => {
    expect(
      resolvePickedAccount({
        ...two,
        needsSignIn: ["account-b"],
        selectedAccountId: "account-b",
        threadOwnerAccountId: "account-b",
        lastUsedAccountId: "account-gone",
      }),
    ).toBe("account-a");
    // The active account is a moment ahead of the known list: fall back to a usable one.
    expect(
      resolvePickedAccount({ ...two, needsSignIn: ["account-a"], activeAccountId: "account-z" }),
    ).toBe("account-b");
    expect(
      resolvePickedAccount({ ...two, needsSignIn: ["account-a", "account-b", "account-c"] }),
    ).toBeNull();
  });
});

describe("buildAccountPickerRows", () => {
  it("lists known accounts by email and explains the ones that cannot be chosen", () => {
    expect(
      buildAccountPickerRows({
        knownAccountIds: ["account-a", "account-b"],
        needsSignIn: ["account-b"],
        profiles: new Map([["account-b", { email: "b@example.com" }]]),
      }),
    ).toEqual([
      { accountId: "account-a", name: UNKNOWN_PICKER_ACCOUNT_NAME, disabledReason: null },
      { accountId: "account-b", name: "b@example.com", disabledReason: NEEDS_SIGN_IN_REASON },
    ]);
  });
});
