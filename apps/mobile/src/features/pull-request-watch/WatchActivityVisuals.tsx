import {
  activityVisualColor,
  type ActivityVisualState,
} from "@lecturn/client-runtime/state/activityContext";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState, type ReactNode } from "react";
import { Animated, AppState, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { ActiveThreadBorder } from "../threads/ActiveThreadBorder";
import { checkSegments } from "./watch-visuals";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export function WatchActivityFrame(props: {
  state: ActivityVisualState;
  visible: boolean;
  children: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const focused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const pulse =
    props.state === "attention" && props.visible && focused && foreground && !reducedMotion;
  useEffect(() => {
    if (!pulse) {
      opacity.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: themeAppearance === "light" ? 0.65 : 0.3,
          duration: 1200,
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity, pulse, themeAppearance]);
  const color = activityVisualColor(props.state, themeAppearance);
  return (
    <View onLayout={props.onLayout} className="gap-3 rounded-xl bg-subtle p-4">
      {props.state === "active" ? (
        <ActiveThreadBorder visible={props.visible} />
      ) : (
        <Animated.View
          pointerEvents="none"
          accessible={false}
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: 12, borderWidth: 1, borderColor: color, opacity },
          ]}
        />
      )}
      {props.children}
    </View>
  );
}

const segmentStyles: Record<
  keyof ReturnType<typeof checkSegments>,
  { icon: AppSymbolName; state: ActivityVisualState; label: string }
> = {
  passed: { icon: "checkmark.circle", state: "complete", label: "passed" },
  running: { icon: "clock", state: "active", label: "running" },
  attention: { icon: "exclamationmark.triangle", state: "attention", label: "need attention" },
  failed: { icon: "xmark.circle.fill", state: "failed", label: "failed" },
  other: {
    icon: "ellipsis.circle",
    state: "idle",
    label: "skipped, cancelled, neutral or unknown",
  },
};

export function WatchCheckSegments({ checks }: { checks: readonly { status: string }[] }) {
  const { themeAppearance } = useAppearancePreferences();
  const segmentColor = (key: keyof typeof segmentStyles) =>
    activityVisualColor(segmentStyles[key].state, themeAppearance);
  const entries = Object.entries(checkSegments(checks)) as [keyof typeof segmentStyles, number][];
  return (
    <View className="gap-2">
      <View
        accessible
        accessibilityLabel={
          checks.length
            ? entries
                .filter(([, count]) => count > 0)
                .map(([key, count]) => `${count} ${segmentStyles[key].label}`)
                .join(", ")
            : "CI status unknown: no jobs reported"
        }
        style={{ flexDirection: "row", gap: 3, height: 5, overflow: "hidden", borderRadius: 3 }}
      >
        {checks.length ? (
          entries
            .filter(([, count]) => count > 0)
            .map(([key, count]) => (
              <View key={key} style={{ flex: count, backgroundColor: segmentColor(key) }} />
            ))
        ) : (
          <View
            style={{
              flex: 1,
              backgroundColor: `${activityVisualColor("idle", themeAppearance)}55`,
            }}
          />
        )}
      </View>
      <View className="flex-row flex-wrap gap-3">
        {entries
          .filter(([, count]) => count > 0)
          .map(([key, count]) => (
            <View
              key={key}
              accessible
              accessibilityLabel={`${count} ${segmentStyles[key].label}`}
              className="flex-row items-center gap-1"
            >
              <SymbolView name={segmentStyles[key].icon} size={14} tintColor={segmentColor(key)} />
              <Text style={{ color: segmentColor(key), fontSize: 12 }}>{count}</Text>
            </View>
          ))}
        {!checks.length ? (
          <Text className="text-xs text-foreground-muted">No jobs reported</Text>
        ) : null}
      </View>
    </View>
  );
}
