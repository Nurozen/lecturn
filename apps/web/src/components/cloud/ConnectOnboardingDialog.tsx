import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { AuthRelayReadScope, AuthRelayWriteScope, type AuthSessionState } from "@lecturn/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import {
  CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
  ConnectOnboardingOptOutSchema,
  EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
  pendingOnboardingRequests,
  type ConnectOnboardingRequest,
} from "~/cloud/connectOnboarding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useAccountEmailWhenSeveral } from "~/cloud/useAccountEmailWhenSeveral";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { knownConnectAccountsAtom, newlyKnownAccounts } from "~/cloud/knownAccounts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { environmentSession, readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useConnectAccountPicker } from "../clerk/ConnectAccountPicker";
import { ConnectSubscriptionGate } from "./ConnectSubscriptionGate";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog } from "../ui/dialog";
import { TeamSelector } from "./TeamSelector";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../ui/wizard";

export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

type OnboardingStep = "publish" | "devices";

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

function ConfiguredConnectOnboardingDialog() {
  // Mirrors ManagedRelayAuthProvider: a pending Clerk session must not read as
  // signed-out, or its later activation would look like a fresh sign-in.
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const { isReady: environmentsReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primarySessionState = useAtomValue(
    primaryEnvironmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(primaryEnvironmentId),
  );
  const canReadRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope);
  const canManageRelay = canReadRelay && canWriteRelay;
  const sessionScopesKnown =
    primaryEnvironmentId === null ? environmentsReady : primarySessionState._tag !== "Initial";

  const [openForAccount, setOpenForAccount] = useState<string | null>(null);
  // The wizard opens for a new account, which stays the default over the open thread's owner.
  // The dialog stays mounted, so a choice made in it ends when it closes or opens for another.
  const account = useConnectAccountPicker("publish", {
    label: "Publish as",
    preferredAccountId: openForAccount,
    open: openForAccount !== null,
  });
  const controller = useCloudLinkController({
    accountId: account.accountId,
    onSelectAccount: account.select,
  });
  const showPublishStep = canManageRelay && controller.linkState.target !== null;
  const steps: ReadonlyArray<OnboardingStep> = showPublishStep
    ? ["publish", "devices"]
    : ["devices"];

  const [requests, setRequests] = useState<ReadonlyArray<ConnectOnboardingRequest>>([]);
  const [step, setStep] = useState<OnboardingStep>("devices");
  const [exposeEnvironment, setExposeEnvironment] = useState(true);
  const [publishAgentActivity, setPublishAgentActivity] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const prefilledFromLinkStateRef = useRef(false);
  const knownAccounts = useAtomValue(knownConnectAccountsAtom);
  const namedAccount = useAccountEmailWhenSeveral(account.visible ? account.accountId : userId);
  const observedKnownAccountsRef = useRef(knownAccounts);

  useEffect(() => {
    if (step === "publish" && sessionScopesKnown && !showPublishStep && !isApplying) {
      setStep("devices");
    }
  }, [isApplying, sessionScopesKnown, showPublishStep, step]);

  const optOutAccounts = optOutState.optOutAccounts;

  // An account that is new to this client requests the wizard: it starts with
  // no devices to reach. Switching between known accounts, a known account
  // signing in again, and sessions restored on a cold load do not. Requests
  // queue, so two accounts added together each get their turn, and one that
  // never becomes active lapses instead of opening on a later switch.
  useEffect(() => {
    const previous = observedKnownAccountsRef.current;
    observedKnownAccountsRef.current = knownAccounts;
    setRequests((current) => {
      const next = pendingOnboardingRequests({
        requests: current,
        added: newlyKnownAccounts(previous, knownAccounts),
        knownAccountIds: knownAccounts.accountIds,
        optOutAccounts,
        now: Date.now(),
      });
      return next.length === current.length && next.every((entry, i) => entry === current[i])
        ? current
        : next;
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- userId only re-runs it, so a switch drops lapsed requests
  }, [knownAccounts, optOutAccounts, userId]);

  // A manageable session implies a primary environment, so when the scopes
  // allow publishing, wait for the connection target too — otherwise the
  // wizard could open on the devices step moments before the publish step
  // becomes available and freeze there.
  const publishStepDecided = !canManageRelay || controller.linkState.target !== null;

  useEffect(() => {
    if (openForAccount !== null || !isLoaded) return;
    // The wizard acts on the active account, which Clerk makes the new one.
    const request = pendingOnboardingRequests({
      requests,
      added: [],
      knownAccountIds: knownAccounts.accountIds,
      optOutAccounts,
      now: Date.now(),
    }).find((entry) => entry.accountId === userId);
    if (request === undefined) return;
    if (!sessionScopesKnown || !publishStepDecided) return;
    setRequests((current) => current.filter((entry) => entry !== request));
    prefilledFromLinkStateRef.current = false;
    setExposeEnvironment(true);
    setPublishAgentActivity(true);
    setDontShowAgain(false);
    setStep(canManageRelay && controller.linkState.target !== null ? "publish" : "devices");
    setOpenForAccount(request.accountId);
  }, [
    canManageRelay,
    controller.linkState.target,
    isLoaded,
    knownAccounts.accountIds,
    openForAccount,
    optOutAccounts,
    publishStepDecided,
    requests,
    sessionScopesKnown,
    userId,
  ]);

  useEffect(() => {
    if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
      setOpenForAccount(null);
    }
    if (requests.length > 0 && isLoaded && !isSignedIn) {
      setRequests([]);
    }
  }, [isLoaded, isSignedIn, openForAccount, requests, userId]);

  const linkStateData = controller.linkState.data;
  useEffect(() => {
    if (openForAccount === null || prefilledFromLinkStateRef.current || linkStateData === null) {
      return;
    }
    prefilledFromLinkStateRef.current = true;
    if (
      linkStateData.linked &&
      linkStateData.linkRevoked !== true &&
      linkStateData.cloudUserId === openForAccount
    ) {
      setExposeEnvironment(linkStateData.managedTunnelActive ?? linkStateData.linked);
      setPublishAgentActivity(linkStateData.publishAgentActivity);
    }
  }, [linkStateData, openForAccount]);

  const complete = () => {
    if (isApplying) return;
    const account = openForAccount;
    setOpenForAccount(null);
    if (account !== null && dontShowAgain) {
      setOptOutState((state) =>
        state.optOutAccounts.includes(account)
          ? state
          : { optOutAccounts: [...state.optOutAccounts, account] },
      );
    }
  };

  const applyPublishSelection = async () => {
    if (isApplying) return;
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    ) {
      setStep("devices");
      return;
    }
    if (linkStateData === null || controller.linkState.error !== null) return;
    // The wizard only ever enables — with both toggles off there is nothing to
    // apply, and an existing link must not be torn down from onboarding.
    if (!exposeEnvironment && !publishAgentActivity) {
      setStep("devices");
      return;
    }
    setIsApplying(true);
    const ok = await controller.reconcileCloudState({
      managedTunnel: exposeEnvironment,
      publish: publishAgentActivity,
    });
    setIsApplying(false);
    if (!ok) return;
    toastManager.add({
      type: "success",
      title: "Lecturn Connect enabled",
      description: namedAccount
        ? exposeEnvironment
          ? `This environment is available to ${namedAccount}'s other devices through Lecturn Connect.`
          : `This environment publishes agent activity to ${namedAccount}'s mobile clients.`
        : exposeEnvironment
          ? "This environment is available to your other devices through Lecturn Connect."
          : "This environment publishes agent activity to your mobile clients.",
    });
    setStep("devices");
  };

  return (
    <Dialog
      open={openForAccount !== null}
      onOpenChange={(open) => {
        if (!open && !isApplying) complete();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title="Set up Lecturn Connect"
          description={
            <>
              {namedAccount
                ? `Publish this environment under ${namedAccount} and connect that account's other devices.`
                : "Publish this environment and connect your other devices."}{" "}
              Managed Connect requires an active subscription, trial, or complimentary access. Local
              and direct connections remain free.
            </>
          }
        >
          {step === "publish" ? account.picker : null}
          <TeamSelector accountId={account.accountId} />
          {steps.length > 1 ? (
            <WizardSteps
              steps={steps.map((id) => STEP_LABELS[id])}
              currentStep={steps.indexOf(step)}
              isStepDisabled={() => isApplying}
              onStepChange={(index) => {
                const next = steps[index];
                if (
                  next === "publish" &&
                  (primaryEnvironmentId === null ||
                    !readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) ||
                    !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope))
                )
                  return;
                if (next) setStep(next);
              }}
            />
          ) : null}
        </WizardHeader>
        <WizardPanel>
          {step === "publish" ? (
            <>
              <PublishStep
                exposeEnvironment={exposeEnvironment}
                publishAgentActivity={publishAgentActivity}
                disabled={isApplying || !canManageRelay || linkStateData === null}
                operationError={
                  controller.operationError ??
                  controller.accountMismatchMessage ??
                  controller.linkState.error
                }
                onExposeEnvironmentChange={(enabled) => {
                  if (
                    primaryEnvironmentId !== null &&
                    readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) &&
                    readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
                  )
                    setExposeEnvironment(enabled);
                }}
                onPublishAgentActivityChange={(enabled) => {
                  if (
                    primaryEnvironmentId !== null &&
                    readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) &&
                    readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
                  )
                    setPublishAgentActivity(enabled);
                }}
              />
              {controller.subscriptionRequired ? (
                <ConnectSubscriptionGate
                  accountId={account.accountId}
                  onRefresh={controller.checkSubscription}
                />
              ) : null}
            </>
          ) : (
            <DevicesStep />
          )}
        </WizardPanel>
        <WizardFooter
          leading={
            <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground sm:self-center">
              <Checkbox
                checked={dontShowAgain}
                onCheckedChange={(checked) => setDontShowAgain(checked === true)}
              />
              Don&apos;t show this again
            </label>
          }
        >
          {step === "publish" ? (
            <>
              <Button variant="ghost" disabled={isApplying} onClick={() => setStep("devices")}>
                Not now
              </Button>
              <Button
                disabled={isApplying || !canManageRelay || linkStateData === null}
                onClick={() => void applyPublishSelection()}
              >
                {isApplying
                  ? "Checking and enabling…"
                  : controller.subscriptionRequired
                    ? "Refresh and continue"
                    : "Continue"}
              </Button>
            </>
          ) : (
            <Button disabled={isApplying} onClick={complete}>
              Done
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

const STEP_LABELS: Record<OnboardingStep, string> = {
  publish: "Publish",
  devices: "Connect devices",
};

function PublishStep({
  exposeEnvironment,
  publishAgentActivity,
  disabled,
  operationError,
  onExposeEnvironmentChange,
  onPublishAgentActivityChange,
}: {
  readonly exposeEnvironment: boolean;
  readonly publishAgentActivity: boolean;
  readonly disabled: boolean;
  readonly operationError: string | null;
  readonly onExposeEnvironmentChange: (enabled: boolean) => void;
  readonly onPublishAgentActivityChange: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border">
        <OnboardingToggleRow
          title="Publish this environment"
          description="Make this environment available to your other devices through Lecturn Connect."
          checked={exposeEnvironment}
          disabled={disabled}
          onCheckedChange={onExposeEnvironmentChange}
        />
        <OnboardingToggleRow
          title="Publish agent activity"
          description="Send activity from this environment to your mobile clients for push notifications and Live Activities."
          checked={publishAgentActivity}
          disabled={disabled}
          onCheckedChange={onPublishAgentActivityChange}
        />
      </div>
      {operationError ? <p className="text-xs text-destructive">{operationError}</p> : null}
    </div>
  );
}

function OnboardingToggleRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/60 px-4 py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function DevicesStep() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
        savedEnvironments={savedEnvironments}
        showSavedEnvironments
        empty={
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No other environments are published to your account yet. Publish one from another device
            and it will show up here.
          </p>
        }
      />
    </div>
  );
}
