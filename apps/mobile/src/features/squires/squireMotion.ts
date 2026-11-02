import type { SquireIndicatorStateName } from "@lecturn/client-runtime/state/squire";

/** 10 updates a second, inside the 12 Hz cap whatever the display refresh rate. */
export const SQUIRE_MOTION_STEP_MS = 100;
// Same cycles as the web (3.6 s ring orbit in 36 steps, 2.4 s mark trace in 24 steps).
export const SQUIRE_ARC_STEPS = 36;
export const SQUIRE_TRACE_STEPS = 24;
// Least common multiple of both cycles, so the shared tick stays bounded and both wrap cleanly.
const TICK_PERIOD = 72;

/** The shared clock's stepped value: changes once per step and only then. */
export function squireMotionTick(elapsedMs: number) {
  "worklet";
  return Math.floor(Math.max(0, elapsedMs) / SQUIRE_MOTION_STEP_MS) % TICK_PERIOD;
}

export function squireArcDegrees(tick: number) {
  "worklet";
  return (tick % SQUIRE_ARC_STEPS) * (360 / SQUIRE_ARC_STEPS);
}

/** Dash offset that walks the mark's trace once along a stroke of `length` per cycle. */
export function squireTraceOffset(tick: number, length: number) {
  "worklet";
  return -((tick % SQUIRE_TRACE_STEPS) / SQUIRE_TRACE_STEPS) * length;
}

/** Only a working indicator in view moves; idle and waiting never repaint. */
export function squireIndicatorAnimates(
  state: SquireIndicatorStateName,
  visible: boolean | undefined,
) {
  return state === "working" && visible !== false;
}

export function squireClockActive(input: {
  readonly registered: number;
  readonly focused: boolean;
  readonly foreground: boolean;
  readonly reducedMotion: boolean;
}) {
  return input.registered > 0 && input.focused && input.foreground && !input.reducedMotion;
}
