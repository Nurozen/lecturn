import { useAuth } from "@clerk/react";
import { useSyncExternalStore } from "react";
import { hasPhoneConnectAccount } from "../lib/androidHostAccess";
import { phoneConnectAccount } from "./phoneConnectAccount";

export function usePhoneConnectAccount() {
  return useSyncExternalStore(phoneConnectAccount.subscribe, phoneConnectAccount.getSnapshot);
}

function usePhoneAccountAuth() {
  const { status, error } = usePhoneConnectAccount();
  const isSignedIn =
    status?.configured === true && status.state === "signed-in" && status.account !== null;
  return {
    isLoaded: (status !== null && status.state !== "loading") || error !== null,
    isSignedIn,
    userId: isSignedIn ? (status.account?.id ?? null) : null,
  };
}

// Host capability is fixed before app startup. Each platform invokes only its
// own provider hook; phone account consumers never invoke Clerk hooks.
export const useConnectAccountAuth = hasPhoneConnectAccount() ? usePhoneAccountAuth : useAuth;
