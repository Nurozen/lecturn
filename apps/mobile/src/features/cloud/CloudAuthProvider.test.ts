import { managedRelaySessionAtom, setManagedRelaySession } from "@lecturn/client-runtime/relay";
import * as Exit from "effect/Exit";
import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { deactivateCloudRelayAccount } from "./CloudAuthProvider";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

vi.mock("@clerk/expo", () => ({
  ClerkProvider: (props: { children: ReactNode }) => props.children,
}));

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(async () => Exit.void),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./MultiAccountCloudAuthBridge", () => ({
  MultiAccountCloudAuthBridge: (props: { readonly children: ReactNode }) => props.children,
}));
vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: vi.fn(async () => undefined),
}));

vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: vi.fn(() => ({
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  resolveRelayClerkTokenOptions: vi.fn(),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  releaseAgentAwarenessRelayTokenProvider: vi.fn(),
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("clears relay and agent-awareness credentials before cleanup can fail", async () => {
    const tokenProvider = async () => "account-1-token";
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-1",
      readClerkToken: tokenProvider,
    });
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    await cleanup;
  });
});
