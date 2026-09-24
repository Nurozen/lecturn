import { linkRemoteDecisionEnvironment } from "../cloud/linkEnvironmentAtoms";
import { readToken } from "../cloud/accountTokens";
import { readPreparedConnection } from "../state/session";
import { useServerConfigs } from "../state/entities";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { useState } from "react";
import { useUser } from "@clerk/react";
import {
  AuthRelayWriteScope,
  type DecisionFundingChallengeResult,
  type EnvironmentId,
} from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { useCloudLinkController } from "../cloud/useCloudLinkController";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentSessionState } from "../state/session";
import { useEnvironmentQuery } from "../state/query";
import { threadDecisionEnvironment } from "../state/threadDecisions";
import { useAtomCommand } from "../state/use-atom-command";
import { isElectron } from "../env";
import { Button } from "./ui/button";

/** Host authority requests a challenge; the browser payer independently approves it. */
type FundingProps = { environmentId: EnvironmentId; onChange: () => void };
export function DecisionsFunding(props: FundingProps) {
  return resolveCloudPublicConfig().clerkPublishableKey ? (
    <ConfiguredDecisionsFunding {...props} />
  ) : (
    <FundingControls {...props} />
  );
}
function ConfiguredDecisionsFunding(props: FundingProps) {
  const controller = useCloudLinkController();
  const { user } = useUser();
  const primaryId = usePrimaryEnvironmentId();
  const remoteLink = useAtomCommand(linkRemoteDecisionEnvironment, { reportFailure: false });
  const configs = useServerConfigs();
  return (
    <FundingControls
      {...props}
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
function FundingControls({
  environmentId,
  onChange,
  accountLabel,
  linkError,
  ensureLink,
}: FundingProps & {
  accountLabel?: string | undefined;
  linkError?: string | null;
  ensureLink?: () => Promise<boolean>;
}) {
  const funding = useEnvironmentQuery(
    threadDecisionEnvironment.fundingStatus({ environmentId, input: {} }),
  );
  const command = useAtomCommand(threadDecisionEnvironment.funding, { reportFailure: false });
  const primaryId = usePrimaryEnvironmentId();
  const session = useEnvironmentSessionState(environmentId);
  const canFund =
    (isElectron && primaryId === environmentId) ||
    (session.data?.authenticated === true &&
      session.data.scopes?.includes(AuthRelayWriteScope) === true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [challenge, setChallenge] = useState<DecisionFundingChallengeResult | null>(null),
    [confirmRevoke, setConfirmRevoke] = useState(false);
  const state = funding.data;
  async function act(operation: "challenge" | "redeem" | "revoke") {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      if (operation === "challenge" && ensureLink && !(await ensureLink())) {
        setError(
          "Link this host to your signed-in Lecturn account before requesting funding. Check account settings if sign-in is needed.",
        );
        return;
      }
      if (operation === "redeem" && !challenge) return;
      const input =
        operation === "redeem"
          ? {
              operation,
              challengeId: challenge!.challengeId,
              expectedGeneration: challenge!.generation,
            }
          : { operation, expectedGeneration: state.generation };
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value.challenge) setChallenge(result.value.challenge);
      else if (operation !== "challenge") setChallenge(null);
      setConfirmRevoke(false);
      funding.refresh();
      onChange();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Funding could not be updated. Refresh and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3" aria-label="Decision funding">
      <h3 className="text-sm font-medium">Detection allowance</h3>
      <p className="text-xs text-muted-foreground">
        {state?.accountLabel
          ? `Funded by ${state.accountLabel} · ${state.state}`
          : state
            ? `Funding: ${state.state}`
            : "Loading funding status…"}
      </p>
      {state?.allowance ? (
        <p className="text-xs">
          {state.allowance.remainingInputTokens.toLocaleString()} input tokens remaining ·{" "}
          {state.allowance.usedInputTokens.toLocaleString()} used ·{" "}
          {state.allowance.reservedInputTokens.toLocaleString()} reserved. Resets{" "}
          {new Date(state.allowance.windowEnd).toLocaleDateString()}.
        </p>
      ) : null}
      {state?.state === "active" && !state.eligible ? (
        <p className="text-xs">
          This membership is not currently eligible for new analysis. Saved decisions remain
          available.
        </p>
      ) : null}
      {state?.remoteRevocationPending ? (
        <p className="text-xs">Local funding is revoked. Cloud revocation will be retried.</p>
      ) : null}
      {!canFund ? (
        <p className="text-xs text-muted-foreground">
          Funding changes require this host’s relay management permission.
        </p>
      ) : (
        <>
          {accountLabel ? (
            <p className="text-xs">
              Signed in here as {accountLabel}. The browser approval shows the account that will
              pay.
            </p>
          ) : (
            <p className="text-xs">
              Approve the challenge in a browser signed in to the individual membership that will
              fund this host.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !state}
              onClick={() => void act("challenge")}
            >
              {state?.state === "active" ? "Change funding account…" : "Link membership…"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                funding.refresh();
                onChange();
              }}
            >
              Refresh allowance
            </Button>
            {state && (state.state === "active" || state.state === "pending") ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmRevoke(true)}
              >
                Revoke funding…
              </Button>
            ) : null}
          </div>
          {challenge ? (
            <div className="space-y-2 border-t border-border/50 pt-2">
              <p className="text-xs">
                Open the approval page, check the host and account, then return here. Expires{" "}
                {new Date(challenge.expiresAt).toLocaleTimeString()}.
              </p>
              <a
                className="text-sm underline"
                href={challenge.approvalUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open funding approval
              </a>
              <div>
                <Button size="xs" disabled={busy} onClick={() => void act("redeem")}>
                  I approved — finish linking
                </Button>
              </div>
            </div>
          ) : null}
          {confirmRevoke ? (
            <div className="space-y-2 border-t border-border/50 pt-2">
              <p className="text-xs">
                Stop this host using this membership’s detection allowance? Saved notes remain
                available.
              </p>
              <Button
                size="xs"
                variant="destructive"
                disabled={busy}
                onClick={() => void act("revoke")}
              >
                Revoke funding
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmRevoke(false)}
              >
                Keep funding
              </Button>
            </div>
          ) : null}
        </>
      )}
      {(error ?? funding.error ?? linkError) ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? funding.error ?? linkError}
        </p>
      ) : null}
    </div>
  );
}
