import { useEffect, useState } from "react";
import { Animated, AppState, StyleSheet, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useReducedMotion } from "react-native-reanimated";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** A compositor-driven thread of light; recycled/offscreen rows keep a static edge. */
export function ActiveThreadBorder({
  visible,
  settled = false,
}: {
  readonly visible: boolean;
  readonly settled?: boolean;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const light = themeAppearance === "light";
  const focused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const animate = visible && focused && foreground && !reducedMotion;
  useEffect(() => {
    if (!animate) return;
    progress.setValue(0);
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 7000,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [animate, progress]);
  const width = Math.max(size.width - 4, 1);
  const height = Math.max(size.height - 4, 1);
  const perimeter = 2 * (width + height);
  const inputRange = [
    0,
    width / perimeter,
    (width + height) / perimeter,
    (2 * width + height) / perimeter,
    1,
  ];
  return (
    <View
      pointerEvents="none"
      accessible={false}
      onLayout={({ nativeEvent }) => setSize(nativeEvent.layout)}
      style={[
        StyleSheet.absoluteFill,
        {
          borderWidth: settled ? 2 : 1,
          borderColor: settled ? (light ? "#b33f32" : "#e64d3d") : light ? "#986718" : "#b68a43",
          borderRadius: 12,
        },
      ]}
    >
      {animate && size.width > 0 ? (
        <Animated.View
          style={{
            position: "absolute",
            width: 4,
            height: 4,
            borderRadius: 2,
            backgroundColor: settled
              ? light
                ? "#8e2c22"
                : "#ffd097"
              : light
                ? "#613908"
                : "#fff0c6",
            shadowColor: settled ? "#ff7258" : "#efc873",
            shadowOpacity: light ? 0.25 : 0.9,
            shadowRadius: 5,
            transform: [
              {
                translateX: progress.interpolate({
                  inputRange,
                  outputRange: [0, width, width, 0, 0],
                }),
              },
              {
                translateY: progress.interpolate({
                  inputRange,
                  outputRange: [0, 0, height, height, 0],
                }),
              },
            ],
          }}
        />
      ) : null}
    </View>
  );
}
