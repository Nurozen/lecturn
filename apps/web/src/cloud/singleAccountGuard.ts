import {
  MULTI_ACCOUNT_ENABLED_MARKER_KEY,
  SINGLE_ACCOUNT_EXHAUSTED_MESSAGE,
  SINGLE_ACCOUNT_REJECTED_MESSAGE,
  SINGLE_ACCOUNT_STAND_DOWN_MESSAGE,
  isMultiAccountMarkerFresh,
  makeSingleAccountEnforcer,
} from "@lecturn/client-runtime/relay";
import * as Schema from "effect/Schema";

import type { ClerkSignInProps } from "../components/clerk/authRedirect";
import { toastManager } from "../components/ui/toast";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";
import { connectMultiAccount } from "./publicConfig";

const LAST_CONNECT_ACCOUNT_ID_KEY = "lecturn:last-connect-account-id";

/** Account this client last served. Only the single-account guard reads it. */
export function readLastConnectAccountId(): string | null {
  try {
    return getLocalStorageItem(LAST_CONNECT_ACCOUNT_ID_KEY, Schema.String);
  } catch {
    return null;
  }
}

export function persistLastConnectAccountId(accountId: string): void {
  try {
    setLocalStorageItem(LAST_CONNECT_ACCOUNT_ID_KEY, accountId, Schema.String);
  } catch {
    // Without storage the guard falls back to the active signed-in session.
  }
}

export function clearLastConnectAccountId(): void {
  try {
    removeLocalStorageItem(LAST_CONNECT_ACCOUNT_ID_KEY);
  } catch {
    // Storage is unavailable, so nothing was persisted.
  }
}

/**
 * While multi-account is off, opening Clerk's sign-in with a session already
 * signed in would add a second account. Every sign-in prompt goes through here.
 */
export function openConnectSignIn(
  clerk: { readonly isSignedIn: boolean; readonly openSignIn: (props: ClerkSignInProps) => void },
  props: ClerkSignInProps,
): void {
  // A pending session is not signed in, and Clerk's sign-in is what finishes it.
  if (!connectMultiAccount && clerk.isSignedIn) {
    return;
  }
  clerk.openSignIn(props);
}

type ConnectSignOutRequest = (options: { readonly everySession: boolean }) => Promise<void>;

let connectSignOutRequest: ConnectSignOutRequest | null = null;

/** The mounted sign-out dialog registers here so the guard's messages can open it. */
export function setConnectSignOutRequest(request: ConnectSignOutRequest | null): void {
  connectSignOutRequest = request;
}

async function requestConnectSignOut(everySession: boolean): Promise<void> {
  if (connectSignOutRequest === null) {
    throw new Error("The sign-out dialog is not mounted.");
  }
  await connectSignOutRequest({ everySession });
}

function subscribeWake(wake: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") wake();
  };
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("online", wake);
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function readMultiAccountMarkerPresent(): boolean {
  try {
    return isMultiAccountMarkerFresh(
      window.localStorage.getItem(MULTI_ACCOUNT_ENABLED_MARKER_KEY),
      Date.now(),
    );
  } catch {
    return false;
  }
}

const MULTI_ACCOUNT_MARKER_HEARTBEAT_MS = 20 * 60 * 1_000;

/**
 * Tells single-account tabs on this origin that a multi-account tab is open.
 * Written now and then every 20 minutes, well inside the two hours a marker
 * stays fresh, since background tabs run timers late. Never removed: a stale marker stops counting on its own.
 */
export function startMultiAccountMarkerHeartbeat(): () => void {
  const write = () => {
    try {
      window.localStorage.setItem(MULTI_ACCOUNT_ENABLED_MARKER_KEY, String(Date.now()));
    } catch {
      // Without shared storage there are no other tabs to tell.
    }
  };
  write();
  const timer = setInterval(write, MULTI_ACCOUNT_MARKER_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

function reportError(cause: unknown): void {
  console.error("Could not sign out the extra Connect account.", cause);
}

export function makeWebSingleAccountEnforcer() {
  return makeSingleAccountEnforcer({
    multiAccountEnabled: connectMultiAccount,
    readMarkerPresent: readMultiAccountMarkerPresent,
    onRejected: () => {
      toastManager.add({ type: "warning", title: SINGLE_ACCOUNT_REJECTED_MESSAGE });
    },
    onStandDown: () => {
      toastManager.add({
        type: "warning",
        title: SINGLE_ACCOUNT_STAND_DOWN_MESSAGE,
        timeout: 0,
        actionProps: {
          children: "Reload",
          onClick: () => window.location.reload(),
        },
        data: {
          secondaryActionProps: {
            children: "Sign out",
            onClick: () => void requestConnectSignOut(false).catch(reportError),
          },
        },
      });
    },
    onExhausted: (signOutEverywhere) => {
      // Closed on use: the guard announces it again if the sign-out fails.
      const toastId = toastManager.add({
        type: "error",
        title: SINGLE_ACCOUNT_EXHAUSTED_MESSAGE,
        timeout: 0,
        actionProps: {
          children: "Sign out of all accounts",
          onClick: () => {
            toastManager.close(toastId);
            void signOutEverywhere();
          },
        },
      });
    },
    signOutEverywhere: () => requestConnectSignOut(true),
    onError: reportError,
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    subscribeWake,
  });
}
