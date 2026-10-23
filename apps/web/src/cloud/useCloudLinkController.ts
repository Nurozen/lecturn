import {
  EnvironmentId,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentCloudLinkStateResult,
} from "@lecturn/contracts";
import type { RelayManagedEndpointProviderKind } from "@lecturn/contracts/relay";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { threadDecisionEnvironment } from "../state/threadDecisions";
import { useConnectAccountAuth } from "./useConnectAccountAuth";
import { useAtomValue } from "@effect/atom-react";
import { findErrorTraceId } from "@lecturn/client-runtime/errors";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { selectedTeam } from "@lecturn/client-runtime/relay";
import { createAccountBillingClient, createAccountTeamsClient } from "./accountRelayClients";
import { readToken } from "./accountTokens";
import { describePublishAccount } from "./cloudLinkAccount";
import { connectAccountProfilesAtom } from "./connectAccounts";
import { knownConnectAccountsAtom } from "./knownAccounts";
import { isConnectSubscriptionRequired } from "./connectSubscriptionGate";

import { toastManager } from "../components/ui/toast";
import { relayEnvironmentDiscovery } from "../state/relay";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import {
  linkPrimaryEnvironment as linkPrimaryEnvironmentAtom,
  unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom,
  updatePrimaryEnvironmentPreferences as updatePrimaryEnvironmentPreferencesAtom,
} from "./linkEnvironmentAtoms";
import { readCachedPrimaryCloudLinkState, usePrimaryCloudLinkState } from "./primaryCloudLinkState";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
  readonly decisions?: boolean;
  readonly unlink?: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}

/**
 * The local tunnel config can outlive a relay link that drifted to
 * publish-only, and clients then get `endpoint_provider_not_managed`. So when
 * relay discovery has this environment's record, it must also say managed.
 */
function isManagedTunnelActive(
  linkState: EnvironmentCloudLinkStateResult,
  relayProviderKind: RelayManagedEndpointProviderKind | undefined,
) {
  const localManagedTunnel = linkState.managedTunnelActive ?? linkState.linked;
  return (
    linkState.linkRevoked !== true &&
    localManagedTunnel &&
    (relayProviderKind === undefined || relayProviderKind === "cloudflare_tunnel")
  );
}

/**
 * Acts as `accountId`, with that account's own token, or as Clerk's active
 * account when none is given. `onSelectAccount` is the surface's picker.
 */
export function useCloudLinkController(
  options: {
    readonly accountId?: string | null | undefined;
    readonly onSelectAccount?: (accountId: string) => void;
  } = {},
) {
  const auth = useConnectAccountAuth();
  const known = useAtomValue(knownConnectAccountsAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const userId = options.accountId === undefined ? auth.userId : options.accountId;
  const isSignedIn =
    userId === auth.userId
      ? auth.isSignedIn
      : Boolean(userId) && !known.needsSignIn.includes(userId ?? "");
  const readAccountToken = (accountId: string | null | undefined) =>
    accountId ? readToken(accountId) : Promise.resolve(null);
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkPrimaryEnvironment = useAtomCommand(linkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const updateDecisionFunding = useAtomCommand(threadDecisionEnvironment.funding, {
    reportFailure: false,
  });
  const updatePrimaryEnvironmentPreferences = useAtomCommand(
    updatePrimaryEnvironmentPreferencesAtom,
    { reportFailure: false },
  );
  const primaryCloudLinkState = usePrimaryCloudLinkState();
  const accountRef = useRef(userId);
  const companyPublishingAllowed = useRef(true);
  useEffect(() => {
    accountRef.current = userId;
    return () => {
      accountRef.current = undefined;
    };
  }, [userId]);
  const [subscriptionRequiredFor, setSubscriptionRequiredFor] = useState<string | null>(null);
  const subscriptionRequired = Boolean(userId && subscriptionRequiredFor === userId);
  const relayEnvironments = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments;
  const primaryEnvironmentId = primaryCloudLinkState.target?.environmentId;
  const relayProviderKind = primaryEnvironmentId
    ? relayEnvironments.get(primaryEnvironmentId)?.environment.endpoint.providerKind
    : undefined;
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
    console.error("[lecturn-connect] Could not update Lecturn Connect", {
      message,
      traceId,
      cause,
    });
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

  const linkData = primaryCloudLinkState.data;
  const linkRevoked = linkData?.linkRevoked ?? false;
  const managedTunnelActive = linkData ? isManagedTunnelActive(linkData, relayProviderKind) : false;
  const managedTunnelOutOfSync =
    linkData !== null && !managedTunnelActive && isManagedTunnelActive(linkData, undefined);
  const publishAgentActivity = primaryCloudLinkState.data?.publishAgentActivity ?? false;
  const holdWebhooksWhileOffline = primaryCloudLinkState.data?.holdWebhooksWhileOffline ?? false;
  const linked = !linkRevoked && (primaryCloudLinkState.data?.linked ?? false);

  const { onSelectAccount } = options;
  const publishAccount = describePublishAccount({
    linked,
    accountId: userId,
    accountSignedIn: Boolean(isSignedIn),
    publisherId: primaryCloudLinkState.data?.cloudUserId,
    knownAccountIds: known.accountIds,
    needsSignIn: known.needsSignIn,
    profiles,
    canChoose: onSelectAccount !== undefined,
  });
  const accountMismatchMessage = publishAccount.message;
  const { actAs } = publishAccount;
  const accountMismatchAction =
    actAs && onSelectAccount
      ? { label: actAs.label, run: () => onSelectAccount(actAs.accountId) }
      : null;

  const checkSubscription = async (clerkToken?: string): Promise<boolean> => {
    const account = userId;
    const organizationId = linked
      ? (primaryCloudLinkState.data?.organizationId ?? null)
      : selectedTeam(userId);
    try {
      companyPublishingAllowed.current = true;
      if (organizationId) {
        const result = await createAccountTeamsClient(account, clerkToken || undefined).list();
        if (accountRef.current !== account || (!linked && selectedTeam(account) !== organizationId))
          return false;
        const organization = result.organizations.find(
          (item) => item.organizationId === organizationId,
        );
        if (!organization?.hasAccess) {
          setOperationError(
            "Your company Connect access is not active. Ask your administrator to assign a seat and check company billing.",
          );
          return false;
        }
        companyPublishingAllowed.current = organization.policy?.publishAgentActivity !== false;
        setSubscriptionRequiredFor(null);
        setOperationError(null);
        return true;
      }
      const status = await createAccountBillingClient(account, clerkToken || undefined).getStatus();
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
    const organizationId = linked
      ? (primaryCloudLinkState.data?.organizationId ?? null)
      : selectedTeam(userId);
    const target = primaryCloudLinkState.target;
    if (!target) {
      reportUpdateFailure(new Error("Local environment is not ready yet."));
      return false;
    }
    const environmentId = EnvironmentId.make(target.environmentId);
    const canManageLink = () => {
      if (
        !readEnvironmentScope(environmentId, AuthRelayReadScope) ||
        !readEnvironmentScope(environmentId, AuthRelayWriteScope)
      ) {
        reportUpdateFailure(
          new Error(
            "This connection needs permission to view and manage Lecturn Connect settings.",
          ),
        );
        return false;
      }
      return true;
    };
    const readLinkState = () => {
      const state = readCachedPrimaryCloudLinkState(target);
      if (state === null) {
        reportUpdateFailure(
          new Error("Wait until the current Lecturn Connect settings can be read."),
        );
      }
      return state;
    };
    if (!canManageLink()) return false;
    let keepDecisionFunding = desired.decisions === true && desired.unlink !== true;
    let revokeFundingGeneration: number | null = null;
    if (
      linked &&
      !desired.managedTunnel &&
      !desired.publish &&
      !keepDecisionFunding &&
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.environment
        .capabilities.threadDecisions === true
    ) {
      const funding = await executeAtomQuery(
        appAtomRegistry,
        threadDecisionEnvironment.fundingStatus({ environmentId, input: {} }),
        { refresh: true, reportFailure: false },
      );
      if (
        funding._tag === "Failure" ||
        (funding.value.state === "unavailable" && !desired.unlink)
      ) {
        reportUpdateFailure(
          new Error(
            "Could not verify decision funding. Retry before removing this environment’s cloud link.",
          ),
        );
        return false;
      }
      if (desired.unlink) revokeFundingGeneration = funding.value.generation;
      else
        keepDecisionFunding = funding.value.state === "active" || funding.value.state === "pending";
    }
    const wantsLink = desired.managedTunnel || desired.publish || keepDecisionFunding;
    if (wantsLink && readLinkState() === null) return false;
    // Another account's link can only be removed, and only when it is one of
    // this client's own accounts.
    if (accountMismatchMessage && (wantsLink || !publishAccount.unlink.allowed)) {
      reportUpdateFailure(new Error(accountMismatchMessage));
      return false;
    }
    const tokenAccountId =
      !wantsLink && publishAccount.unlink.allowed ? publishAccount.unlink.tokenAccountId : userId;
    const tokenResult = await settlePromise(() => readAccountToken(tokenAccountId));
    if (!canManageLink()) return false;

    // A failure after this point may follow a partially applied mutation (e.g.
    // the link succeeded but the preference update did not), so every exit —
    // success or failure — refreshes the rendered state to whatever the server
    // actually holds now.
    if (!wantsLink) {
      if (revokeFundingGeneration !== null) {
        const revoked = await updateDecisionFunding({
          environmentId,
          input: { operation: "revoke", expectedGeneration: revokeFundingGeneration },
        });
        if (revoked._tag === "Failure") {
          reportUpdateFailure(squashAtomCommandFailure(revoked));
          return false;
        }
      }
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
      const currentLinkState = readLinkState();
      if (currentLinkState === null) return false;
      if (tokenResult._tag === "Failure") {
        reportUpdateFailure(squashAtomCommandFailure(tokenResult));
        return false;
      }
      const clerkToken = tokenResult.value;
      if (!clerkToken) {
        reportUpdateFailure(new Error("Sign in to Lecturn Connect before enabling this."));
        return false;
      }
      if (
        ((desired.managedTunnel || desired.publish) && !(await checkSubscription(clerkToken))) ||
        (!linked && selectedTeam(userId) !== organizationId)
      )
        return false;
      const currentManagedTunnel = isManagedTunnelActive(currentLinkState, relayProviderKind);
      if (
        !currentLinkState.linked ||
        currentLinkState.linkRevoked === true ||
        currentManagedTunnel !== desired.managedTunnel ||
        currentLinkState.deviceRelayConflict
      ) {
        const linkResult = await linkPrimaryEnvironment({
          target,
          clerkToken,
          mode: desired.managedTunnel ? "managed" : desired.publish ? "publish_only" : "decisions",
          publishAgentActivity: desired.publish && companyPublishingAllowed.current,
          ...(organizationId && (desired.managedTunnel || desired.publish)
            ? { organizationId }
            : {}),
        });
        if (linkResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(linkResult)) {
            reportUpdateFailure(squashAtomCommandFailure(linkResult));
          }
          primaryCloudLinkState.refresh();
          return false;
        }
      }
      if (!canManageLink() || readLinkState() === null) {
        primaryCloudLinkState.refresh();
        return false;
      }
      const prefResult = await updatePrimaryEnvironmentPreferences({
        target,
        publishAgentActivity: desired.publish && companyPublishingAllowed.current,
        ...(desired.holdWebhooksWhileOffline === undefined
          ? {}
          : { holdWebhooksWhileOffline: desired.holdWebhooksWhileOffline }),
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
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    subscriptionRequired,
    checkSubscription,
    accountMismatchMessage,
    accountMismatchAction,
    unlinkBlocked: publishAccount.mismatch && !publishAccount.unlink.allowed,
    reconcileCloudState,
  };
}
