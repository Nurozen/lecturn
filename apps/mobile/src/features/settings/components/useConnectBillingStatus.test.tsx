import { act, useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { bindAccountTokenClerk } from "../../cloud/accountTokenReaders";
import { useConnectBillingStatus } from "./useConnectBillingStatus";

const mocks = vi.hoisted(() => ({
  userId: "account-a" as string | null,
  focused: true,
  token: "token-a",
  getToken: vi.fn(),
  requests: [] as Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>,
  appState: "active" as string | null,
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({
    sessionId: mocks.userId ? `session-${mocks.userId}` : null,
    userId: mocks.userId,
    isSignedIn: !!mocks.userId,
    // Match the real Clerk Expo hook: a fresh wrapper on each render.
    getToken: () => {
      mocks.getToken(mocks.token);
      return Promise.resolve(mocks.token);
    },
  }),
}));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    useEffect(() => (mocks.focused ? effect() : undefined), [effect, mocks.focused]);
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      return { remove: () => mocks.listeners.delete(listener) };
    },
  },
}));
vi.mock("../../cloud/publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ relay: { url: "https://relay.example.test" } }),
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));
vi.mock("@lecturn/client-runtime/relay", () => ({
  createBillingClient: ({ getToken }: { getToken: () => Promise<string | null> }) => ({
    getStatus: async () => {
      await getToken();
      return new Promise((resolve, reject) => mocks.requests.push({ resolve, reject }));
    },
  }),
}));
let root: Root;
let renders = 0;
let view: ReturnType<typeof useConnectBillingStatus>;
function Probe() {
  if (++renders > 50) throw new Error("Connect access entered a render/request loop");
  const result = useConnectBillingStatus();
  useLayoutEffect(() => {
    view = result;
  });
  return null;
}
async function render() {
  await act(() => root.render(<Probe />));
}
async function state(next: string) {
  await act(() => {
    mocks.appState = next;
    for (const listener of mocks.listeners) listener(next);
  });
}
const status = { hasAccess: true };
beforeEach(() => {
  renders = 0;
  mocks.userId = "account-a";
  mocks.focused = true;
  mocks.token = "token-a";
  mocks.appState = "active";
  mocks.requests.length = 0;
  mocks.listeners.clear();
  mocks.getToken.mockClear();
  bindAccountTokenClerk({
    client: {
      get signedInSessions() {
        return mocks.userId
          ? [
              {
                user: { id: mocks.userId },
                getToken: async () => {
                  mocks.getToken(mocks.token);
                  return `header.${btoa(JSON.stringify({ sub: mocks.userId, token: mocks.token }))}.signature`;
                },
              },
            ]
          : [];
      },
    },
  });

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
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  bindAccountTokenClerk(null);
  vi.unstubAllGlobals();
});
describe("mobile Connect access refresh", () => {
  it("loads when native app state is initially unknown", async () => {
    mocks.appState = null;
    await render();
    expect(mocks.requests).toHaveLength(1);
    await act(() => mocks.requests[0]!.resolve(status));
    expect(view.loading).toBe(false);
  });
  it("settles one request despite fresh Clerk token functions and unrelated rerenders", async () => {
    await render();
    await render();
    expect(mocks.requests).toHaveLength(1);
    await act(() => mocks.requests[0]!.resolve(status));
    expect(view.loading).toBe(false);
    expect(view.status).toEqual(status);
    await render();
    expect(mocks.requests).toHaveLength(1);
  });
  it("recovers after foregrounding and ignores a pre-background response", async () => {
    await render();
    await state("background");
    mocks.token = "refreshed-token";
    await render();
    await state("active");
    await state("active");
    expect(mocks.requests).toHaveLength(2);
    expect(mocks.getToken).toHaveBeenLastCalledWith("refreshed-token");
    await act(() => mocks.requests[1]!.resolve(status));
    await act(() => mocks.requests[0]!.reject(new Error("old network")));
    expect(view.loading).toBe(false);
    expect(view.status).toEqual(status);
  });
  it("ignores previous-account results and refreshes only the current account", async () => {
    await render();
    mocks.userId = "account-b";
    await render();
    await act(() => mocks.requests[0]!.resolve(status));
    expect(view.loading).toBe(true);
    await act(() => mocks.requests[1]!.reject(new Error("offline")));
    expect(view.loading).toBe(false);
    expect(view.status).toBeNull();
    await act(() => view.refresh());
    expect(mocks.requests).toHaveLength(3);
    await act(() => mocks.requests[2]!.resolve(status));
    expect(view.status).toEqual(status);
    mocks.userId = null;
    await render();
    expect(view.signedIn).toBe(false);
  });
  it("does not refresh a blurred screen and requests again when focused", async () => {
    await render();
    mocks.focused = false;
    await render();
    await state("background");
    await state("active");
    expect(mocks.requests).toHaveLength(1);
    await act(() => mocks.requests[0]!.resolve(status));
    expect(view.loading).toBe(true);
    mocks.focused = true;
    await render();
    expect(mocks.requests).toHaveLength(2);
  });
});
