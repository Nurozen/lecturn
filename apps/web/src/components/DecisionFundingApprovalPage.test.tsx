import type { ComponentProps, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ info: vi.fn(), approve: vi.fn(), userId: "account" }));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, userId: mocks.userId }),
  useUser: () => ({ user: { fullName: "Test account" } }),
  useClerk: () => ({}),
  UserButton: () => null,
}));
vi.mock("../cloud/decisionFundingApproval", () => ({
  decisionFundingApprovalClient: () => mocks,
}));
vi.mock("../cloud/extensionsFundingApproval", () => ({
  extensionFundingApprovalClient: () => mocks,
}));
vi.mock("./clerk/ConnectAccountPicker", () => ({
  useConnectAccountPicker: () => ({ accountId: undefined, email: null, picker: null }),
}));
vi.mock("./auth/AuthSurfaceShell", () => ({
  AuthSurfaceShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

import {
  DecisionFundingApprovalPage,
  ExtensionsFundingApprovalPage,
} from "./DecisionFundingApprovalPage";

const info = {
  challengeId: "challenge",
  environmentId: "host",
  environmentLabel: "My Mac",
  expiresAt: "2026-09-23T12:00:00.000Z",
  approved: false,
  eligible: false,
};
let renderer: ReactTestRenderer | undefined;
async function render() {
  await act(async () => {
    renderer = create(<DecisionFundingApprovalPage challengeId="challenge" />);
  });
  return renderer!;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = "account";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});

describe("Decisions approval eligibility", () => {
  it.each([
    ["disabled", "disabled for this service", false],
    ["cohort", "current rollout", false],
    ["stale-billing", "verify your current billing status", false],
    ["unavailable", "could not be confirmed", false],
    ["trial", "not available during a trial", true],
    ["not-paid", "does not have an eligible paid membership", true],
    [undefined, "could not be confirmed", false],
  ] as const)(
    "explains %s without misdirecting users to billing",
    async (reason, message, billing) => {
      mocks.info.mockResolvedValue({ ...info, ...(reason ? { reason } : {}) });
      const view = await render();
      expect(JSON.stringify(view.toJSON())).toContain(message);
      expect(view.root.findAllByProps({ href: "/account/billing" })).toHaveLength(billing ? 1 : 0);
      expect(
        view.root.findAllByType("button").some((b) => b.children.join("") === "Allow Decisions"),
      ).toBe(false);
      expect(mocks.approve).not.toHaveBeenCalled();
    },
  );

  it("reloads denied access and allows approval only after eligibility is confirmed", async () => {
    mocks.info
      .mockResolvedValueOnce({ ...info, reason: "stale-billing" })
      .mockResolvedValueOnce({ ...info, eligible: true, reason: "eligible" });
    mocks.approve.mockResolvedValue({ approved: true });
    const view = await render();
    const reload = view.root
      .findAllByType("button")
      .find((b) => b.children.join("") === "Reload request");
    await act(async () => reload!.props.onClick());
    expect(mocks.info).toHaveBeenCalledTimes(2);
    expect(mocks.approve).not.toHaveBeenCalled();
    const approve = view.root
      .findAllByType("button")
      .find((b) => b.children.join("") === "Allow Decisions");
    expect(approve).toBeDefined();
    await act(async () => approve!.props.onClick());
    expect(mocks.approve).toHaveBeenCalledWith("account", "challenge");
    expect(JSON.stringify(view.toJSON())).toContain("Approved. Return to Lecturn");
  });
});

describe("Extensions approval lifecycle", () => {
  const extensionInfo = {
    ...info,
    featureId: "contextual",
    generation: 2,
    state: "awaiting-approval",
    eligible: true,
    reason: "eligible",
  };
  async function renderExtension() {
    await act(async () => {
      renderer = create(
        <ExtensionsFundingApprovalPage challengeId="challenge" featureId="contextual" />,
      );
    });
    return renderer!;
  }
  it("keeps approval distinct from linking and refreshes the host state", async () => {
    mocks.info
      .mockResolvedValueOnce(extensionInfo)
      .mockResolvedValueOnce({ ...extensionInfo, state: "linked" });
    mocks.approve.mockResolvedValue({ state: "approved-awaiting-host" });
    const view = await renderExtension();
    expect(JSON.stringify(view.toJSON())).toContain("same monthly Extensions token pool");
    const approve = view.root
      .findAllByType("button")
      .find((b) => b.children.join("") === "Allow Contextual");
    await act(async () => approve!.props.onClick());
    expect(JSON.stringify(view.toJSON())).toContain(
      "Approval alone does not mean the host is linked",
    );
    const refresh = view.root
      .findAllByType("button")
      .find((b) => b.children.join("") === "Check connection");
    await act(async () => refresh!.props.onClick());
    expect(JSON.stringify(view.toJSON())).toContain("Host connected");
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });
  it.each(["expired", "revoked", "canceled"])(
    "never offers approval for a %s request",
    async (state) => {
      mocks.info.mockResolvedValue({ ...extensionInfo, state });
      const view = await renderExtension();
      expect(JSON.stringify(view.toJSON())).toContain(`This request is `);
      expect(
        view.root.findAllByType("button").some((b) => b.children.join("") === "Allow Contextual"),
      ).toBe(false);
      expect(mocks.approve).not.toHaveBeenCalled();
    },
  );
  it("discards an in-flight approval after switching accounts", async () => {
    let finish!: (value: unknown) => void;
    mocks.info.mockResolvedValue(extensionInfo);
    mocks.approve.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = await renderExtension();
    const approve = view.root
      .findAllByType("button")
      .find((b) => b.children.join("") === "Allow Contextual");
    await act(async () => {
      void approve!.props.onClick();
    });
    mocks.userId = "another-account";
    mocks.info.mockResolvedValue({ ...extensionInfo, eligible: false, reason: "not-paid" });
    await act(async () =>
      view.update(<ExtensionsFundingApprovalPage challengeId="challenge" featureId="contextual" />),
    );
    await act(async () => finish({ state: "approved-awaiting-host" }));
    expect(JSON.stringify(view.toJSON())).toContain("does not have an eligible paid membership");
    expect(JSON.stringify(view.toJSON())).not.toContain("Membership approved");
  });
});
