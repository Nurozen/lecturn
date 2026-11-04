import { useIsFocused } from "@react-navigation/native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AccessibilityInfo, AppState } from "react-native";
import {
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { squireClockActive, squireMotionTick } from "./squireMotion";

interface SquireMotion {
  readonly tick: SharedValue<number>;
  readonly register: () => () => void;
}

const SquireMotionContext = createContext<SquireMotion | null>(null);

/**
 * One stepped clock (10 Hz) for every indicator under it; mount once per screen. The frame
 * callback runs only while a working, visible indicator is registered and the screen is
 * focused, the app is foreground, and reduced motion is off.
 */
export function SquireMotionClock({ children }: { readonly children: ReactNode }) {
  const focused = useIsFocused();
  const initialReducedMotion = useReducedMotion();
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [registered, setRegistered] = useState(0);
  const tick = useSharedValue(0);
  useEffect(() => {
    const app = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => {
      app.remove();
      motion.remove();
    };
  }, []);
  const clock = useFrameCallback(
    useCallback(
      ({ timeSinceFirstFrame }: { timeSinceFirstFrame: number }) => {
        "worklet";
        const next = squireMotionTick(timeSinceFirstFrame);
        if (tick.get() !== next) tick.set(next);
      },
      [tick],
    ),
    false,
  );
  const active = squireClockActive({ registered, focused, foreground, reducedMotion });
  useEffect(() => {
    clock.setActive(active);
    // A paused clock rests every indicator on the static pose rather than mid-orbit.
    if (!active) tick.set(0);
    return () => clock.setActive(false);
  }, [active, clock, tick]);
  const register = useCallback(() => {
    setRegistered((count) => count + 1);
    return () => setRegistered((count) => count - 1);
  }, []);
  const value = useMemo(() => ({ tick, register }), [tick, register]);
  return <SquireMotionContext.Provider value={value}>{children}</SquireMotionContext.Provider>;
}

/**
 * The tick a working layer reads. Without a clock above it, or while not animating, it reads a
 * still tick of 0: the static working pose.
 */
export function useSquireMotionTick(animate: boolean) {
  const motion = useContext(SquireMotionContext);
  const still = useSharedValue(0);
  const live = animate && motion !== null;
  useEffect(() => (live ? motion.register() : undefined), [live, motion]);
  return live ? motion.tick : still;
}
