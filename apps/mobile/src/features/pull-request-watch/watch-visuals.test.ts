import { describe, expect, it } from "vite-plus/test";
import { cardIsVisible, checkSegments } from "./watch-visuals";

describe("watch activity visuals", () => {
  it("does not count absent, skipped, cancelled or unknown jobs as passing", () => {
    expect(checkSegments([])).toEqual({ passed: 0, running: 0, attention: 0, failed: 0, other: 0 });
    expect(
      checkSegments(
        [
          "success",
          "pending",
          "action-required",
          "failure",
          "skipped",
          "neutral",
          "cancelled",
          "unknown",
        ].map((status) => ({ status })),
      ),
    ).toEqual({ passed: 1, running: 1, attention: 1, failed: 1, other: 4 });
  });
  it("animates only measured cards overlapping the scroll viewport", () => {
    const viewport = { y: 100, height: 400 };
    expect(cardIsVisible(undefined, viewport)).toBe(false);
    expect(cardIsVisible({ y: 0, height: 100 }, viewport)).toBe(false);
    expect(cardIsVisible({ y: 0, height: 101 }, viewport)).toBe(true);
    expect(cardIsVisible({ y: 500, height: 100 }, viewport)).toBe(false);
    expect(cardIsVisible({ y: 100, height: 100 }, { y: 100, height: 0 })).toBe(false);
  });
});
