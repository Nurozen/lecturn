import { managedRelaySessionAtom } from "@lecturn/client-runtime/relay";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  activateCloudRelayAccount,
  CloudAuthProvider,
  deactivateCloudRelayAccount,
} from "./CloudAuthProvider";
import { resolveCloudPublicConfig } from "./publicConfig";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

interface FakeSession {
  readonly id: string;
  readonly status: "active";
  readonly createdAt: Date;
  readonly user: { readonly id: string };
}

const clerk = vi.hoisted(() => ({
  // undefined while Clerk is between states, as clerk-js reports it.
  session: null as FakeSession | null | undefined,
  client: { signedInSessions: [] as FakeSession[] },
  setActive: vi.fn(),
  signOut: vi.fn(),
}));
const removeRelayEnvironments = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());

vi.mock("@clerk/expo", () => ({
  ClerkProvider: (props: { readonly children: ReactNode }) => props.children,
  useAuth: () => ({
    isLoaded: clerk.session !== undefined,
    isSignedIn: clerk.session === undefined ? undefined : clerk.session !== null,
    userId: clerk.session?.user.id ?? null,
    sessionId: clerk.session?.id ?? null,
  }),
  useClerk: () => clerk,
  useSessionList: () => ({ sessions: clerk.client.signedInSessions }),
}));

vi.mock("react-native", () => ({
  Alert: { alert },
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => removeRelayEnvironments,
}));

vi.mock("./useSessionRelayToken", () => ({
  useSessionRelayToken: () => sessionTokenProvider,
}));

vi.mock("./connectOnboarding", () => ({
  clearConnectOnboardingRequest: vi.fn(),
  requestConnectOnboarding: vi.fn(),
}));

const sessionTokenProvider = async () => "session-token";

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(async () => Exit.void),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./MultiAccountCloudAuthBridge", () => ({
  MultiAccountCloudAuthBridge: (props: { readonly children: ReactNode }) => props.children,
}));
vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: vi.fn(async () => undefined),
}));

vi.mock("./publicConfig", () => ({
  connectMultiAccount: false,
  resolveCloudPublicConfig: vi.fn(() => ({
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  resolveRelayClerkTokenOptions: vi.fn(),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  releaseAgentAwarenessRelayTokenProvider: vi.fn(),
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("clears relay and agent-awareness credentials before cleanup can fail", async () => {
    const tokenProvider = async () => "account-1-token";
    activateCloudRelayAccount("account-1", tokenProvider);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    await cleanup;
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
  let root: Root;

  // Commits the current fake Clerk state, then lets queued transitions finish.
  const render = async () => {
    await act(async () => {
      root.render(createElement(CloudAuthProvider, null));
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
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(resolveCloudPublicConfig).mockReturnValue({
      clerk: { publishableKey: "pk_test_example", jwtTemplate: "relay" },
      relay: { url: "https://relay.example.test" },
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
    removeRelayEnvironments.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    alert.mockReset();
    appStateListeners.clear();
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

  it("rejects a second account once while native sync flips the active session", async () => {
    await observe([sessionA], sessionA);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");

    let finishSetActive = () => {};
    clerk.setActive.mockImplementation(
      () => new Promise<void>((resolve) => (finishSetActive = resolve)),
    );
    await observe([sessionA, sessionB], sessionB);
    await observe([sessionA, sessionB], null);
    await observe([sessionA, sessionB], sessionA);
    await observe([sessionA, sessionB], sessionB);
    expect(clerk.setActive).toHaveBeenCalledExactlyOnceWith({ session: "session-a" });

    clerk.session = sessionA;
    finishSetActive();
    await render();
    await observe([sessionA], sessionA);

    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-b" });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
  });

  it("still cleans up when the served account really signs out and another signs in", async () => {
    await observe([sessionA], sessionA);
    await observe([sessionB], sessionB);

    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith("account-a");
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

    // B appears with A still active, then becomes active while it is being
    // signed out, so clerk-js leaves no active session.
    await observe([sessionA, sessionB], sessionA);
    await observe([sessionA, sessionB], sessionB);
    releaseSignOut();
    await render();
    await render();

    expect(clerk.session).toBe(sessionA);
    expect(clerk.client.signedInSessions).toEqual([sessionA]);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("retries a failed reactivation and only then says the account was signed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await observe([sessionA], sessionA);
      const setActive = clerk.setActive.getMockImplementation()!;
      clerk.setActive.mockRejectedValueOnce(new Error("offline")).mockImplementation(setActive);

      await observe([sessionA, sessionB], sessionB);
      expect(alert).not.toHaveBeenCalled();
      expect(clerk.signOut).not.toHaveBeenCalled();

      await act(async () => {
        vi.runAllTimers();
      });
      await render();
      await render();

      expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-b" });
      expect(alert).toHaveBeenCalledTimes(1);
      expect(removeRelayEnvironments).not.toHaveBeenCalled();
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it("behaves as it did before the guard while there is never a second session", async () => {
    await observe([sessionA], sessionA);
    await observe([sessionA], undefined);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    await observe([sessionA], sessionA);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();

    await observe([], undefined);
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    await observe([], null);
    expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith("account-a");
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();

    await observe([sessionB], undefined);
    await observe([sessionB], sessionB);
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
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
      expect(removeRelayEnvironments).toHaveBeenCalledExactlyOnceWith("account-a");
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rides out being offline and recovers when the app returns to the foreground", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await observe([sessionA], sessionA);
      const setActive = clerk.setActive.getMockImplementation()!;
      clerk.setActive.mockRejectedValue(new TypeError("Network request failed"));
      await observe([sessionA, sessionB], sessionB);
      for (let retry = 0; retry < 6; retry += 1) {
        await act(async () => {
          vi.runOnlyPendingTimers();
        });
        await render();
      }
      expect(clerk.setActive.mock.calls.length).toBeGreaterThan(3);
      expect(alert).not.toHaveBeenCalled();

      clerk.setActive.mockImplementation(setActive);
      await act(async () => {
        for (const listener of appStateListeners) listener("active");
      });
      await render();
      await render();

      expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-b" });
      expect(alert).toHaveBeenCalledTimes(1);
      expect(removeRelayEnvironments).not.toHaveBeenCalled();
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-a");
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });
});
