import { useAuth, useClerk, useSessionList } from "@clerk/expo";
import { useAtomValue } from "@effect/atom-react";
import {
  ManagedRelay,
  managedRelaySessionsAtom,
  syncManagedRelaySessions,
  setManagedRelayPrimaryAccount,
} from "@lecturn/client-runtime/relay";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { useEffect, useRef, type ReactNode } from "react";
import * as Effect from "effect/Effect";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { restoreCloudComposerDrafts } from "../../state/use-composer-drafts";
import { useMultiAccountPushSupported } from "../agent-awareness/multiAccountCapability";
import { accountTokenReader, bindAccountTokenClerk } from "./accountTokenReaders";
import { releaseAccountPushProviders, syncAccountPushProviders } from "./accountPushRegistration";
import { removeCloudEnvironments } from "./cloud-drafts";
import { requestConnectOnboarding } from "./connectOnboarding";
import {
  accountsPendingRemoval,
  cancelConnectAccountRemoval,
  forgetConnectAccount,
  loadKnownConnectAccounts,
  markConnectAccountRemoval,
  persistKnownConnectAccounts,
} from "./knownAccountStorage";
import {
  connectAccountsReadyAtom,
  connectAccountRemovalRevisionAtom,
  knownConnectAccountsAtom,
  reconcileMobileAccounts,
} from "./knownAccounts";

/** Clerk's active session is presentation state; ownership comes from the full session set. */
export function MultiAccountCloudAuthBridge({ children }: { readonly children: ReactNode }) {
  const clerk = useClerk();
  const multiAccountPushSupported = useMultiAccountPushSupported();
  const { isLoaded, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { sessions } = useSessionList();
  const key = sessions
    ?.map(
      (session) =>
        `${session.id}:${session.status}:${session.user?.id}:${session.user?.updatedAt?.getTime()}`,
    )
    .join(",");
  const removalRevision = useAtomValue(connectAccountRemovalRevisionAtom);
  const remove = useAtomCommand(removeCloudEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const first = useRef(true);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    bindAccountTokenClerk(clerk);
    return () => {
      bindAccountTokenClerk(null);
      appAtomRegistry.set(connectAccountsReadyAtom, false);
      releaseAccountPushProviders();
      syncManagedRelaySessions(appAtomRegistry, []);
    };
  }, [clerk]);
  useEffect(() => {
    if (!isLoaded || key === undefined) return;
    let cancelled = false;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        await loadKnownConnectAccounts();
        if (cancelled) return;
        const signedIn = clerk.client?.signedInSessions ?? [];
        const observed = clerk.client?.sessions ?? [];
        for (const session of observed) {
          if (
            (session.status === "removed" || session.status === "revoked") &&
            session.user &&
            appAtomRegistry
              .get(knownConnectAccountsAtom)
              .some((account) => account.accountId === session.user?.id) &&
            !signedIn.some((active) => active.user?.id === session.user?.id) &&
            !accountsPendingRemoval().has(session.user.id)
          ) {
            await markConnectAccountRemoval(session.user.id);
          }
        }
        syncManagedRelaySessions(
          appAtomRegistry,
          signedIn
            .filter(
              (session) =>
                session.user && appAtomRegistry.get(managedRelaySessionsAtom).has(session.user.id),
            )
            .map((session) => ({
              accountId: session.user!.id,
              readClerkToken: accountTokenReader(session.user!.id),
            })),
        );
        for (const id of accountsPendingRemoval()) {
          if (signedIn.some((session) => session.user?.id === id)) {
            if (first.current) await cancelConnectAccountRemoval(id);
            continue;
          }
          const result = await remove(id);
          if (result._tag !== "Success") throw squashAtomCommandFailure(result);
          await runtime.runPromise(
            ManagedRelay.ManagedRelayClient.pipe(
              Effect.flatMap((client) => client.resetTokenCache(id)),
            ),
          );
          await forgetConnectAccount(id);
        }
        if (cancelled) return;
        const before = appAtomRegistry.get(knownConnectAccountsAtom);
        const next = reconcileMobileAccounts(before, signedIn);
        for (const account of next) {
          if (
            account.signedIn &&
            !before.some((old) => old.accountId === account.accountId && old.signedIn)
          ) {
            await restoreCloudComposerDrafts(account.accountId);
          }
        }
        if (cancelled) return;
        appAtomRegistry.set(knownConnectAccountsAtom, next);
        await persistKnownConnectAccounts();
        if (cancelled) return;
        syncManagedRelaySessions(
          appAtomRegistry,
          next
            .filter((account) => account.signedIn)
            .map((account) => ({
              accountId: account.accountId,
              readClerkToken: accountTokenReader(account.accountId),
            })),
        );
        setManagedRelayPrimaryAccount(appAtomRegistry, userId ?? null);
        syncAccountPushProviders(
          new Map(
            next
              .filter((account) => account.signedIn)
              .map((account) => [account.accountId, accountTokenReader(account.accountId)]),
          ),
          userId ?? null,
        );
        if (!first.current) {
          const added = next.find(
            (account) =>
              account.signedIn && !before.some((old) => old.accountId === account.accountId),
          );
          if (added) requestConnectOnboarding(added.accountId);
        }
        appAtomRegistry.set(connectAccountsReadyAtom, true);
        first.current = false;
      })
      .catch((error) => {
        console.error("[lecturn-connect] Could not synchronize mobile accounts", error);
      });
    return () => {
      cancelled = true;
    };
    // Account removals and relay capability changes are explicit synchronization signals.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [clerk, isLoaded, key, userId, removalRevision, remove, multiAccountPushSupported]);
  return children;
}
