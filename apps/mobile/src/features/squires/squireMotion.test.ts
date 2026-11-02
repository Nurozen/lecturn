import { describe, expect, it } from "vite-plus/test";
import {
  SQUIRE_ARC_STEPS,
  SQUIRE_TRACE_STEPS,
  squireArcDegrees,
  squireClockActive,
  squireIndicatorAnimates,
  squireMotionTick,
  squireTraceOffset,
} from "./squireMotion";

const ready = { registered: 1, focused: true, foreground: true, reducedMotion: false };

describe("squire motion clock gating", () => {
  it("runs only while a working, visible indicator holds it on a focused, foreground screen", () => {
    expect(squireClockActive(ready)).toBe(true);
    expect(squireClockActive({ ...ready, registered: 0 })).toBe(false);
    expect(squireClockActive({ ...ready, focused: false })).toBe(false);
    expect(squireClockActive({ ...ready, foreground: false })).toBe(false);
    expect(squireClockActive({ ...ready, reducedMotion: true })).toBe(false);
  });

  it("registers only working indicators that are not offscreen", () => {
    expect(squireIndicatorAnimates("working", undefined)).toBe(true);
    expect(squireIndicatorAnimates("working", true)).toBe(true);
    expect(squireIndicatorAnimates("working", false)).toBe(false);
    for (const state of ["idle", "waiting", "needs_provider"] as const) {
      expect(squireIndicatorAnimates(state, true)).toBe(false);
    }
  });
});

describe("squire stepped phase", () => {
  it("changes at most 12 times a second on any refresh rate", () => {
    for (const refreshRate of [30, 60, 90, 120, 144]) {
      let changes = 0;
      let previous = squireMotionTick(0);
      for (let frame = 1; frame <= refreshRate * 3; frame += 1) {
        const next = squireMotionTick((frame * 1000) / refreshRate);
        if (next !== previous) changes += 1;
        previous = next;
      }
      expect(changes / 3).toBeLessThanOrEqual(12);
      expect(changes / 3).toBeGreaterThanOrEqual(9);
    }
  });

  it("orbits the arc and walks the trace once per cycle, wrapping without a jump", () => {
    const arc = new Set<number>();
    const trace = new Set<number>();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 7) {
      const tick = squireMotionTick(elapsed);
      arc.add(squireArcDegrees(tick));
      trace.add(squireTraceOffset(tick, 48));
    }
    expect(arc.size).toBe(SQUIRE_ARC_STEPS);
    expect(trace.size).toBe(SQUIRE_TRACE_STEPS);
    expect(Math.max(...arc)).toBe(350);
    expect(Math.min(...trace)).toBe(-48 + 48 / SQUIRE_TRACE_STEPS);
    // The shared tick's period is a multiple of both cycles, so its wrap lands on pose 0.
    const wrap = squireMotionTick(7200);
    expect(wrap).toBe(0);
    expect(squireArcDegrees(squireMotionTick(7100))).toBe(350);
    expect(squireTraceOffset(squireMotionTick(7100), 48)).toBe(-46);
  });
});
