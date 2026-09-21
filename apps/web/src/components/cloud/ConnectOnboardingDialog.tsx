import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { AuthAdministrativeScopes, AuthRelayWriteScope } from "@lecturn/contracts";
import { CheckIcon } from "lucide-react";
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
import { usePrimarySessionState } from "~/environments/primary";
import { knownConnectAccountsAtom, newlyKnownAccounts } from "~/cloud/knownAccounts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { ConnectSubscriptionGate } from "./ConnectSubscriptionGate";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { TeamSelector } from "./TeamSelector";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

/**
 * Post-sign-in onboarding wizard for Lecturn Connect. Opens when an account
 * that is new to this client signs in, since it has no devices to reach yet:
 * sign-out removes an account's relay environments. It first prompts to publish this
 * environment (managed tunnel + agent activity, both defaulting on) when the
 * current session is authorized to manage the relay link, then lists the
 * account's Lecturn Connect environments so every device can be connected right
 * away. A cold load with a restored session does not count as a sign-in.
 */
export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

type OnboardingStep = "publish" | "devices";

function ConfiguredConnectOnboardingDialog() {
  // Mirrors ManagedRelayAuthProvider: a pending Clerk session must not read as
  // signed-out, or its later activation would look like a fresh sign-in.
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const desktopBridge = window.desktopBridge;
  const primarySessionState = usePrimarySessionState();
  const currentSessionScopes = desktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null;
  const canManageRelay = currentSessionScopes?.includes(AuthRelayWriteScope) ?? false;
  // The publish step is only offered when we know the answer; opening the
  // wizard before the session state resolves would let the step set change
  // mid-flight. A failed session read still opens the wizard — it just means
  // no publish step.
  const sessionScopesKnown =
    Boolean(desktopBridge) ||
    primarySessionState.data !== null ||
    primarySessionState.error !== null;

  const controller = useCloudLinkController();
  const showPublishStep = canManageRelay && controller.linkState.target !== null;
  const steps: ReadonlyArray<OnboardingStep> = showPublishStep
    ? ["publish", "devices"]
    : ["devices"];

  const [requests, setRequests] = useState<ReadonlyArray<ConnectOnboardingRequest>>([]);
  const [openForAccount, setOpenForAccount] = useState<string | null>(null);
  const [step, setStep] = useState<OnboardingStep>("devices");
  const [exposeEnvironment, setExposeEnvironment] = useState(true);
  const [publishAgentActivity, setPublishAgentActivity] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const prefilledFromLinkStateRef = useRef(false);
  const knownAccounts = useAtomValue(knownConnectAccountsAtom);
  // The wizard publishes and lists devices as Clerk's active account.
  const namedAccount = useAccountEmailWhenSeveral(userId);
  const observedKnownAccountsRef = useRef(knownAccounts);

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

  // Open once the session scopes resolve so the step set is stable. Accounts
  // that chose "Don't show this again" are skipped.
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

  // Signing out (or switching accounts) mid-wizard invalidates everything the
  // wizard would do — close it and let the sign-in trigger re-evaluate.
  useEffect(() => {
    if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
      setOpenForAccount(null);
    }
    if (requests.length > 0 && isLoaded && !isSignedIn) {
      setRequests([]);
    }
  }, [isLoaded, isSignedIn, openForAccount, requests, userId]);

  // Toggles default on, but an environment that is already linked should show
  // its actual configuration instead of silently proposing to rewrite it.
  // Only when the link belongs to the account being onboarded, though — after
  // an account switch the cached link state can still describe the previous
  // account's setup.
  const linkStateData = controller.linkState.data;
  useEffect(() => {
    if (openForAccount === null || prefilledFromLinkStateRef.current || linkStateData === null) {
      return;
    }
    prefilledFromLinkStateRef.current = true;
    if (linkStateData.linked && linkStateData.cloudUserId === openForAccount) {
      setExposeEnvironment(linkStateData.managedTunnelActive ?? linkStateData.linked);
      setPublishAgentActivity(linkStateData.publishAgentActivity);
    }
  }, [linkStateData, openForAccount]);

  const complete = () => {
    // Keep the wizard up while a link request is in flight so its outcome
    // (and any failure) stays visible.
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
        // Keep the dialog up while a link request is in flight so its outcome
        // (and any failure) stays visible.
        if (!open && !isApplying) complete();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Set up Lecturn Connect</DialogTitle>
          <DialogDescription>
            {namedAccount
              ? `Publish this environment under ${namedAccount} and connect that account's other devices.`
              : "Publish this environment and connect your other devices."}{" "}
            Managed Connect requires an active subscription, trial, or complimentary access. Local
            and direct connections remain free.
          </DialogDescription>
          <TeamSelector />
          {steps.length > 1 ? (
            <OnboardingStepper
              steps={steps}
              currentStep={step}
              disabled={isApplying}
              onStepSelect={setStep}
            />
          ) : null}
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {step === "publish" ? (
            <>
              <PublishStep
                exposeEnvironment={exposeEnvironment}
                publishAgentActivity={publishAgentActivity}
                disabled={isApplying}
                operationError={controller.operationError ?? controller.accountMismatchMessage}
                onExposeEnvironmentChange={setExposeEnvironment}
                onPublishAgentActivityChange={setPublishAgentActivity}
              />
              {controller.subscriptionRequired ? (
                <ConnectSubscriptionGate onRefresh={controller.checkSubscription} />
              ) : null}
            </>
          ) : (
            <DevicesStep />
          )}
        </DialogPanel>
        <DialogFooter variant="bare" className="sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground sm:self-center">
            <Checkbox
              checked={dontShowAgain}
              onCheckedChange={(checked) => setDontShowAgain(checked === true)}
            />
            Don&apos;t show this again
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {step === "publish" ? (
              <>
                <Button variant="ghost" disabled={isApplying} onClick={() => setStep("devices")}>
                  Not now
                </Button>
                <Button
                  disabled={
                    isApplying || (controller.linkState.isPending && linkStateData === null)
                  }
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
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const STEP_LABELS: Record<OnboardingStep, string> = {
  publish: "Publish",
  devices: "Connect devices",
};

function OnboardingStepper({
  steps,
  currentStep,
  disabled,
  onStepSelect,
}: {
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly currentStep: OnboardingStep;
  readonly disabled: boolean;
  readonly onStepSelect: (step: OnboardingStep) => void;
}) {
  const currentIndex = steps.indexOf(currentStep);
  return (
    <div className="grid grid-cols-2 gap-2">
      {steps.map((step, index) => (
        <button
          key={step}
          type="button"
          disabled={disabled}
          className={cn(
            "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left",
            index === currentIndex
              ? "border-primary bg-primary/10 ring-1 ring-primary/25"
              : index < currentIndex
                ? "border-border bg-background"
                : "border-border bg-muted/40",
          )}
          onClick={() => onStepSelect(step)}
        >
          <span
            className={cn(
              "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
              index < currentIndex
                ? "border-primary bg-primary text-primary-foreground"
                : index === currentIndex
                  ? "border-primary bg-background"
                  : "border-muted-foreground/35 bg-background",
            )}
            aria-hidden
          >
            {index < currentIndex ? <CheckIcon className="size-3" /> : null}
          </span>
          <span className="text-[10px] font-medium uppercase text-muted-foreground">
            Step {index + 1}
          </span>
          <span className="truncate text-xs font-semibold text-foreground">
            {STEP_LABELS[step]}
          </span>
        </button>
      ))}
    </div>
  );
}

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
