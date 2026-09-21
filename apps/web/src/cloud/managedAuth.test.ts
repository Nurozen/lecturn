import {
  MULTI_ACCOUNT_ENABLED_MARKER_KEY,
  MULTI_ACCOUNT_MARKER_MAX_AGE_MS,
  isMultiAccountMarkerFresh,
  managedRelaySessionAtom,
  managedRelaySessionsAtom,
} from "@lecturn/client-runtime/relay";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readToken } from "./accountTokens";
import {
  forgetKnownAccount,
  KNOWN_ACCOUNTS_STORAGE_KEY,
  knownConnectAccountsAtom,
  markConnectSignOutStarted,
} from "./knownAccounts";
import { ManagedRelayAuthProvider } from "./managedAuth";
import {
  openConnectSignIn,
  readLastConnectAccountId,
  setConnectSignOutRequest,
} from "./singleAccountGuard";

interface FakeSession {
  readonly id: string;
  readonly status: "active";
  readonly createdAt: Date;
  readonly user: { readonly id: string };
  readonly getToken: (options: { readonly template: string }) => Promise<string>;
}

const clerk = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    // undefined while Clerk is between states, as clerk-js reports it.
    session: null as FakeSession | null | undefined,
    client: {
      sessions: [] as FakeSession[],
      get signedInSessions() {
        return this.sessions.filter((session) => session.status === "active");
      },
    },
    setActive: vi.fn(),
    signOut: vi.fn(),
    listeners,
    addListener: (listener: () => void) => {
      listeners.add(listener);
      listener();
      return () => void listeners.delete(listener);
    },
  };
});
// When set, the hooks keep rendering this session while Clerk has moved on.
const rendered = vi.hoisted(() => ({ stale: null as FakeSession | null }));
const removeRelayEnvironments = vi.hoisted(() => vi.fn());
const resetRelayTokenCache = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => ({ connectMultiAccount: false }));
const toastAdd = vi.hoisted(() => vi.fn());
const toastClose = vi.hoisted(() => vi.fn());
// Stubbed before any module loads, so the stores under test bind to this
// storage as they bind to the browser's, and not to their in-memory fallback.
const sharedStorage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
  vi.stubGlobal("window", { localStorage });
  return { entries, localStorage };
});

vi.mock("@clerk/react", () => ({
  useAuth: () => {
    const session = rendered.stale ?? clerk.session;
    return {
      isLoaded: session !== undefined,
      isSignedIn: session === undefined ? undefined : session !== null,
      userId: session?.user.id ?? null,
    };
  },
  useClerk: () => clerk,
  useSessionList: () => ({ sessions: clerk.client.sessions }),
}));

vi.mock("./relayTokenCache", () => ({ resetRelayTokenCache }));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => removeRelayEnvironments,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: toastAdd, close: toastClose },
}));

// The dialog needs a real DOM. Tests register their own sign-out flow instead.
vi.mock("../components/clerk/useConnectSignOut", () => ({ ConnectSignOutHost: () => null }));

vi.mock("./publicConfig", () => ({
  get connectMultiAccount() {
    return config.connectMultiAccount;
  },
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

function relayToken(name: string) {
  const payload = Buffer.from(JSON.stringify({ sub: `account-${name}` })).toString("base64url");
  return `header.${payload}.signature`;
}

function fakeSession(name: string, createdAt: number, id = `session-${name}`): FakeSession {
  return {
    id,
    status: "active",
    createdAt: new Date(createdAt),
    user: { id: `account-${name}` },
    getToken: vi.fn(async () => relayToken(name)),
  };
}

const mark = (...sessions: FakeSession[]) =>
  markConnectSignOutStarted(
    sessions.map((session) => ({ accountId: session.user.id, sessionId: session.id })),
  );

const relayAccountIds = () => [...appAtomRegistry.get(managedRelaySessionsAtom).keys()];
const knownAccountIds = () => appAtomRegistry.get(knownConnectAccountsAtom).accountIds;

describe("single-account guard in front of account transitions", () => {
  const sessionA = fakeSession("a", 1_000);
  const sessionB = fakeSession("b", 2_000);
  const sessionC = fakeSession("c", 3_000);
  const windowListeners = new Map<string, () => void>();
  let root: Root;

  // Commits the current fake Clerk state, then lets queued transitions finish.
  const render = async () => {
    await act(async () => {
      root.render(createElement(ManagedRelayAuthProvider, null));
    });
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  };
  const observe = async (sessions: FakeSession[], active: FakeSession | null | undefined) => {
    clerk.client.sessions = sessions;
    clerk.session = active;
    await render();
  };

  beforeEach(() => {
    // The provider renders no host nodes, but ReactDOM still needs an event target.
    const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", {
      document,
      HTMLIFrameElement: EventTarget,
      localStorage: sharedStorage.localStorage,
      addEventListener: (type: string, listener: () => void) => windowListeners.set(type, listener),
      removeEventListener: (type: string) => windowListeners.delete(type),
    });
    windowListeners.clear();
    for (const session of [sessionA, sessionB, sessionC]) {
      vi.mocked(session.getToken).mockClear();
    }
    clerk.listeners.clear();
    rendered.stale = null;
    setConnectSignOutRequest(null);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    config.connectMultiAccount = false;
    // Forgetting also drops what the store keeps in memory for the page.
    for (const accountId of ["account-a", "account-b", "account-c"]) {
      forgetKnownAccount(appAtomRegistry, accountId);
    }
    sharedStorage.entries.clear();
    appAtomRegistry.set(knownConnectAccountsAtom, {
      accountIds: [],
      needsSignIn: [],
      synced: false,
    });
    removeRelayEnvironments.mockReset().mockResolvedValue(AsyncResult.success([]));
    resetRelayTokenCache.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    toastAdd.mockReset().mockReturnValue("toast");
    toastClose.mockReset();
    clerk.setActive.mockReset().mockImplementation(async ({ session }: { session: string }) => {
      clerk.session = clerk.client.signedInSessions.find((entry) => entry.id === session) ?? null;
    });
    // Mirrors clerk-js: signing out the current session leaves none active.
    clerk.signOut.mockReset().mockImplementation(async (options?: { sessionId: string }) => {
      clerk.client.sessions = clerk.client.signedInSessions.filter(
        (entry) => options !== undefined && entry.id !== options.sessionId,
      );
      if (options === undefined || clerk.session?.id === options.sessionId) {
        clerk.session = null;
      }
    });
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("rejects a second account without removing the first account's environments", async () => {
    await observe([sessionA], sessionA);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");

    // B signs in through Clerk's UI and becomes the active session. Clerk
    // takes a while to switch back, and passes through other states meanwhile.
    let finishSetActive = () => {};
    clerk.setActive.mockImplementation(
      () => new Promise<void>((resolve) => (finishSetActive = resolve)),
    );
    await observe([sessionA, sessionB], sessionB);
    await observe([sessionA, sessionB], null);
    await observe([sessionA, sessionB], sessionB);
    expect(clerk.setActive).toHaveBeenCalledExactlyOnceWith({ session: "session-a" });
    expect(clerk.signOut).not.toHaveBeenCalled();

    clerk.session = sessionA;
    finishSetActive();
    await render();
    await observe([sessionA], sessionA);

    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-b" });
    expect(toastAdd).toHaveBeenCalledTimes(1);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    expect(await readToken("account-a")).toBe(relayToken("a"));
  });

  it("reads the served account's token from its own session while another is active", async () => {
    await observe([sessionA], sessionA);
    clerk.setActive.mockImplementation(async () => undefined);
    clerk.signOut.mockImplementation(async () => undefined);
    await observe([sessionA, sessionB], sessionB);

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    expect(await readToken("account-a")).toBe(relayToken("a"));
    expect(sessionA.getToken).toHaveBeenCalledExactlyOnceWith({ template: "relay" });
    expect(sessionB.getToken).not.toHaveBeenCalled();
  });

  it("still cleans up when the served account really signs out and another signs in", async () => {
    await observe([sessionA], sessionA);
    mark(sessionA);
    await observe([sessionB], sessionB);

    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(knownAccountIds()).toEqual(["account-b"]);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
  });

  it("keeps the first account when Clerk activates the second one mid sign-out", async () => {
    await observe([sessionA], sessionA);
    const signOut = clerk.signOut.getMockImplementation()!;
    let releaseSignOut = () => {};
    const signOutReleased = new Promise<void>((resolve) => (releaseSignOut = resolve));
    clerk.signOut.mockImplementationOnce(async (options) => {
      await signOutReleased;
      return signOut(options);
    });

    // Clerk adds an account in two steps: B appears with A still active, then
    // B becomes active. The second step lands while B is being signed out, so
    // clerk-js takes the current-session path and leaves no active session.
    await observe([sessionA, sessionB], sessionA);
    await observe([sessionA, sessionB], sessionB);
    releaseSignOut();
    await render();
    await render();

    expect(clerk.session).toBe(sessionA);
    expect(clerk.client.signedInSessions).toEqual([sessionA]);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(readLastConnectAccountId()).toBe("account-a");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    expect(toastAdd).toHaveBeenCalledTimes(1);
  });

  it("keeps the active account on a first run that already has two sessions", async () => {
    await observe([sessionA, sessionB], sessionB);
    await render();

    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-a" });
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
  });

  it("stands down for a fresh multi-account marker and ignores a stale one", async () => {
    await observe([sessionA], sessionA);
    sharedStorage.entries.set(
      MULTI_ACCOUNT_ENABLED_MARKER_KEY,
      String(Date.now() - MULTI_ACCOUNT_MARKER_MAX_AGE_MS + 60_000),
    );
    await observe([sessionA, sessionB], sessionB);
    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ actionProps: expect.objectContaining({ children: "Reload" }) }),
    );

    sharedStorage.entries.set(
      MULTI_ACCOUNT_ENABLED_MARKER_KEY,
      String(Date.now() - MULTI_ACCOUNT_MARKER_MAX_AGE_MS),
    );
    // The guard looks again on Clerk's next change, not on a bare re-render.
    await observe([sessionA, sessionB], sessionA);
    await render();
    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-b" });
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
  });

  it("cleans up and rewrites the served account on a real sign-out then sign-in", async () => {
    await observe([sessionA], sessionA);
    expect(readLastConnectAccountId()).toBe("account-a");

    mark(sessionA);
    await observe([], null);
    expect(readLastConnectAccountId()).toBeNull();
    // The last known account takes the untagged relay environments with it.
    expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(resetRelayTokenCache).toHaveBeenCalledExactlyOnceWith(undefined);

    await observe([sessionB], sessionB);
    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(readLastConnectAccountId()).toBe("account-b");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
  });

  it("behaves as it did before the guard while there is never a second session", async () => {
    await observe([sessionA], sessionA);
    await observe([sessionA], undefined);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    await observe([sessionA], sessionA);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(await readToken("account-a")).toBe(relayToken("a"));

    mark(sessionA);
    await observe([], undefined);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    await observe([], null);
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();

    await observe([sessionB], undefined);
    await observe([sessionB], sessionB);
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(toastAdd).not.toHaveBeenCalled();
  });

  // What the next account could see at the moment the previous one's data went.
  const recordSweep = () => {
    const seen: Array<{ known: ReadonlyArray<string>; relay: ReadonlyArray<string> }> = [];
    removeRelayEnvironments.mockImplementation(async () => {
      seen.push({ known: knownAccountIds(), relay: relayAccountIds() });
      return AsyncResult.success([]);
    });
    return seen;
  };

  it("keeps an expired account's data until another account is served, then sweeps it first", async () => {
    await observe([sessionA], sessionA);
    await observe([], null);
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(knownAccountIds()).toEqual(["account-a"]);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();

    const sweep = recordSweep();
    await observe([sessionB], sessionB);
    // Everything relay goes, untagged included, before B is known or connected.
    expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(resetRelayTokenCache).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(sweep).toEqual([{ known: ["account-a"], relay: [] }]);
    expect(knownAccountIds()).toEqual(["account-b"]);
    expect(relayAccountIds()).toEqual(["account-b"]);
  });

  it("gives the same account its data back when it signs in again after expiring", async () => {
    await observe([sessionA], sessionA);
    await observe([], null);
    await observe([fakeSession("a", 4_000, "session-a2")], fakeSession("a", 4_000, "session-a2"));

    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(resetRelayTokenCache).not.toHaveBeenCalled();
    expect(relayAccountIds()).toEqual(["account-a"]);
  });

  it("sweeps a stored account on a cold start as somebody else", async () => {
    sharedStorage.entries.set(
      KNOWN_ACCOUNTS_STORAGE_KEY,
      JSON.stringify({ accountIds: ["account-a"] }),
    );
    const sweep = recordSweep();
    await observe([sessionB], sessionB);

    expect(sweep).toEqual([{ known: ["account-a"], relay: [] }]);
    expect(knownAccountIds()).toEqual(["account-b"]);
    expect(relayAccountIds()).toEqual(["account-b"]);
  });

  it("sweeps the last served account on a cold start that has no account list yet", async () => {
    sharedStorage.entries.set("lecturn:last-connect-account-id", JSON.stringify("account-a"));
    const sweep = recordSweep();
    await observe([], null);
    expect(sweep).toEqual([]);

    await observe([sessionB], sessionB);
    expect(sweep).toEqual([{ known: ["account-a"], relay: [] }]);
    expect(relayAccountIds()).toEqual(["account-b"]);
  });

  it("removes nothing on a cold start that is signed out with a catalog present", async () => {
    await observe([], null);
    await observe([sessionB], sessionB);

    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(resetRelayTokenCache).not.toHaveBeenCalled();
    expect(relayAccountIds()).toEqual(["account-b"]);
  });

  it("serves the extra account once the served one has expired, after sweeping it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await observe([sessionA], sessionA);
      clerk.setActive.mockRejectedValue(new Error("session expired"));
      await observe([sessionA, sessionB], sessionB);
      expect(removeRelayEnvironments).not.toHaveBeenCalled();

      const sweep = recordSweep();
      await observe([sessionB], sessionB);
      expect(clerk.signOut).not.toHaveBeenCalled();
      expect(sweep).toEqual([{ known: ["account-a"], relay: [] }]);
      expect(readLastConnectAccountId()).toBe("account-b");
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps the served account when another tab removes the extra one mid-rejection", async () => {
    await observe([sessionA], sessionA);
    clerk.signOut.mockImplementation(async () => {
      // clerk-js ends every session once only one is left, whatever id it is given.
      clerk.client.sessions = [];
      clerk.session = null;
    });
    let finishSetActive = () => {};
    clerk.setActive.mockImplementation(
      () => new Promise<void>((resolve) => (finishSetActive = resolve)),
    );
    await observe([sessionA, sessionB], sessionB);

    clerk.client.sessions = [sessionA];
    clerk.session = sessionA;
    finishSetActive();
    await render();
    await render();

    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
  });

  it("rides out being offline and recovers when the browser comes back online", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await observe([sessionA], sessionA);
      const setActive = clerk.setActive.getMockImplementation()!;
      clerk.setActive.mockRejectedValue(new TypeError("Failed to fetch"));
      await observe([sessionA, sessionB], sessionB);
      for (let retry = 0; retry < 6; retry += 1) {
        await act(async () => {
          vi.runOnlyPendingTimers();
        });
        await render();
      }
      expect(clerk.setActive.mock.calls.length).toBeGreaterThan(3);
      expect(toastAdd).not.toHaveBeenCalled();

      clerk.setActive.mockImplementation(setActive);
      await act(async () => {
        windowListeners.get("online")!();
      });
      await render();
      await render();

      expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-b" });
      expect(toastAdd).toHaveBeenCalledTimes(1);
      expect(removeRelayEnvironments).not.toHaveBeenCalled();
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it("offers the full sign-out through the sign-out dialog, and again when that fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const signOutRequest = vi.fn<(options: { everySession: boolean }) => Promise<void>>();
      setConnectSignOutRequest(signOutRequest);
      await observe([sessionA], sessionA);
      clerk.signOut.mockRejectedValue(new Error("refused"));
      await observe([sessionA, sessionB], sessionA);
      for (let retry = 0; retry < 3; retry += 1) {
        await act(async () => {
          vi.runOnlyPendingTimers();
        });
        await render();
      }
      expect(toastAdd).toHaveBeenCalledTimes(1);
      const press = (call: number) =>
        act(async () => {
          toastAdd.mock.calls[call]![0].actionProps.onClick();
        });

      // Desktop could not unpublish this computer, so nothing was signed out.
      signOutRequest.mockRejectedValueOnce(new Error("unpublish failed"));
      await press(0);
      await render();
      expect(signOutRequest).toHaveBeenCalledExactlyOnceWith({ everySession: true });
      expect(clerk.signOut).toHaveBeenCalledTimes(3);
      expect(toastAdd).toHaveBeenCalledTimes(2);

      signOutRequest.mockResolvedValueOnce(undefined);
      await press(1);
      expect(signOutRequest).toHaveBeenCalledTimes(2);
      expect(toastAdd).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it("lets a stood-down tab sign out through the sign-out dialog", async () => {
    const signOutRequest = vi.fn(async () => undefined);
    setConnectSignOutRequest(signOutRequest);
    await observe([sessionA], sessionA);
    sharedStorage.entries.set(MULTI_ACCOUNT_ENABLED_MARKER_KEY, String(Date.now()));
    await observe([sessionA, sessionB], sessionA);

    toastAdd.mock.calls[0]![0].data.secondaryActionProps.onClick();
    expect(signOutRequest).toHaveBeenCalledExactlyOnceWith({ everySession: false });
    expect(clerk.signOut).not.toHaveBeenCalled();
  });

  it("looks at Clerk again after a rejection even if the revision moved meanwhile", async () => {
    await observe([sessionA], sessionA);
    const setActive = clerk.setActive.getMockImplementation()!;
    let finishSetActive = () => {};
    clerk.setActive.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishSetActive = resolve)),
    );
    await observe([sessionA, sessionB], sessionB);

    // While that rejection is on the network, React is a render behind Clerk,
    // and Clerk's next emit bumps the revision from under the rejection.
    rendered.stale = sessionB;
    await observe([sessionA, sessionB, sessionC], sessionA);
    await act(async () => {
      for (const listener of clerk.listeners) listener();
    });

    rendered.stale = null;
    await act(async () => {
      finishSetActive();
      await setActive({ session: "session-a" });
    });
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(clerk.signOut.mock.calls).toEqual([
      [{ sessionId: "session-b" }],
      [{ sessionId: "session-c" }],
    ]);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
  });

  it("does not let a pending session block the sign-in prompt", () => {
    const openSignIn = vi.fn();
    openConnectSignIn({ isSignedIn: true, openSignIn }, {});
    expect(openSignIn).not.toHaveBeenCalled();

    // Clerk reports a pending session as not signed in.
    openConnectSignIn({ isSignedIn: false, openSignIn }, {});
    expect(openSignIn).toHaveBeenCalledTimes(1);
  });
  describe("with multi-account on", () => {
    beforeEach(() => {
      config.connectMultiAccount = true;
    });

    it("lets a second account join the first and follows Clerk's active user", async () => {
      await observe([sessionA], sessionA);
      const relaySessionA = appAtomRegistry.get(managedRelaySessionsAtom).get("account-a");
      await observe([sessionA, sessionB], sessionB);

      expect(relayAccountIds()).toEqual(["account-a", "account-b"]);
      // Reconnect leases hang on the session object, so A keeps its own.
      expect(appAtomRegistry.get(managedRelaySessionsAtom).get("account-a")).toBe(relaySessionA);
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
      expect(knownAccountIds()).toEqual(["account-a", "account-b"]);
      expect(await readToken("account-a")).toBe(relayToken("a"));
      expect(clerk.setActive).not.toHaveBeenCalled();
      expect(clerk.signOut).not.toHaveBeenCalled();
      expect(removeRelayEnvironments).not.toHaveBeenCalled();
      expect(toastAdd).not.toHaveBeenCalled();
      expect(
        isMultiAccountMarkerFresh(
          sharedStorage.entries.get(MULTI_ACCOUNT_ENABLED_MARKER_KEY) ?? null,
          Date.now(),
        ),
      ).toBe(true);
    });

    it("changes nothing when the active account flips within the same set", async () => {
      await observe([sessionA, sessionB], sessionB);
      const relaySessions = appAtomRegistry.get(managedRelaySessionsAtom);
      await observe([sessionA, sessionB], sessionA);

      expect(appAtomRegistry.get(managedRelaySessionsAtom)).toBe(relaySessions);
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
      expect(removeRelayEnvironments).not.toHaveBeenCalled();
      expect(resetRelayTokenCache).not.toHaveBeenCalled();
    });

    it("removes only the account whose sign-out was started in Lecturn", async () => {
      await observe([sessionA, sessionB], sessionB);
      mark(sessionB);
      await observe([sessionA], sessionA);

      expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith({ accountId: "account-b" });
      expect(resetRelayTokenCache).toHaveBeenCalledExactlyOnceWith("account-b");
      expect(relayAccountIds()).toEqual(["account-a"]);
      expect(knownAccountIds()).toEqual(["account-a"]);
    });

    it("keeps an account whose session expired, and everything it owns", async () => {
      await observe([sessionA, sessionB], sessionB);
      await observe([sessionB], sessionB);

      expect(removeRelayEnvironments).not.toHaveBeenCalled();
      expect(resetRelayTokenCache).not.toHaveBeenCalled();
      expect(relayAccountIds()).toEqual(["account-b"]);
      expect(await readToken("account-a")).toBeNull();
      // What the broker blocks A's targets on: known, synced, and not signed in.
      expect(appAtomRegistry.get(knownConnectAccountsAtom)).toEqual({
        accountIds: ["account-a", "account-b"],
        needsSignIn: ["account-a"],
        synced: true,
      });
    });

    it("keeps an expired account's data when another account then signs in", async () => {
      await observe([sessionA], sessionA);
      await observe([], null);
      await observe([sessionB], sessionB);

      expect(removeRelayEnvironments).not.toHaveBeenCalled();
      expect(resetRelayTokenCache).not.toHaveBeenCalled();
      expect(relayAccountIds()).toEqual(["account-b"]);
      expect(appAtomRegistry.get(knownConnectAccountsAtom)).toEqual({
        accountIds: ["account-a", "account-b"],
        needsSignIn: ["account-a"],
        synced: true,
      });
    });

    it("does not sweep an account that a later expiry finds with a stale mark", async () => {
      // The stand-down toast's sign-out ends one session. The other account stays.
      await observe([sessionA, sessionB], sessionB);
      mark(sessionB);
      await observe([sessionA], sessionA);
      expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith({ accountId: "account-b" });

      await observe([], null);
      expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
      expect(knownAccountIds()).toEqual(["account-a"]);
    });

    it("skips a queued cleanup whose account has signed in again", async () => {
      await observe([sessionA, sessionB], sessionB);
      let finishFirstCleanup = () => {};
      removeRelayEnvironments.mockImplementationOnce(
        () =>
          new Promise((resolve) => (finishFirstCleanup = () => resolve(AsyncResult.success([])))),
      );
      mark(sessionA, sessionB);
      await observe([], null);
      expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith({ accountId: "account-a" });

      // B is back before its turn, and React has not rendered that yet.
      clerk.client.sessions = [fakeSession("b", 5_000, "session-b2")];
      await act(async () => finishFirstCleanup());
      await render();

      expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
      expect(knownAccountIds()).toEqual(["account-b"]);
    });

    it("removes nothing when the Clerk client comes back empty", async () => {
      await observe([sessionA, sessionB], sessionB);
      await observe([], null);
      expect(relayAccountIds()).toEqual([]);

      await observe([sessionA, sessionB], sessionB);
      expect(removeRelayEnvironments).not.toHaveBeenCalled();
      expect(resetRelayTokenCache).not.toHaveBeenCalled();
      expect(knownAccountIds()).toEqual(["account-a", "account-b"]);
      expect(relayAccountIds()).toEqual(["account-a", "account-b"]);
    });

    it("removes the untagged environments too once the last account leaves", async () => {
      await observe([sessionA, sessionB], sessionB);
      mark(sessionA, sessionB);
      await observe([], null);

      expect(removeRelayEnvironments.mock.calls).toEqual([
        [{ accountId: "account-a" }],
        [undefined],
      ]);
      expect(resetRelayTokenCache.mock.calls).toEqual([["account-a"], [undefined]]);
      expect(knownAccountIds()).toEqual([]);
    });

    it("backs off a failing cleanup, says so once, and retries from the message", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await observe([sessionA], sessionA);
        // The environments go, the cached tokens do not.
        resetRelayTokenCache.mockResolvedValue(
          AsyncResult.failure(Cause.fail(new Error("Token store is read-only."))),
        );
        mark(sessionA);
        await observe([sessionB], sessionB);
        expect(resetRelayTokenCache).toHaveBeenCalledTimes(1);
        expect(relayAccountIds()).toEqual([]);
        expect(knownAccountIds()).toEqual(["account-a", "account-b"]);

        const advance = async (ms: number) => {
          await act(async () => {
            vi.advanceTimersByTime(ms);
          });
          await render();
        };
        await advance(4_999);
        expect(resetRelayTokenCache).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(resetRelayTokenCache).toHaveBeenCalledTimes(2);
        await advance(9_999);
        expect(resetRelayTokenCache).toHaveBeenCalledTimes(2);
        await advance(1);
        expect(resetRelayTokenCache).toHaveBeenCalledTimes(3);
        expect(toastAdd).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            timeout: 0,
            actionProps: expect.objectContaining({ children: "Retry" }),
          }),
        );

        resetRelayTokenCache.mockResolvedValue(AsyncResult.success(undefined));
        await act(async () => {
          toastAdd.mock.calls[0]![0].actionProps.onClick();
        });
        await render();
        expect(resetRelayTokenCache).toHaveBeenCalledTimes(4);
        expect(relayAccountIds()).toEqual(["account-b"]);
        expect(knownAccountIds()).toEqual(["account-b"]);
        expect(toastClose).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        consoleWarn.mockRestore();
        consoleError.mockRestore();
      }
    });

    it("does not activate a replacement account until a failed cleanup has succeeded", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await observe([sessionA], sessionA);
        removeRelayEnvironments.mockResolvedValue(
          AsyncResult.failure(Cause.fail(new Error("Persistence removal failed."))),
        );
        mark(sessionA);
        await observe([sessionB], sessionB);
        expect(relayAccountIds()).toEqual([]);
        expect(knownAccountIds()).toEqual(["account-a", "account-b"]);

        removeRelayEnvironments.mockResolvedValue(AsyncResult.success([]));
        await act(async () => {
          vi.runOnlyPendingTimers();
        });
        await render();
        expect(removeRelayEnvironments).toHaveBeenCalledTimes(2);
        expect(relayAccountIds()).toEqual(["account-b"]);
        expect(knownAccountIds()).toEqual(["account-b"]);
      } finally {
        vi.useRealTimers();
        consoleWarn.mockRestore();
        consoleError.mockRestore();
      }
    });
  });
});
