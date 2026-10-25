import { AuthAccessReadScope, type AppRuntimeCeiling, type AppStatus } from "@lecturn/contracts";
import { useState } from "react";

import { appsEnvironment } from "~/state/apps";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  APP_PAIRING_APPROVE_LABEL,
  appPairingKind,
  type AppPairingKind,
} from "../settings/ConnectedAppsSettings.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  ConnectedAppCommand,
  ConnectedAppGatedTools,
  ConnectedAppIcon,
  RuntimeCeilingSelect,
} from "./ConnectedAppDetails";
import { useConnectedAppCommands } from "./useConnectedAppCommands";

const PROMPT_TITLES: Readonly<Record<AppPairingKind, (name: string) => string>> = {
  new: (name) => `Connect ${name} to Lecturn?`,
  changed: (name) => `${name} changed what it runs`,
  renew: (name) => `${name} wants to reconnect`,
  repair: (name) => `Pair ${name} again?`,
};

const PROMPT_DESCRIPTIONS: Readonly<Record<AppPairingKind, string>> = {
  new: "It asks to run agent threads in its own workspaces and offer its tools to their agents.",
  changed:
    "Its command, environment or allowed origins differ from what you approved. Its access is paused until you decide.",
  renew: "It asks for a new credential with the command you already approved.",
  repair: "You revoked or denied it before. Approving restores its access.",
};

/**
 * Asks every client that holds `access:write` on this machine's environment to
 * answer a waiting app pairing request. Closing the prompt only hides it here;
 * the request stays answerable from Settings > Connected apps until it expires.
 */
export function AppPairingPromptCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const commands = useConnectedAppCommands(environmentId);
  const enabled = environmentId !== null && canRead && commands.canManage;
  const statuses = useEnvironmentQuery(
    enabled ? appsEnvironment.statuses({ environmentId, input: null }) : null,
  );
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const app = (statuses.data ?? []).find(
    (candidate) =>
      candidate.pendingRequest !== null && !dismissed.has(candidate.pendingRequest.requestId),
  );
  if (!enabled || app === undefined || app.pendingRequest === null) return null;
  const requestId = app.pendingRequest.requestId;
  const dismiss = () => setDismissed((current) => new Set(current).add(requestId));

  return (
    <AppPairingPrompt
      // A new request starts from the app's current ceiling, not the last prompt's choice.
      key={requestId}
      app={app}
      busy={commands.busyAppId === app.appId}
      onDismiss={dismiss}
      onApprove={async (ceiling) => {
        if (await commands.approve(app, ceiling)) dismiss();
      }}
      onDeny={async () => {
        if (await commands.deny(app)) dismiss();
      }}
    />
  );
}

function AppPairingPrompt({
  app,
  busy,
  onApprove,
  onDeny,
  onDismiss,
}: {
  readonly app: AppStatus;
  readonly busy: boolean;
  readonly onApprove: (ceiling: AppRuntimeCeiling) => void;
  readonly onDeny: () => void;
  readonly onDismiss: () => void;
}) {
  const [ceiling, setCeiling] = useState(app.runtimeCeiling);
  const kind = appPairingKind(app) ?? "new";
  const registration = app.pendingRequest?.registration;
  if (registration === undefined) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <DialogPopup data-testid="app-pairing-prompt">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectedAppIcon iconDataUrl={registration.iconDataUrl} size="lg" />
            <div className="min-w-0 space-y-1">
              <DialogTitle>{PROMPT_TITLES[kind](registration.name)}</DialogTitle>
              <p className="truncate font-mono text-xs text-muted-foreground">{app.appId}</p>
            </div>
          </div>
          <DialogDescription>{PROMPT_DESCRIPTIONS[kind]}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <PromptSection title="Headless command">
            <ConnectedAppCommand tools={registration.headlessTools ?? null} />
          </PromptSection>
          <PromptSection title="Tools that need approval">
            <ConnectedAppGatedTools
              toolPrefix={registration.toolPrefix}
              gatedTools={registration.gatedTools}
            />
          </PromptSection>
          {registration.embedOrigins !== undefined && registration.embedOrigins.length > 0 ? (
            <PromptSection title="May embed Lecturn in">
              <p className="font-mono text-xs text-foreground/90">
                {registration.embedOrigins.join(", ")}
              </p>
            </PromptSection>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <h3 className="text-sm font-medium text-foreground">Runtime ceiling</h3>
              <p className="text-xs text-muted-foreground">
                The most its gated tools may run without asking. Change it later in Settings.
              </p>
            </div>
            <RuntimeCeilingSelect value={ceiling} disabled={busy} onChange={setCeiling} />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onDeny}>
            Deny
          </Button>
          <Button disabled={busy} onClick={() => onApprove(ceiling)}>
            {APP_PAIRING_APPROVE_LABEL[kind]}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PromptSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}
