import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ info: vi.fn(), approve: vi.fn(), userId: "account" }));
vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => ({ isLoaded: true, userId: mocks.userId })) as never,
  useUser: (() => ({ user: { fullName: "Test account" } })) as never,
  useClerk: (() => ({})) as never,
  UserButton: (() => null) as never,
}));
vi.mock(import("../cloud/decisionFundingApproval"), async (original) => ({
  ...(await original()),
  decisionFundingApprovalClient: (() => mocks) as never,
}));
vi.mock(import("../cloud/extensionsFundingApproval"), async (original) => ({
  ...(await original()),
  extensionFundingApprovalClient: (() => mocks) as never,
}));
vi.mock(import("./clerk/ConnectAccountPicker"), async (original) => ({
  ...(await original()),
  useConnectAccountPicker: (() => ({ accountId: undefined, email: null, picker: null })) as never,
}));
vi.mock(import("./auth/AuthSurfaceShell"), async (original) => ({
  ...(await original()),
  AuthSurfaceShell: (({ children }: { children: ReactNode }) => <div>{children}</div>) as never,
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
let mounted: { root: Root; container: HTMLDivElement } | undefined;
async function mount(element: ReactElement) {
  if (!mounted) {
    const container = document.createElement("div");
    document.body.append(container);
    mounted = { root: createRoot(container), container };
  }
  const { root } = mounted;
  await act(async () => root.render(element));
}
async function render() {
  await mount(<DecisionFundingApprovalPage challengeId="challenge" />);
}
const pageText = () => mounted?.container.textContent ?? "";
const button = (name: string) =>
  [...(mounted?.container.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent === name,
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.userId = "account";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  const current = mounted;
  mounted = undefined;
  if (current) {
    await act(async () => current.root.unmount());
    current.container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      await render();
      expect(pageText()).toContain(message);
      expect(mounted?.container.querySelectorAll('[href="/account/billing"]')).toHaveLength(
        billing ? 1 : 0,
      );
      expect(button("Allow Decisions") !== undefined).toBe(false);
      expect(mocks.approve).not.toHaveBeenCalled();
    },
  );

  it("reloads denied access and allows approval only after eligibility is confirmed", async () => {
    mocks.info
      .mockResolvedValueOnce({ ...info, reason: "stale-billing" })
      .mockResolvedValueOnce({ ...info, eligible: true, reason: "eligible" });
    mocks.approve.mockResolvedValue({ approved: true });
    await render();
    const reload = button("Reload request");
    await act(async () => reload!.click());
    expect(mocks.info).toHaveBeenCalledTimes(2);
    expect(mocks.approve).not.toHaveBeenCalled();
    const approve = button("Allow Decisions");
    expect(approve).toBeDefined();
    await act(async () => approve!.click());
    expect(mocks.approve).toHaveBeenCalledWith("account", "challenge");
    expect(pageText()).toContain("Approved. Return to Lecturn");
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
    await mount(<ExtensionsFundingApprovalPage challengeId="challenge" featureId="contextual" />);
  }
  it("keeps approval distinct from linking and refreshes the host state", async () => {
    mocks.info
      .mockResolvedValueOnce(extensionInfo)
      .mockResolvedValueOnce({ ...extensionInfo, state: "linked" });
    mocks.approve.mockResolvedValue({ state: "approved-awaiting-host" });
    await renderExtension();
    expect(pageText()).toContain("same monthly Extensions token pool");
    const approve = button("Allow Contextual");
    await act(async () => approve!.click());
    expect(pageText()).toContain("Approval alone does not mean the host is linked");
    const refresh = button("Check connection");
    await act(async () => refresh!.click());
    expect(pageText()).toContain("Host connected");
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });
  it.each(["expired", "revoked", "canceled"])(
    "never offers approval for a %s request",
    async (state) => {
      mocks.info.mockResolvedValue({ ...extensionInfo, state });
      await renderExtension();
      expect(pageText()).toContain(`This request is `);
      expect(button("Allow Contextual") !== undefined).toBe(false);
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
    await renderExtension();
    const approve = button("Allow Contextual");
    await act(async () => {
      approve!.click();
    });
    mocks.userId = "another-account";
    mocks.info.mockResolvedValue({ ...extensionInfo, eligible: false, reason: "not-paid" });
    await mount(<ExtensionsFundingApprovalPage challengeId="challenge" featureId="contextual" />);
    await act(async () => finish({ state: "approved-awaiting-host" }));
    expect(pageText()).toContain("does not have an eligible paid membership");
    expect(pageText()).not.toContain("Membership approved");
  });
});
