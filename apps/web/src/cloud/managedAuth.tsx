import { useAuth, useClerk, useSessionList } from "@clerk/react";
import { ManagedRelay, setManagedRelaySession } from "@lecturn/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@lecturn/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ConnectSignOutHost } from "../components/clerk/useConnectSignOut";
import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveRelayClerkTokenOptions } from "./publicConfig";
import {
  clearLastConnectAccountId,
  makeWebSingleAccountEnforcer,
  persistLastConnectAccountId,
  readLastConnectAccountId,
} from "./singleAccountGuard";

let relayTokenProvider: (() => Promise<string | null>) | null = null;

export async function readManagedRelayClerkToken(): Promise<string | null> {
  return relayTokenProvider?.() ?? null;
}

export function deactivateManagedRelayAuthentication(): void {
  relayTokenProvider = null;
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  relayTokenProvider = readClerkToken;
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const clerk = useClerk();
  const signedInSessionKey = useSessionList()
    .sessions?.map((session) => `${session.id}:${session.status}`)
    .join(",");
  const [singleAccountEnforcer] = useState(makeWebSingleAccountEnforcer);
  // Bumped when a rejection settles, so the guard looks at Clerk again.
  const [guardRevision, setGuardRevision] = useState(0);
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!isLoaded || signedInSessionKey === undefined) {
      return;
    }
    // An extra Clerk session, from another tab or Clerk's own UI, is rejected
    // here in front of the transition handling so it never reads as an account
    // change. signedInSessionKey is a dependency so those additions re-run it.
    if (
      !singleAccountEnforcer.evaluate({
        clerk,
        renderedAccountId: isSignedIn && userId ? userId : null,
        observedAccountId: observedAccountRef.current,
        persistedAccountId: readLastConnectAccountId(),
        onSettled: () => setGuardRevision((revision) => revision + 1),
      })
    ) {
      return;
    }

    let cancelled = false;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;

    const queueAccountCleanup = () => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const results = await Promise.all([
          removeRelayEnvironments(),
          settleAsyncResult(() =>
            runtime.runPromiseExit(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((client) => client.resetTokenCache()),
              ),
            ),
          ),
        ]);
        for (const result of results) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      deactivateManagedRelayAuthentication();
      clearLastConnectAccountId();
      if (previousAccount !== null) {
        void queueAccountCleanup();
      }
    } else {
      persistLastConnectAccountId(userId);
      // getToken reads Clerk's active session at call time. Never hand this
      // account a token while another session is briefly active.
      const tokenProvider = async () =>
        clerk.session?.user.id === userId ? getToken(resolveRelayClerkTokenOptions()) : null;
      const activateSession = () => {
        if (!cancelled) {
          activateManagedRelayAuthentication(userId, tokenProvider);
        }
      };
      const activateAfterTransition = (transition: Promise<void>) => {
        void (async () => {
          const result = await settlePromise(async () => {
            await transition;
            activateSession();
          });
          reportAtomCommandResult(result, { label: "cloud account activation" });
        })();
      };
      if (previousAccount !== undefined && previousAccount !== null && previousAccount !== userId) {
        deactivateManagedRelayAuthentication();
        activateAfterTransition(queueAccountCleanup());
      } else {
        activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
      }
    }
    return () => {
      cancelled = true;
    };
  }, [
    clerk,
    getToken,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- only a re-run trigger
    guardRevision,
    isLoaded,
    isSignedIn,
    removeRelayEnvironments,
    signedInSessionKey,
    singleAccountEnforcer,
    userId,
  ]);

  useEffect(() => () => deactivateManagedRelayAuthentication(), []);
  useEffect(() => () => singleAccountEnforcer.dispose(), [singleAccountEnforcer]);

  // This provider sits above the app's atom registry, which the dialog reads.
  return (
    <>
      {children}
      <AppAtomRegistryProvider>
        <ConnectSignOutHost />
      </AppAtomRegistryProvider>
    </>
  );
}
