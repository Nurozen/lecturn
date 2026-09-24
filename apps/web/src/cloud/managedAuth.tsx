import { useProfileStableAccountId } from "./useProfileStableAccountId";
import { initializeAccountAppearance, refreshAccountAppearance } from "./accountAppearance";
import { useAuth, useClerk, useSessionList } from "@clerk/react";
import {
  managedRelaySessionsAtom,
  setManagedRelayPrimaryAccount,
  syncManagedRelaySessions,
} from "@lecturn/client-runtime/relay";
import type { EnvironmentId } from "@lecturn/contracts";
import { reportAtomCommandResult, settlePromise } from "@lecturn/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ConnectAccountCommandsHost } from "../components/clerk/ConnectAccountCommandsHost";
import { toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { recordSignedOutAccount } from "./accountGone";
import { bindAccountTokenClerk, readToken } from "./accountTokens";
import { observeAccountProfiles } from "./connectAccounts";
import {
  forgetKnownAccount,
  knownAccountRemovalsAtom,
  knownConnectAccountsAtom,
  observeClerkSessions,
} from "./knownAccounts";
import { resetRelayTokenCache } from "./relayTokenCache";
import { bindActiveAccountClerk } from "./withActiveAccount";
import { startMultiAccountMarkerHeartbeat } from "./connectAuthCompatibility";

const CLEANUP_RETRY_MS = 5_000;
const CLEANUP_RETRY_MAX_MS = 5 * 60 * 1_000;
const CLEANUP_MAX_RETRIES = 8;
const CLEANUP_FAILED_MESSAGE = "Could not remove the signed-out Connect account's data.";

// Loaded on use: these stores read session state that is built after this provider.
async function sweepViewState(environmentIds: ReadonlyArray<EnvironmentId>): Promise<void> {
  try {
    const { clearEnvironmentOwnedState } = await import("../environmentOwnedState");
    environmentIds.forEach(clearEnvironmentOwnedState);
  } catch (error) {
    console.warn("Could not clear view state after account sign-out.", error);
  }
}

function relaySessionInput(accountId: string) {
  return { accountId, readClerkToken: () => readToken(accountId) };
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const {
    isLoaded,
    isSignedIn,
    userId: clerkUserId,
  } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const userId = useProfileStableAccountId(clerkUserId);
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const clerk = useClerk();
  const signedInSessionKey = useSessionList()
    .sessions?.map((session) => `${session.id}:${session.status}`)
    .join(",");
  // Bumped when account removal or a cleanup retry needs another observation.
  const [revision, setRevision] = useState(0);
  const accountTransitionRef = useRef<Promise<void> | null>(null);
  const cleanupFailuresRef = useRef(0);
  const cleanupToastRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (!isLoaded || signedInSessionKey === undefined) return;
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void refreshAccountAppearance(clerk).then(() => initializeAccountAppearance(clerk));
      }
    };
    // Initial profile observation happens in the lifecycle effect below.
    void Promise.resolve().then(() => initializeAccountAppearance(clerk));
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [clerk, isLoaded, signedInSessionKey]);

  useEffect(() => {
    bindAccountTokenClerk(clerk);
    bindActiveAccountClerk(clerk);
    return () => {
      bindAccountTokenClerk(null);
      bindActiveAccountClerk(null);
    };
  }, [clerk]);

  useEffect(() => {
    if (!isLoaded || signedInSessionKey === undefined) {
      return;
    }
    let cancelled = false;
    const nextAccount = isSignedIn && userId ? userId : null;

    const signedInSessions = () =>
      (clerk.client?.signedInSessions ?? []).flatMap((session) =>
        session.user ? [{ accountId: session.user.id, sessionId: session.id }] : [],
      );
    const observe = () => {
      const result = observeClerkSessions(appAtomRegistry, signedInSessions());
      observeAccountProfiles(
        appAtomRegistry,
        (clerk.client?.signedInSessions ?? []).flatMap((session) =>
          session.user ? [session.user] : [],
        ),
      );
      return result;
    };
    const { leaving } = observe();
    const signedIn = [...new Set(signedInSessions().map((session) => session.accountId))];
    setManagedRelayPrimaryAccount(appAtomRegistry, nextAccount);
    // An account without a signed-in session loses its relay session right
    // away. Its environments and local data stay unless it is leaving.
    const active = appAtomRegistry.get(managedRelaySessionsAtom);
    syncManagedRelaySessions(
      appAtomRegistry,
      signedIn.filter((accountId) => active.has(accountId)).map(relaySessionInput),
    );

    // Removes what a leaving account owns. The last known account also takes
    // the untagged relay environments with it.
    const cleanUp = async (accountId: string) => {
      const known = appAtomRegistry.get(knownConnectAccountsAtom).accountIds;
      // Looked at again this late because a queued cleanup can find the account
      // signed in again, or a newer run in charge.
      if (
        cancelled ||
        !known.includes(accountId) ||
        signedInSessions().some((session) => session.accountId === accountId)
      ) {
        return;
      }
      recordSignedOutAccount(appAtomRegistry, accountId);
      const scope = known.length === 1 ? undefined : accountId;
      const results = await Promise.all([
        removeRelayEnvironments(scope === undefined ? undefined : { accountId: scope }),
        resetRelayTokenCache(scope),
      ]);
      for (const result of results) {
        reportAtomCommandResult(result, { label: "cloud account cleanup" });
      }
      if (results.some((result) => result._tag !== "Success")) {
        throw new Error(CLEANUP_FAILED_MESSAGE);
      }
      // Only a signed-out account takes its view state along. Removing an
      // environment by hand keeps it, so adding it back restores the layout.
      if (AsyncResult.isSuccess(results[0])) {
        await sweepViewState(results[0].value);
      }
      forgetKnownAccount(appAtomRegistry, accountId);
    };
    // A failed cleanup keeps its account known and is tried again. Until it
    // succeeds no new account is activated over the leftover data.
    const transition = (accountTransitionRef.current ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        for (const accountId of leaving) {
          await cleanUp(accountId);
        }
      });
    accountTransitionRef.current = transition;
    const closeCleanupToast = () => {
      if (cleanupToastRef.current !== null) {
        toastManager.close(cleanupToastRef.current);
        cleanupToastRef.current = null;
      }
    };
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const result = await settlePromise(async () => {
        await transition;
        if (!cancelled) {
          if (leaving.length > 0) {
            observe();
          }
          syncManagedRelaySessions(appAtomRegistry, signedIn.map(relaySessionInput));
        }
      });
      reportAtomCommandResult(result, { label: "cloud account activation" });
      if (cancelled) {
        return;
      }
      if (AsyncResult.isSuccess(result)) {
        cleanupFailuresRef.current = 0;
        closeCleanupToast();
        return;
      }
      cleanupFailuresRef.current += 1;
      cleanupToastRef.current ??= toastManager.add({
        type: "error",
        title: "Could not clear the previous account's data",
        description: "Connect stays off for the new account until this is cleared.",
        timeout: 0,
        actionProps: {
          children: "Retry",
          onClick: () => {
            closeCleanupToast();
            cleanupFailuresRef.current = 0;
            setRevision((revision) => revision + 1);
          },
        },
      });
      if (cleanupFailuresRef.current <= CLEANUP_MAX_RETRIES) {
        retryTimer = setTimeout(
          () => setRevision((revision) => revision + 1),
          Math.min(CLEANUP_RETRY_MS * 2 ** (cleanupFailuresRef.current - 1), CLEANUP_RETRY_MAX_MS),
        );
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [
    clerk,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- only a re-run trigger
    revision,
    isLoaded,
    isSignedIn,
    removeRelayEnvironments,
    signedInSessionKey,
    userId,
  ]);

  useEffect(
    () => () => {
      setManagedRelayPrimaryAccount(appAtomRegistry, null);
      syncManagedRelaySessions(appAtomRegistry, []);
    },
    [],
  );
  useEffect(
    () =>
      appAtomRegistry.subscribe(knownAccountRemovalsAtom, () =>
        setRevision((revision) => revision + 1),
      ),
    [],
  );
  useEffect(startMultiAccountMarkerHeartbeat, []);

  // This provider sits above the app's atom registry, which the dialog reads.
  return (
    <>
      {children}
      <AppAtomRegistryProvider>
        <ConnectAccountCommandsHost />
      </AppAtomRegistryProvider>
    </>
  );
}
