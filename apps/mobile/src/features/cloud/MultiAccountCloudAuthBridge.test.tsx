import { managedRelaySessionsAtom } from "@lecturn/client-runtime/relay";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../state/atom-registry";
import { MultiAccountCloudAuthBridge } from "./MultiAccountCloudAuthBridge";
import { knownConnectAccountsAtom, connectAccountRemovalRevisionAtom } from "./knownAccounts";
import { requestConnectOnboarding } from "./connectOnboarding";

type Session = { id: string; status: "active" | "expired" | "revoked"; user: { id: string } };
const fixtures = vi.hoisted(() => ({
  sessions: [] as Session[],
  active: null as string | null,
  remove: vi.fn(),
  pendingRemoval: new Set<string>(),
  restore: vi.fn(),
  capability: vi.fn(),
  pushSupported: true,
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, Alert: { alert: vi.fn() } }));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
    unlistedRelayEnvironmentIdsValueAtom: Atom.make(new Set()),
  },
}));
vi.mock("@clerk/expo", () => ({
  useClerk: () => clerk,
  useAuth: () => ({ isLoaded: true, userId: fixtures.active }),
  useSessionList: () => ({ sessions: fixtures.sessions }),
}));
const clerk = {
  get session() {
    return fixtures.sessions.find((session) => session.user.id === fixtures.active);
  },
  setActive: vi.fn(async ({ session: id }: { session: string }) => {
    fixtures.active = fixtures.sessions.find((session) => session.id === id)?.user.id ?? null;
  }),
  __internal_environment: { authConfig: { singleSessionMode: false } },
  client: {
    get sessions() {
      return fixtures.sessions;
    },
    get signedInSessions() {
      return fixtures.sessions.filter((session) => session.status === "active");
    },
  },
};
vi.mock("../agent-awareness/multiAccountCapability", () => ({
  useMultiAccountPushSupported: () => fixtures.pushSupported,
  getMultiAccountPushSupported: () => fixtures.pushSupported,
  refreshMultiAccountPushCapability: () => fixtures.capability(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixtures.remove }));
vi.mock("../../state/use-composer-drafts", () => ({
  restoreCloudComposerDrafts: (id: string) => fixtures.restore(id),
}));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: async () => undefined } }));
vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("./connectOnboarding", () => ({ requestConnectOnboarding: vi.fn() }));
vi.mock("./accountTokenReaders", () => ({
  bindAccountTokenClerk: vi.fn(),
  accountTokenReader: (id: string) => {
    let reader = readers.get(id);
    if (!reader) {
      reader = async () => null;
      readers.set(id, reader);
    }
    return reader;
  },
}));
const readers = new Map<string, () => Promise<null>>();
vi.mock("./accountPushRegistration", () => ({
  releaseAccountPushProviders: vi.fn(),
  syncAccountPushProviders: vi.fn(),
}));
vi.mock("./knownAccountStorage", async () => await import("./knownAccounts"));
vi.mock("./knownAccounts", async () => {
  const { reconcileMobileAccounts } = await import("./knownAccounts.logic");
  return {
    knownConnectAccountsAtom: Atom.make([]).pipe(Atom.keepAlive),
    connectAccountRemovalRevisionAtom: Atom.make(0).pipe(Atom.keepAlive),
    connectAccountsReadyAtom: Atom.make(false).pipe(Atom.keepAlive),
    reconcileMobileAccounts,
    loadKnownConnectAccounts: async () => {},
    persistKnownConnectAccounts: async () => {},
    accountsPendingRemoval: () => fixtures.pendingRemoval,
    cancelConnectAccountRemoval: async (id: string) => {
      fixtures.pendingRemoval.delete(id);
    },
    markConnectAccountRemoval: async (id: string) => {
      fixtures.pendingRemoval.add(id);
    },
    forgetConnectAccount: async (id: string) => {
      appAtomRegistry.set(
        knownConnectAccountsAtom,
        appAtomRegistry.get(knownConnectAccountsAtom).filter((account) => account.accountId !== id),
      );
      fixtures.pendingRemoval.delete(id);
    },
  };
});
let root: Root;
const session = (id: string): Session => ({ id: `session-${id}`, status: "active", user: { id } });
async function observe(sessions: Session[], active: string | null) {
  fixtures.sessions = sessions;
  fixtures.active = active;
  await act(async () => {
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MultiAccountCloudAuthBridge>{null}</MultiAccountCloudAuthBridge>
      </RegistryContext.Provider>,
    );
  });
}
beforeEach(() => {
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
  fixtures.pushSupported = true;
  fixtures.capability.mockReset().mockResolvedValue(undefined);
  fixtures.remove.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  fixtures.restore.mockReset().mockResolvedValue(undefined);
  fixtures.pendingRemoval.clear();
  appAtomRegistry.set(knownConnectAccountsAtom, []);
  vi.mocked(requestConnectOnboarding).mockClear();
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
describe("mobile multi-account lifecycle", () => {
  it("waits for capability then removes only the native-added session and restores the prior active account", async () => {
    await observe([session("a")], "a");
    let resolve!: () => void;
    fixtures.capability.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    fixtures.pushSupported = false;
    const rejected = {
      ...session("b"),
      remove: vi.fn(async () => {
        fixtures.sessions = fixtures.sessions.filter((s) => s.user.id !== "b");
      }),
    };
    await observe([session("a"), rejected], "b");
    expect(rejected.remove).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(knownConnectAccountsAtom).map((a) => a.accountId)).toEqual(["a"]);
    await act(async () => {
      resolve();
    });
    expect(rejected.remove).toHaveBeenCalledOnce();
    expect(clerk.setActive).toHaveBeenLastCalledWith({ session: "session-a" });
    expect(appAtomRegistry.get(managedRelaySessionsAtom).has("b")).toBe(false);
    expect(fixtures.remove).not.toHaveBeenCalled();
  });
  it("keeps both live sessions and their identities across an active-account flip", async () => {
    await observe([session("a"), session("b")], "a");
    const a = appAtomRegistry.get(managedRelaySessionsAtom).get("a");
    const b = appAtomRegistry.get(managedRelaySessionsAtom).get("b");
    await observe([session("a"), session("b")], "b");
    expect(appAtomRegistry.get(managedRelaySessionsAtom).get("a")).toBe(a);
    expect(appAtomRegistry.get(managedRelaySessionsAtom).get("b")).toBe(b);
    expect(fixtures.remove).not.toHaveBeenCalled();
    expect(requestConnectOnboarding).not.toHaveBeenCalled();
  });
  it("disconnects expiry without removing data, including an empty session list", async () => {
    await observe([session("a")], "a");
    await observe([], null);
    expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
    expect(appAtomRegistry.get(knownConnectAccountsAtom)).toMatchObject([
      { accountId: "a", signedIn: false },
    ]);
    await observe([session("b")], "b");
    expect(fixtures.remove).not.toHaveBeenCalled();
    expect(
      appAtomRegistry.get(knownConnectAccountsAtom).map((account) => account.accountId),
    ).toEqual(["a", "b"]);
    expect(requestConnectOnboarding).toHaveBeenCalledExactlyOnceWith("b");
  });
  it("cleans only the explicitly removed account while keeping another connection", async () => {
    await observe([session("a"), session("b")], "a");
    const a = appAtomRegistry.get(managedRelaySessionsAtom).get("a");
    fixtures.pendingRemoval.add("b");
    await act(async () => {
      appAtomRegistry.set(connectAccountRemovalRevisionAtom, 1);
    });
    await observe([session("a")], "a");
    expect(fixtures.remove).toHaveBeenCalledExactlyOnceWith("b");
    expect(
      appAtomRegistry.get(knownConnectAccountsAtom).map((account) => account.accountId),
    ).toEqual(["a"]);
    expect(appAtomRegistry.get(managedRelaySessionsAtom).get("a")).toBe(a);
  });
  it("waits for draft restoration before exposing a newly signed-in account", async () => {
    let release = () => {};
    fixtures.restore.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await observe([session("a")], "a");
    expect(appAtomRegistry.get(managedRelaySessionsAtom).has("a")).toBe(false);
    await act(async () => release());
    expect(appAtomRegistry.get(managedRelaySessionsAtom).has("a")).toBe(true);
  });
  it("sweeps an explicitly revoked account once without touching the remaining account", async () => {
    await observe([session("a"), session("b")], "a");
    const revoked = { ...session("b"), status: "revoked" as const };
    await observe([session("a"), revoked], "a");
    await observe([session("a"), revoked], "a");
    expect(fixtures.remove).toHaveBeenCalledExactlyOnceWith("b");
    expect(
      appAtomRegistry.get(knownConnectAccountsAtom).map((account) => account.accountId),
    ).toEqual(["a"]);
  });
  it("does not remove an account when another session for that account remains active", async () => {
    await observe([session("a")], "a");
    await observe([session("a"), { ...session("a"), id: "old-a", status: "revoked" }], "a");
    expect(fixtures.remove).not.toHaveBeenCalled();
    expect(fixtures.pendingRemoval.size).toBe(0);
  });
});
