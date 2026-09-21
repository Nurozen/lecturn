import {
  MULTI_ACCOUNT_ENABLED_MARKER_KEY,
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
import { signedOutEnvironmentsAtom } from "./accountGone";
import { readToken } from "./accountTokens";
import {
  forgetKnownAccount,
  knownConnectAccountsAtom,
  markConnectSignOutStarted,
} from "./knownAccounts";
import { ManagedRelayAuthProvider } from "./managedAuth";
import { openConnectSignIn } from "./connectAuthCompatibility";

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
const clearEnvironmentOwnedState = vi.hoisted(() => vi.fn());
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

vi.mock("./useProfileStableAccountId", () => ({
  useProfileStableAccountId: (id: string | null | undefined) => id,
}));

vi.mock("./accountAppearance", () => ({
  initializeAccountAppearance: vi.fn(async () => {}),
  refreshAccountAppearance: vi.fn(async () => {}),
}));

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

vi.mock("../environmentOwnedState", () => ({ clearEnvironmentOwnedState }));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => removeRelayEnvironments,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: toastAdd, close: toastClose },
}));

vi.mock("../components/clerk/ConnectAccountCommandsHost", () => ({
  ConnectAccountCommandsHost: () => null,
}));

vi.mock("./publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));

vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    environmentCatalog: {
      removeRelayEnvironments: {},
      catalogValueAtom: Atom.make({
        entries: new Map([
          [
            "environment-b",
            {
              target: {
                _tag: "RelayConnectionTarget",
                environmentId: "environment-b",
                accountId: "account-b",
              },
            },
          ],
        ]),
      }),
    },
  };
});

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
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    clearEnvironmentOwnedState.mockReset();
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

  it("opens sign-in for existing and pending sessions", () => {
    const openSignIn = vi.fn();
    openConnectSignIn({ isSignedIn: true, openSignIn }, {});
    openConnectSignIn({ isSignedIn: false, openSignIn }, {});
    expect(openSignIn).toHaveBeenCalledTimes(2);
  });
  describe("multi-account lifecycle", () => {
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

    it("sweeps the view state of the environments a signed-out account owned", async () => {
      removeRelayEnvironments.mockResolvedValue(AsyncResult.success(["environment-b"]));
      await observe([sessionA, sessionB], sessionB);
      mark(sessionB);
      await observe([sessionA], sessionA);

      expect(clearEnvironmentOwnedState.mock.calls.map(([id]) => id)).toEqual(["environment-b"]);
    });

    it("records a signed-out account's environments before they are removed", async () => {
      let recordedAtRemoval: ReadonlyArray<string> = [];
      removeRelayEnvironments.mockImplementation(async () => {
        recordedAtRemoval = [...appAtomRegistry.get(signedOutEnvironmentsAtom).keys()];
        return AsyncResult.success(["environment-b"]);
      });
      await observe([sessionA, sessionB], sessionB);
      mark(sessionB);
      await observe([sessionA], sessionA);

      expect(recordedAtRemoval).toEqual(["environment-b"]);
      expect(appAtomRegistry.get(signedOutEnvironmentsAtom).get("environment-b")).toEqual({
        accountId: "account-b",
        email: null,
      });
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
