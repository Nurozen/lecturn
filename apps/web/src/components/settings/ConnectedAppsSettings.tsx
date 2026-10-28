import {
  APP_PAIRING_APPROVE_LABEL,
  appPairingKind,
} from "@lecturn/client-runtime/state/app-status";
import { AuthAccessReadScope, type AppStatus } from "@lecturn/contracts";
import { BlocksIcon, EllipsisIcon } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { appsEnvironment } from "~/state/apps";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  ConnectedAppCommand,
  ConnectedAppGatedTools,
  ConnectedAppIcon,
  RuntimeCeilingSelect,
} from "../apps/ConnectedAppDetails";
import { useConnectedAppCommands } from "../apps/useConnectedAppCommands";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import {
  connectedAppAccess,
  connectedAppStatus,
  deleteConnectedAppConfirmMessage,
  type ConnectedAppStatusTone,
} from "./ConnectedAppsSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const STATUS_BADGE_VARIANT = {
  success: "success",
  warning: "warning",
  error: "error",
  muted: "secondary",
} as const satisfies Record<ConnectedAppStatusTone, string>;

const PAIRING_ROW_DESCRIPTIONS = {
  new: "Waiting for your approval to connect.",
  changed:
    "Asks to run a different command, environment or origins than you approved. Its access is paused until you decide.",
  renew: "Asks for a new credential with the command you already approved.",
  repair: "Asks to pair again. Approving restores its access.",
} as const;

type ConnectedAppCommands = ReturnType<typeof useConnectedAppCommands>;

export function ConnectedAppsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const commands = useConnectedAppCommands(environmentId);
  const statuses = useEnvironmentQuery(
    environmentId !== null && canRead
      ? appsEnvironment.statuses({ environmentId, input: null })
      : null,
  );
  const apps = statuses.data ?? [];

  return (
    <SettingsPageContainer>
      {!canRead ? (
        <Alert variant="warning">
          <AlertDescription>
            This connection cannot view connected apps. Pair with administrative access to manage
            them.
          </AlertDescription>
        </Alert>
      ) : !commands.canManage ? (
        <Alert variant="info">
          <AlertDescription>
            This connection can view connected apps but not approve, revoke or remove them.
          </AlertDescription>
        </Alert>
      ) : null}
      {canRead && statuses.error !== null && apps.length === 0 ? (
        <Alert variant="error">
          <AlertDescription>{statuses.error}</AlertDescription>
        </Alert>
      ) : null}
      {canRead && statuses.data === null && statuses.error === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : null}
      {canRead && statuses.data !== null && apps.length === 0 ? (
        <SettingsSection {...searchableSetting("connected-apps")} hideTitle>
          <Empty className="min-h-52">
            <EmptyMedia variant="icon">
              <BlocksIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No connected apps</EmptyTitle>
              <EmptyDescription>
                Apps built on Lecturn appear here when they ask to pair with this machine.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : null}
      {apps.map((app, index) => (
        <ConnectedAppSection
          key={app.appId}
          app={app}
          commands={commands}
          {...(index === 0 ? { id: searchableSetting("connected-apps").id } : {})}
        />
      ))}
    </SettingsPageContainer>
  );
}

function ConnectedAppSection({
  app,
  commands,
  id,
}: {
  readonly app: AppStatus;
  readonly commands: ConnectedAppCommands;
  readonly id?: string;
}) {
  const status = connectedAppStatus(app);
  const pairingKind = appPairingKind(app);
  const busy = commands.busyAppId === app.appId;
  const disabled = busy || !commands.canManage;
  const access = connectedAppAccess(app);

  const remove = async (deleteThreads: boolean) => {
    const confirmed = await requestConfirmDialog(
      deleteConnectedAppConfirmMessage(app, deleteThreads),
      { variant: "destructive" },
    );
    if (confirmed === true) await commands.remove(app, deleteThreads);
  };
  const revoke = async () => {
    const confirmed = await requestConfirmDialog(
      `Revoke ${app.name}?\n\nIts credential stops working and its tools stop running. Its threads stay visible, and you can pair it again later.`,
      { variant: "destructive" },
    );
    if (confirmed === true) await commands.revoke(app);
  };

  return (
    <SettingsSection
      {...(id === undefined ? {} : { id })}
      title={app.name}
      icon={<ConnectedAppIcon iconDataUrl={app.iconDataUrl} />}
      titleAction={
        <Badge variant={STATUS_BADGE_VARIANT[status.tone]} size="sm" data-testid="app-status">
          {status.label}
        </Badge>
      }
      headerAction={
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`More actions for ${app.name}`}
                disabled={disabled}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem variant="destructive" onClick={() => void remove(false)}>
              Remove app
            </MenuItem>
            <MenuItem variant="destructive" onClick={() => void remove(true)}>
              Remove app and its threads
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    >
      {pairingKind !== null ? (
        <SettingsRow
          title="Pairing request"
          description={PAIRING_ROW_DESCRIPTIONS[pairingKind]}
          control={
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => void commands.deny(app)}
              >
                Deny
              </Button>
              <Button size="sm" disabled={disabled} onClick={() => void commands.approve(app)}>
                {APP_PAIRING_APPROVE_LABEL[pairingKind]}
              </Button>
            </>
          }
        >
          {pairingKind === "changed" && app.pendingRequest !== null ? (
            <div className="space-y-1.5 pb-2">
              <p className="text-xs font-medium text-foreground/80">Requested command</p>
              <ConnectedAppCommand tools={app.pendingRequest.registration.headlessTools ?? null} />
            </div>
          ) : null}
        </SettingsRow>
      ) : app.state === "revoked" || app.state === "denied" ? (
        <SettingsRow
          title="Re-pair"
          description={`Open ${app.name} to ask for pairing again; you approve the request here or in the prompt that appears.`}
        />
      ) : null}
      <SettingsRow
        title="Status"
        description={app.appId}
        status={
          app.lastSeenAt === null
            ? "Not seen yet"
            : `Last seen ${formatRelativeTimeLabel(app.lastSeenAt)}`
        }
      />
      <SettingsRow title="Scopes" description="What the app's credential allows.">
        <ul className="space-y-1 pb-2 text-xs">
          {access.map((item) => (
            <li key={item.title}>
              <span className="font-medium text-foreground/85">{item.title}.</span>{" "}
              <span className="text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
      </SettingsRow>
      <SettingsRow title="Pinned command" description="Approved at pairing; a change asks again.">
        <div className="pb-2">
          <ConnectedAppCommand tools={app.headlessTools} />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Gated tools"
        description="Tools the app marked as needing approval."
        status={<ConnectedAppGatedTools toolPrefix={app.toolPrefix} gatedTools={app.gatedTools} />}
      />
      <SettingsRow
        title="Runtime ceiling"
        description="The most the app's gated tools may run without asking, whatever the thread's mode."
        control={
          <RuntimeCeilingSelect
            value={app.runtimeCeiling}
            disabled={disabled}
            onChange={(ceiling) => void commands.setRuntimeCeiling(app, ceiling)}
          />
        }
      />
      {app.state === "granted" ? (
        <SettingsRow
          title="Revoke access"
          description="Stops its tools and rejects its credential. Threads stay visible."
          control={
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={disabled}
              onClick={() => void revoke()}
            >
              Revoke
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
