import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, AppState, StyleSheet, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import Animated, {
  useAnimatedProps,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { threadBorderGeometry, threadBorderPalette, threadBorderPhase } from "./thread-border";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const SEGMENTS = [
  "tail",
  "tail-rise",
  "body",
  "body-rise",
  "crest-rise",
  "crest",
  "tip-rise",
  "tip",
] as const;

function SheenSegment({
  path,
  perimeter,
  index,
  color,
  progress,
  strokeWidth,
}: {
  path: string;
  perimeter: number;
  index: number;
  color: string;
  progress: SharedValue<number>;
  strokeWidth: number;
}) {
  // Eight contiguous segments form a broad, tapered trail (24% of the outline),
  // rather than a point moving inside a square bounding box.
  const length = perimeter * 0.03;
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: -(progress.get() * perimeter + index * length),
  }));
  return (
    <AnimatedPath
      d={path}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeOpacity={(index + 1) / 8}
      strokeDasharray={[length, perimeter - length]}
      strokeDashoffset={-index * length}
      animatedProps={animatedProps}
    />
  );
}

/** A rounded metallic perimeter; motion is UI-thread driven and capped at 12 updates/s. */
export function ActiveThreadBorder({
  visible,
  settled = false,
  radius = 12,
}: {
  readonly visible: boolean;
  readonly settled?: boolean;
  readonly radius?: number;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const light = themeAppearance === "light";
  const palette = threadBorderPalette(light, settled);
  const focused = useIsFocused();
  const initialReducedMotion = useReducedMotion();
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const progress = useSharedValue(0);
  useEffect(() => {
    const app = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => {
      app.remove();
      motion.remove();
    };
  }, []);
  const strokeWidth = settled ? 2 : 1.5;
  // Copper edging remains visible beside the bright crest on cream surfaces.
  const edgeWidth = strokeWidth + (light ? 1 : 0);
  const geometry = threadBorderGeometry(size.width, size.height, radius, edgeWidth);
  const animate = visible && focused && foreground && !reducedMotion && geometry !== null;
  const clock = useFrameCallback(
    useCallback(
      ({ timeSinceFirstFrame }: { timeSinceFirstFrame: number }) => {
        "worklet";
        const phase = threadBorderPhase(timeSinceFirstFrame);
        if (progress.get() !== phase) progress.set(phase);
      },
      [progress],
    ),
    false,
  );
  useEffect(() => {
    clock.setActive(animate);
    // Keep a real static sheen when motion is disabled or a recycled row leaves view.
    if (!animate) progress.set(0);
    return () => clock.setActive(false);
  }, [animate, clock, progress]);
  const colors = [
    palette.trail,
    palette.trail,
    palette.trail,
    palette.metal,
    palette.metal,
    palette.metal,
    palette.tip,
    palette.tip,
  ];
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={({ nativeEvent: { layout } }) =>
        setSize((previous) =>
          previous.width === layout.width && previous.height === layout.height
            ? previous
            : { width: layout.width, height: layout.height },
        )
      }
      style={[StyleSheet.absoluteFill, { zIndex: 1 }]}
    >
      {geometry ? (
        <Svg width={size.width} height={size.height}>
          <Path d={geometry.path} fill="none" stroke={palette.base} strokeWidth={edgeWidth} />
          {colors.map((color, index) => (
            <SheenSegment
              key={SEGMENTS[index]}
              path={geometry.path}
              perimeter={geometry.perimeter}
              index={index}
              color={color}
              progress={progress}
              strokeWidth={strokeWidth}
            />
          ))}
        </Svg>
      ) : null}
    </View>
  );
}
