import type { SquireIndicatorStateName } from "@lecturn/client-runtime/state/squire";
import type { SquirePalette } from "@lecturn/contracts";
import { View } from "react-native";
import Animated, { useAnimatedProps } from "react-native-reanimated";
import Svg, { Circle, G, Path } from "react-native-svg";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useSquireMotionTick } from "./SquireMotionClock";
import {
  SQUIRE_MARK_STRAND_LENGTH,
  SQUIRE_MARK_STRAND_PATH,
  squireIndicatorDimmed,
} from "./squireIndicator.logic";
import { squireTraceOffset } from "./squireMotion";
import { grayscaleTint, squireTint } from "./squirePalette";

const AnimatedPath = Animated.createAnimatedComponent(Path);

// Inlined from v5 threadkeeper-small.svg (24 viewBox), the source of truth.
const THREAD = "M4.5 12C4.5 16 11 15.5 14 17C17 19 13 21 9 20";
const STAR =
  "M16 1.5C16.3 3.4 16.6 3.7 18.5 4C16.6 4.3 16.3 4.6 16 6.5C15.7 4.6 15.4 4.3 13.5 4C15.4 3.7 15.7 3.4 16 1.5Z";
const TRACE_DASH = [SQUIRE_MARK_STRAND_LENGTH * 0.56, SQUIRE_MARK_STRAND_LENGTH * 0.44];

export interface SquireMarkProps {
  readonly state: SquireIndicatorStateName;
  readonly palette: SquirePalette;
  readonly isLead?: boolean | undefined;
  readonly size: number;
  readonly label: string;
  readonly visible?: boolean | undefined;
}

/** The Threadkeeper mark form of the indicator, used below 22 pt and for emblem presence. */
export function SquireMark({ state, palette, isLead, size, label, visible }: SquireMarkProps) {
  const { themeAppearance } = useAppearancePreferences();
  const working = state === "working";
  const waiting = state === "waiting";
  const dimmed = squireIndicatorDimmed(state);
  const color = squireTint(palette, isLead, themeAppearance);
  const tint = dimmed ? grayscaleTint(color) : color;
  // Waiting draws strand and thread in the one ring color: a two-tone mark at this size reads
  // as a dash, which is working's look.
  const strand = waiting ? tint.ring : tint.strand;
  const thread = waiting ? tint.ring : tint.thread;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: size, height: size, opacity: dimmed ? 0.5 : 1 }}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {/* While working the base recedes so the travelling segment reads in a still. */}
        <G opacity={working ? 0.35 : 1}>
          <G strokeLinecap="round" strokeLinejoin="round" strokeWidth={waiting ? 1.6 : 1.25}>
            <Path d={SQUIRE_MARK_STRAND_PATH} stroke={strand} />
            <Path d={THREAD} stroke={thread} />
          </G>
          <G fill={waiting ? tint.ring : tint.thread}>
            <Circle cx={4.5} cy={12} r={1} />
            <Circle cx={9} cy={20} r={1} />
            <Path d={STAR} />
          </G>
        </G>
        {working ? <MarkTrace color={tint.trace} animate={visible !== false} /> : null}
      </Svg>
    </View>
  );
}

function MarkTrace({ color, animate }: { readonly color: string; readonly animate: boolean }) {
  const tick = useSquireMotionTick(animate);
  const animatedProps = useAnimatedProps(
    () => ({
      strokeDashoffset: squireTraceOffset(tick.get(), SQUIRE_MARK_STRAND_LENGTH),
    }),
    [tick],
  );
  return (
    <AnimatedPath
      d={SQUIRE_MARK_STRAND_PATH}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeDasharray={TRACE_DASH}
      strokeDashoffset={0}
      animatedProps={animatedProps}
    />
  );
}
