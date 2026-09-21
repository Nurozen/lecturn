import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Stubbed before any module loads, so the marks bind to this storage.
const storage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
  vi.stubGlobal("window", { localStorage });
  return { entries };
});

import { KNOWN_ACCOUNTS_STORAGE_KEY } from "../../cloud/knownAccounts";
import {
  canSignOutAllAccounts,
  planConnectSignOut,
  runConnectSignOut,
  SIGN_OUT_ACCOUNT_LOADING_MESSAGE,
  SIGN_OUT_HOST_NOT_READY_MESSAGE,
  signOutDialogCopy,
  type SignOutHost,
  type SignOutSession,
} from "./useConnectSignOut.logic";

const session = (name: string, lastActiveAt: number): SignOutSession => ({
  accountId: `account-${name}`,
  sessionId: `session-${name}`,
  lastActiveAt,
});
const A = session("a", 10);
const B = session("b", 20);
const C = session("c", 30);
const mark = ({ accountId, sessionId }: SignOutSession) => ({ accountId, sessionId });
const none: SignOutHost = { _tag: "none" };
const publishedBy = (publishingAccountId: string | null): SignOutHost => ({
  _tag: "known",
  publishingAccountId,
});

type PlanInput = Parameters<typeof planConnectSignOut>[0];
const steps = (input: Omit<PlanInput, "multiAccount"> & { readonly multiAccount?: boolean }) => {
  const plan = planConnectSignOut({ multiAccount: true, ...input });
  if (plan._tag === "blocked") throw new Error("blocked");
  return plan.steps;
};

describe("planConnectSignOut", () => {
  it("signs out the only account as before", () => {
    const signOut = {
      _tag: "signOut",
      sessionId: A.sessionId,
      ending: [mark(A)],
      redirect: "signedOut",
    };
    expect(
      steps({ sessions: [A], activeSessionId: A.sessionId, targets: [A.accountId], host: none }),
    ).toEqual([signOut]);
    // A desktop host is unpublished whoever it is published under, or when that is not known yet.
    for (const host of [publishedBy(null), publishedBy("account-other"), { _tag: "unknown" }]) {
      expect(
        steps({
          sessions: [A],
          activeSessionId: A.sessionId,
          targets: [A.accountId],
          host: host as SignOutHost,
        }),
      ).toEqual([{ _tag: "unpublish", accountId: A.accountId }, signOut]);
    }
  });

  it("makes the remaining account active before it signs out the active one", () => {
    expect(
      steps({ sessions: [A, B], activeSessionId: B.sessionId, targets: [B.accountId], host: none }),
    ).toEqual([
      { _tag: "setActive", sessionId: A.sessionId },
      { _tag: "signOut", sessionId: B.sessionId, ending: [mark(B)], redirect: "stay" },
    ]);
  });

  it("prefers the most recently active remaining account", () => {
    expect(
      steps({
        sessions: [A, B, C],
        activeSessionId: C.sessionId,
        targets: [C.accountId],
        host: none,
      })[0],
    ).toEqual({ _tag: "setActive", sessionId: B.sessionId });
  });

  it("signs out a non-active account without touching the active one", () => {
    expect(
      steps({ sessions: [A, B], activeSessionId: A.sessionId, targets: [B.accountId], host: none }),
    ).toEqual([{ _tag: "signOut", sessionId: B.sessionId, ending: [mark(B)], redirect: "stay" }]);
  });

  it("unpublishes only when the publishing account leaves", () => {
    const input = { sessions: [A, B], activeSessionId: A.sessionId, targets: [B.accountId] };
    expect(steps({ ...input, host: publishedBy(B.accountId) })[0]).toEqual({
      _tag: "unpublish",
      accountId: B.accountId,
    });
    for (const host of [publishedBy(A.accountId), publishedBy(null), publishedBy("account-gone")]) {
      expect(steps({ ...input, host }).map((step) => step._tag)).toEqual(["signOut"]);
    }
  });

  it("waits for the host's link state while another account stays", () => {
    expect(
      planConnectSignOut({
        sessions: [A, B],
        activeSessionId: A.sessionId,
        targets: [B.accountId],
        host: { _tag: "unknown" },
        multiAccount: true,
      }),
    ).toEqual({ _tag: "blocked" });
  });

  it("signs out all accounts with one unpublish and Clerk's sign-out-all", () => {
    expect(
      steps({
        sessions: [A, B],
        activeSessionId: A.sessionId,
        targets: "all",
        host: publishedBy(B.accountId),
      }),
    ).toEqual([
      { _tag: "unpublish", accountId: B.accountId },
      { _tag: "signOut", sessionId: null, ending: [mark(A), mark(B)], redirect: "signedOut" },
    ]);
  });

  it("does nothing for an account that is already gone", () => {
    expect(
      steps({
        sessions: [A],
        activeSessionId: A.sessionId,
        targets: [B.accountId],
        host: publishedBy(B.accountId),
      }),
    ).toEqual([]);
  });

  it("unpublishes for a leaving account that needs sign-in and published this computer", () => {
    const input = { sessions: [A], activeSessionId: A.sessionId, sessionless: ["account-x"] };
    expect(steps({ ...input, targets: ["account-x"], host: publishedBy("account-x") })).toEqual([
      { _tag: "unpublish", accountId: "account-x" },
    ]);
    expect(steps({ ...input, targets: ["account-x"], host: publishedBy(A.accountId) })).toEqual([]);
    expect(steps({ ...input, targets: ["account-x"], host: none })).toEqual([]);
    expect(
      planConnectSignOut({
        ...input,
        targets: ["account-x"],
        host: { _tag: "unknown" },
        multiAccount: true,
      }),
    ).toEqual({ _tag: "blocked" });
    expect(
      steps({ ...input, targets: "all", host: publishedBy("account-x") }).map((step) =>
        step._tag === "unpublish" ? step.accountId : step._tag,
      ),
    ).toEqual(["account-x", "signOut"]);
  });

  it("skips the unpublish once it has happened", () => {
    expect(
      steps({
        sessions: [A],
        activeSessionId: A.sessionId,
        targets: [A.accountId],
        host: publishedBy(A.accountId),
        unpublished: true,
      }).map((step) => step._tag),
    ).toEqual(["signOut"]);
  });

  it("ends the current session and navigates in a single-account build", () => {
    // The guard's stand-down state: a newer tab added B, and this tab serves A.
    expect(
      steps({
        sessions: [A, B],
        activeSessionId: A.sessionId,
        targets: [A.accountId],
        host: publishedBy(B.accountId),
        multiAccount: false,
      }),
    ).toEqual([
      { _tag: "unpublish", accountId: A.accountId },
      { _tag: "signOut", sessionId: A.sessionId, ending: [mark(A)], redirect: "signedOut" },
    ]);
    expect(
      steps({
        sessions: [A, B],
        activeSessionId: A.sessionId,
        targets: "all",
        host: none,
        multiAccount: false,
      }),
    ).toEqual([
      { _tag: "signOut", sessionId: null, ending: [mark(A), mark(B)], redirect: "signedOut" },
    ]);
  });
});

describe("signOutDialogCopy", () => {
  const input = {
    multiAccount: true,
    knownAccountCount: 2,
    targets: ["account-a"],
    email: "a@example.com",
    localHost: true,
    unpublishes: false,
  };

  it("keeps the original copy while multi-account is off, whatever is signed in", () => {
    for (const targets of [["account-a"], "all"] as const) {
      const copy = signOutDialogCopy({ ...input, multiAccount: false, targets });
      expect(copy.title).toBe("Sign out of Lecturn?");
      expect(copy.description).toContain("will unpublish this computer");
    }
    expect(signOutDialogCopy({ ...input, multiAccount: false, localHost: false }).description).toBe(
      "This signs out this client. Your published computers will stay available to your other devices.",
    );
  });

  it("names the account only once more than one is known", () => {
    expect(signOutDialogCopy({ ...input, knownAccountCount: 1, unpublishes: true }).title).toBe(
      "Sign out of Lecturn?",
    );
    expect(signOutDialogCopy(input).title).toBe("Sign out a@example.com?");
    expect(signOutDialogCopy(input).description).toContain("stays published");
    expect(signOutDialogCopy({ ...input, targets: "all" }).title).toBe("Sign out of all accounts?");
  });
});

describe("canSignOutAllAccounts", () => {
  it("is never offered by a single-account build, even with two sessions", () => {
    const signedIn = ["account-a", "account-b"];
    expect(canSignOutAllAccounts({ multiAccount: false, signedInAccountIds: signedIn })).toBe(
      false,
    );
    expect(canSignOutAllAccounts({ multiAccount: true, signedInAccountIds: signedIn })).toBe(true);
    expect(
      canSignOutAllAccounts({ multiAccount: true, signedInAccountIds: ["account-a", "account-a"] }),
    ).toBe(false);
  });
});

interface FakeSession {
  readonly id: string;
  readonly lastActiveAt: Date;
  readonly user: { readonly id: string };
}

/** Models clerk-js: one session left ends them all, and ending the current one nulls it. */
function fakeClerk(names: ReadonlyArray<string>, active: string) {
  const clerk = {
    navigations: [] as Array<string | undefined>,
    session: null as FakeSession | null,
    client: { signedInSessions: [] as FakeSession[] },
    setActive: vi.fn(async ({ session }: { session: string }) => {
      clerk.session = clerk.client.signedInSessions.find(({ id }) => id === session) ?? null;
    }),
    signOut: vi.fn(async (options?: { sessionId?: string; redirectUrl?: string }) => {
      const sessions = clerk.client.signedInSessions;
      if (options?.sessionId === undefined || sessions.length <= 1) {
        clerk.client.signedInSessions = [];
        clerk.session = null;
        clerk.navigations.push(options?.redirectUrl);
        return;
      }
      clerk.client.signedInSessions = sessions.filter(({ id }) => id !== options.sessionId);
      if (clerk.session?.id === options.sessionId) {
        clerk.session = null;
        clerk.navigations.push(options.redirectUrl);
      }
    }),
  };
  clerk.client.signedInSessions = names.map((name, index) => ({
    id: `session-${name}`,
    lastActiveAt: new Date(index),
    user: { id: `account-${name}` },
  }));
  clerk.session = clerk.client.signedInSessions.find(({ id }) => id === `session-${active}`)!;
  return clerk;
}

const storedMarks = (): ReadonlyArray<string> => {
  const raw = storage.entries.get(KNOWN_ACCOUNTS_STORAGE_KEY);
  const marks = raw ? (JSON.parse(raw).signingOut ?? []) : [];
  return marks.map((entry: { sessionId: string }) => entry.sessionId);
};

describe("runConnectSignOut", () => {
  const run = (
    clerk: ReturnType<typeof fakeClerk>,
    input: Partial<Parameters<typeof runConnectSignOut>[0]> = {},
  ) =>
    runConnectSignOut({
      clerk,
      targets: ["account-b"],
      host: none,
      multiAccount: true,
      unpublish: async () => undefined,
      stayUrl: "https://app.test/here",
      signedOutUrl: "https://app.test/signed-out",
      ...input,
    });

  beforeEach(() => {
    // The marks need a known-account list to be written next to.
    storage.entries.set(
      KNOWN_ACCOUNTS_STORAGE_KEY,
      JSON.stringify({ accountIds: ["account-a", "account-b"] }),
    );
  });

  it("keeps A signed in and active after the active B is signed out", async () => {
    const clerk = fakeClerk(["a", "b"], "b");
    await run(clerk);
    expect(clerk.client.signedInSessions.map(({ id }) => id)).toEqual(["session-a"]);
    expect(clerk.session?.id).toBe("session-a");
    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-b",
      redirectUrl: "https://app.test/here",
    });
    expect(clerk.navigations).toEqual([]);
    expect(storedMarks()).toEqual(["session-b"]);
  });

  it("goes to the signed-out destination only when no account remains", async () => {
    const clerk = fakeClerk(["a", "b"], "a");
    await run(clerk, { targets: "all" });
    expect(clerk.client.signedInSessions).toEqual([]);
    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({
      redirectUrl: "https://app.test/signed-out",
    });
    expect(storedMarks()).toEqual(["session-a", "session-b"]);
  });

  it("unpublishes once, before any session ends, and only for the publishing account", async () => {
    const clerk = fakeClerk(["a", "b"], "b");
    const unpublish = vi.fn(async () => {
      expect(clerk.signOut).not.toHaveBeenCalled();
    });
    await run(clerk, { host: publishedBy("account-b"), unpublish });
    expect(unpublish).toHaveBeenCalledExactlyOnceWith("account-b");

    const other = fakeClerk(["a", "b"], "b");
    const unused = vi.fn(async () => undefined);
    await run(other, { host: publishedBy("account-a"), unpublish: unused });
    expect(unused).not.toHaveBeenCalled();
    expect(other.client.signedInSessions.map(({ id }) => id)).toEqual(["session-a"]);
  });

  it("signs nobody out and marks nothing when the unpublish fails", async () => {
    const clerk = fakeClerk(["a", "b"], "b");
    await expect(
      run(clerk, {
        host: publishedBy("account-b"),
        unpublish: async () => {
          throw new Error("relay down");
        },
      }),
    ).rejects.toThrow("relay down");
    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(clerk.session?.id).toBe("session-b");
    expect(storedMarks()).toEqual([]);
  });

  it("stops without marks while the host's link state is unknown", async () => {
    const clerk = fakeClerk(["a", "b"], "b");
    await expect(run(clerk, { host: { _tag: "unknown" } })).rejects.toThrow(
      SIGN_OUT_HOST_NOT_READY_MESSAGE,
    );
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(storedMarks()).toEqual([]);
  });

  it("clears the mark when Clerk's sign-out fails or leaves the session signed in", async () => {
    const failing = fakeClerk(["a", "b"], "a");
    failing.signOut.mockRejectedValueOnce(new Error("network"));
    await expect(run(failing)).rejects.toThrow("network");
    expect(storedMarks()).toEqual([]);

    const ignoring = fakeClerk(["a", "b"], "a");
    ignoring.signOut.mockResolvedValueOnce(undefined);
    await expect(run(ignoring)).rejects.toThrow("Could not complete sign out");
    expect(storedMarks()).toEqual([]);
  });

  it("never names the last session when the other account is already gone", async () => {
    const clerk = fakeClerk(["a"], "a");
    await run(clerk);
    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(clerk.session?.id).toBe("session-a");
  });

  it("removes an account that needs sign-in only after the unpublish succeeded", async () => {
    const input = {
      targets: "all" as const,
      host: publishedBy("account-x"),
      sessionless: ["account-x"],
    };
    const failed = fakeClerk(["a"], "a");
    const removeSessionless = vi.fn();
    await expect(
      run(failed, {
        ...input,
        removeSessionless,
        unpublish: async () => {
          throw new Error("relay down");
        },
      }),
    ).rejects.toThrow("relay down");
    expect(removeSessionless).not.toHaveBeenCalled();
    expect(failed.signOut).not.toHaveBeenCalled();

    const clerk = fakeClerk(["a"], "a");
    const unpublish = vi.fn(async () => expect(removeSessionless).not.toHaveBeenCalled());
    await run(clerk, { ...input, removeSessionless, unpublish });
    expect(unpublish).toHaveBeenCalledExactlyOnceWith("account-x");
    expect(removeSessionless).toHaveBeenCalledExactlyOnceWith("account-x");
    expect(clerk.client.signedInSessions).toEqual([]);
  });

  it("still unpublishes when the remaining account disappears between steps", async () => {
    const clerk = fakeClerk(["a", "b"], "b");
    // Another tab signs A out while this one makes it active.
    clerk.setActive.mockImplementationOnce(async () => {
      clerk.client.signedInSessions = clerk.client.signedInSessions.filter(
        ({ id }) => id !== "session-a",
      );
    });
    const unpublish = vi.fn(async () => undefined);
    await run(clerk, { host: publishedBy("account-a"), unpublish });
    expect(unpublish).toHaveBeenCalledExactlyOnceWith("account-b");
    expect(clerk.client.signedInSessions).toEqual([]);
  });

  it("asks for a retry on desktop when no signed-in session matches", async () => {
    const clerk = fakeClerk([], "a");
    await expect(run(clerk, { targets: "all", host: publishedBy(null) })).rejects.toThrow(
      SIGN_OUT_ACCOUNT_LOADING_MESSAGE,
    );
  });

  it("ends the current session and navigates in a single-account build", async () => {
    const clerk = fakeClerk(["a", "b"], "a");
    const unpublish = vi.fn(async () => undefined);
    await run(clerk, {
      targets: ["account-a"],
      host: publishedBy("account-b"),
      multiAccount: false,
      unpublish,
    });
    expect(unpublish).toHaveBeenCalledExactlyOnceWith("account-a");
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-a",
      redirectUrl: "https://app.test/signed-out",
    });
    expect(clerk.navigations).toEqual(["https://app.test/signed-out"]);
  });
});
