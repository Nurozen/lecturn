import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { managedRelaySessionAtom, managedRelaySessionsAtom } from "@lecturn/client-runtime/relay";
import type { PhoneConnectStatus } from "./phoneConnectAccount";

const test = vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  return {
    status: vi.fn(),
    token: vi.fn(async () => ({ token: "opaque-test-credential" })),
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
    phoneConnectAccount: module.createPhoneConnectAccount({
      status: test.status,
      token: test.token,
      begin: async () => {
        throw new Error("unused");
      },
      complete: async () => signedOut,
      cancel: async () => signedOut,
      logout: async () => signedOut,
    }),
  };
});
vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("./connectAccounts", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { connectAccountProfilesAtom: Atom.make(new Map()) };
});
vi.mock("../connection/catalog", () => ({ environmentCatalog: { removeRelayEnvironments: {} } }));
vi.mock("@lecturn/client-runtime/state/runtime", () => ({
  runAtomCommand: (...args: unknown[]) => test.remove(...args),
}));
vi.mock("./relayTokenCache", () => ({ resetRelayTokenCache: test.reset }));
vi.mock("../environmentOwnedState", () => ({ clearEnvironmentOwnedState: test.clear }));
vi.mock("./accountGone", () => ({ recordSignedOutAccount: vi.fn() }));

vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => null,
  setLocalStorageItem: test.persist,
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let renderer: ReactTestRenderer;
beforeEach(async () => {
  await phoneConnectAccount.logout();
  test.status.mockResolvedValue(signedIn);
  test.remove.mockReset().mockResolvedValue({ _tag: "Success", value: ["removed-environment"] });
  test.reset.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  test.clear.mockClear();
  test.persist.mockClear();
  appAtomRegistry.set(knownConnectAccountsAtom, { accountIds: [], needsSignIn: [], synced: false });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});
const mount = () =>
  act(async () => {
    renderer = create(
      <PhoneManagedAuthShell>
        <div />
      </PhoneManagedAuthShell>,
    );
  });

describe("phone account runtime binding", () => {
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
  it.effect(
    "binds identity, profile and opaque token into existing managed sessions without refreshing their identity",
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
    expect(test.clear.mock.calls.map((call) => call[0])).toContain("removed-environment");
    expect(appAtomRegistry.get(knownConnectAccountsAtom).accountIds).toEqual([]);
    expect(appAtomRegistry.get(connectAccountProfilesAtom).size).toBe(0);
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
      expect(yield* session.readClerkToken()).toBe("opaque-test-credential");
    }),
  );

  it("blocks new account activation until failed cleanup is retried", async () => {
    appAtomRegistry.set(knownConnectAccountsAtom, {
      accountIds: ["old-account"],
      needsSignIn: [],
      synced: true,
    });
    test.remove.mockResolvedValueOnce({ _tag: "Failure" });
    await mount();
    expect(appAtomRegistry.get(managedRelaySessionsAtom).size).toBe(0);
    expect(phoneConnectAccount.getSnapshot().error).toContain("previous account");
    await act(async () => {
      await phoneConnectAccount.refresh();
    });
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("phone-account");
    expect(phoneConnectAccount.getSnapshot().error).toBeNull();
  });
});
