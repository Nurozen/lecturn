import { describe, expect, it } from "vite-plus/test";
import { threadBorderGeometry, threadBorderPhase } from "./thread-border";

describe("rounded thread perimeter", () => {
  it("uses rounded corner lengths instead of the square bounding box for a wide unsettle tile", () => {
    const border = threadBorderGeometry(400, 80, 12, 2)!;
    // Four straight tangents plus four quarter-circles of radius 11.
    expect(border.perimeter).toBeCloseTo(2 * (376 + 56) + 2 * Math.PI * 11);
    expect(border.path).toContain("M 12 1 H 388 A 11 11 0 0 1 399 12");
    expect(border.path).toContain("V 12 A 11 11 0 0 1 12 1 Z");
  });
  it("clamps corner radii on small tiles and supports flat list rows", () => {
    expect(threadBorderGeometry(20, 10, 12, 2)!.perimeter).toBeCloseTo(20 + 8 * Math.PI);
    expect(threadBorderGeometry(100, 40, 0, 2)!.perimeter).toBe(272);
    expect(threadBorderGeometry(0, 40, 12, 2)).toBeNull();
    expect(threadBorderGeometry(100, 2, 12, 2)).toBeNull();
    expect(threadBorderGeometry(Number.NaN, 40, 12, 2)).toBeNull();
  });
  it("caps repaint phases independently of screen refresh rate and wraps each orbit", () => {
    for (const refreshRate of [60, 120]) {
      const phases = new Set(
        Array.from({ length: refreshRate * 4 }, (_, frame) =>
          threadBorderPhase((frame * 1000) / refreshRate),
        ),
      );
      expect(phases.size).toBe(48);
    }
    expect(threadBorderPhase(3999)).toBe(47 / 48);
    expect(threadBorderPhase(4000)).toBe(0);
    expect(threadBorderPhase(4250)).toBe(threadBorderPhase(250));
  });
});
