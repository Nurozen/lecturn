import { Easing, LinearTransition, ReduceMotion } from "react-native-reanimated";

/** Finite row movement after a hierarchy toggle; never a repeating decoration. */
export const HIERARCHY_LAYOUT_TRANSITION = LinearTransition.duration(420)
  .easing(Easing.out(Easing.cubic))
  .reduceMotion(ReduceMotion.System);
