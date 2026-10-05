import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  accountsReady: true,
  catalogReady: false,
  accountReadyAtom: Symbol("accountReady"),
  accountsAtom: Symbol("accounts"),
  catalogAtom: Symbol("catalog"),
  effect: null as (() => void | (() => void)) | null,
  linkTo: vi.fn(),
  navigate: vi.fn(),
  expand: vi.fn(),
  readResponse: vi.fn(),
  clearResponse: vi.fn(),
  listen: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void) => {
    state.effect = effect;
  },
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.accountReadyAtom ? state.accountsReady : { isReady: state.catalogReady },
}));
vi.mock("@react-navigation/native", () => ({
  useLinkTo: () => state.linkTo,
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("@lecturn/client-runtime/relay", () => ({
  relayAccountByEnvironmentId: () => new Map([["env-b", "b"]]),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: state.catalogAtom },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === state.accountsAtom ? [{ accountId: "b", signedIn: true }] : { entries: new Map() },
  },
}));
vi.mock("../cloud/knownAccounts", () => ({
  connectAccountsReadyAtom: state.accountReadyAtom,
  knownConnectAccountsAtom: state.accountsAtom,
}));
vi.mock("../home/accountSectionExpansion", () => ({ expandMobileAccountSection: state.expand }));
vi.mock("expo-notifications", () => ({
  addNotificationResponseReceivedListener: state.listen,
  getLastNotificationResponseAsync: state.readResponse,
  clearLastNotificationResponseAsync: state.clearResponse,
}));

import { useAgentNotificationNavigation } from "./notificationNavigation";

describe("cold notification hydration", () => {
  it("keeps the initial response until both accounts and catalog can verify ownership", async () => {
    state.readResponse.mockResolvedValue({
      notification: {
        request: {
          identifier: "cold",
          content: { data: { accountId: "b", environmentId: "env-b", threadId: "thread-b" } },
        },
      },
    });
    let cleared!: () => void;
    const completed = new Promise<void>((resolve) => {
      cleared = resolve;
    });
    state.clearResponse.mockImplementation(async () => {
      cleared();
    });
    useAgentNotificationNavigation();
    state.effect?.();
    expect(state.readResponse).not.toHaveBeenCalled();
    expect(state.clearResponse).not.toHaveBeenCalled();
    state.catalogReady = true;
    state.accountsReady = false;
    useAgentNotificationNavigation();
    state.effect?.();
    expect(state.readResponse).not.toHaveBeenCalled();
    state.accountsReady = true;
    useAgentNotificationNavigation();
    const cleanup = state.effect?.();
    await completed;
    expect(state.expand).toHaveBeenCalledWith("b");
    expect(state.linkTo).toHaveBeenCalledWith("/threads/env-b/thread-b?accountId=b");
    expect(state.clearResponse).toHaveBeenCalledOnce();
    cleanup?.();
  });
});
