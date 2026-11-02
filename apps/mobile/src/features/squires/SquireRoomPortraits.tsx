import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId } from "@lecturn/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useSquireEntry, useSquireIndicator } from "../../state/squire";
import { SquireIndicator } from "./SquireIndicator";

/** Member portraits overlapped, then "+N". Callers mount this under one `SquireMotionClock`. */
export function SquireRoomPortraits(props: {
  readonly environmentId: EnvironmentId;
  readonly portraits: ReadonlyArray<SquireId>;
  readonly overflow: number;
  readonly size: number;
  readonly visible?: boolean;
}) {
  return (
    <View
      className="flex-row items-center"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {props.portraits.map((squireId, index) => (
        <View key={squireId} style={index === 0 ? undefined : { marginLeft: -props.size * 0.28 }}>
          <MemberPortrait
            environmentId={props.environmentId}
            squireId={squireId}
            size={props.size}
            visible={props.visible}
          />
        </View>
      ))}
      {props.overflow > 0 ? (
        <Text className="ml-1 font-sans text-2xs text-foreground-muted tabular-nums">
          +{props.overflow}
        </Text>
      ) : null}
    </View>
  );
}

function MemberPortrait(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly size: number;
  readonly visible: boolean | undefined;
}) {
  const entry = useSquireEntry(props.environmentId, props.squireId);
  if (entry === null) return null;
  return <MemberPortraitBody {...props} entry={entry} />;
}

function MemberPortraitBody(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly size: number;
  readonly visible: boolean | undefined;
}) {
  const { squire } = props.entry;
  const indicator = useSquireIndicator(props.environmentId, props.entry);
  return (
    <SquireIndicator
      state={indicator.state}
      companion={squire.companion}
      isLead={squire.role === "lead"}
      size={props.size}
      label={squire.name}
      {...(props.visible === undefined ? {} : { visible: props.visible })}
    />
  );
}
