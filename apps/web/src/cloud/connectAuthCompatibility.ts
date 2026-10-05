import { MULTI_ACCOUNT_ENABLED_MARKER_KEY } from "@lecturn/client-runtime/relay";
import type { ClerkSignInProps } from "../components/clerk/authRedirect";

/** Open sign-in; account admission is enforced by the Connect account flow. */
export function openConnectSignIn(
  clerk: { readonly isSignedIn: boolean; readonly openSignIn: (props: ClerkSignInProps) => void },
  props: ClerkSignInProps,
): void {
  clerk.openSignIn(props);
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
