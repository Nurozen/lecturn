import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId } from "@lecturn/contracts";
import { useRef } from "react";
import { View, type ViewInstance } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useSquireEntry, useSquireIndicator } from "../../state/squire";
import { SquireIndicator } from "./SquireIndicator";
import { useSquireInView } from "./SquireViewport";

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
  // A list row passes its viewability; inside a scroll view (the room header) it measures itself.
  const portraitRef = useRef<ViewInstance>(null);
  const inView = useSquireInView(
    portraitRef,
    indicator.state === "working" && props.visible === undefined,
  );
  const visible = props.visible ?? inView.visible;
  return (
    <View ref={portraitRef} onLayout={inView.onLayout} collapsable={false}>
      <SquireIndicator
        state={indicator.state}
        companion={squire.companion}
        isLead={squire.role === "lead"}
        size={props.size}
        label={squire.name}
        {...(visible === undefined ? {} : { visible })}
      />
    </View>
  );
}
