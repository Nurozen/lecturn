import { useEffect, type ReactNode } from "react";
import {
  setManagedRelayPrimaryAccount,
  syncManagedRelaySessions,
} from "@lecturn/client-runtime/relay";
import { runAtomCommand } from "@lecturn/client-runtime/state/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentCatalog } from "../connection/catalog";
import { connectAccountProfilesAtom } from "./connectAccounts";
import {
  knownConnectAccountsAtom,
  KNOWN_ACCOUNTS_STORAGE_KEY,
  KnownAccountsDocument,
} from "./knownAccounts";
import { setLocalStorageItem } from "../hooks/useLocalStorage";
import { phoneConnectAccount } from "./phoneConnectAccount";
import { recordSignedOutAccount } from "./accountGone";
import { resetRelayTokenCache } from "./relayTokenCache";

/**
 * Binds the native Connect account to managed relay sessions until the returned
 * cleanup runs. Module-level so the shell compiles: its generation counter and
 * lazy import are outside what the React Compiler handles.
 */
function bindPhoneConnectAccount(): () => void {
  let disposed = false;
  let generation = 0;
  let lastStatus = phoneConnectAccount.getSnapshot().status;
  let transition = Promise.resolve();
  let appliedKey: string | undefined;
  const sync = () => {
    const status = phoneConnectAccount.getSnapshot().status;
    if (!status || status === lastStatus) return;
    lastStatus = status;
    const account = status.configured && status.state === "signed-in" ? status.account : null;
    const key = JSON.stringify([account?.id ?? null, status.relayUrl]);
    if (key === appliedKey) return;
    // A return to the last account must supersede pending sign-out cleanup.
    appliedKey = undefined;
    const version = ++generation;
    // Stop old account credentials before any asynchronous cleanup runs.
    setManagedRelayPrimaryAccount(appAtomRegistry, null);
    syncManagedRelaySessions(appAtomRegistry, []);
    const known = appAtomRegistry.get(knownConnectAccountsAtom);
    appAtomRegistry.set(knownConnectAccountsAtom, {
      ...known,
      needsSignIn: known.accountIds,
      synced: true,
    });
    // Restoring or refreshing a session is not sign-out. Keep saved data
    // until native confirms the session ended or a different account signs in.
    if (
      status.state === "loading" ||
      status.state === "error" ||
      status.state === "authorizing" ||
      !status.configured
    )
      return;
    transition = transition
      .catch(() => undefined)
      .then(async () => {
        if (disposed || version !== generation) return;
        const previous = appAtomRegistry.get(knownConnectAccountsAtom).accountIds;
        for (const id of previous.filter((id) => id !== account?.id)) {
          recordSignedOutAccount(appAtomRegistry, id);
          const result = await runAtomCommand(
            appAtomRegistry,
            environmentCatalog.removeRelayEnvironments,
            { accountId: id },
            { reportFailure: false, reportDefect: false },
          );
          if (disposed || version !== generation) return;
          const reset = await resetRelayTokenCache(id);
          if (disposed || version !== generation) return;
          if (result._tag !== "Success" || reset._tag !== "Success") {
            phoneConnectAccount.setRuntimeError(
              "Could not clear the previous account's local connections. Refresh status to retry.",
            );
            return;
          }
          const { clearEnvironmentOwnedState } = await import("../environmentOwnedState");
          if (disposed || version !== generation) return;
          result.value.forEach(clearEnvironmentOwnedState);
        }
        if (disposed || version !== generation) return;
        appliedKey = key;
        phoneConnectAccount.setRuntimeError(null);
        const ids = account ? [account.id] : [];
        appAtomRegistry.set(knownConnectAccountsAtom, {
          accountIds: ids,
          needsSignIn: [],
          synced: true,
        });
        try {
          setLocalStorageItem(
            KNOWN_ACCOUNTS_STORAGE_KEY,
            { accountIds: ids },
            KnownAccountsDocument,
          );
        } catch {
          /* Account remains usable without local storage. */
        }
        appAtomRegistry.set(
          connectAccountProfilesAtom,
          new Map(account ? [[account.id, { email: account.email ?? "Connect account" }]] : []),
        );
        setManagedRelayPrimaryAccount(appAtomRegistry, account?.id ?? null);
        syncManagedRelaySessions(
          appAtomRegistry,
          account
            ? [
                {
                  accountId: account.id,
                  readClerkToken: () => phoneConnectAccount.readToken(account.id),
                },
              ]
            : [],
        );
      })
      .catch(() => {
        if (!disposed && version === generation)
          phoneConnectAccount.setRuntimeError(
            "Could not prepare Connect connections. Refresh status to retry.",
          );
      });
  };
  lastStatus = null;
  const unsubscribe = phoneConnectAccount.subscribe(sync);
  sync();
  void phoneConnectAccount.refresh();
  // Native AuthActivity dismissal may leave WebView focus/visibility unchanged.
  const refreshNative = () => {
    void phoneConnectAccount.refresh();
  };
  const refresh = () => {
    if (document.visibilityState === "visible") refreshNative();
  };
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("focus", refresh);
  window.addEventListener("lecturn:connect-changed", refreshNative);
  return () => {
    disposed = true;
    unsubscribe();
    document.removeEventListener("visibilitychange", refresh);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("lecturn:connect-changed", refreshNative);
    setManagedRelayPrimaryAccount(appAtomRegistry, null);
    syncManagedRelaySessions(appAtomRegistry, []);
  };
}

export default function PhoneManagedAuthShell({
  children,
}: {
  readonly children: ReactNode;
  readonly publishableKey?: string;
}) {
  useEffect(() => bindPhoneConnectAccount(), []);
  return children;
}
