import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";
import {
  CONNECT_ONBOARDING_REQUEST_MAX_AGE_MS,
  pendingOnboardingRequests,
} from "./connectOnboarding";
import {
  clearConnectSignOutStarted,
  KnownAccountsDocument,
  forgetKnownAccount,
  KNOWN_ACCOUNTS_STORAGE_KEY,
  knownAccountRemovalsAtom,
  knownConnectAccountsAtom,
  markConnectSignOutStarted,
  newlyKnownAccounts,
  observeClerkSessions,
  reconcileKnownAccounts,
  removeSignedOutKnownAccount,
  SIGN_OUT_MARK_MAX_AGE_MS,
} from "./knownAccounts";

const active = (accountId: string, sessionId = `session-${accountId}`) => ({
  accountId,
  sessionId,
});
const unsynced = { accountIds: [], needsSignIn: [], synced: false };

describe("reconcileKnownAccounts", () => {
  it("adds signed-in accounts in the order they appeared", () => {
    expect(
      reconcileKnownAccounts({
        known: ["account-a"],
        signedIn: ["account-b", "account-a"],
        signingOut: [],
      }),
    ).toEqual({ known: ["account-a", "account-b"], leaving: [] });
  });

  it("keeps an account whose session is gone without a sign-out", () => {
    expect(
      reconcileKnownAccounts({
        known: ["account-a", "account-b"],
        signedIn: ["account-a"],
        signingOut: [],
      }),
    ).toEqual({ known: ["account-a", "account-b"], leaving: [] });
  });

  it("lets a sign-out started in Lecturn leave only once its session is gone", () => {
    const input = { known: ["account-a", "account-b"], signingOut: ["account-b"] };
    expect(
      reconcileKnownAccounts({ ...input, signedIn: ["account-a", "account-b"] }).leaving,
    ).toEqual([]);
    expect(reconcileKnownAccounts({ ...input, signedIn: ["account-a"] }).leaving).toEqual([
      "account-b",
    ]);
  });
});

describe("known-account store", () => {
  let registry: AtomRegistry.AtomRegistry;
  const restart = () => {
    registry = AtomRegistry.make();
    registry.set(knownConnectAccountsAtom, unsynced);
  };
  const storedDocument = () =>
    getLocalStorageItem(KNOWN_ACCOUNTS_STORAGE_KEY, KnownAccountsDocument);
  // A restart loses what the page held in memory, which the storage copy outlives.
  const restartKeepingStorage = () => {
    const persisted = storedDocument();
    clearConnectSignOutStarted(["session-account-a", "session-account-b", "session-a2"]);
    if (persisted !== null) {
      setLocalStorageItem(KNOWN_ACCOUNTS_STORAGE_KEY, persisted, KnownAccountsDocument);
    }
    restart();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    removeLocalStorageItem(KNOWN_ACCOUNTS_STORAGE_KEY);
    clearConnectSignOutStarted(["session-account-a", "session-account-b", "session-a2"]);
    restart();
    forgetKnownAccount(registry, "account-a");
    forgetKnownAccount(registry, "account-b");
    removeLocalStorageItem(KNOWN_ACCOUNTS_STORAGE_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("remembers an expired account across a restart", () => {
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    restart();

    expect(observeClerkSessions(registry, [active("account-b")])).toEqual({
      known: ["account-a", "account-b"],
      leaving: [],
    });
    expect(registry.get(knownConnectAccountsAtom)).toEqual({
      accountIds: ["account-a", "account-b"],
      needsSignIn: ["account-a"],
      synced: true,
    });
  });

  it("lets an account that needs sign-in be signed out, and asks for an observation", () => {
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    observeClerkSessions(registry, [active("account-b")]);
    const asked = vi.fn();
    const unsubscribe = registry.subscribe(knownAccountRemovalsAtom, asked);

    removeSignedOutKnownAccount(registry, "account-a");

    expect(asked).toHaveBeenCalled();
    expect(observeClerkSessions(registry, [active("account-b")]).leaving).toEqual(["account-a"]);
    // Signing in again before the cleanup ran keeps the account.
    expect(
      observeClerkSessions(registry, [active("account-a", "session-a2"), active("account-b")])
        .leaving,
    ).toEqual([]);
    unsubscribe();
  });

  it("keeps a needs-sign-in account leaving across a reload", () => {
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    observeClerkSessions(registry, [active("account-b")]);
    removeSignedOutKnownAccount(registry, "account-a");
    restartKeepingStorage();

    expect(observeClerkSessions(registry, [active("account-b")]).leaving).toEqual(["account-a"]);
    forgetKnownAccount(registry, "account-a");
    expect(storedDocument()).toEqual({ accountIds: ["account-b"], signingOut: [] });
  });

  it("finishes after a restart a sign-out that was started before it", () => {
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    markConnectSignOutStarted([active("account-b")]);
    restartKeepingStorage();

    expect(observeClerkSessions(registry, [active("account-a")]).leaving).toEqual(["account-b"]);
    forgetKnownAccount(registry, "account-b");
    restart();
    expect(observeClerkSessions(registry, [active("account-a")])).toEqual({
      known: ["account-a"],
      leaving: [],
    });
    expect(storedDocument()).toEqual({ accountIds: ["account-a"], signingOut: [] });
  });

  it("drops a mark on restart when the sign-out never reached Clerk", () => {
    observeClerkSessions(registry, [active("account-a")]);
    markConnectSignOutStarted([active("account-a")]);
    restartKeepingStorage();

    observeClerkSessions(registry, [active("account-a")]);
    expect(observeClerkSessions(registry, []).leaving).toEqual([]);
  });

  it("forgets a failed sign-out", () => {
    observeClerkSessions(registry, [active("account-a")]);
    markConnectSignOutStarted([active("account-a")]);
    clearConnectSignOutStarted(["session-account-a"]);

    expect(observeClerkSessions(registry, []).leaving).toEqual([]);
  });

  it("drops a mark once its account is signed in under another session", () => {
    observeClerkSessions(registry, [active("account-a")]);
    markConnectSignOutStarted([active("account-a")]);
    // The sign-out went through, its cleanup did not, and the user signed in again.
    observeClerkSessions(registry, [active("account-a", "session-a2")]);

    expect(storedDocument()?.signingOut).toEqual([]);
    expect(observeClerkSessions(registry, []).leaving).toEqual([]);
  });

  it("keeps an account signed in through a second session when the first is signed out", () => {
    const both = [active("account-a"), active("account-a", "session-a2")];
    expect(observeClerkSessions(registry, both).known).toEqual(["account-a"]);
    markConnectSignOutStarted([active("account-a")]);

    expect(observeClerkSessions(registry, [both[1]!]).leaving).toEqual([]);
    expect(observeClerkSessions(registry, []).leaving).toEqual([]);
  });

  it("lets a mark lapse, and keeps an account leaving once its sign-out was seen", () => {
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    markConnectSignOutStarted([active("account-a"), active("account-b")]);
    // A's sign-out is seen in time. B's never reached Clerk, and B expires later.
    expect(observeClerkSessions(registry, [active("account-b")]).leaving).toEqual(["account-a"]);
    vi.setSystemTime(Date.now() + SIGN_OUT_MARK_MAX_AGE_MS);

    expect(observeClerkSessions(registry, []).leaving).toEqual(["account-a"]);
    expect(storedDocument()?.signingOut).toEqual([]);
  });

  it("keeps another tab's fresh mark when this tab writes its accounts", () => {
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    // Another tab marks B between this tab's reads.
    const document = storedDocument()!;
    setLocalStorageItem(
      KNOWN_ACCOUNTS_STORAGE_KEY,
      {
        ...document,
        signingOut: [{ ...active("account-b"), startedAt: Date.now() }],
      },
      KnownAccountsDocument,
    );
    markConnectSignOutStarted([active("account-a")]);
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);

    expect(storedDocument()?.signingOut?.map((mark) => mark.accountId)).toEqual([
      "account-b",
      "account-a",
    ]);
    expect(observeClerkSessions(registry, [active("account-a")]).leaving).toEqual(["account-b"]);
  });

  it("follows another tab that finished signing an account out", () => {
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    const otherTab = AtomRegistry.make();
    otherTab.set(knownConnectAccountsAtom, {
      accountIds: ["account-a", "account-b"],
      needsSignIn: [],
      synced: true,
    });
    forgetKnownAccount(otherTab, "account-b");

    expect(observeClerkSessions(registry, [active("account-a")]).leaving).toEqual(["account-b"]);
  });

  it("reads a document rewritten as only an empty account list", () => {
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    setLocalStorageItem(
      KNOWN_ACCOUNTS_STORAGE_KEY,
      { accountIds: [] },
      Schema.Struct({ accountIds: Schema.Array(Schema.String) }),
    );

    // The signed-in account is known again. The expired one was dropped elsewhere.
    expect(observeClerkSessions(registry, [active("account-a")])).toEqual({
      known: ["account-a", "account-b"],
      leaving: ["account-b"],
    });
    expect(storedDocument()).toEqual({ accountIds: ["account-a", "account-b"], signingOut: [] });
  });
});

describe("newlyKnownAccounts, the Connect onboarding trigger", () => {
  it("does not fire when the active account flips, and fires once for a new account", () => {
    const registry = AtomRegistry.make();
    registry.set(knownConnectAccountsAtom, unsynced);
    removeLocalStorageItem(KNOWN_ACCOUNTS_STORAGE_KEY);
    const fired: string[] = [];
    let previous = registry.get(knownConnectAccountsAtom);
    const unsubscribe = registry.subscribe(knownConnectAccountsAtom, (next) => {
      fired.push(...newlyKnownAccounts(previous, next));
      previous = next;
    });

    observeClerkSessions(registry, [active("account-a")]);
    expect(fired).toEqual([]);
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    // Clerk reorders nothing on a flip: the same sessions are observed again.
    observeClerkSessions(registry, [active("account-b"), active("account-a")]);
    observeClerkSessions(registry, [active("account-b")]);
    observeClerkSessions(registry, [active("account-a"), active("account-b")]);
    unsubscribe();

    expect(fired).toEqual(["account-b"]);
  });

  it("ignores sessions restored on a cold load", () => {
    expect(
      newlyKnownAccounts(unsynced, { accountIds: ["account-a"], needsSignIn: [], synced: true }),
    ).toEqual([]);
  });

  it("reports an account that joins, and not one that leaves", () => {
    const before = { accountIds: ["account-a"], needsSignIn: [], synced: true };
    expect(
      newlyKnownAccounts(before, { ...before, accountIds: ["account-a", "account-b"] }),
    ).toEqual(["account-b"]);
    expect(newlyKnownAccounts(before, { ...before, accountIds: [] })).toEqual([]);
  });
});

describe("pendingOnboardingRequests", () => {
  const base = { knownAccountIds: ["account-a", "account-b", "account-c"], optOutAccounts: [] };

  it("queues two accounts that were added together", () => {
    expect(
      pendingOnboardingRequests({
        ...base,
        requests: [],
        added: ["account-b", "account-c"],
        now: 1_000,
      }).map((request) => request.accountId),
    ).toEqual(["account-b", "account-c"]);
  });

  it("drops a request that lapsed, opted out, or whose account is gone", () => {
    const requests = ["account-a", "account-b", "account-c"].map((accountId) => ({
      accountId,
      requestedAt: 1_000,
    }));
    const pending = (input: Partial<Parameters<typeof pendingOnboardingRequests>[0]>) =>
      pendingOnboardingRequests({ ...base, requests, added: [], now: 2_000, ...input }).map(
        (request) => request.accountId,
      );

    expect(pending({})).toEqual(["account-a", "account-b", "account-c"]);
    expect(pending({ optOutAccounts: ["account-a"], knownAccountIds: ["account-a"] })).toEqual([]);
    expect(pending({ now: 1_000 + CONNECT_ONBOARDING_REQUEST_MAX_AGE_MS })).toEqual([]);
  });
});
