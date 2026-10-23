import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentId,
  type EnvironmentCloudLinkStateResult,
} from "@lecturn/contracts";
import type { RelayManagedEndpointProviderKind } from "@lecturn/contracts/relay";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  scopes: new Set<string>(),
  snapshot: null as EnvironmentCloudLinkStateResult | null,
  renderedSnapshot: null as EnvironmentCloudLinkStateResult | null,
  relayProviderKind: null as RelayManagedEndpointProviderKind | null,
  getToken: vi.fn<() => Promise<string | null>>(),
  link: vi.fn(),
  unlink: vi.fn(),
  preferences: vi.fn(),
  refreshDiscovery: vi.fn(),
  refreshLink: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("./useConnectAccountAuth"), async (original) => ({
  ...(await original()),
  useConnectAccountAuth: (() => ({ userId: "account-1", isSignedIn: true })) as never,
}));
vi.mock(import("./accountTokens"), async (original) => ({
  ...(await original()),
  readToken: (() => testState.getToken()) as never,
}));
vi.mock(import("./knownAccounts"), async (original) => ({
  ...(await original()),
  knownConnectAccountsAtom: "known" as never,
}));
vi.mock(import("./connectAccounts"), async (original) => ({
  ...(await original()),
  connectAccountProfilesAtom: "profiles" as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) => {
    if (atom === "known") return { accountIds: ["account-1"], needsSignIn: [], synced: true };
    if (atom === "relay-discovery") {
      return {
        environments: new Map(
          testState.relayProviderKind === null
            ? []
            : [
                [
                  "primary",
                  { environment: { endpoint: { providerKind: testState.relayProviderKind } } },
                ],
              ],
        ),
      };
    }
    return new Map();
  }) as never,
}));
vi.mock(import("./accountRelayClients"), async (original) => ({
  ...(await original()),
  createAccountBillingClient: (() => ({
    getStatus: async () => ({ state: "active", hasAccess: true }),
  })) as never,
  createAccountTeamsClient: (() => ({ list: async () => ({ organizations: [] }) })) as never,
}));
vi.mock(import("@lecturn/client-runtime/relay"), async (original) => ({
  ...(await original()),
  selectedTeam: () => null,
}));
vi.mock(import("../rpc/atomRegistry"), async (original) => ({
  ...(await original()),
  appAtomRegistry: { get: () => undefined } as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => "config" } as never,
  };
});
vi.mock(import("../state/threadDecisions"), async (original) => ({
  ...(await original()),
  threadDecisionEnvironment: {
    fundingStatus: () => "funding-status",
    funding: "funding",
  } as never,
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } as never };
});
vi.mock(import("../state/relay"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    relayEnvironmentDiscovery: {
      ...actual.relayEnvironmentDiscovery,
      refresh: testState.refreshDiscovery,
      stateValueAtom: "relay-discovery",
    } as never,
  };
});
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (_environmentId, scope) => testState.scopes.has(scope),
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("./linkEnvironmentAtoms"), async (original) => ({
  ...(await original()),
  linkPrimaryEnvironment: testState.link as never,
  unlinkPrimaryEnvironment: testState.unlink as never,
  updatePrimaryEnvironmentPreferences: testState.preferences as never,
}));
vi.mock(import("./primaryCloudLinkState"), async (original) => ({
  ...(await original()),
  readCachedPrimaryCloudLinkState: () => testState.snapshot,
  usePrimaryCloudLinkState: (() => ({
    target,
    data: testState.renderedSnapshot,
    error: null,
    isPending: false,
    refresh: testState.refreshLink,
  })) as never,
}));
import { useCloudLinkController, type CloudLinkDesiredState } from "./useCloudLinkController";

const target = {
  environmentId: EnvironmentId.make("primary"),
  label: "Primary",
  httpBaseUrl: "http://localhost:3773",
  wsBaseUrl: "ws://localhost:3773/ws",
};
const linkedState: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "account-1",
  relayUrl: "https://relay.example.com",
  relayIssuer: "https://relay.example.com",
  managedTunnelActive: true,
  publishAgentActivity: false,
};

let root: Root | null = null;
let controller: ReturnType<typeof useCloudLinkController> | null = null;

function ControllerProbe() {
  const value = useCloudLinkController();
  useLayoutEffect(() => {
    controller = value;
  });
  return null;
}

async function mountController() {
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<ControllerProbe />));
}

async function reconcile(desired: CloudLinkDesiredState) {
  let succeeded = false;
  await act(async () => {
    if (controller === null) throw new Error("Controller is not mounted.");
    succeeded = await controller.reconcileCloudState(desired);
  });
  return succeeded;
}

function expectNoMutations() {
  expect(testState.link).not.toHaveBeenCalled();
  expect(testState.unlink).not.toHaveBeenCalled();
  expect(testState.preferences).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  testState.scopes = new Set([AuthRelayReadScope, AuthRelayWriteScope]);
  testState.snapshot = linkedState;
  testState.renderedSnapshot = linkedState;
  testState.relayProviderKind = null;
  testState.getToken.mockReset().mockResolvedValue("clerk-token");
  for (const command of [
    testState.link,
    testState.unlink,
    testState.preferences,
    testState.refreshDiscovery,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success({}));
  }
  testState.refreshLink.mockReset();
  testState.toast.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  controller = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCloudLinkController", () => {
  it.each([AuthRelayReadScope, AuthRelayWriteScope])(
    "does not mutate without %s, even with a cached link snapshot",
    async (scope) => {
      await mountController();
      testState.scopes.delete(scope);

      expect(await reconcile({ managedTunnel: true, publish: true })).toBe(false);
      expect(testState.getToken).not.toHaveBeenCalled();
      expectNoMutations();
    },
  );

  it("does not interpret unavailable link state as an unlinked environment", async () => {
    testState.snapshot = null;
    await mountController();

    expect(await reconcile({ managedTunnel: false, publish: true })).toBe(false);
    expect(testState.getToken).not.toHaveBeenCalled();
    expectNoMutations();
  });

  it.each([AuthRelayReadScope, AuthRelayWriteScope])(
    "rechecks %s after requesting the cloud token",
    async (scope) => {
      await mountController();
      testState.getToken.mockImplementationOnce(async () => {
        testState.scopes.delete(scope);
        return "clerk-token";
      });

      expect(await reconcile({ managedTunnel: false, publish: false })).toBe(false);
      expectNoMutations();
    },
  );

  it("stops if the link-state read fails while requesting the cloud token", async () => {
    await mountController();
    testState.getToken.mockImplementationOnce(async () => {
      testState.snapshot = null;
      return "clerk-token";
    });

    expect(await reconcile({ managedTunnel: true, publish: true })).toBe(false);
    expectNoMutations();
  });

  it("uses the latest linked mode to change publishing without replacing the tunnel", async () => {
    testState.snapshot = { ...linkedState, linked: false, managedTunnelActive: false };
    testState.renderedSnapshot = testState.snapshot;
    await mountController();
    testState.getToken.mockImplementationOnce(async () => {
      testState.snapshot = linkedState;
      return "clerk-token";
    });

    expect(await reconcile({ managedTunnel: true, publish: true })).toBe(true);
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.unlink).not.toHaveBeenCalled();
    expect(testState.preferences).toHaveBeenCalledExactlyOnceWith({
      target,
      publishAgentActivity: true,
    });
  });

  it("shows a link the relay holds as publish-only as off and relinks it as managed", async () => {
    testState.relayProviderKind = "manual";
    await mountController();

    expect(controller?.managedTunnelActive).toBe(false);
    expect(controller?.managedTunnelOutOfSync).toBe(true);
    expect(await reconcile({ managedTunnel: true, publish: false })).toBe(true);
    expect(testState.link).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
      mode: "managed",
      publishAgentActivity: false,
    });
  });

  it("shows a revoked link as off and links it again when turned on", async () => {
    testState.snapshot = { ...linkedState, linkRevoked: true };
    testState.renderedSnapshot = testState.snapshot;
    await mountController();
    expect(controller).toMatchObject({
      linked: false,
      linkRevoked: true,
      managedTunnelActive: false,
      managedTunnelOutOfSync: false,
    });

    expect(await reconcile({ managedTunnel: true, publish: false })).toBe(true);
    expect(testState.link).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
      mode: "managed",
      publishAgentActivity: false,
    });
  });

  it("keeps a managed link that the relay also holds as managed", async () => {
    testState.relayProviderKind = "cloudflare_tunnel";
    await mountController();

    expect(controller?.managedTunnelActive).toBe(true);
    expect(controller?.managedTunnelOutOfSync).toBe(false);
    expect(await reconcile({ managedTunnel: true, publish: false })).toBe(true);
    expect(testState.link).not.toHaveBeenCalled();
  });

  it("stops the preference write if management permission is lost after linking", async () => {
    await mountController();
    testState.link.mockImplementationOnce(async () => {
      testState.scopes.delete(AuthRelayWriteScope);
      return AsyncResult.success({});
    });

    expect(await reconcile({ managedTunnel: false, publish: true })).toBe(false);
    expect(testState.link).toHaveBeenCalledOnce();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.refreshLink).toHaveBeenCalledOnce();
  });

  it("still lets an authorized user unlink when the cloud token is unavailable", async () => {
    await mountController();
    testState.getToken.mockRejectedValueOnce(new Error("Cloud sign-in unavailable"));

    expect(await reconcile({ managedTunnel: false, publish: false })).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
  });

  it("unlinks if the link-state read fails while requesting the cloud token", async () => {
    await mountController();
    testState.getToken.mockImplementationOnce(async () => {
      testState.snapshot = null;
      throw new Error("Cloud sign-in unavailable");
    });

    expect(await reconcile({ managedTunnel: false, publish: false })).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.refreshLink).toHaveBeenCalledOnce();
  });
});
