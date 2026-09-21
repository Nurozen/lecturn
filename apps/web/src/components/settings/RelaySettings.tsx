import { useAtomValue } from "@effect/atom-react";
import { AuthAdministrativeScopes, AuthRelayWriteScope } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { Link } from "@tanstack/react-router";

import { connectAccountProfilesAtom } from "~/cloud/connectAccounts";
import { usePrimaryCloudLinkState } from "~/cloud/primaryCloudLinkState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { usePrimarySessionState } from "~/environments/primary";
import { usePrimaryEnvironment } from "~/state/environments";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { CloudLinkRow } from "./ConnectionsSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { relayHealthStatus } from "./RelaySettings.logic";

function ConfiguredRelaySettings() {
  const primary = usePrimaryEnvironment();
  const link = usePrimaryCloudLinkState();
  const session = usePrimarySessionState();
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const accounts = useAtomValue(relayEnvironmentDiscovery.accountStatesValueAtom);
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const scopes = window.desktopBridge
    ? AuthAdministrativeScopes
    : session.data?.authenticated
      ? session.data.scopes
      : undefined;
  const ownerId = link.data?.cloudUserId;
  const owner = ownerId ? profiles.get(ownerId) : undefined;
  const accountState = ownerId ? accounts.get(ownerId) : undefined;
  const environment = primary ? accountState?.environments.get(primary.environmentId) : undefined;
  const status = relayHealthStatus({
    deviceRelayConflict: link.data?.deviceRelayConflict,
    linked: link.data?.linked ?? false,
    managedTunnel: link.data?.managedTunnelActive ?? link.data?.linked ?? false,
    checking: link.isPending || (accountState?.refreshing ?? false),
    error: link.error ?? (accountState ? Option.getOrNull(accountState.error)?.message : null),
    availability: environment?.availability,
    offline: accountState?.offline ?? false,
  });

  if (!link.target) {
    return (
      <SettingsSection title="Relay">
        <SettingsRow
          title="Manage relay on your host"
          description="Open Settings → Relay in the Lecturn desktop app or the web app served by your host to publish that environment. This hosted web client does not run a relay."
          control={
            <Button render={<Link to="/settings/connections" />} variant="outline">
              View connections
            </Button>
          }
        />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection id="relay-health" title="Relay health">
        <SettingsRow
          title={primary?.label ?? "This environment"}
          description={
            <span role="status" className="flex items-start gap-2">
              <span
                key={status.tone}
                aria-hidden="true"
                className="lecturn-relay-status-dot mt-1.5 shrink-0"
                data-status={status.tone}
              />
              <span>{status.label}</span>
            </span>
          }
          status={environment ? Option.getOrNull(environment.error)?.message : undefined}
          control={
            <Button
              variant="outline"
              disabled={link.isPending || accountState?.refreshing}
              onClick={() => {
                link.refresh();
                void refreshDiscovery();
              }}
            >
              Refresh status
            </Button>
          }
        />
        {link.data?.deviceRelayConflict ? (
          <SettingsRow title="Device relay in use" description={link.data.deviceRelayConflict} />
        ) : null}
        <SettingsRow
          title="Associated account"
          description={
            link.data?.linked
              ? (owner?.email ?? owner?.label ?? "Another Lecturn account")
              : "Not linked to an account"
          }
        />
        {link.data?.relayUrl ? (
          <SettingsRow title="Relay service" description={link.data.relayUrl} />
        ) : null}
      </SettingsSection>
      <SettingsSection id="relay-publishing" title="Publishing">
        <p className="px-3 py-4 text-sm leading-relaxed text-muted-foreground sm:px-4">
          This device can publish through one relay at a time, across all Lecturn installations. The
          relay belongs to one account. Switching accounts does not move its projects. Unlink it
          before publishing to another account.
        </p>
        <CloudLinkRow canManageRelay={scopes?.includes(AuthRelayWriteScope) ?? false} />
      </SettingsSection>
    </>
  );
}

export function RelaySettings() {
  return (
    <SettingsPageContainer>
      {hasCloudPublicConfig() ? (
        <ConfiguredRelaySettings />
      ) : (
        <SettingsSection title="Relay">
          <SettingsRow
            title="Lecturn Connect is not configured"
            description="This installation supports local and direct connections. Configure Lecturn Connect to publish this environment through a relay."
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
