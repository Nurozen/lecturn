import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { RequestActionButton } from "../threads/RequestActionButton";
import {
  APP_PAIRING_APPROVE_LABEL,
  APP_PAIRING_DESCRIPTION,
  type AppPairingItem,
} from "./apps-tab-state";
import { useConnectedAppCommands } from "./useConnectedAppCommands";

/** A pairing request inside the app's box, answered here or in Settings on another client. */
export function AppPairingRow(props: { readonly item: AppPairingItem }) {
  const { item } = props;
  const commands = useConnectedAppCommands(item.environmentId);
  const disabled = commands.busy || !commands.canManage;
  // A changed request runs a different command than the one approved, so show what will run.
  const tools = item.app.pendingRequest?.registration.headlessTools;
  const requestedCommand =
    item.kind === "changed" && tools !== undefined
      ? [tools.command, ...tools.args].join(" ")
      : null;
  return (
    <View className="gap-2.5 py-2 pr-1">
      <View className="gap-0.5">
        <AppText className="text-sm font-lecturn-medium text-foreground">
          {APP_PAIRING_DESCRIPTION[item.kind]}
          {item.machineLabel ? ` on ${item.machineLabel}` : ""}
        </AppText>
        {requestedCommand !== null ? (
          <AppText selectable className="font-mono text-xs text-foreground-secondary">
            {requestedCommand}
          </AppText>
        ) : null}
        {!commands.canManage ? (
          <AppText className="text-xs text-foreground-muted">
            This connection cannot approve apps.
          </AppText>
        ) : null}
      </View>
      <View className="flex-row gap-2.5">
        <RequestActionButton
          label="Deny"
          tone="secondary"
          disabled={disabled}
          accessibilityLabel={`Deny ${item.card.name}`}
          onPress={() => void commands.deny(item.app)}
        />
        <RequestActionButton
          label={APP_PAIRING_APPROVE_LABEL[item.kind]}
          tone="primary"
          disabled={disabled}
          accessibilityLabel={`${APP_PAIRING_APPROVE_LABEL[item.kind]} ${item.card.name}`}
          onPress={() => void commands.approve(item.app)}
        />
      </View>
    </View>
  );
}
