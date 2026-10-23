import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { managedRelaySessionAtom, managedRelaySessionsAtom } from "@lecturn/client-runtime/relay";
import type { PhoneConnectStatus } from "./phoneConnectAccount";

const test = vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return {
    status: vi.fn(),
    begin: vi.fn(),
    token: vi.fn(async () => ({ token: "synthetic.session.jwt" })),
    remove: vi.fn(),
    reset: vi.fn(),
    clear: vi.fn(),
    persist: vi.fn(),
  };
});
vi.mock("./phoneConnectAccount", async (original) => {
  const module = await original<typeof import("./phoneConnectAccount")>();
  const signedOut = {
    configured: true,
    state: "signed-out" as const,
    account: null,
    relayUrl: "https://relay.example.test",
  };
  return {
    ...module,
    phoneConnectAccount: module.createPhoneConnectAccount(
      module.createPhoneConnectApi({
        protocolVersion: 2,
        connectAccount: true,
        nativeConnect: true,
        getAccessState: vi.fn(),
        requestFullAccess: vi.fn(),
        openDeviceAccess: vi.fn(),
        getConnectState: test.status,
        getConnectToken: test.token,
        openConnectSignIn: test.begin,
        signOutConnect: async () => signedOut,
      }),
    ),
  };
});
vi.mock(import("../rpc/atomRegistry"), async (original) => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { ...(await original()), appAtomRegistry: AtomRegistry.make() as never };
});
vi.mock(import("./connectAccounts"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return { ...(await original()), connectAccountProfilesAtom: Atom.make(new Map()) as never };
});
vi.mock(import("../connection/catalog"), async (original) => ({
  ...(await original()),
  environmentCatalog: { removeRelayEnvironments: {} } as never,
}));
vi.mock(import("@lecturn/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((...args: unknown[]) => test.remove(...args)) as never,
}));
vi.mock(import("./relayTokenCache"), async (original) => ({
  ...(await original()),
  resetRelayTokenCache: test.reset as never,
}));
vi.mock(import("../environmentOwnedState"), async (original) => ({
  ...(await original()),
  clearEnvironmentOwnedState: test.clear as never,
}));
vi.mock(import("./accountGone"), async (original) => ({
  ...(await original()),
  recordSignedOutAccount: vi.fn(),
}));

vi.mock(import("../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  getLocalStorageItem: (() => null) as never,
  setLocalStorageItem: test.persist as never,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { knownConnectAccountsAtom } from "./knownAccounts";
import { connectAccountProfilesAtom } from "./connectAccounts";
import { phoneConnectAccount } from "./phoneConnectAccount";
import PhoneManagedAuthShell from "./PhoneManagedAuthShell";
const signedIn: PhoneConnectStatus = {
  configured: true,
  state: "signed-in",
  account: { id: "phone-account", email: "phone@example.test" },
  relayUrl: "https://relay.example.test",
};
const signedOut: PhoneConnectStatus = { ...signedIn, state: "signed-out", account: null };
const authorizing: PhoneConnectStatus = { ...signedOut, state: "authorizing" };
// Sign-out cleanup lazily imports environmentOwnedState; in the browser the mocker
// resolves that import over its RPC channel, so the tail lands after `act` returns.
// That round trip can exceed waitFor's 1s default while the full suite loads the page.
const settledCleanup = (assertions: () => void) => vi.waitFor(assertions, { timeout: 10_000 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
// The page is visible in headless Chromium; an own getter shadows Document's.
function setVisibility(visibilityState: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
}
beforeEach(async () => {
  await phoneConnectAccount.logout();
  test.status.mockReset().mockResolvedValue(signedIn);
  test.begin.mockReset().mockResolvedValue(authorizing);
  setVisibility("visible");
  test.remove.mockReset().mockResolvedValue({ _tag: "Success", value: ["removed-environment"] });
  test.reset.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  test.clear.mockReset();
  test.persist.mockReset();
  test.token.mockClear();
  appAtomRegistry.set(knownConnectAccountsAtom, { accountIds: [], needsSignIn: [], synced: false });
});
afterEach(async () => {
  await act(async () => root?.unmount());
});
afterAll(() => {
  Reflect.deleteProperty(document, "visibilityState");
});
const mount = () =>
  act(async () => {
    root = createRoot(document.createElement("div"));
    root.render(
      <PhoneManagedAuthShell>
        <div />
      </PhoneManagedAuthShell>,
    );
  });

describe("phone account runtime binding", () => {
  it.each([null, signedIn.account])(
    "preserves cached account data through loading with account %s and native restoration",
    async (account) => {
      const saved = {
        accounts: { accountIds: ["phone-account"] },
        connections: new Map([["removed-environment", { accountId: "phone-account" }]]),
        drafts: new Map([["removed-environment", "synthetic unsent draft"]]),
        cache: new Map([["phone-account", "synthetic cached relay entry"]]),
      };
      const original = structuredClone(saved);
      test.persist.mockImplementation((_key, value) => {
        saved.accounts = value;
      });
      test.remove.mockImplementation(async () => {
        const ids = [...saved.connections.keys()];
        saved.connections.clear();
        return { _tag: "Success", value: ids };
      });
      test.clear.mockImplementation((id: string) => saved.drafts.delete(id));
      test.reset.mockImplementation(async (id: string) => {
        saved.cache.delete(id);
        return { _tag: "Success", value: undefined };
      });
      // A cached signed-in snapshot and saved account survive native SDK restart.
      await phoneConnectAccount.refresh();
      appAtomRegistry.set(knownConnectAccountsAtom, {
        accountIds: saved.accounts.accountIds,
        needsSignIn: [],
        synced: false,
      });
      await mount();
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
      test.status.mockResolvedValue({ ...signedIn, state: "loading", account });
      await act(async () => {
        window.dispatchEvent(new Event("lecturn:connect-changed"));
      });
      expect(phoneConnectAccount.getSnapshot().status?.state).toBe("loading");
      expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
      expect(await phoneConnectAccount.readToken("phone-account")).toBeNull();
      expect(test.token).not.toHaveBeenCalled();
      expect(appAtomRegistry.get(knownConnectAccountsAtom).accountIds).toEqual(["phone-account"]);
      expect(saved).toEqual(original);
      expect(test.remove).not.toHaveBeenCalled();
      expect(test.clear).not.toHaveBeenCalled();
      expect(test.reset).not.toHaveBeenCalled();

      test.status.mockResolvedValue(signedIn);
      await act(async () => {
        window.dispatchEvent(new Event("lecturn:connect-changed"));
      });
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
      expect(appAtomRegistry.get(knownConnectAccountsAtom).needsSignIn).toEqual([]);
      expect(saved).toEqual(original);

      // Prove this same fixture actually loses data on explicit sign-out.
      await act(async () => phoneConnectAccount.logout());
      await settledCleanup(() => {
        expect(saved.accounts.accountIds).toEqual([]);
        expect(saved.connections.size).toBe(0);
        expect(saved.drafts.size).toBe(0);
        expect(saved.cache.size).toBe(0);
      });
    },
  );

  it("keeps persisted accounts without installing credentials on an initially loading SDK", async () => {
    test.status.mockResolvedValue({ ...signedOut, state: "loading" });
    await phoneConnectAccount.refresh();
    appAtomRegistry.set(knownConnectAccountsAtom, {
      accountIds: ["phone-account"],
      needsSignIn: [],
      synced: false,
    });
    await mount();
    expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
    expect(appAtomRegistry.get(knownConnectAccountsAtom).accountIds).toEqual(["phone-account"]);
    expect(test.persist).not.toHaveBeenCalled();
    expect(test.remove).not.toHaveBeenCalled();
    expect(test.clear).not.toHaveBeenCalled();
    expect(test.reset).not.toHaveBeenCalled();
    expect(test.token).not.toHaveBeenCalled();
    test.status.mockResolvedValue(signedIn);
    await act(async () => {
      window.dispatchEvent(new Event("lecturn:connect-changed"));
    });
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
    expect(test.remove).not.toHaveBeenCalled();
  });

  it("suspends credentials on refresh failure without deleting saved connections or drafts", async () => {
    await mount();
    test.status.mockResolvedValue({ ...signedIn, state: "error", error: "Refresh failed" });
    await act(async () => {
      await phoneConnectAccount.refresh();
    });
    expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
    expect(appAtomRegistry.get(knownConnectAccountsAtom)).toEqual({
      accountIds: ["phone-account"],
      needsSignIn: ["phone-account"],
      synced: true,
    });
    expect(test.remove).not.toHaveBeenCalled();
    expect(test.clear).not.toHaveBeenCalled();
    test.status.mockResolvedValue({ ...signedIn });
    await act(async () => {
      await phoneConnectAccount.refresh();
    });
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
    expect(test.remove).not.toHaveBeenCalled();
  });
  it.each([
    ["focus", "visible"],
    ["visibilitychange", "visible"],
    ["lecturn:connect-changed", "visible"],
    ["lecturn:connect-changed", "hidden"],
  ])(
    "automatically settles native sign-in and cancellation on %s while %s",
    async (event, visibilityState) => {
      test.status.mockResolvedValue(signedOut);
      await mount();
      await act(async () => phoneConnectAccount.begin());
      expect(phoneConnectAccount.getSnapshot().status?.state).toBe("authorizing");
      expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
      setVisibility(visibilityState as DocumentVisibilityState);
      test.status.mockResolvedValue(signedIn);
      test.status.mockClear();
      await act(async () => {
        (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
      });
      expect(test.status).toHaveBeenCalledOnce();
      expect(phoneConnectAccount.getSnapshot().status?.state).toBe("signed-in");
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
      expect(appAtomRegistry.get(knownConnectAccountsAtom)).toEqual({
        accountIds: ["phone-account"],
        needsSignIn: [],
        synced: true,
      });
      expect(appAtomRegistry.get(connectAccountProfilesAtom).get("phone-account")?.email).toBe(
        "phone@example.test",
      );
      await act(async () => phoneConnectAccount.logout());
      await act(async () => phoneConnectAccount.begin());
      expect(phoneConnectAccount.getSnapshot().status?.state).toBe("authorizing");
      test.status.mockResolvedValue(signedOut);
      test.status.mockClear();
      await act(async () => {
        (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
      });
      expect(test.status).toHaveBeenCalledOnce();
      expect(phoneConnectAccount.getSnapshot().status?.state).toBe("signed-out");
      expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
      await settledCleanup(() => {
        expect(appAtomRegistry.get(knownConnectAccountsAtom).accountIds).toEqual([]);
        expect(appAtomRegistry.get(connectAccountProfilesAtom).size).toBe(0);
      });
    },
  );

  it("queues native return during the opening receipt without concurrent mutations", async () => {
    test.status.mockResolvedValue(signedOut);
    await mount();
    const opening = deferred<PhoneConnectStatus>();
    test.begin.mockReturnValueOnce(opening.promise);
    await act(async () => {
      const begin = phoneConnectAccount.begin();
      await phoneConnectAccount.begin();
      test.status.mockClear().mockResolvedValue(signedIn);
      window.dispatchEvent(new Event("lecturn:connect-changed"));
      expect(phoneConnectAccount.getSnapshot().busy).toBe(true);
      expect(test.status).not.toHaveBeenCalled();
      opening.resolve(authorizing);
      await begin;
    });
    expect(test.begin).toHaveBeenCalledOnce();
    expect(test.status).toHaveBeenCalledOnce();
    expect(phoneConnectAccount.getSnapshot()).toMatchObject({ busy: false, status: signedIn });
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
  });

  it("queues native return behind an earlier status read without concurrent reads", async () => {
    const earlier = deferred<PhoneConnectStatus>();
    test.status.mockReturnValueOnce(earlier.promise);
    await mount();
    expect(test.status).toHaveBeenCalledOnce();
    test.status.mockResolvedValue(signedIn);
    await act(async () => {
      window.dispatchEvent(new Event("lecturn:connect-changed"));
      window.dispatchEvent(new Event("lecturn:connect-changed"));
      expect(test.status).toHaveBeenCalledOnce();
      earlier.resolve(authorizing);
      await earlier.promise;
    });
    expect(test.status).toHaveBeenCalledTimes(2);
    expect(phoneConnectAccount.getSnapshot().status?.state).toBe("signed-in");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
    expect(appAtomRegistry.get(knownConnectAccountsAtom).accountIds).toEqual(["phone-account"]);
  });

  it("stops lifecycle refreshes and relay activation after unmount", async () => {
    await mount();
    await act(async () => root.unmount());
    test.status.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("lecturn:connect-changed"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(test.status).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
  });

  it("preserves saved connections during native sign-in and transport errors", async () => {
    await mount();
    test.status.mockResolvedValue({ ...signedIn, state: "authorizing", account: null });
    await act(async () => phoneConnectAccount.refresh());
    expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
    expect(test.remove).not.toHaveBeenCalled();
    expect(test.clear).not.toHaveBeenCalled();
    test.status.mockRejectedValueOnce(new Error("private detail"));
    await act(async () => phoneConnectAccount.refresh());
    expect(test.remove).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(knownConnectAccountsAtom).accountIds).toEqual(["phone-account"]);
    test.status.mockResolvedValue(signedIn);
    await act(async () => phoneConnectAccount.refresh());
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
    expect(test.remove).not.toHaveBeenCalled();
  });

  it.effect(
    "binds identity, profile and native token into existing managed sessions without refreshing their identity",
    () =>
      Effect.gen(function* () {
        const session = yield* Effect.promise(async () => {
          await mount();
          const session = appAtomRegistry.get(managedRelaySessionAtom);
          expect(session?.accountId).toBe("phone-account");
          expect(appAtomRegistry.get(knownConnectAccountsAtom)).toEqual({
            accountIds: ["phone-account"],
            needsSignIn: [],
            synced: true,
          });
          expect(appAtomRegistry.get(connectAccountProfilesAtom).get("phone-account")?.email).toBe(
            "phone@example.test",
          );
          await act(async () => {
            await phoneConnectAccount.refresh();
          });
          expect(appAtomRegistry.get(managedRelaySessionAtom)).toBe(session);
          return session;
        });
        expect(yield* session!.readClerkToken()).not.toBeNull();
      }),
  );

  it("revokes managed sessions and cleans account-owned remote data on logout", async () => {
    await mount();
    await act(async () => {
      await phoneConnectAccount.logout();
    });
    expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
    expect(test.remove).toHaveBeenCalledWith(
      appAtomRegistry,
      {},
      { accountId: "phone-account" },
      expect.anything(),
    );
    expect(test.reset).toHaveBeenCalledWith("phone-account");
    await settledCleanup(() => {
      expect(test.clear.mock.calls.map((call) => call[0])).toContain("removed-environment");
      expect(appAtomRegistry.get(knownConnectAccountsAtom).accountIds).toEqual([]);
      expect(appAtomRegistry.get(connectAccountProfilesAtom).size).toBe(0);
    });
  });

  it.effect("restores A when A signs in again while sign-out cleanup is pending", () =>
    Effect.gen(function* () {
      const session = yield* Effect.promise(async () => {
        const cleanup = deferred<{ _tag: "Success"; value: string[] }>();
        const started = deferred<void>();
        await mount();
        expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
        test.persist.mockClear();
        test.remove.mockImplementationOnce(() => {
          started.resolve();
          return cleanup.promise;
        });
        await act(async () => {
          await phoneConnectAccount.logout();
          await started.promise;
        });
        expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
        await act(async () => {
          await phoneConnectAccount.refresh();
        });
        expect(phoneConnectAccount.getSnapshot().status?.account?.id).toBe("phone-account");
        expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
        await act(async () => {
          cleanup.resolve({ _tag: "Success", value: ["removed-environment"] });
          await cleanup.promise;
        });
        expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
        expect(appAtomRegistry.get(knownConnectAccountsAtom)).toEqual({
          accountIds: ["phone-account"],
          needsSignIn: [],
          synced: true,
        });
        expect(appAtomRegistry.get(connectAccountProfilesAtom).get("phone-account")?.email).toBe(
          "phone@example.test",
        );
        expect(test.persist.mock.calls.map((call) => call[1])).toEqual([
          { accountIds: ["phone-account"] },
        ]);
        const session = appAtomRegistry.get(managedRelaySessionAtom)!;
        return session;
      });
      expect(yield* session.readClerkToken()).toBe("synthetic.session.jwt");
    }),
  );

  it("blocks new account activation until failed cleanup is retried", async () => {
    appAtomRegistry.set(knownConnectAccountsAtom, {
      accountIds: ["old-account"],
      needsSignIn: [],
      synced: true,
    });
    test.remove.mockResolvedValue({ _tag: "Failure" });
    await mount();
    expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
    expect(phoneConnectAccount.getSnapshot().error).toContain("previous account");
    test.remove.mockResolvedValue({ _tag: "Success", value: ["removed-environment"] });
    await act(async () => {
      await phoneConnectAccount.refresh();
    });
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
    expect(phoneConnectAccount.getSnapshot().error).toBeNull();
  });
});
