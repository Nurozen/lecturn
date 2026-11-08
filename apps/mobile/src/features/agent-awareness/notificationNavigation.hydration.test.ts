import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  accountsReady: true,
  catalogReady: false,
  accountReadyAtom: Symbol("accountReady"),
  accountsAtom: Symbol("accounts"),
  catalogAtom: Symbol("catalog"),
  listeners: new Map<unknown, Set<(value: unknown) => void>>(),
  tap: null as ((response: unknown) => void) | null,
  rootNavigate: vi.fn(),
  expand: vi.fn(),
  readResponse: vi.fn(),
  clearResponse: vi.fn(),
}));

function readAtom(atom: unknown): unknown {
  if (atom === state.accountReadyAtom) return state.accountsReady;
  if (atom === state.accountsAtom) return [{ accountId: "b", signedIn: true }];
  if (atom === state.catalogAtom) return { isReady: state.catalogReady, entries: new Map() };
  return null;
}

function emit(atom: unknown): void {
  for (const listener of state.listeners.get(atom) ?? []) listener(readAtom(atom));
}

vi.mock("./androidNotifications", () => ({ setAndroidThreadOnScreen: vi.fn() }));
vi.mock("../squires/squireLinks", () => ({
  parseSquireRoutePath: () => null,
  squireHomeThreadPath: () => null,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/squire", () => ({ squireEnvironment: {} }));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { navigate: state.rootNavigate },
  whenRootNavigationReady: (navigate: () => void) => navigate(),
}));
vi.mock("@lecturn/client-runtime/connection", () => ({ accountOwnerTarget: () => null }));
vi.mock("@lecturn/client-runtime/relay", () => ({
  relayAccountByEnvironmentId: () => new Map([["env-b", "b"]]),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: state.catalogAtom },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: readAtom,
    set: vi.fn(),
    subscribe: (
      atom: unknown,
      listener: (value: unknown) => void,
      options?: { readonly immediate?: boolean },
    ) => {
      const listeners = state.listeners.get(atom) ?? new Set();
      state.listeners.set(atom, listeners);
      listeners.add(listener);
      if (options?.immediate) listener(readAtom(atom));
      return () => listeners.delete(listener);
    },
  },
}));
vi.mock("../cloud/knownAccounts", () => ({
  connectAccountsReadyAtom: state.accountReadyAtom,
  knownConnectAccountsAtom: state.accountsAtom,
}));
vi.mock("../home/accountSectionExpansion", () => ({ expandMobileAccountSection: state.expand }));
vi.mock("expo-notifications", () => ({
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
    state.tap = listener;
    return { remove: vi.fn() };
  },
  getLastNotificationResponseAsync: state.readResponse,
  clearLastNotificationResponseAsync: state.clearResponse,
  setNotificationHandler: vi.fn(),
}));

import { installAgentNotificationNavigation } from "./notificationNavigation";

const ownedResponse = (identifier: string) => ({
  notification: {
    request: {
      identifier,
      content: { data: { accountId: "b", environmentId: "env-b", threadId: "thread-b" } },
    },
  },
});

afterEach(() => {
  state.listeners.clear();
  state.tap = null;
  state.accountsReady = true;
  state.catalogReady = false;
  vi.clearAllMocks();
});

describe("cold notification hydration", () => {
  it("keeps the initial response until both accounts and catalog can verify ownership", async () => {
    state.readResponse.mockResolvedValue(ownedResponse("cold"));
    let cleared!: () => void;
    const completed = new Promise<void>((resolve) => {
      cleared = resolve;
    });
    state.clearResponse.mockImplementation(async () => {
      cleared();
    });
    const navigate = vi.fn();
    const dispose = installAgentNotificationNavigation(navigate);
    expect(state.readResponse).not.toHaveBeenCalled();
    expect(state.clearResponse).not.toHaveBeenCalled();
    state.catalogReady = true;
    state.accountsReady = false;
    emit(state.catalogAtom);
    expect(state.readResponse).not.toHaveBeenCalled();
    state.accountsReady = true;
    emit(state.accountReadyAtom);
    await completed;
    expect(state.expand).toHaveBeenCalledWith("b");
    expect(navigate).toHaveBeenCalledWith("/threads/env-b/thread-b?accountId=b");
    expect(state.clearResponse).toHaveBeenCalledOnce();
    dispose();
  });

  it("routes a tap that arrives before ownership is known once it is", () => {
    state.readResponse.mockResolvedValue(null);
    const navigate = vi.fn();
    const dispose = installAgentNotificationNavigation(navigate);
    state.tap?.(ownedResponse("warm"));
    expect(navigate).not.toHaveBeenCalled();
    state.catalogReady = true;
    emit(state.catalogAtom);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/threads/env-b/thread-b?accountId=b");
    dispose();
  });
});
