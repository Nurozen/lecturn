import { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/react";
import type {
  EnvironmentId,
  ExtensionFeatureId,
  ExtensionFundingChallengeResult,
  ExtensionFundingObserveResult,
  ExtensionHostFundingRequest,
} from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { fundingSupersedesChallenge } from "@lecturn/client-runtime/state/contextual";
import { CheckIcon, ExternalLinkIcon, ShieldCheckIcon } from "lucide-react";
import { linkRemoteDecisionEnvironment } from "../cloud/linkEnvironmentAtoms";
import { readToken } from "../cloud/accountTokens";
import { readPreparedConnection } from "../state/session";
import { useServerConfigs } from "../state/entities";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { useCloudLinkController } from "../cloud/useCloudLinkController";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import {
  contextualEnvironment,
  useContextualAccess,
  useContextualAvailable,
} from "../state/contextual";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { decisionFundingDenial } from "./DecisionFundingApprovalPage.logic";
import {
  matchesFundingChallenge,
  matchesFundingRedemption,
  FUNDING_OBSERVATION_INTERVAL_MS,
  FUNDING_OBSERVATION_LIMIT,
} from "./ExtensionsFunding.logic";

export type ExtensionsFundingProps = {
  environmentId: EnvironmentId;
  featureId: ExtensionFeatureId;
  onChange?: () => void;
};
/** Cloud registration is distinct from the payer's explicit, feature-specific approval. */
export function ExtensionsFunding(props: ExtensionsFundingProps) {
  const available = useContextualAvailable(props.environmentId);
  if (!available)
    return (
      <p className="text-xs text-muted-foreground">
        Update this host to manage membership access for{" "}
        {props.featureId === "decisions" ? "Decisions" : "Contextual"}. Existing saved data remains
        available.
      </p>
    );
  return resolveCloudPublicConfig().clerkPublishableKey ? (
    <ConfiguredExtensionsFunding {...props} />
  ) : (
    <ExtensionsFundingControls {...props} />
  );
}
function ConfiguredExtensionsFunding(props: ExtensionsFundingProps) {
  const controller = useCloudLinkController();
  const { user } = useUser();
  const primaryId = usePrimaryEnvironmentId();
  const remoteLink = useAtomCommand(linkRemoteDecisionEnvironment, { reportFailure: false });
  const configs = useServerConfigs();
  return (
    <ExtensionsFundingControls
      {...props}
      accountKey={user?.id ?? "signed-out"}
      accountLabel={user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? user?.id}
      linkError={controller.operationError}
      ensureLink={async () => {
        if (primaryId === props.environmentId)
          return (
            controller.linked ||
            (await controller.reconcileCloudState({
              managedTunnel: false,
              publish: false,
              decisions: true,
            }))
          );
        if (!user) return true;
        if (configs.get(props.environmentId)?.environment.capabilities.manualCloudLink !== true)
          throw new Error(
            "Update the selected remote environment to enable cloud registration from here.",
          );
        const prepared = readPreparedConnection(props.environmentId),
          relayUrl = resolveCloudPublicConfig().relayUrl;
        if (!prepared || !relayUrl)
          throw new Error("Reconnect the selected remote environment before linking membership.");
        const clerkToken = await readToken(user.id);
        if (!clerkToken) throw new Error("Sign in here to register this remote environment.");
        const result = await remoteLink({
          environmentId: props.environmentId,
          prepared,
          clerkToken,
          relayUrl,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return true;
      }}
    />
  );
}
type ControlsProps = ExtensionsFundingProps & {
  accountKey?: string;
  accountLabel?: string | undefined;
  linkError?: string | null;
  ensureLink?: () => Promise<boolean>;
};
function ExtensionsFundingControls(props: ControlsProps) {
  return (
    <FundingControls
      key={`${props.environmentId}:${props.featureId}:${props.accountKey ?? ""}`}
      {...props}
    />
  );
}
function FundingControls({
  environmentId,
  featureId,
  onChange,
  accountLabel,
  linkError,
  ensureLink,
}: ControlsProps) {
  const funding = useEnvironmentQuery(
    contextualEnvironment.fundingStatus({ environmentId, input: { featureId } }),
  );
  const command = useAtomCommand(contextualEnvironment.funding, { reportFailure: false });
  const canFund = useContextualAccess(environmentId).funding;
  const host = useEnvironment(environmentId)?.label ?? "this host";
  const name = featureId === "contextual" ? "Contextual" : "Decisions";
  const [pending, setPending] = useState<{
    challenge: ExtensionFundingChallengeResult;
    state: ExtensionFundingObserveResult["state"];
    accountLabel: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [monitor, setMonitor] = useState(0);
  const [checkingStopped, setCheckingStopped] = useState(false);
  const mounted = useRef(true);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const state = funding.data;
  const refreshFunding = funding.refresh;
  const challenge = pending?.challenge;
  const waiting =
    pending?.state === "awaiting-approval" || pending?.state === "approved-awaiting-host";

  useEffect(() => {
    if (!challenge || funding.error || !fundingSupersedesChallenge(challenge, state)) return;
    setPending(null);
    setError(null);
    setCheckingStopped(false);
  }, [challenge, state, funding.error]);

  useEffect(() => {
    if (!challenge || !waiting || !canFund || busy) return;
    let canceled = false;
    let checks = 0;
    const stopAt = monitor + FUNDING_OBSERVATION_INTERVAL_MS * FUNDING_OBSERVATION_LIMIT;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observe = async () => {
      if (canceled) return;
      if (Date.parse(challenge.expiresAt) <= Date.now()) {
        setPending((value) => (value ? { ...value, state: "expired" } : null));
        return;
      }
      if (Date.now() >= stopAt) {
        setCheckingStopped(true);
        return;
      }
      try {
        const observed = await command({
          environmentId,
          input: {
            featureId,
            operation: "observe",
            challengeId: challenge.challengeId,
            expectedGeneration: challenge.generation,
          },
        });
        if (canceled) return;
        if (observed._tag === "Failure") throw squashAtomCommandFailure(observed);
        // The host can finish redemption while observing, including during recovery.
        if ("allowance" in observed.value && matchesFundingRedemption(challenge, observed.value)) {
          setPending({ challenge, state: "linked", accountLabel: observed.value.accountLabel });
          refreshFunding();
          changed.current?.();
          return;
        }
        if (
          !("state" in observed.value) ||
          !("challengeId" in observed.value) ||
          !matchesFundingChallenge(challenge, observed.value)
        )
          throw new Error("The approval request changed. Start a new link request.");
        const result = observed.value;
        setPending({ challenge, state: result.state, accountLabel: result.accountLabel });
        if (result.state === "approved-awaiting-host") {
          const redeemed = await command({
            environmentId,
            input: {
              featureId,
              operation: "redeem",
              challengeId: challenge.challengeId,
              expectedGeneration: challenge.generation,
            },
          });
          if (canceled) return;
          if (redeemed._tag === "Failure") throw squashAtomCommandFailure(redeemed);
          if (
            !("allowance" in redeemed.value) ||
            !matchesFundingRedemption(challenge, redeemed.value)
          )
            throw new Error("The host link changed. Refresh its funding status.");
          setPending({ challenge, state: "linked", accountLabel: redeemed.value.accountLabel });
          refreshFunding();
          changed.current?.();
          return;
        }
        if (result.state !== "awaiting-approval") {
          refreshFunding();
          changed.current?.();
          return;
        }
        checks += 1;
        if (checks >= FUNDING_OBSERVATION_LIMIT) {
          setCheckingStopped(true);
          return;
        }
        timer = setTimeout(() => void observe(), FUNDING_OBSERVATION_INTERVAL_MS);
      } catch (cause) {
        if (canceled) return;
        refreshFunding();
        setError(cause instanceof Error ? cause.message : "Could not check approval. Try again.");
        setCheckingStopped(true);
      }
    };
    void observe();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    challenge,
    waiting,
    canFund,
    busy,
    command,
    environmentId,
    featureId,
    monitor,
    refreshFunding,
  ]);

  async function act(operation: "create" | "cancel" | "revoke") {
    if (!state || busy || !canFund) return;
    setBusy(true);
    setError(null);
    try {
      if (operation === "create" && ensureLink && !(await ensureLink()))
        throw new Error(
          "Sign in to Lecturn and link this host before requesting membership approval.",
        );
      if (!mounted.current) return;
      let input: ExtensionHostFundingRequest;
      if (operation === "cancel") {
        if (!challenge) return;
        input = {
          featureId,
          operation,
          challengeId: challenge.challengeId,
          expectedGeneration: challenge.generation,
        };
      } else input = { featureId, operation, expectedGeneration: state.generation };
      const result = await command({ environmentId, input });
      if (!mounted.current) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (operation === "create") {
        if (
          !("approvalUrl" in result.value) ||
          result.value.environmentId !== environmentId ||
          result.value.featureId !== featureId ||
          (result.value.generation !== state.generation &&
            result.value.generation !== state.generation + 1)
        )
          throw new Error("The funding request changed. Refresh before trying again.");
        setPending({ challenge: result.value, state: "awaiting-approval", accountLabel: null });
        setCheckingStopped(false);
        setMonitor(Date.now());
      } else {
        setPending(null);
        setConfirmRevoke(false);
      }
      refreshFunding();
      changed.current?.();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Funding could not be updated. Try again.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const denial =
    state &&
    !state.eligible &&
    (state.state === "active" ||
      state.state === "unavailable" ||
      state.reason === "disabled" ||
      state.reason === "cohort")
      ? decisionFundingDenial(state.reason, name)
      : null;
  const allowance = state?.allowance;
  const allowanceConfirmed = state?.state === "active" && state.eligible && !funding.error;
  return (
    <section
      className="overflow-hidden rounded-xl border border-border/60 bg-card/50"
      aria-label={`${name} funding`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheckIcon className="size-4 text-primary" />
            Membership allowance
          </h3>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {name} on {host}
          </p>
        </div>
        <Badge variant={state?.state === "active" && state.eligible ? "success" : "outline"}>
          {!state
            ? "Checking"
            : state.state === "active" && state.eligible
              ? "Linked"
              : state.state === "unfunded"
                ? "Not linked"
                : state.state === "pending"
                  ? "Approval pending"
                  : state.state === "revoked"
                    ? "Revoked"
                    : "Unavailable"}
        </Badge>
      </div>
      <div className="space-y-3 px-4 pb-4 pt-3 text-xs">
        {state?.accountLabel && (
          <p className="break-words">
            Membership · <span className="font-medium">{state.accountLabel}</span>
          </p>
        )}
        {allowance && (
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p>
                <span className="text-lg font-semibold tabular-nums">
                  {allowance.remainingInputTokens.toLocaleString()}
                </span>{" "}
                <span className="text-muted-foreground">
                  {allowanceConfirmed ? "tokens remaining" : "tokens last reported"}
                </span>
              </p>
              <span className="text-muted-foreground">
                Resets {new Date(allowance.windowEnd).toLocaleDateString()}
              </span>
            </div>
            <p className="mt-1 text-muted-foreground">
              One monthly pool shared by Decisions and Contextual.
              {!allowanceConfirmed
                ? " This balance is not confirmed. Refresh membership status to check current access."
                : ""}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-3">
              {allowance.byFeature.map((usage) => (
                <div key={usage.featureId}>
                  <dt className="font-medium">
                    {usage.featureId === "decisions" ? "Decisions" : "Contextual"}
                  </dt>
                  <dd className="mt-0.5 text-muted-foreground">
                    {usage.usedInputTokens.toLocaleString()} used ·{" "}
                    {usage.reservedInputTokens.toLocaleString()} reserved
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {state?.eligible && allowance?.remainingInputTokens === 0 && (
          <p className="text-warning-foreground">
            The shared allowance is exhausted.{" "}
            {featureId === "contextual"
              ? "Eligible local collection can continue; paid evaluation is paused."
              : "New detection is paused until the allowance resets."}
          </p>
        )}
        {denial && <p>{denial.message}</p>}
        {state?.remoteRevocationPending && (
          <p>Revoked on this host. Cloud revocation will be retried.</p>
        )}
        {canFund ? (
          <>
            {pending ? (
              <div className="space-y-2 rounded-lg border border-border/60 p-3" role="status">
                <p className="font-medium">
                  {pending.state === "linked"
                    ? "Membership linked"
                    : pending.state === "approved-awaiting-host"
                      ? "Approved · finishing host link"
                      : pending.state === "awaiting-approval"
                        ? "Approve in your browser"
                        : `Request ${pending.state}`}
                </p>
                {waiting && (
                  <>
                    <p className="text-muted-foreground">
                      Confirm {name}, {host}, and the paying account in the approval page. This host
                      finishes linking automatically after approval. Expires{" "}
                      {new Date(pending.challenge.expiresAt).toLocaleTimeString()}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        render={
                          <a
                            href={pending.challenge.approvalUrl}
                            target="_blank"
                            rel="noreferrer"
                          />
                        }
                      >
                        <ExternalLinkIcon />
                        Open approval
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void act("cancel")}
                      >
                        Cancel request
                      </Button>
                    </div>
                  </>
                )}
                {pending.accountLabel && (
                  <p className="break-words">Paying account: {pending.accountLabel}</p>
                )}
                {checkingStopped && waiting && (
                  <p className="text-muted-foreground">
                    Automatic checks stopped. Your request remains open until it expires.
                  </p>
                )}
                {pending.state === "linked" && (
                  <p className="flex gap-1.5 text-success-foreground">
                    <CheckIcon className="size-3.5" />
                    {name} can use this membership’s shared allowance.
                  </p>
                )}
              </div>
            ) : null}
            {!waiting && (
              <p className="break-words text-muted-foreground">
                {accountLabel ? `Signed in here as ${accountLabel}. ` : ""}The approval page
                confirms the paying account. Approval authorizes only {name} on this host.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {!waiting && (
                <Button
                  size="sm"
                  variant={state?.state === "active" ? "outline" : "default"}
                  disabled={busy || !state}
                  onClick={() => void act("create")}
                >
                  {busy
                    ? "Working…"
                    : state?.state === "active"
                      ? "Change membership"
                      : "Link membership"}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  refreshFunding();
                  changed.current?.();
                  if (waiting) {
                    setCheckingStopped(false);
                    setMonitor(Date.now());
                  }
                }}
              >
                {waiting ? "Check approval" : "Refresh allowance"}
              </Button>
              {state?.state === "active" && !waiting && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmRevoke(true)}
                >
                  Revoke access…
                </Button>
              )}
              {denial?.manageMembership && (
                <Button
                  size="sm"
                  variant="outline"
                  render={<a href="/account/billing" target="_blank" rel="noreferrer" />}
                >
                  Manage membership
                </Button>
              )}
            </div>
            {confirmRevoke && (
              <div className="space-y-2 border-t border-border/60 pt-3">
                <p>
                  Revoke {name} on {host}?{" "}
                  {featureId === "contextual"
                    ? "New evaluation and collection stop. Saved data stays available to inspect, export, or forget."
                    : "New detection stops. Saved decisions remain available."}{" "}
                  Other feature approvals stay unchanged.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void act("revoke")}
                  >
                    Revoke {name}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmRevoke(false)}
                  >
                    Keep access
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            Only people with this host’s relay management permission can change funding.
          </p>
        )}
        {(error ?? funding.error ?? linkError) && (
          <p role="alert" className="text-destructive">
            {error ?? funding.error ?? linkError}
          </p>
        )}
      </div>
    </section>
  );
}
