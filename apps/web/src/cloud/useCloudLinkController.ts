import { useAuth } from "@clerk/react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { createBillingClient } from "@t3tools/client-runtime/relay";
import { isConnectSubscriptionRequired } from "./connectSubscriptionGate";

import { toastManager } from "../components/ui/toast";
import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import {
  linkPrimaryEnvironment as linkPrimaryEnvironmentAtom,
  unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom,
  updatePrimaryEnvironmentPreferences as updatePrimaryEnvironmentPreferencesAtom,
} from "./linkEnvironmentAtoms";
import { usePrimaryCloudLinkState } from "./primaryCloudLinkState";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
}

/**
 * Drives the primary environment's Lecturn Connect link. Lecturn Connect (managed
 * tunnel) and agent-activity publishing are independent capabilities backed by
 * a single relay link, so consumers express the full desired state and
 * `reconcileCloudState` applies it: unlink when neither is wanted, otherwise
 * (re)link with the mode the managed-tunnel bit implies and set the publish
 * preference. Re-linking only happens when the managed-tunnel mode actually
 * changes, so flipping publish alone is cheap.
 */
export function useCloudLinkController() {
  const { getToken, isSignedIn, userId } = useAuth();
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkPrimaryEnvironment = useAtomCommand(linkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const updatePrimaryEnvironmentPreferences = useAtomCommand(
    updatePrimaryEnvironmentPreferencesAtom,
    { reportFailure: false },
  );
  const primaryCloudLinkState = usePrimaryCloudLinkState();
  const accountRef = useRef(userId);
  useEffect(() => {
    accountRef.current = userId;
    return () => {
      accountRef.current = undefined;
    };
  }, [userId]);
  const [subscriptionRequiredFor, setSubscriptionRequiredFor] = useState<string | null>(null);
  const subscriptionRequired = Boolean(userId && subscriptionRequiredFor === userId);
  const [operationError, setOperationError] = useState<string | null>(null);

  const reportUpdateFailure = (cause: unknown) => {
    if (isConnectSubscriptionRequired(cause)) {
      setSubscriptionRequiredFor(userId ?? null);
      setOperationError(null);
      return;
    }
    const message =
      cause instanceof Error ? cause.message : "Could not update Lecturn Connect access.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not update Lecturn Connect", { message, traceId, cause });
    setOperationError(traceId ? `${message} Trace ID: ${traceId}` : message);
    toastManager.add({
      type: "error",
      title: "Could not update Lecturn Connect",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  // Older environment servers predate the managedTunnelActive field; for them a
  // link always implies a managed tunnel, so fall back to `linked`.
  const managedTunnelActive =
    primaryCloudLinkState.data?.managedTunnelActive ?? primaryCloudLinkState.data?.linked ?? false;
  const publishAgentActivity = primaryCloudLinkState.data?.publishAgentActivity ?? false;
  const linked = primaryCloudLinkState.data?.linked ?? false;

  const accountMismatch =
    linked && isSignedIn && Boolean(userId) && primaryCloudLinkState.data?.cloudUserId !== userId;
  const accountMismatchMessage = accountMismatch
    ? "This environment is still published to a different Lecturn account. Sign out to stop its local relay, then sign in to the account you want to use. The previous owner can remove the offline environment from their account."
    : null;

  const checkSubscription = async (clerkToken?: string): Promise<boolean> => {
    const account = userId;
    try {
      const status = await createBillingClient({
        relayUrl: resolveCloudPublicConfig().relayUrl ?? "",
        getToken: () =>
          clerkToken ? Promise.resolve(clerkToken) : getToken(resolveRelayClerkTokenOptions()),
      }).getStatus();
      if (!account || accountRef.current !== account) return false;
      if (status.state === "unavailable")
        throw new Error("Your subscription could not be checked. Refresh to try again.");
      // A disabled billing service does not impose a purchase requirement.
      const allowed = status.state === "disabled" || status.hasAccess;
      setSubscriptionRequiredFor(allowed ? null : account);
      setOperationError(null);
      return allowed;
    } catch (cause) {
      if (accountRef.current === account) reportUpdateFailure(cause);
      return false;
    }
  };

  const reconcileCloudState = async (desired: CloudLinkDesiredState): Promise<boolean> => {
    setOperationError(null);
    const target = primaryCloudLinkState.target;
    if (!target) {
      reportUpdateFailure(new Error("Local environment is not ready yet."));
      return false;
    }
    if (accountMismatchMessage) {
      reportUpdateFailure(new Error(accountMismatchMessage));
      return false;
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    const wantsLink = desired.managedTunnel || desired.publish;

    // A failure after this point may follow a partially applied mutation (e.g.
    // the link succeeded but the preference update did not), so every exit —
    // success or failure — refreshes the rendered state to whatever the server
    // actually holds now.
    if (!wantsLink) {
      // Unlink works without a relay token — a failed token read must not
      // leave the user unable to turn Lecturn Connect off.
      const unlinkResult = await unlinkPrimaryEnvironment({
        target,
        clerkToken: tokenResult._tag === "Success" ? (tokenResult.value ?? null) : null,
      });
      if (unlinkResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(unlinkResult)) {
          reportUpdateFailure(squashAtomCommandFailure(unlinkResult));
        }
        primaryCloudLinkState.refresh();
        return false;
      }
    } else {
      if (tokenResult._tag === "Failure") {
        reportUpdateFailure(squashAtomCommandFailure(tokenResult));
        return false;
      }
      const clerkToken = tokenResult.value;
      if (!clerkToken) {
        reportUpdateFailure(new Error("Sign in to Lecturn Connect before enabling this."));
        return false;
      }
      if (!(await checkSubscription(clerkToken))) return false;
      if (!linked || managedTunnelActive !== desired.managedTunnel) {
        const linkResult = await linkPrimaryEnvironment({
          target,
          clerkToken,
          mode: desired.managedTunnel ? "managed" : "publish_only",
        });
        if (linkResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(linkResult)) {
            reportUpdateFailure(squashAtomCommandFailure(linkResult));
          }
          primaryCloudLinkState.refresh();
          return false;
        }
      }
      const prefResult = await updatePrimaryEnvironmentPreferences({
        target,
        publishAgentActivity: desired.publish,
      });
      if (prefResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(prefResult)) {
          reportUpdateFailure(squashAtomCommandFailure(prefResult));
        }
        primaryCloudLinkState.refresh();
        return false;
      }
    }

    primaryCloudLinkState.refresh();
    const refreshResult = await refreshRelayEnvironments();
    if (refreshResult._tag === "Failure" && !isAtomCommandInterrupted(refreshResult)) {
      reportUpdateFailure(squashAtomCommandFailure(refreshResult));
      return false;
    }
    return true;
  };

  return {
    isSignedIn,
    linkState: primaryCloudLinkState,
    linked,
    managedTunnelActive,
    publishAgentActivity,
    operationError,
    subscriptionRequired,
    checkSubscription,
    accountMismatchMessage,
    reconcileCloudState,
  };
}
