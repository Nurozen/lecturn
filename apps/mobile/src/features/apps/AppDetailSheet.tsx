import {
  appPairingKind,
  type AppEnvironmentStatus,
} from "@lecturn/client-runtime/state/app-status";
import { ScrollView, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Sheet } from "../../components/ui/Sheet";
import { AppText } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { appStatusPresentation, type AppCard } from "./apps-tab-state";
import { useConnectedAppCommands } from "./useConnectedAppCommands";

function AppEnvironmentSection(props: {
  readonly status: AppEnvironmentStatus;
  readonly machineLabel: string | null;
}) {
  const { app, environmentId } = props.status;
  const commands = useConnectedAppCommands(environmentId);
  const presentation = appStatusPresentation(app);
  const repairRequest = appPairingKind(app) === "repair";
  const disabled = commands.busy || !commands.canManage;

  const revoke = () =>
    Dialog.confirm({
      title: `Revoke ${app.name}?`,
      message:
        "Its credential stops working and its tools stop running. Its threads stay visible, and you can pair it again later.",
      confirmText: "Revoke",
      destructive: true,
      onConfirm: () => void commands.revoke(app),
    });

  return (
    <ListSection
      title={props.machineLabel ?? "Status"}
      footer={
        !commands.canManage
          ? "This connection can view the app but not revoke or re-pair it."
          : undefined
      }
    >
      <ListRowLayout
        label={presentation.label}
        description={app.appId}
        detail={
          app.lastSeenAt === null ? "Not seen yet" : `Seen ${relativeTime(app.lastSeenAt)} ago`
        }
      />
      {app.state === "granted" ? (
        <ListActionRow
          icon="xmark.circle.fill"
          label="Revoke access"
          description="Stops its tools and rejects its credential. Threads stay visible."
          tone="danger"
          disabled={disabled}
          loading={commands.busy}
          onPress={revoke}
        />
      ) : repairRequest ? (
        <ListActionRow
          icon="arrow.clockwise"
          label="Re-pair"
          description={`${app.name} asked to pair again. Approving restores its access.`}
          disabled={disabled}
          loading={commands.busy}
          onPress={() => void commands.approve(app)}
        />
      ) : app.state === "revoked" || app.state === "denied" ? (
        <ListRowLayout
          icon="arrow.clockwise"
          label="Re-pair"
          description={`Open ${app.name} on ${props.machineLabel ?? "its computer"} to ask for pairing again, then approve it here.`}
        />
      ) : null}
    </ListSection>
  );
}

/** The way out on mobile: revoke and re-pair; the rest of an app's settings stay on web and desktop. */
export function AppDetailSheet(props: {
  readonly card: AppCard;
  readonly environmentLabels: ReadonlyMap<string, string>;
  readonly onClose: () => void;
}) {
  const { card } = props;
  return (
    <Sheet title={card.name} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16, gap: 20 }}
      >
        {card.statuses.length === 0 ? (
          <View className="px-2">
            <AppText className="text-sm text-foreground-muted">
              This connection cannot see {card.name}'s pairing. Its threads stay listed here.
            </AppText>
          </View>
        ) : (
          card.statuses.map((status) => (
            <AppEnvironmentSection
              key={status.environmentId}
              status={status}
              machineLabel={
                card.spansEnvironments
                  ? (props.environmentLabels.get(status.environmentId) ?? null)
                  : null
              }
            />
          ))
        )}
      </ScrollView>
    </Sheet>
  );
}
