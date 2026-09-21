import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { decideAddAccountGate } from "@lecturn/client-runtime/relay";
import { useEffect } from "react";

import { readClerkSingleSessionMode } from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom, type KnownConnectAccounts } from "../../cloud/knownAccounts";
import { environmentCatalog } from "../../connection/catalog";
import { isElectron } from "../../env";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import {
  isOAuthFlowPendingError,
  unexpectedSignInToReject,
  type PendingSignInAgain,
} from "./ConnectAccountMenu.logic";
import { runConnectSignOut } from "./useConnectSignOut.logic";
import { useLecturnConnectAuthPrompt } from "./useLecturnConnectAuthPrompt";

type Clerk = ReturnType<typeof useClerk>;

// The account menu and the sidebar's account bars mount and unmount on their
// own. The sidebar's bars go away while the user searches threads, often in
// the middle of a browser sign-in, so what waits on a sign-in lives here and
// not in a component: one pending "Sign in again", watched by one subscription.
let pendingSignInAgain: PendingSignInAgain | null = null;
let stopWatchingKnownAccounts: (() => void) | null = null;

function stopWatching(): void {
  pendingSignInAgain = null;
  stopWatchingKnownAccounts?.();
  stopWatchingKnownAccounts = null;
}

/** Somebody new who came out of "Sign in again" past a closed gate is signed out again. */
function settleSignInAgain(clerk: Clerk, known: KnownConnectAccounts): void {
  const pending = pendingSignInAgain;
  if (pending === null) return;
  if (!known.needsSignIn.includes(pending.expectedAccountId)) {
    stopWatching();
    return;
  }
  const rejected = unexpectedSignInToReject({
    pending,
    knownAccountIds: known.accountIds,
    needsSignIn: known.needsSignIn,
  });
  if (rejected === null) return;
  stopWatching();
  toastManager.add({
    type: "warning",
    title: "That account was not added",
    description: rejected.reason,
  });
  void runConnectSignOut({
    clerk,
    targets: [rejected.accountId],
    // A new account cannot have published this computer.
    host: { _tag: "none" },
    multiAccount: true,
    unpublish: async () => undefined,
    stayUrl: window.location.href,
  }).catch((cause: unknown) =>
    toastManager.add({
      type: "error",
      title: "Could not sign that account out",
      description: cause instanceof Error ? cause.message : undefined,
    }),
  );
}

function expectSignInAgain(clerk: Clerk, pending: PendingSignInAgain): void {
  stopWatching();
  pendingSignInAgain = pending;
  stopWatchingKnownAccounts = appAtomRegistry.subscribe(knownConnectAccountsAtom, (known) =>
    settleSignInAgain(clerk, known),
  );
}

// The desktop shell runs one browser sign-in at a time and rejects a second
// from inside Clerk's own component, where nothing else reports it.
let pendingFlowReporters = 0;
const reportPendingFlow = (event: PromiseRejectionEvent) => {
  if (!isOAuthFlowPendingError(event.reason)) return;
  event.preventDefault();
  toastManager.add({
    type: "warning",
    title: "A sign-in is already waiting in your browser",
    description: "Finish or close it there, then try again.",
  });
};

/**
 * Sign-in for a multi-account client: "Add account", and "Sign in again" for a
 * known account that needs it. Both open the same Clerk sign-in, so somebody
 * new who comes out of "Sign in again" past a closed gate is signed out again.
 */
export function useConnectSignIn() {
  const clerk = useClerk();
  // `clerk` keeps one identity while its environment loads behind it, so the
  // read below is keyed on `isLoaded` to run again once Clerk is ready.
  const { isLoaded } = useAuth();
  const known = useAtomValue(knownConnectAccountsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const unlisted = useAtomValue(environmentCatalog.unlistedRelayEnvironmentIdsValueAtom);
  const { openAuthPrompt, authPrompt } = useLecturnConnectAuthPrompt();

  // One listener while anything that can start a sign-in is mounted.
  useEffect(() => {
    if (!isElectron) return;
    pendingFlowReporters += 1;
    if (pendingFlowReporters === 1) {
      window.addEventListener("unhandledrejection", reportPendingFlow);
    }
    return () => {
      pendingFlowReporters -= 1;
      if (pendingFlowReporters === 0) {
        window.removeEventListener("unhandledrejection", reportPendingFlow);
      }
    };
  }, []);

  const gate = decideAddAccountGate({
    multiAccountEnabled: true,
    clerkSingleSessionMode: isLoaded ? readClerkSingleSessionMode(clerk) : undefined,
    targets: [...catalog.entries.values()].map((entry) => entry.target),
    unlistedRelayEnvironmentIds: unlisted,
    knownAccountCount: known.accountIds.length,
  });

  const signIn = () => {
    try {
      openAuthPrompt();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: isOAuthFlowPendingError(cause)
          ? "A sign-in is already waiting in your browser"
          : "Could not open sign-in",
        description: isOAuthFlowPendingError(cause)
          ? "Finish or close it there, then try again."
          : cause instanceof Error
            ? cause.message
            : undefined,
      });
    }
  };

  return {
    gate,
    authPrompt,
    addAccount: () => {
      stopWatching();
      signIn();
    },
    signInAgainAs: (accountId: string) => {
      expectSignInAgain(clerk, {
        expectedAccountId: accountId,
        knownAccountIds: known.accountIds,
        gate,
      });
      signIn();
    },
  };
}
