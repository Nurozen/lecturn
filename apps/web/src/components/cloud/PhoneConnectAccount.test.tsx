import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { cloneElement, type ReactElement, type ReactNode, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const test = vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    symbaHost: { protocolVersion: 2, connectAccount: true },
    open: vi.fn(),
  });
  return {
    openNative: vi.fn(),
    navigate: vi.fn(),
    closeSidebar: vi.fn(),
    configured: true,
    nativeConnect: true,
    status: vi.fn(),
  };
});
vi.mock("@clerk/react", () => ({
  useAuth: () => {
    throw new Error("Phone called Clerk");
  },
}));
vi.mock("../../cloud/phoneConnectAccount", async (original) => {
  const module = await original<typeof import("../../cloud/phoneConnectAccount")>();
  const signedOut = () => ({
    configured: test.configured,
    state: "signed-out" as const,
    account: null,
    relayUrl: test.configured ? "https://relay.example.test" : null,
  });
  const host = {
    protocolVersion: 2,
    connectAccount: true,
    get nativeConnect() {
      return test.nativeConnect;
    },
    getAccessState: vi.fn(),
    requestFullAccess: vi.fn(),
    openDeviceAccess: vi.fn(),
    getConnectState: async () => test.status() ?? signedOut(),
    openConnectSignIn: async () => {
      test.openNative();
      return { ...signedOut(), state: "authorizing" };
    },
    signOutConnect: async () => signedOut(),
    getConnectToken: async () => ({ token: null }),
  };
  const account = module.createPhoneConnectAccount(module.createPhoneConnectApi(host));
  return { ...module, phoneConnectAccount: account };
});
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children: ReactNode;
  }) => cloneElement(render, {}, children),
  useSidebar: () => ({ setOpenMobile: test.closeSidebar }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, onClick }: { to: string; children: ReactNode; onClick: () => void }) => (
    <a
      onClick={() => {
        test.navigate(to);
        onClick();
      }}
    >
      {children}
    </a>
  ),
}));

import { phoneConnectAccount } from "../../cloud/phoneConnectAccount";
import { useConnectAccountAuth } from "../../cloud/useConnectAccountAuth";
import { PhoneConnectAccountSection, PhoneConnectSidebarEntry } from "./PhoneConnectAccount";
let renderer: ReactTestRenderer;
const button = (label: string) =>
  renderer.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const displayedText = () => JSON.stringify(renderer.toJSON());
function AuthState() {
  const { isLoaded, isSignedIn, userId } = useConnectAccountAuth();
  return <output>{JSON.stringify({ isLoaded, isSignedIn, userId })}</output>;
}
beforeEach(async () => {
  test.configured = true;
  test.nativeConnect = true;
  test.status.mockReset();
  test.navigate.mockClear();
  test.openNative.mockClear();
  test.closeSidebar.mockClear();
  await phoneConnectAccount.logout();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

async function mount() {
  await act(async () => {
    renderer = create(
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
    test.status.mockReturnValue({
      configured: true,
      state: "loading",
      account: null,
      relayUrl: "https://relay.example.test",
    });
    await phoneConnectAccount.refresh();
    await mount();
    expect(displayedText()).toContain("Checking account…");
    expect(displayedText()).not.toContain("Signed out");
    expect(renderer.root.findByType("output").children).toEqual([
      JSON.stringify({ isLoaded: false, isSignedIn: false, userId: null }),
    ]);
    expect(button("Sign in to Lecturn Connect").props.disabled).toBe(true);
    await act(async () => button("Sign in to Lecturn Connect").props.onClick());
    expect(test.openNative).not.toHaveBeenCalled();

    test.status.mockImplementationOnce(() => {
      throw new Error("synthetic startup failure");
    });
    await act(async () => button("Refresh status").props.onClick());
    expect(displayedText()).toContain("Sign-in needs attention");
    expect(renderer.root.findByType("output").children).toEqual([
      JSON.stringify({ isLoaded: true, isSignedIn: false, userId: null }),
    ]);
    await act(async () => button("Reset sign-in").props.onClick());
    expect(button("Sign in to Lecturn Connect").props.disabled).toBe(false);
    await act(async () => button("Sign in to Lecturn Connect").props.onClick());
    expect(test.openNative).toHaveBeenCalledOnce();
  });

  it("keeps the account entry discoverable and reaches the Connections body while disabled", async () => {
    test.configured = false;
    await phoneConnectAccount.refresh();
    await mount();
    expect(displayedText()).toContain("App update needed");
    expect(button("Sign in to Lecturn Connect").props.disabled).toBe(true);
    await act(async () => renderer.root.findByType("a").props.onClick());
    expect(test.navigate).toHaveBeenCalledWith("/settings/connections");
    expect(test.closeSidebar).toHaveBeenCalledWith(false);
    test.configured = true;
    await act(async () => button("Refresh status").props.onClick());
    expect(button("Sign in to Lecturn Connect").props.disabled).toBe(false);
  });

  it("opens native sign-in directly and settles success/cancel from native status", async () => {
    await mount();
    await act(async () => button("Sign in to Lecturn Connect").props.onClick());
    expect(test.openNative).toHaveBeenCalledOnce();
    expect(displayedText()).toContain("Signing in…");
    expect(window.open).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    expect(button("Open browser")).toBeUndefined();
    expect(button("Copy sign-in link")).toBeUndefined();
    await act(async () => phoneConnectAccount.refresh());
    expect(displayedText()).toContain("Signed out");
    await act(async () => button("Sign in to Lecturn Connect").props.onClick());
    test.status.mockReturnValue({
      configured: true,
      state: "signed-in",
      account: { id: "phone-account", email: "phone@example.test" },
      relayUrl: "https://relay.example.test",
    });
    await act(async () => phoneConnectAccount.refresh());
    expect(displayedText()).toContain("phone@example.test");
    await act(async () => button("Sign out").props.onClick());
    expect(displayedText()).toContain("Signed out");
    expect(displayedText()).not.toContain("phone@example.test");
  });

  it.each([
    { account: { id: "phone-account", email: "phone@example.test" }, action: "Sign out" },
    { account: null, action: "Reset sign-in" },
  ])(
    "recovers a refresh/credential error with $action before starting again",
    async ({ account, action }) => {
      test.status.mockReturnValue({
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
      expect(button(action).props.disabled).toBe(false);
      expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
        account ? "Sign out" : "Reset sign-in",
      );
      await act(async () => button(action).props.onClick());
      expect(phoneConnectAccount.getSnapshot().status?.account).toBeNull();
      expect(displayedText()).toContain("Signed out");
      expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      await act(async () => button("Sign in to Lecturn Connect").props.onClick());
      expect(phoneConnectAccount.getSnapshot().status?.state).toBe("authorizing");
      expect(test.openNative).toHaveBeenCalledOnce();
    },
  );

  it("shows explicit update guidance for older native binaries", async () => {
    test.nativeConnect = false;
    await phoneConnectAccount.refresh();
    await mount();
    expect(displayedText()).toContain("Update Lecturn on this phone");
    expect(test.openNative).not.toHaveBeenCalled();
    expect(button("Open browser")).toBeUndefined();
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
  });
});
