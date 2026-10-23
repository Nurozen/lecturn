import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("symbaHost", { protocolVersion: 2, connectAccount: true });
  return {
    openNative: vi.fn(),
    navigate: vi.fn(),
    closeSidebar: vi.fn(),
    configured: true,
    nativeConnect: true,
    status: vi.fn(),
  };
});
vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => {
    throw new Error("Phone called Clerk");
  }) as never,
}));
vi.mock(import("../../cloud/phoneConnectAccount"), async (original) => {
  const module = await original();
  const signedOut = () => ({
    configured: state.configured,
    state: "signed-out" as const,
    account: null,
    relayUrl: state.configured ? "https://relay.example.test" : null,
  });
  const host = {
    protocolVersion: 2,
    connectAccount: true,
    get nativeConnect() {
      return state.nativeConnect;
    },
    getAccessState: vi.fn(),
    requestFullAccess: vi.fn(),
    openDeviceAccess: vi.fn(),
    getConnectState: async () => state.status() ?? signedOut(),
    openConnectSignIn: async () => {
      state.openNative();
      return { ...signedOut(), state: "authorizing" };
    },
    signOutConnect: async () => signedOut(),
    getConnectToken: async () => ({ token: null }),
  };
  const account = module.createPhoneConnectAccount(module.createPhoneConnectApi(host as never));
  return { ...module, phoneConnectAccount: account };
});
vi.mock(import("../ui/sidebar"), async (original) => ({
  ...(await original()),
  SidebarMenu: (({ children }: { children: ReactNode }) => <div>{children}</div>) as never,
  SidebarMenuItem: (({ children }: { children: ReactNode }) => <div>{children}</div>) as never,
  SidebarMenuButton: (({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children: ReactNode;
  }) => cloneElement(render, {}, children)) as never,
  useSidebar: (() => ({ setOpenMobile: state.closeSidebar })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ to, children, onClick }: { to: string; children: ReactNode; onClick: () => void }) => (
    <a
      onClick={() => {
        state.navigate(to);
        onClick();
      }}
    >
      {children}
    </a>
  )) as never,
}));

import { phoneConnectAccount } from "../../cloud/phoneConnectAccount";
import { useConnectAccountAuth } from "../../cloud/useConnectAccountAuth";
import { PhoneConnectAccountSection, PhoneConnectSidebarEntry } from "./PhoneConnectAccount";
let root: Root | null = null;
let container: HTMLDivElement;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
const displayedText = () => container.textContent ?? "";
const authOutput = () => container.querySelector("output")!.textContent;
const press = (label: string) => act(async () => button(label).click());
function AuthState() {
  const { isLoaded, isSignedIn, userId } = useConnectAccountAuth();
  return <output>{JSON.stringify({ isLoaded, isSignedIn, userId })}</output>;
}
beforeEach(async () => {
  vi.spyOn(window, "open").mockImplementation(() => null);
  container = document.createElement("div");
  document.body.append(container);
  state.configured = true;
  state.nativeConnect = true;
  state.status.mockReset();
  state.navigate.mockClear();
  state.openNative.mockClear();
  state.closeSidebar.mockClear();
  await phoneConnectAccount.logout();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <>
        <PhoneConnectSidebarEntry />
        <PhoneConnectAccountSection />
        <AuthState />
      </>,
    );
  });
}

describe("phone Connect controls", () => {
  it("shows restoration progress and blocks duplicate sign-in until native settles", async () => {
    state.status.mockReturnValue({
      configured: true,
      state: "loading",
      account: null,
      relayUrl: "https://relay.example.test",
    });
    await phoneConnectAccount.refresh();
    await mount();
    expect(displayedText()).toContain("Checking account…");
    expect(displayedText()).not.toContain("Signed out");
    expect(authOutput()).toBe(JSON.stringify({ isLoaded: false, isSignedIn: false, userId: null }));
    expect(button("Sign in to Lecturn Connect").disabled).toBe(true);
    await press("Sign in to Lecturn Connect");
    expect(state.openNative).not.toHaveBeenCalled();

    state.status.mockImplementationOnce(() => {
      throw new Error("synthetic startup failure");
    });
    await press("Refresh status");
    expect(displayedText()).toContain("Sign-in needs attention");
    expect(authOutput()).toBe(JSON.stringify({ isLoaded: true, isSignedIn: false, userId: null }));
    await press("Reset sign-in");
    expect(button("Sign in to Lecturn Connect").disabled).toBe(false);
    await press("Sign in to Lecturn Connect");
    expect(state.openNative).toHaveBeenCalledOnce();
  });

  it("keeps the account entry discoverable and reaches the Connections body while disabled", async () => {
    state.configured = false;
    await phoneConnectAccount.refresh();
    await mount();
    expect(displayedText()).toContain("App update needed");
    expect(button("Sign in to Lecturn Connect").disabled).toBe(true);
    await act(async () => container.querySelector("a")!.click());
    expect(state.navigate).toHaveBeenCalledWith("/settings/connections");
    expect(state.closeSidebar).toHaveBeenCalledWith(false);
    state.configured = true;
    await press("Refresh status");
    expect(button("Sign in to Lecturn Connect").disabled).toBe(false);
  });

  it("opens native sign-in directly and settles success/cancel from native status", async () => {
    await mount();
    await press("Sign in to Lecturn Connect");
    expect(state.openNative).toHaveBeenCalledOnce();
    expect(displayedText()).toContain("Signing in…");
    expect(window.open).not.toHaveBeenCalled();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(button("Open browser")).toBeUndefined();
    expect(button("Copy sign-in link")).toBeUndefined();
    await act(async () => phoneConnectAccount.refresh());
    expect(displayedText()).toContain("Signed out");
    await press("Sign in to Lecturn Connect");
    state.status.mockReturnValue({
      configured: true,
      state: "signed-in",
      account: { id: "phone-account", email: "phone@example.test" },
      relayUrl: "https://relay.example.test",
    });
    await act(async () => phoneConnectAccount.refresh());
    expect(displayedText()).toContain("phone@example.test");
    await press("Sign out");
    expect(displayedText()).toContain("Signed out");
    expect(displayedText()).not.toContain("phone@example.test");
  });

  it.each([
    { account: { id: "phone-account", email: "phone@example.test" }, action: "Sign out" },
    { account: null, action: "Reset sign-in" },
  ])(
    "recovers a refresh/credential error with $action before starting again",
    async ({ account, action }) => {
      state.status.mockReturnValue({
        configured: true,
        state: "error",
        account,
        relayUrl: "https://relay.example.test",
        error: "Connect session could not be refreshed. Sign out and sign in again.",
      });
      await phoneConnectAccount.refresh();
      await mount();
      expect(displayedText()).toContain("Sign-in needs attention");
      expect(button("Sign in to Lecturn Connect")).toBeUndefined();
      expect(button(action).disabled).toBe(false);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        account ? "Sign out" : "Reset sign-in",
      );
      await press(action);
      expect(phoneConnectAccount.getSnapshot().status?.account).toBeNull();
      expect(displayedText()).toContain("Signed out");
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      await press("Sign in to Lecturn Connect");
      expect(phoneConnectAccount.getSnapshot().status?.state).toBe("authorizing");
      expect(state.openNative).toHaveBeenCalledOnce();
    },
  );

  it("shows explicit update guidance for older native binaries", async () => {
    state.nativeConnect = false;
    await phoneConnectAccount.refresh();
    await mount();
    expect(displayedText()).toContain("Update Lecturn on this phone");
    expect(state.openNative).not.toHaveBeenCalled();
    expect(button("Open browser")).toBeUndefined();
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });
});
