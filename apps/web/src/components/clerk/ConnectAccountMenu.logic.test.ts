import { describe, expect, it } from "vite-plus/test";

import {
  UNKNOWN_ACCOUNT_NAME,
  accountInitials,
  buildConnectAccountMenu,
  isOAuthFlowPendingError,
  unexpectedSignInToReject,
} from "./ConnectAccountMenu.logic";

const profiles = new Map([
  ["account-a", { email: "ada.lovelace@work.example", imageUrl: "https://img.example/ada" }],
  ["account-b", { email: "grace@home.example" }],
]);

const build = (input: Partial<Parameters<typeof buildConnectAccountMenu>[0]>) =>
  buildConnectAccountMenu({
    knownAccountIds: ["account-a", "account-b"],
    needsSignIn: [],
    activeAccountId: "account-a",
    profiles,
    gate: { available: true },
    ...input,
  });

describe("buildConnectAccountMenu", () => {
  it("lists every known account and marks the active one", () => {
    expect(build({}).rows).toEqual([
      {
        accountId: "account-a",
        name: "ada.lovelace@work.example",
        initials: "AD",
        imageUrl: "https://img.example/ada",
        active: true,
        needsSignIn: false,
        canManage: true,
        canActivate: false,
      },
      {
        accountId: "account-b",
        name: "grace@home.example",
        initials: "GR",
        imageUrl: null,
        active: false,
        needsSignIn: false,
        canManage: false,
        canActivate: true,
      },
    ]);
  });

  it("shows a known account without a session as needing sign-in, without Manage", () => {
    const row = build({ needsSignIn: ["account-b"] }).rows[1]!;
    expect(row).toMatchObject({
      needsSignIn: true,
      canManage: false,
      canActivate: false,
      active: false,
    });
  });

  it("still lists accounts when none is signed in", () => {
    const model = build({ activeAccountId: null, needsSignIn: ["account-a", "account-b"] });
    expect(model.rows.map((row) => [row.needsSignIn, row.canManage])).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  it("lists Clerk's active account before the known list has caught up", () => {
    const model = build({ knownAccountIds: ["account-a"], activeAccountId: "account-c" });
    expect(model.rows.map((row) => row.accountId)).toEqual(["account-a", "account-c"]);
    expect(model.rows[1]).toMatchObject({
      name: UNKNOWN_ACCOUNT_NAME,
      initials: "?",
      active: true,
    });
  });

  it("offers sign out of all accounts only with more than one account", () => {
    expect(build({}).canSignOutAll).toBe(true);
    expect(build({ knownAccountIds: ["account-a"] }).canSignOutAll).toBe(false);
  });

  it("enables, explains, or hides Add account from the gate", () => {
    expect(build({}).addAccount).toEqual({ enabled: true });
    expect(build({ gate: { available: false, reason: "disabled" } }).addAccount).toBeNull();
    const reasons = (["single-session", "unowned-environments", "account-limit"] as const).map(
      (reason) => {
        const addAccount = build({ gate: { available: false, reason } }).addAccount;
        return addAccount && !addAccount.enabled ? addAccount.reason : null;
      },
    );
    expect(reasons.every((reason) => typeof reason === "string" && reason.length > 0)).toBe(true);
    expect(new Set(reasons).size).toBe(3);
  });
});

describe("accountInitials", () => {
  it("takes two characters of the local part", () => {
    expect(accountInitials("ada.lovelace@work.example")).toBe("AD");
    expect(accountInitials("x@work.example")).toBe("X");
    expect(accountInitials("._@work.example")).toBe("?");
    expect(accountInitials(undefined)).toBe("?");
  });
});

describe("isOAuthFlowPendingError", () => {
  it("recognises the desktop shell's rejection, also through IPC wrapping", () => {
    expect(isOAuthFlowPendingError(new Error("Clerk: an OAuth flow is already pending."))).toBe(
      true,
    );
    expect(
      isOAuthFlowPendingError(
        new Error(
          "Error invoking remote method 'clerk:oauth:start': Error: Clerk: an OAuth flow is already pending.",
        ),
      ),
    ).toBe(true);
    expect(isOAuthFlowPendingError({ message: "Clerk: an OAuth flow is already pending." })).toBe(
      true,
    );
  });

  it("ignores everything else", () => {
    expect(isOAuthFlowPendingError(new Error("Clerk: OAuth flow was cancelled."))).toBe(false);
    expect(isOAuthFlowPendingError(null)).toBe(false);
    expect(isOAuthFlowPendingError(undefined)).toBe(false);
  });
});

describe("unexpectedSignInToReject", () => {
  const pending = {
    expectedAccountId: "account-x",
    knownAccountIds: ["account-a", "account-x"],
    gate: { available: false, reason: "account-limit" },
  } as const;
  const after = {
    knownAccountIds: ["account-a", "account-x", "account-new"],
    needsSignIn: ["account-x"],
  };

  it("rejects somebody new who signed in past a closed gate", () => {
    expect(unexpectedSignInToReject({ pending, ...after })).toEqual({
      accountId: "account-new",
      reason: expect.stringContaining("Sign out of one"),
    });
  });

  it("lets the expected account back in, and a new one through an open gate", () => {
    expect(
      unexpectedSignInToReject({
        pending,
        knownAccountIds: pending.knownAccountIds,
        needsSignIn: [],
      }),
    ).toBeNull();
    expect(
      unexpectedSignInToReject({ pending: { ...pending, gate: { available: true } }, ...after }),
    ).toBeNull();
  });
});
