import { RegistryContext } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectAccountsReadyAtom, knownConnectAccountsAtom } from "../cloud/knownAccounts";
import { PullRequestWatchAccountGuard } from "./PullRequestWatchAccountGuard";
import { expandMobileAccountSection } from "../home/accountSectionExpansion";
const screen = vi.hoisted(() => ({ mounted: false, message: "" }));
const catalog = Atom.make({
  isReady: false,
  entries: new Map<
    string,
    { target: { environmentId: string; _tag: string; accountId?: string } }
  >(),
}).pipe(Atom.keepAlive);
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    get catalogValueAtom() {
      return catalog;
    },
  },
}));
vi.mock("react-native", () => ({ View: (props: { children: ReactNode }) => props.children }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate() {} }) }));
vi.mock("../../components/EmptyState", () => ({
  EmptyState: (props: { title: string }) => {
    screen.message = props.title;
    return null;
  },
}));
vi.mock("../../components/LoadingScreen", () => ({
  LoadingScreen: (props: { message: string }) => {
    screen.message = props.message;
    return null;
  },
}));
vi.mock("../home/accountSectionExpansion", () => ({ expandMobileAccountSection: vi.fn() }));
function Controls() {
  useEffect(() => {
    screen.mounted = true;
    return () => {
      screen.mounted = false;
    };
  }, []);
  return null;
}
let root: Root;
async function render(accountId?: string) {
  await act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <PullRequestWatchAccountGuard environmentId="env" accountId={accountId}>
          <Controls />
        </PullRequestWatchAccountGuard>
      </RegistryContext.Provider>,
    ),
  );
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
  root = createRoot(container as unknown as HTMLElement);
  appAtomRegistry.set(connectAccountsReadyAtom, true);
  appAtomRegistry.set(knownConnectAccountsAtom, [
    { accountId: "b", email: "b@example.com", label: "B", preset: "jade", signedIn: true },
  ]);
  appAtomRegistry.set(catalog, {
    isReady: true,
    entries: new Map([
      ["env", { target: { environmentId: "env", _tag: "RelayConnectionTarget", accountId: "b" } }],
    ]),
  });
  screen.mounted = false;
  screen.message = "";
  vi.mocked(expandMobileAccountSection).mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
describe("pull request Live Activity account guard", () => {
  it("never mounts B's watch controls for an old A activity after relink", async () => {
    await render("a");
    expect(screen.mounted).toBe(false);
    expect(screen.message).toBe("Pull request watch unavailable");
    expect(expandMobileAccountSection).not.toHaveBeenCalled();
  });
  it("waits for both catalog and account hydration before mounting controls", async () => {
    const readyCatalog = appAtomRegistry.get(catalog);
    appAtomRegistry.set(catalog, { ...readyCatalog, isReady: false });
    appAtomRegistry.set(connectAccountsReadyAtom, false);
    await render("b");
    expect(screen.mounted).toBe(false);
    await act(() => appAtomRegistry.set(catalog, readyCatalog));
    expect(screen.mounted).toBe(false);
    await act(() => appAtomRegistry.set(connectAccountsReadyAtom, true));
    expect(screen.mounted).toBe(true);
    expect(expandMobileAccountSection).toHaveBeenCalledExactlyOnceWith("b");
  });
  it("unmounts controls on expiry and requires the same owner's sign-in", async () => {
    await render("b");
    expect(screen.mounted).toBe(true);
    await act(() =>
      appAtomRegistry.set(
        knownConnectAccountsAtom,
        appAtomRegistry
          .get(knownConnectAccountsAtom)
          .map((account) => ({ ...account, signedIn: false })),
      ),
    );
    expect(screen.mounted).toBe(false);
    expect(screen.message).toBe("Sign in again");
  });
  it("keeps direct watch links usable without Connect", async () => {
    appAtomRegistry.set(catalog, {
      isReady: true,
      entries: new Map([
        ["env", { target: { environmentId: "env", _tag: "BearerConnectionTarget" } }],
      ]),
    });
    appAtomRegistry.set(connectAccountsReadyAtom, false);
    await render();
    expect(screen.mounted).toBe(true);
  });
});
