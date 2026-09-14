import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSessionRelayToken } from "./useSessionRelayToken";

vi.mock("./publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));

let root: Root;
let tokenProvider: () => Promise<string | null>;
const connect = vi.fn();
function Probe(props: { account: string | null; session: string | null; token: string }) {
  const provider = useSessionRelayToken({
    userId: props.account,
    sessionId: props.session,
    isSignedIn: props.account !== null,
    // Like Clerk Expo, this closure changes on every render.
    getToken: async () => props.token,
  });
  useEffect(() => {
    tokenProvider = provider;
    connect(provider);
  }, [provider]);
  return null;
}
async function render(account: string | null, session: string | null, token: string) {
  await act(() => root.render(<Probe account={account} session={session} token={token} />));
}

beforeEach(() => {
  connect.mockClear();
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
  vi.unstubAllGlobals();
});

describe("session-scoped relay credentials", () => {
  it("uses refreshed credentials without restarting relay effects on every render", async () => {
    await render("account-a", "session-a", "first-token");
    const original = tokenProvider;
    await render("account-a", "session-a", "refreshed-token");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(tokenProvider).toBe(original);
    expect(await original()).toBe("refreshed-token");
  });

  it("keeps delayed old-account cleanup bound to the old account", async () => {
    await render("account-a", "session-a", "account-a-token");
    const cleanupToken = tokenProvider;
    await render("account-b", "session-b", "account-b-token");
    expect(await cleanupToken()).toBe("account-a-token");
    expect(await tokenProvider()).toBe("account-b-token");
    expect(connect).toHaveBeenCalledTimes(2);
    await render(null, null, "must-not-be-used");
    expect(await tokenProvider()).toBeNull();
    expect(await cleanupToken()).toBe("account-a-token");
  });

  it("replaces the provider on a new session for the same account", async () => {
    await render("account-a", "session-a", "first-session-token");
    const previousSession = tokenProvider;
    await render("account-a", "session-b", "second-session-token");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(await previousSession()).toBe("first-session-token");
    expect(await tokenProvider()).toBe("second-session-token");
  });
});
