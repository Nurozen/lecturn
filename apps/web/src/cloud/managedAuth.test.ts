import {
  MULTI_ACCOUNT_ENABLED_MARKER_KEY,
  MULTI_ACCOUNT_MARKER_MAX_AGE_MS,
  managedRelaySessionAtom,
  setManagedRelaySession,
} from "@lecturn/client-runtime/relay";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
  ManagedRelayAuthProvider,
  readManagedRelayClerkToken,
} from "./managedAuth";
import {
  clearLastConnectAccountId,
  openConnectSignIn,
  readLastConnectAccountId,
  setConnectSignOutRequest,
} from "./singleAccountGuard";

interface FakeSession {
  readonly id: string;
  readonly status: "active";
  readonly createdAt: Date;
  readonly user: { readonly id: string };
}

const clerk = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    // undefined while Clerk is between states, as clerk-js reports it.
    session: null as FakeSession | null | undefined,
    client: { signedInSessions: [] as FakeSession[] },
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
const toastAdd = vi.hoisted(() => vi.fn());

vi.mock("@clerk/react", () => ({
  useAuth: () => {
    const session = rendered.stale ?? clerk.session;
    return {
      getToken: async () => `${clerk.session?.user.id}-token`,
      isLoaded: session !== undefined,
      isSignedIn: session === undefined ? undefined : session !== null,
      userId: session?.user.id ?? null,
    };
  },
  useClerk: () => clerk,
  useSessionList: () => ({ sessions: clerk.client.signedInSessions }),
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(async () => Exit.void),
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => removeRelayEnvironments,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: toastAdd, close: vi.fn() },
}));

// The dialog needs a real DOM. Tests register their own sign-out flow instead.
vi.mock("../components/clerk/useConnectSignOut", () => ({ ConnectSignOutHost: () => null }));

vi.mock("./publicConfig", () => ({
  connectMultiAccount: false,
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

afterEach(() => {
  deactivateManagedRelayAuthentication();
});

describe("managed relay authentication", () => {
  it("clears all token access synchronously before account cleanup can fail", async () => {
    activateManagedRelayAuthentication("account-1", async () => "account-1-token");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    expect(await readManagedRelayClerkToken()).toBe("account-1-token");

    deactivateManagedRelayAuthentication();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(await readManagedRelayClerkToken()).toBeNull();
    await cleanup;
  });

  it("replaces an existing account session atomically", () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-1",
      readClerkToken: async () => "account-1-token",
    });

    activateManagedRelayAuthentication("account-2", async () => "account-2-token");

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
  });
});

describe("single-account guard in front of account transitions", () => {
  const sessionA: FakeSession = {
    id: "session-a",
    status: "active",
    createdAt: new Date(1_000),
    user: { id: "account-a" },
  };
  const sessionB: FakeSession = {
    id: "session-b",
    status: "active",
    createdAt: new Date(2_000),
    user: { id: "account-b" },
  };
  const sessionC: FakeSession = {
    id: "session-c",
    status: "active",
    createdAt: new Date(3_000),
    user: { id: "account-c" },
  };
  const sharedStorage = new Map<string, string>();
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
    clerk.client.signedInSessions = sessions;
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
      localStorage: { getItem: (key: string) => sharedStorage.get(key) ?? null },
      addEventListener: (type: string, listener: () => void) => windowListeners.set(type, listener),
      removeEventListener: (type: string) => windowListeners.delete(type),
    });
    windowListeners.clear();
    clerk.listeners.clear();
    rendered.stale = null;
    setConnectSignOutRequest(null);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    sharedStorage.clear();
    clearLastConnectAccountId();
    removeRelayEnvironments.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    toastAdd.mockReset();
    clerk.setActive.mockReset().mockImplementation(async ({ session }: { session: string }) => {
      clerk.session = clerk.client.signedInSessions.find((entry) => entry.id === session) ?? null;
    });
    // Mirrors clerk-js: signing out the current session leaves none active.
    clerk.signOut.mockReset().mockImplementation(async (options?: { sessionId: string }) => {
      clerk.client.signedInSessions = clerk.client.signedInSessions.filter(
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
    expect(await readManagedRelayClerkToken()).toBe("account-a-token");
  });

  it("never hands the served account a token while another session is active", async () => {
    await observe([sessionA], sessionA);
    clerk.setActive.mockImplementation(async () => undefined);
    clerk.signOut.mockImplementation(async () => undefined);
    await observe([sessionA, sessionB], sessionB);

    expect(await readManagedRelayClerkToken()).toBeNull();
  });

  it("still cleans up when the served account really signs out and another signs in", async () => {
    await observe([sessionA], sessionA);
    await observe([sessionB], sessionB);

    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
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
    sharedStorage.set(
      MULTI_ACCOUNT_ENABLED_MARKER_KEY,
      String(Date.now() - MULTI_ACCOUNT_MARKER_MAX_AGE_MS + 60_000),
    );
    await observe([sessionA, sessionB], sessionB);
    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ actionProps: expect.objectContaining({ children: "Reload" }) }),
    );

    sharedStorage.set(
      MULTI_ACCOUNT_ENABLED_MARKER_KEY,
      String(Date.now() - MULTI_ACCOUNT_MARKER_MAX_AGE_MS),
    );
    await render();
    await render();
    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-b" });
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
  });

  it("cleans up and rewrites the served account on a real sign-out then sign-in", async () => {
    await observe([sessionA], sessionA);
    expect(readLastConnectAccountId()).toBe("account-a");

    await observe([], null);
    expect(readLastConnectAccountId()).toBeNull();
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);

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
    expect(await readManagedRelayClerkToken()).toBe("account-a-token");

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

  it("cleans up when the served account expires while the extra one is still there", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await observe([sessionA], sessionA);
      clerk.setActive.mockRejectedValue(new Error("session expired"));
      await observe([sessionA, sessionB], sessionB);
      expect(removeRelayEnvironments).not.toHaveBeenCalled();

      await observe([sessionB], sessionB);
      expect(clerk.signOut).not.toHaveBeenCalled();
      expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
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
      clerk.client.signedInSessions = [];
      clerk.session = null;
    });
    let finishSetActive = () => {};
    clerk.setActive.mockImplementation(
      () => new Promise<void>((resolve) => (finishSetActive = resolve)),
    );
    await observe([sessionA, sessionB], sessionB);

    clerk.client.signedInSessions = [sessionA];
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
    sharedStorage.set(MULTI_ACCOUNT_ENABLED_MARKER_KEY, String(Date.now()));
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
});
