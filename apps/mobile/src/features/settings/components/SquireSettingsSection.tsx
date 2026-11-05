import { squireKnockResetDescription } from "@lecturn/client-runtime/state/squireKnock";
import { AuthSettingsWriteScope, type ServerSettingsPatch } from "@lecturn/contracts";
import { useState } from "react";

import { ListActionRow } from "../../../components/ui/ListActionRow";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { releaseSquireKnock } from "../../squires/SquireKnockCard";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/**
 * The Squires switch and the way back from the suggestion's "Not now" and "Don't show again".
 * Only where the server applies the switch live: elsewhere a change waits for a restart, and
 * the suggestion never shows.
 */
export function SquireSettingsSection(props: { readonly targets: readonly SettingsTarget[] }) {
  const writable = useEnvironmentsWithScope(props.targets, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "squire settings update",
    reportFailure: true,
  });
  // Read once per visit: a snooze that runs out while this screen stays open shows until revisited.
  const [now] = useState(() => Date.now());
  const targets = props.targets.filter(
    (target) =>
      writable.has(target.environmentId) &&
      target.serverConfig.environment.capabilities.squireLiveSwitch === true,
  );
  if (targets.length === 0) return null;
  const write = (target: SettingsTarget, patch: ServerSettingsPatch) =>
    void updateSettings({ environmentId: target.environmentId, input: { patch } });

  return (
    <SettingsSection title="Squires">
      {targets.map((target) => {
        const { settings } = target.serverConfig;
        const on = target.serverConfig.environment.capabilities.squire === true;
        const hidden = on ? null : squireKnockResetDescription(settings.squire.knock, now);
        const where = props.targets.length > 1 ? ` on ${target.label}` : "";
        return [
          <SettingsSwitchRow
            key={`${target.environmentId}:enabled`}
            icon="person.2"
            label={`Squires${where}`}
            subtitle="Watch your threads and step in when one needs you."
            value={settings.squire.enabled}
            onValueChange={(enabled) => write(target, { squire: { enabled } })}
          />,
          hidden === null ? null : (
            <ListActionRow
              key={`${target.environmentId}:knock`}
              icon="arrow.uturn.backward"
              label="Show the Squire suggestion again"
              description={hidden}
              onPress={() => {
                releaseSquireKnock(target.environmentId);
                write(target, { squire: { knock: { dismissed: false, snoozedUntil: "" } } });
              }}
            />
          ),
        ];
      })}
    </SettingsSection>
  );
}
