import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  billingStatus: vi.fn(async () => ({ state: "active", hasAccess: true })),
  userId: "account-b",
  isSignedIn: true,
  getToken: vi.fn(async (): Promise<string | null> => "token"),
  state: {
    linked: true,
    cloudUserId: "account-a",
    managedTunnelActive: true,
    publishAgentActivity: true,
  },
  link: vi.fn(async () => ({ _tag: "Success" })),
  unlink: vi.fn(async () => ({ _tag: "Success" })),
  preferences: vi.fn(async () => ({ _tag: "Success" })),
  refresh: vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isSignedIn: mocks.isSignedIn, userId: mocks.userId, getToken: mocks.getToken }),
}));
vi.mock("react", () => ({
  useState: () => [null, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => unknown) => {
    effect();
  },
}));
vi.mock("@lecturn/client-runtime/relay", () => ({
  createBillingClient: () => ({ getStatus: mocks.billingStatus }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../state/relay", () => ({ relayEnvironmentDiscovery: { refresh: "refresh" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (key: "link" | "unlink" | "preferences" | "refresh") => mocks[key],
}));
vi.mock("./linkEnvironmentAtoms", () => ({
  linkPrimaryEnvironment: "link",
  unlinkPrimaryEnvironment: "unlink",
  updatePrimaryEnvironmentPreferences: "preferences",
}));
vi.mock("./primaryCloudLinkState", () => ({
  usePrimaryCloudLinkState: () => ({
    data: mocks.state,
    target: { environmentId: "desktop" },
    refresh: vi.fn(),
  }),
}));
vi.mock("./publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({}),
  resolveCloudPublicConfig: () => ({ relayUrl: "https://relay.example.com" }),
}));

import { useCloudLinkController } from "./useCloudLinkController";

describe("Connect account ownership during reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.billingStatus.mockResolvedValue({ state: "active", hasAccess: true });
    mocks.userId = "account-b";
    mocks.isSignedIn = true;
    mocks.getToken.mockResolvedValue("token");
    mocks.state.linked = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("does not claim publishing succeeded or mutate the old owner's settings after account switching", async () => {
    const controller = useCloudLinkController();
    expect(await controller.reconcileCloudState({ managedTunnel: true, publish: true })).toBe(
      false,
    );
    expect(controller.accountMismatchMessage).toContain("previous owner");
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.preferences).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does not silently remove another account's publication", async () => {
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: false, publish: false }),
    ).toBe(false);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("lets the owning account explicitly stop both publication capabilities", async () => {
    mocks.userId = "account-a";
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: false, publish: false }),
    ).toBe(true);
    expect(mocks.unlink).toHaveBeenCalledOnce();
    expect(mocks.preferences).not.toHaveBeenCalled();
  });

  it("still updates the same account without unnecessarily relinking", async () => {
    mocks.userId = "account-a";
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: false }),
    ).toBe(true);
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.preferences).toHaveBeenCalledOnce();
  });

  it("preserves explicit local unlink while signed out and token retrieval fails", async () => {
    mocks.isSignedIn = false;
    mocks.getToken.mockRejectedValueOnce(new Error("Offline"));
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: false, publish: false }),
    ).toBe(true);
    expect(mocks.unlink).toHaveBeenCalledWith({
      target: { environmentId: "desktop" },
      clerkToken: null,
    });
  });

  it("links an unpublished environment to the new account", async () => {
    mocks.state.linked = false;
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
    ).toBe(true);
    expect(mocks.link).toHaveBeenCalledOnce();
  });
});

describe("Connect subscription preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = "account-a";
    mocks.state.linked = false;
    mocks.isSignedIn = true;
    mocks.getToken.mockResolvedValue("token");
  });
  it("does not install or link an environment before subscription access exists", async () => {
    mocks.billingStatus.mockResolvedValue({ state: "free", hasAccess: false });
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
    ).toBe(false);
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.preferences).not.toHaveBeenCalled();
  });
  it("can continue with the chosen capabilities after access becomes active", async () => {
    mocks.billingStatus
      .mockResolvedValueOnce({ state: "free", hasAccess: false })
      .mockResolvedValueOnce({ state: "trialing", hasAccess: true });
    const controller = useCloudLinkController();
    const desired = { managedTunnel: false, publish: true };
    expect(await controller.reconcileCloudState(desired)).toBe(false);
    expect(await controller.reconcileCloudState(desired)).toBe(true);
    expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({ mode: "publish_only" }));
    expect(mocks.preferences).toHaveBeenCalledWith(
      expect.objectContaining({ publishAgentActivity: true }),
    );
  });
  it("does not mutate when subscription status is unavailable", async () => {
    mocks.billingStatus.mockResolvedValue({ state: "unavailable", hasAccess: false });
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
    ).toBe(false);
    expect(mocks.link).not.toHaveBeenCalled();
  });
});
