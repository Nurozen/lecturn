import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import Svg, { Path } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Finite decoration behind the conversation; native navigation keeps its own gestures. */
export function AccountGlassSweep({
  identity,
  color,
  disabled,
}: {
  readonly identity: string | undefined;
  readonly color: string;
  readonly disabled: boolean;
}) {
  const previous = useRef(identity);
  const progress = useSharedValue(1);
  useEffect(() => {
    if (previous.current === identity) {
      cancelAnimation(progress);
      progress.set(1);
      return;
    }
    const hadIdentity = previous.current !== undefined;
    previous.current = identity;
    cancelAnimation(progress);
    if (disabled || !hadIdentity || identity === undefined) {
      progress.set(1);
      return;
    }
    progress.set(0);
    progress.set(
      withTiming(1, {
        duration: 680,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }),
    );
    return () => cancelAnimation(progress);
  }, [identity, disabled, progress]);
  const path = useAnimatedProps(() => {
    const p = progress.value;
    const x = -18 + p * 144;
    const bend = 70 - p * 55;
    return {
      d: `M ${x} -20 L ${x} ${bend - 18} C ${x} ${bend}, ${x + 12} ${bend}, ${x + 12} ${bend + 18} L ${x + 12} 120`,
      opacity: disabled ? 0 : Math.sin(p * Math.PI) * 0.45,
    };
  });
  return (
    <Svg
      width="100%"
      height="100%"
      pointerEvents="none"
      accessible={false}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={StyleSheet.absoluteFill}
    >
      <AnimatedPath
        animatedProps={path}
        fill="none"
        stroke={color}
        strokeWidth={4}
        strokeOpacity={0.08}
      />
      <AnimatedPath
        animatedProps={path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={0.15}
      />
      <AnimatedPath animatedProps={path} fill="none" stroke={color} strokeWidth={0.25} />
    </Svg>
  );
}
