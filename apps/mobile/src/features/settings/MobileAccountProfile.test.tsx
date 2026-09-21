import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MobileAccountProfile } from "./MobileAccountProfile";
const state = vi.hoisted(() => ({
  userId: "a" as string | null,
  profileMounted: false,
  setActive: vi.fn(),
}));
const a = { id: "session-a", user: { id: "a" } };
const b = { id: "session-b", user: { id: "b" } };
const clerk = { session: a, client: { signedInSessions: [a, b] }, setActive: state.setActive };
vi.mock("@clerk/expo", () => ({
  useClerk: () => clerk,
  useAuth: () => ({ isLoaded: true, userId: state.userId }),
}));
vi.mock("@clerk/expo/native", () => ({
  UserProfileView: () => {
    useEffect(() => {
      state.profileMounted = true;
      return () => {
        state.profileMounted = false;
      };
    }, []);
    return null;
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch() {} }),
  StackActions: { popTo: () => ({}) },
}));
vi.mock("react-native", () => ({ View: (props: { children: ReactNode }) => props.children }));
vi.mock("../../components/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/LoadingScreen", () => ({ LoadingScreen: () => null }));
let root: Root;
async function render() {
  await act(() => root.render(<MobileAccountProfile accountId="b" />));
}
beforeEach(() => {
  state.userId = "a";
  state.profileMounted = false;
  clerk.session = a;
  clerk.client.signedInSessions = [a, b];
  state.setActive.mockReset().mockImplementation(async () => {
    clerk.session = b;
    state.userId = "b";
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
  vi.unstubAllGlobals();
});
describe("native account profile guard", () => {
  it("does not mount editable profile UI until the requested session selection completes", async () => {
    let release = () => {};
    state.setActive.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            clerk.session = b;
            state.userId = "b";
            resolve();
          };
        }),
    );
    await render();
    expect(state.profileMounted).toBe(false);
    await act(async () => release());
    expect(state.profileMounted).toBe(true);
  });
  it("unmounts editable UI when native sync changes the active account", async () => {
    await render();
    expect(state.profileMounted).toBe(true);
    clerk.session = a;
    state.userId = "a";
    await render();
    expect(state.profileMounted).toBe(false);
  });
  it("never mounts another account's profile when selection is rejected", async () => {
    state.setActive.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(state.profileMounted).toBe(false);
  });
});
