import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  selectedTeam: null as string | null,
  teamList: vi.fn(async () => ({
    organizations: [
      { organizationId: "org_test", hasAccess: true, policy: { publishAgentActivity: true } },
    ],
  })),
  billingStatus: vi.fn(async () => ({ state: "active", hasAccess: true })),
  userId: "account-b",
  isSignedIn: true,
  connectMultiAccount: false,
  known: { accountIds: [] as string[], needsSignIn: [] as string[], synced: true },
  setActive: vi.fn(async () => undefined),
  getToken: vi.fn(async (): Promise<string | null> => "token"),
  state: {
    linked: true,
    organizationId: null as string | null,
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
  useAuth: () => ({ isSignedIn: mocks.isSignedIn, userId: mocks.userId }),
  useClerk: () => ({
    client: { signedInSessions: [{ id: "session-a", user: { id: "account-a" } }] },
    setActive: mocks.setActive,
  }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: "known" | "profiles") =>
    atom === "known" ? mocks.known : new Map([["account-a", { email: "a@example.com" }]]),
}));
vi.mock("./knownAccounts", () => ({ knownConnectAccountsAtom: "known" }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("react", () => ({
  useState: () => [null, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => unknown) => {
    effect();
  },
}));
vi.mock("@lecturn/client-runtime/relay", () => ({
  createBillingClient: () => ({ getStatus: mocks.billingStatus }),
  selectedTeam: () => mocks.selectedTeam,
  createTeamsClient: () => ({ list: mocks.teamList }),
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
vi.mock("./accountTokens", () => ({ readToken: mocks.getToken }));
vi.mock("./publicConfig", () => ({
  get connectMultiAccount() {
    return mocks.connectMultiAccount;
  },
  resolveRelayClerkTokenOptions: () => ({}),
  resolveCloudPublicConfig: () => ({ relayUrl: "https://relay.example.com" }),
}));

import { useCloudLinkController } from "./useCloudLinkController";

describe("Connect account ownership during reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectedTeam = null;
    mocks.state.organizationId = null;
    mocks.billingStatus.mockResolvedValue({ state: "active", hasAccess: true });
    mocks.userId = "account-b";
    mocks.isSignedIn = true;
    mocks.getToken.mockResolvedValue("token");
    mocks.state.linked = true;
    mocks.connectMultiAccount = false;
    mocks.known = { accountIds: [], needsSignIn: [], synced: true };
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

  it("offers the publishing account instead of a sign-out once it is one of this client's", () => {
    mocks.known = { accountIds: ["account-a", "account-b"], needsSignIn: [], synced: true };
    // A single-account build keeps its advice, whatever the known list says.
    expect(useCloudLinkController().accountMismatchMessage).toContain("Sign out");
    expect(useCloudLinkController().accountMismatchAction).toBeNull();

    mocks.connectMultiAccount = true;
    const controller = useCloudLinkController();
    expect(controller.accountMismatchMessage).toBe(
      "a@example.com published this computer. Make it the active account to change publishing.",
    );
    expect(controller.accountMismatchAction?.label).toBe("Make a@example.com active");
    controller.accountMismatchAction?.run();
    expect(mocks.setActive).toHaveBeenCalledExactlyOnceWith({ session: "session-a" });

    mocks.known = { ...mocks.known, needsSignIn: ["account-a"] };
    const expired = useCloudLinkController();
    expect(expired.accountMismatchMessage).toContain("Sign in to it again");
    expect(expired.accountMismatchAction).toBeNull();

    // A publisher this client never held is still a stranger.
    mocks.known = { accountIds: ["account-b"], needsSignIn: [], synced: true };
    expect(useCloudLinkController().accountMismatchMessage).toContain("Sign out");
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
    mocks.selectedTeam = null;
    mocks.state.organizationId = null;
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

describe("company funding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = "account-a";
    mocks.isSignedIn = true;
    mocks.state.linked = false;
    mocks.selectedTeam = "org_test";
    mocks.getToken.mockResolvedValue("token");
    mocks.teamList.mockResolvedValue({
      organizations: [
        { organizationId: "org_test", hasAccess: true, policy: { publishAgentActivity: true } },
      ],
    });
  });
  it("publishes with the explicitly selected company without consulting personal billing", async () => {
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
    ).toBe(true);
    expect(mocks.billingStatus).not.toHaveBeenCalled();
    expect(mocks.link).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org_test" }),
    );
  });
  it("does not publish for a member without company access", async () => {
    mocks.teamList.mockResolvedValue({
      organizations: [
        { organizationId: "org_test", hasAccess: false, policy: { publishAgentActivity: true } },
      ],
    });
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
    ).toBe(false);
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it("does not publish after funding context changes during preflight", async () => {
    mocks.teamList.mockImplementationOnce(async () => {
      mocks.selectedTeam = null;
      mocks.state.organizationId = null;
      return {
        organizations: [
          { organizationId: "org_test", hasAccess: true, policy: { publishAgentActivity: true } },
        ],
      };
    });
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
    ).toBe(false);
    expect(mocks.link).not.toHaveBeenCalled();
  });
});

it("links a company tunnel without requesting notification capabilities forbidden by policy", async () => {
  vi.clearAllMocks();
  mocks.userId = "account-a";
  mocks.isSignedIn = true;
  mocks.state.linked = false;
  mocks.selectedTeam = "org_test";
  mocks.teamList.mockResolvedValue({
    organizations: [
      { organizationId: "org_test", hasAccess: true, policy: { publishAgentActivity: false } },
    ],
  });
  expect(
    await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
  ).toBe(true);
  expect(mocks.link).toHaveBeenCalledWith(
    expect.objectContaining({ organizationId: "org_test", publishAgentActivity: false }),
  );
  expect(mocks.preferences).toHaveBeenCalledWith(
    expect.objectContaining({ publishAgentActivity: false }),
  );
});

it("preserves company funding on an existing link when Personal is selected", async () => {
  vi.clearAllMocks();
  mocks.userId = "account-a";
  mocks.isSignedIn = true;
  mocks.state.linked = true;
  mocks.state.organizationId = "org_test";
  mocks.state.cloudUserId = "account-a";
  mocks.state.managedTunnelActive = false;
  mocks.selectedTeam = null;
  mocks.teamList.mockResolvedValue({
    organizations: [
      { organizationId: "org_test", hasAccess: true, policy: { publishAgentActivity: true } },
    ],
  });
  expect(
    await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
  ).toBe(true);
  expect(mocks.billingStatus).not.toHaveBeenCalled();
  expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_test" }));
  mocks.state.organizationId = null;
});
