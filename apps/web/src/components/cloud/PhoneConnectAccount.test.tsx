import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { cloneElement, type ReactElement, type ReactNode, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const test = vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    symbaHost: { protocolVersion: 2, connectAccount: true },
    open: vi.fn(),
  });
  return { navigate: vi.fn(), closeSidebar: vi.fn(), configured: true, status: vi.fn() };
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
  const account = module.createPhoneConnectAccount({
    status: async () => test.status() ?? signedOut(),
    begin: async () => ({
      authorizationUrl: "https://accounts.example.test/authorize",
      requestId: "test-attempt",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
    complete: async () => ({
      ...signedOut(),
      state: "signed-in",
      account: { id: "phone-account", email: "phone@example.test" },
    }),
    cancel: async () => signedOut(),
    logout: async () => signedOut(),
    token: async () => ({ token: null }),
  });
  return { ...module, phoneConnectAccount: account };
});
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));
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
import { PhoneConnectAccountSection, PhoneConnectSidebarEntry } from "./PhoneConnectAccount";
let renderer: ReactTestRenderer;
const button = (label: string) =>
  renderer.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const displayedText = () => JSON.stringify(renderer.toJSON());
beforeEach(async () => {
  test.configured = true;
  test.status.mockReset();
  test.navigate.mockClear();
  test.closeSidebar.mockClear();
  await phoneConnectAccount.logout();
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
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
      </>,
    );
  });
}

describe("phone Connect controls", () => {
  it("keeps the account entry discoverable and reaches the Connections body while disabled", async () => {
    test.configured = false;
    await phoneConnectAccount.refresh();
    await mount();
    expect(displayedText()).toContain("Not configured on this phone");
    expect(button("Sign in to Lecturn Connect").props.disabled).toBe(true);
    await act(async () => renderer.root.findByType("a").props.onClick());
    expect(test.navigate).toHaveBeenCalledWith("/settings/connections");
    expect(test.closeSidebar).toHaveBeenCalledWith(false);
    test.configured = true;
    await act(async () => button("Refresh status").props.onClick());
    expect(button("Sign in to Lecturn Connect").props.disabled).toBe(false);
  });

  it("runs sign-in, open/copy, pasted return, and logout through the real account state", async () => {
    await mount();
    await act(async () => button("Sign in to Lecturn Connect").props.onClick());
    expect(displayedText()).toContain("Waiting for return code");
    await act(async () => button("Open browser").props.onClick());
    expect(window.open).toHaveBeenCalledOnce();
    await act(async () => button("Copy sign-in link").props.onClick());
    expect(displayedText()).toContain("Sign-in link copied.");
    await act(async () =>
      renderer.root.findByType("input").props.onChange({ target: { value: "entire-code" } }),
    );
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(displayedText()).toContain("phone@example.test");
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
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
      expect(phoneConnectAccount.getSnapshot().authorization?.requestId).toBe("test-attempt");
      expect(button("Open browser")).toBeDefined();
    },
  );

  it("cancels without leaving the return code or link visible and reports clipboard failure", async () => {
    await mount();
    await act(async () => button("Sign in to Lecturn Connect").props.onClick());
    vi.stubGlobal("navigator", {});
    await act(async () => button("Copy sign-in link").props.onClick());
    expect(displayedText()).toContain("Could not copy the link");
    await act(async () =>
      renderer.root.findByType("input").props.onChange({ target: { value: "discard-me" } }),
    );
    await act(async () => button("Cancel sign-in").props.onClick());
    expect(displayedText()).toContain("Signed out");
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(phoneConnectAccount.getSnapshot().authorization).toBeNull();
  });
});
