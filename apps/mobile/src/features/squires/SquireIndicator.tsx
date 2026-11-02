import type { SquireIndicatorStateName } from "@lecturn/client-runtime/state/squire";
import type { SquireCompanion } from "@lecturn/contracts";
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  LEAD_CREST_FILL,
  LEAD_CREST_PATHS,
  LEAD_CREST_STROKE,
  LEAD_CREST_STROKE_WIDTH,
  LEAD_CREST_VIEWBOX,
} from "./leadCrest";
import { SquireMark } from "./SquireMark";
import { useSquireMotionTick } from "./SquireMotionClock";
import {
  SQUIRE_ARC_HEAD_WIDTH,
  SQUIRE_ARC_TAIL_OPACITY,
  SQUIRE_ARC_TAIL_WIDTH,
  squireArcDash,
  squireIndicatorForm,
  squirePortraitKey,
  squirePortraitOpacity,
  type SquirePortraitKey,
} from "./squireIndicator.logic";
import { squireArcDegrees } from "./squireMotion";
import { squireTint } from "./squirePalette";

export { SquireMotionClock } from "./SquireMotionClock";

// Metro bundles only literal requires, so every variant is listed.
const PORTRAITS: Readonly<Record<SquirePortraitKey, number>> = {
  "female-down-brass": require("../../../assets/squire/portraits/female-down-brass.webp"),
  "female-down-brass-idle": require("../../../assets/squire/portraits/female-down-brass-idle.webp"),
  "female-down-moonstone": require("../../../assets/squire/portraits/female-down-moonstone.webp"),
  "female-down-moonstone-idle": require("../../../assets/squire/portraits/female-down-moonstone-idle.webp"),
  "female-down-sage": require("../../../assets/squire/portraits/female-down-sage.webp"),
  "female-down-sage-idle": require("../../../assets/squire/portraits/female-down-sage-idle.webp"),
  "female-down-rose": require("../../../assets/squire/portraits/female-down-rose.webp"),
  "female-down-rose-idle": require("../../../assets/squire/portraits/female-down-rose-idle.webp"),
  "female-down-gold": require("../../../assets/squire/portraits/female-down-gold.webp"),
  "female-down-gold-idle": require("../../../assets/squire/portraits/female-down-gold-idle.webp"),
  "female-up-brass": require("../../../assets/squire/portraits/female-up-brass.webp"),
  "female-up-brass-idle": require("../../../assets/squire/portraits/female-up-brass-idle.webp"),
  "female-up-moonstone": require("../../../assets/squire/portraits/female-up-moonstone.webp"),
  "female-up-moonstone-idle": require("../../../assets/squire/portraits/female-up-moonstone-idle.webp"),
  "female-up-sage": require("../../../assets/squire/portraits/female-up-sage.webp"),
  "female-up-sage-idle": require("../../../assets/squire/portraits/female-up-sage-idle.webp"),
  "female-up-rose": require("../../../assets/squire/portraits/female-up-rose.webp"),
  "female-up-rose-idle": require("../../../assets/squire/portraits/female-up-rose-idle.webp"),
  "female-up-gold": require("../../../assets/squire/portraits/female-up-gold.webp"),
  "female-up-gold-idle": require("../../../assets/squire/portraits/female-up-gold-idle.webp"),
  "male-down-brass": require("../../../assets/squire/portraits/male-down-brass.webp"),
  "male-down-brass-idle": require("../../../assets/squire/portraits/male-down-brass-idle.webp"),
  "male-down-moonstone": require("../../../assets/squire/portraits/male-down-moonstone.webp"),
  "male-down-moonstone-idle": require("../../../assets/squire/portraits/male-down-moonstone-idle.webp"),
  "male-down-sage": require("../../../assets/squire/portraits/male-down-sage.webp"),
  "male-down-sage-idle": require("../../../assets/squire/portraits/male-down-sage-idle.webp"),
  "male-down-rose": require("../../../assets/squire/portraits/male-down-rose.webp"),
  "male-down-rose-idle": require("../../../assets/squire/portraits/male-down-rose-idle.webp"),
  "male-down-gold": require("../../../assets/squire/portraits/male-down-gold.webp"),
  "male-down-gold-idle": require("../../../assets/squire/portraits/male-down-gold-idle.webp"),
  "male-up-brass": require("../../../assets/squire/portraits/male-up-brass.webp"),
  "male-up-brass-idle": require("../../../assets/squire/portraits/male-up-brass-idle.webp"),
  "male-up-moonstone": require("../../../assets/squire/portraits/male-up-moonstone.webp"),
  "male-up-moonstone-idle": require("../../../assets/squire/portraits/male-up-moonstone-idle.webp"),
  "male-up-sage": require("../../../assets/squire/portraits/male-up-sage.webp"),
  "male-up-sage-idle": require("../../../assets/squire/portraits/male-up-sage-idle.webp"),
  "male-up-rose": require("../../../assets/squire/portraits/male-up-rose.webp"),
  "male-up-rose-idle": require("../../../assets/squire/portraits/male-up-rose-idle.webp"),
  "male-up-gold": require("../../../assets/squire/portraits/male-up-gold.webp"),
  "male-up-gold-idle": require("../../../assets/squire/portraits/male-up-gold-idle.webp"),
};

const RING_RADIUS = 11;
const ARC_DASH = squireArcDash(RING_RADIUS);

export interface SquireIndicatorProps {
  readonly state: SquireIndicatorStateName;
  readonly companion: Pick<SquireCompanion, "presence" | "appearance" | "hood" | "palette">;
  readonly isLead?: boolean;
  /** Points. Below 22 the indicator is the mark. */
  readonly size: number;
  readonly label: string;
  /** False while the row is offscreen (list viewability); the working motion pauses. */
  readonly visible?: boolean | undefined;
}

/**
 * The state encoding, readable from one still: idle is partly desaturated and slightly dim with a faint
 * ring (muted, not disabled); working
 * is full color with a tapered arc, under half the ring, travelling it; waiting is full color with a solid ring.
 */
export function SquireIndicator(props: SquireIndicatorProps) {
  const { state, companion, isLead, size, label, visible } = props;
  if (squireIndicatorForm(size, companion.presence) === "mark") {
    return (
      <SquireMark
        state={state}
        palette={companion.palette}
        isLead={isLead}
        size={size}
        label={label}
        visible={visible}
      />
    );
  }
  return <SquirePortrait {...props} />;
}

function SquirePortrait({ state, companion, isLead, size, label, visible }: SquireIndicatorProps) {
  const { themeAppearance } = useAppearancePreferences();
  const ring = squireTint(companion.palette, isLead, themeAppearance).ring;
  const inset = size * 0.11;
  const face = size * 0.78;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: size, height: size }}
    >
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      >
        <Image
          source={PORTRAITS[squirePortraitKey(companion, isLead, state)]}
          accessible={false}
          contentFit="cover"
          transition={0}
          style={{
            position: "absolute",
            top: inset,
            left: inset,
            width: face,
            height: face,
            borderRadius: face / 2,
            opacity: squirePortraitOpacity(state),
          }}
        />
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            stroke={ring}
            strokeWidth={1.5}
            strokeOpacity={state === "waiting" ? 1 : 0.25}
          />
        </Svg>
        {state === "working" ? (
          <WorkingArc color={ring} size={size} animate={visible !== false} />
        ) : null}
        {isLead ? <LeadCrest size={size} /> : null}
      </View>
    </View>
  );
}

/** Drawn once; motion is a stepped rotation transform of the static arc, never an SVG redraw. */
function WorkingArc({
  color,
  size,
  animate,
}: {
  readonly color: string;
  readonly size: number;
  readonly animate: boolean;
}) {
  const tick = useSquireMotionTick(animate);
  const style = useAnimatedStyle(
    () => ({ transform: [{ rotate: `${squireArcDegrees(tick.get())}deg` }] }),
    [tick],
  );
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Circle
          cx={12}
          cy={12}
          r={RING_RADIUS}
          stroke={color}
          strokeWidth={SQUIRE_ARC_TAIL_WIDTH}
          strokeOpacity={SQUIRE_ARC_TAIL_OPACITY}
          strokeDasharray={ARC_DASH.tail.dash}
          strokeDashoffset={ARC_DASH.tail.offset}
        />
        <Circle
          cx={12}
          cy={12}
          r={RING_RADIUS}
          stroke={color}
          strokeWidth={SQUIRE_ARC_HEAD_WIDTH}
          strokeLinecap="round"
          strokeDasharray={ARC_DASH.head.dash}
          strokeDashoffset={ARC_DASH.head.offset}
        />
      </Svg>
    </Animated.View>
  );
}

function LeadCrest({ size }: { readonly size: number }) {
  const crest = size * 0.42;
  return (
    <Svg
      width={crest}
      height={crest}
      viewBox={`0 0 ${LEAD_CREST_VIEWBOX} ${LEAD_CREST_VIEWBOX}`}
      style={{ position: "absolute", right: -size * 0.06, bottom: -size * 0.06 }}
    >
      {LEAD_CREST_PATHS.map((d) => (
        <Path
          key={d}
          d={d}
          fill={LEAD_CREST_FILL}
          stroke={LEAD_CREST_STROKE}
          strokeWidth={LEAD_CREST_STROKE_WIDTH}
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
