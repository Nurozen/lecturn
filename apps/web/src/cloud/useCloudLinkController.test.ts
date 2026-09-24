import { Cause } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  supportsDecisions: false,
  fundingState: "active",
  queryFunding: vi.fn(),
  selectedTeam: null as string | null,
  teamList: vi.fn(async () => ({
    organizations: [
      { organizationId: "org_test", hasAccess: true, policy: { publishAgentActivity: true } },
    ],
  })),
  billingStatus: vi.fn(async () => ({ state: "active", hasAccess: true })),
  userId: "account-b",
  isSignedIn: true,
  known: { accountIds: [] as string[], needsSignIn: [] as string[], synced: true },
  setActive: vi.fn(async () => undefined),
  getToken: vi.fn(async (_accountId?: string): Promise<string | null> => "token"),
  state: {
    deviceRelayConflict: null as string | null,
    linked: true,
    organizationId: null as string | null,
    cloudUserId: "account-a",
    managedTunnelActive: true,
    publishAgentActivity: true,
  },
  link: vi.fn(async () => ({ _tag: "Success" })),
  unlink: vi.fn(async () => ({ _tag: "Success" })),
  funding: vi.fn(async (): Promise<{ _tag: string; cause?: unknown }> => ({ _tag: "Success" })),
  preferences: vi.fn(async () => ({ _tag: "Success" })),
  refresh: vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({ environment: { capabilities: { threadDecisions: mocks.supportsDecisions } } }),
  },
}));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../state/threadDecisions", () => ({
  threadDecisionEnvironment: { fundingStatus: () => "funding-status", funding: "funding" },
}));
vi.mock("@lecturn/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lecturn/client-runtime/state/runtime")>()),
  executeAtomQuery: () => mocks.queryFunding(),
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
  useAtomCommand: (key: "link" | "unlink" | "preferences" | "refresh" | "funding") => mocks[key],
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
  resolveRelayClerkTokenOptions: () => ({}),
  resolveCloudPublicConfig: () => ({ relayUrl: "https://relay.example.com" }),
}));

import { useCloudLinkController } from "./useCloudLinkController";

describe("Connect account ownership during reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supportsDecisions = false;
    mocks.funding.mockResolvedValue({ _tag: "Success" });
    mocks.queryFunding.mockResolvedValue({ _tag: "Success", value: { state: "active" } });
    mocks.selectedTeam = null;
    mocks.state.organizationId = null;
    mocks.state.deviceRelayConflict = null;
    mocks.billingStatus.mockResolvedValue({ state: "active", hasAccess: true });
    mocks.userId = "account-b";
    mocks.isSignedIn = true;
    mocks.getToken.mockResolvedValue("token");
    mocks.state.linked = true;
    mocks.state.managedTunnelActive = true;
    mocks.state.publishAgentActivity = true;
    mocks.known = { accountIds: [], needsSignIn: [], synced: true };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("creates a funding-only personal link without enabling publishing or a tunnel", async () => {
    mocks.userId = "account-a";
    mocks.state.linked = false;
    mocks.selectedTeam = "org_test";
    expect(
      await useCloudLinkController().reconcileCloudState({
        managedTunnel: false,
        publish: false,
        decisions: true,
      }),
    ).toBe(true);
    expect(mocks.link).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "decisions", publishAgentActivity: false }),
    );
    expect(mocks.link).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org_test" }),
    );
    expect(mocks.teamList).not.toHaveBeenCalled();
    expect(mocks.billingStatus).not.toHaveBeenCalled();
  });
  it("preserves active or pending funding when tunnel and publishing are switched off", async () => {
    mocks.userId = "account-a";
    mocks.supportsDecisions = true;
    for (const state of ["active", "pending"]) {
      mocks.queryFunding.mockResolvedValue({ _tag: "Success", value: { state } });
      expect(
        await useCloudLinkController().reconcileCloudState({
          managedTunnel: false,
          publish: false,
        }),
      ).toBe(true);
    }
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.link).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "decisions", publishAgentActivity: false }),
    );
  });
  it("fails closed on an unavailable funding check instead of destroying the link", async () => {
    mocks.userId = "account-a";
    mocks.supportsDecisions = true;
    mocks.queryFunding.mockResolvedValue({ _tag: "Success", value: { state: "unavailable" } });
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: false, publish: false }),
    ).toBe(false);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("explicit unlink revokes funding before clearing the cloud link, even when cloud status is unavailable", async () => {
    mocks.userId = "account-a";
    mocks.supportsDecisions = true;
    mocks.queryFunding.mockResolvedValue({
      _tag: "Success",
      value: { state: "unavailable", generation: 4 },
    });
    expect(
      await useCloudLinkController().reconcileCloudState({
        managedTunnel: false,
        publish: false,
        unlink: true,
      }),
    ).toBe(true);
    expect(mocks.funding).toHaveBeenCalledWith({
      environmentId: "desktop",
      input: { operation: "revoke", expectedGeneration: 4 },
    });
    expect(mocks.funding.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.unlink.mock.invocationCallOrder[0]!,
    );
    expect(mocks.unlink).toHaveBeenCalledOnce();
  });
  it("does not report an unlink when the host funding revoke failed", async () => {
    mocks.userId = "account-a";
    mocks.supportsDecisions = true;
    mocks.queryFunding.mockResolvedValue({
      _tag: "Success",
      value: { state: "active", generation: 2 },
    });
    mocks.funding.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    expect(
      await useCloudLinkController().reconcileCloudState({
        managedTunnel: false,
        publish: false,
        unlink: true,
      }),
    ).toBe(false);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("allows unlink after funding is explicitly revoked", async () => {
    mocks.userId = "account-a";
    mocks.supportsDecisions = true;
    mocks.queryFunding.mockResolvedValue({ _tag: "Success", value: { state: "revoked" } });
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: false, publish: false }),
    ).toBe(true);
    expect(mocks.unlink).toHaveBeenCalledOnce();
  });

  it("reacquires a conflicted managed relay without changing its mode or publishing preference", async () => {
    mocks.userId = "account-a";
    mocks.state.deviceRelayConflict = "Relay in use by another installation";
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
    ).toBe(true);
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mode: "managed", publishAgentActivity: true }),
    );
    expect(mocks.preferences).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ publishAgentActivity: true }),
    );
  });

  it("reacquires activity-only publishing without enabling a managed tunnel", async () => {
    mocks.userId = "account-a";
    mocks.state.managedTunnelActive = false;
    mocks.state.deviceRelayConflict = "Relay in use by another installation";
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: false, publish: true }),
    ).toBe(true);
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mode: "publish_only", publishAgentActivity: true }),
    );
  });

  it("does not restart a healthy relay for a preference-only update", async () => {
    mocks.userId = "account-a";
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: false }),
    ).toBe(true);
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.preferences).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ publishAgentActivity: false }),
    );
  });

  it("cannot use retry to take another account's conflicted relay", async () => {
    mocks.state.deviceRelayConflict = "Relay in use by another installation";
    expect(
      await useCloudLinkController().reconcileCloudState({ managedTunnel: true, publish: true }),
    ).toBe(false);
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.preferences).not.toHaveBeenCalled();
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
    const onSelectAccount = vi.fn();

    const controller = useCloudLinkController({ accountId: "account-b", onSelectAccount });
    expect(controller.accountMismatchMessage).toBe(
      "a@example.com published this computer. Choose it to change publishing, or unlink this computer.",
    );
    expect(controller.unlinkBlocked).toBe(false);
    expect(controller.accountMismatchAction?.label).toBe("Use a@example.com");
    controller.accountMismatchAction?.run();
    expect(onSelectAccount).toHaveBeenCalledExactlyOnceWith("account-a");
    expect(mocks.setActive).not.toHaveBeenCalled();

    mocks.known = { ...mocks.known, needsSignIn: ["account-a"] };
    const expired = useCloudLinkController({ accountId: "account-b", onSelectAccount });
    expect(expired.accountMismatchMessage).toContain("Sign in to it again");
    expect(expired.accountMismatchAction).toBeNull();

    // A publisher this client never held is still a stranger.
    mocks.known = { accountIds: ["account-b"], needsSignIn: [], synced: true };
    expect(useCloudLinkController().accountMismatchMessage).toContain("Sign out");
  });

  it("acts as the chosen account, not Clerk's active one, with that account's token", async () => {
    mocks.known = { accountIds: ["account-a", "account-b"], needsSignIn: [], synced: true };
    mocks.state.linked = false;
    mocks.getToken.mockImplementation(async (accountId?: string) => `token-of-${accountId}`);
    const controller = useCloudLinkController({ accountId: "account-a" });
    expect(controller.isSignedIn).toBe(true);
    expect(await controller.reconcileCloudState({ managedTunnel: true, publish: true })).toBe(true);
    expect(mocks.getToken.mock.calls.every(([accountId]) => accountId === "account-a")).toBe(true);
    expect(mocks.link).toHaveBeenCalledWith(
      expect.objectContaining({ clerkToken: "token-of-account-a" }),
    );
    expect(await controller.checkSubscription()).toBe(true);
    expect(mocks.getToken.mock.calls.every(([accountId]) => accountId === "account-a")).toBe(true);
  });

  it("treats a chosen account that needs sign-in as signed out", () => {
    mocks.known = {
      accountIds: ["account-a", "account-b"],
      needsSignIn: ["account-a"],
      synced: true,
    };
    expect(useCloudLinkController({ accountId: "account-a" }).isSignedIn).toBe(false);
  });

  it("unlinks a known publisher's link with the publisher's token, and refuses to relink over it", async () => {
    mocks.known = { accountIds: ["account-a", "account-b"], needsSignIn: [], synced: true };
    mocks.getToken.mockImplementation(async (accountId?: string) => `token-of-${accountId}`);
    const controller = useCloudLinkController({ accountId: "account-b" });
    expect(await controller.reconcileCloudState({ managedTunnel: true, publish: true })).toBe(
      false,
    );
    expect(mocks.link).not.toHaveBeenCalled();
    expect(await controller.reconcileCloudState({ managedTunnel: false, publish: false })).toBe(
      true,
    );
    expect(mocks.unlink).toHaveBeenCalledWith({
      target: { environmentId: "desktop" },
      clerkToken: "token-of-account-a",
    });

    // A publisher that needs sign-in has no token: only the local relay stops.
    mocks.known = { ...mocks.known, needsSignIn: ["account-a"] };
    mocks.unlink.mockClear();
    expect(
      await useCloudLinkController({ accountId: "account-b" }).reconcileCloudState({
        managedTunnel: false,
        publish: false,
      }),
    ).toBe(true);
    expect(mocks.unlink).toHaveBeenCalledWith({
      target: { environmentId: "desktop" },
      clerkToken: null,
    });
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
    mocks.supportsDecisions = false;
    mocks.funding.mockResolvedValue({ _tag: "Success" });
    mocks.queryFunding.mockResolvedValue({ _tag: "Success", value: { state: "active" } });
    mocks.selectedTeam = null;
    mocks.state.organizationId = null;
    mocks.state.deviceRelayConflict = null;
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
    mocks.supportsDecisions = false;
    mocks.funding.mockResolvedValue({ _tag: "Success" });
    mocks.queryFunding.mockResolvedValue({ _tag: "Success", value: { state: "active" } });
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
      mocks.state.deviceRelayConflict = null;
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
