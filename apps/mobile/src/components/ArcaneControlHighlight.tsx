import { useEffect, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

/** One short fade per interaction; no idle animation or animated shadow. */
export function ArcaneControlHighlight({
  active,
  radius = 999,
}: {
  readonly active: boolean;
  readonly radius?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const animation = Animated.timing(opacity, {
      toValue: active ? 1 : 0,
      duration: reduceMotion ? 0 : active ? 180 : 140,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [active, opacity, reduceMotion]);
  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      style={[StyleSheet.absoluteFill, styles.thread, { opacity, borderRadius: radius }]}
    />
  );
}

const styles = StyleSheet.create({
  thread: {
    borderWidth: 1,
    borderColor: "rgba(229, 180, 88, 0.8)",
    backgroundColor: "rgba(229, 180, 88, 0.055)",
    shadowColor: "#dfab52",
    shadowOpacity: 0.3,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
});
