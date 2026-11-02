import { describe, expect, it } from "vite-plus/test";
import {
  SQUIRE_ARC_HEAD_WIDTH,
  SQUIRE_ARC_TAIL_OPACITY,
  SQUIRE_ARC_TAIL_WIDTH,
  SQUIRE_MARK_STRAND_LENGTH,
  SQUIRE_MARK_STRAND_PATH,
  cubicLength,
  squireArcDash,
  squireIndicatorForm,
  squirePortraitKey,
  squirePortraitOpacity,
} from "./squireIndicator.logic";
import { grayscaleHex, squireTint } from "./squirePalette";

describe("squire indicator form", () => {
  it("uses the mark below 22 pt and always for emblem presence", () => {
    expect(squireIndicatorForm(21.5, "figure")).toBe("mark");
    expect(squireIndicatorForm(22, "figure")).toBe("portrait");
    expect(squireIndicatorForm(40, "figure")).toBe("portrait");
    expect(squireIndicatorForm(40, "emblem")).toBe("mark");
  });
});

describe("squire portrait source", () => {
  const research = { appearance: "female", hood: "down", palette: "sage" } as const;

  it("picks the appearance, hood, and palette file, full color while working or waiting", () => {
    expect(squirePortraitKey(research, false, "working")).toBe("female-down-sage");
    expect(squirePortraitKey({ ...research, palette: "rose" }, false, "waiting")).toBe(
      "female-down-rose",
    );
  });

  it("gives the Lead the gold face whatever its stored palette", () => {
    expect(squirePortraitKey({ ...research, hood: "up" }, true, "waiting")).toBe("female-up-gold");
  });

  it("uses the pre-desaturated file for idle and a missing provider", () => {
    expect(squirePortraitKey(research, false, "idle")).toBe("female-down-sage-idle");
    expect(squirePortraitKey({ ...research, appearance: "male" }, true, "needs_provider")).toBe(
      "male-down-gold-idle",
    );
  });

  it("dims idle only slightly, so it reads muted rather than disabled", () => {
    expect(squirePortraitOpacity("idle")).toBe(0.8);
    expect(squirePortraitOpacity("needs_provider")).toBe(0.8);
    expect(squirePortraitOpacity("waiting")).toBe(1);
    expect(squirePortraitOpacity("working")).toBe(1);
  });
});

describe("squire working arc", () => {
  const radius = 11;
  const circumference = 2 * Math.PI * radius;
  const { head, tail } = squireArcDash(radius);
  // Where each stroke starts and ends along the ring; the head's round caps add half its width.
  const span = (stroke: typeof head, cap: number) => {
    const start = -stroke.offset;
    return { start: start - cap, end: start + stroke.dash[0] + cap };
  };
  const headSpan = span(head, SQUIRE_ARC_HEAD_WIDTH / 2);
  const tailSpan = span(tail, 0);

  it("caps the visible sweep at half the ring, round caps included", () => {
    expect(head.dash[0] + head.dash[1]).toBeCloseTo(circumference);
    expect(tail.dash[0] + tail.dash[1]).toBeCloseTo(circumference);
    const sweep = Math.max(headSpan.end, tailSpan.end) - Math.min(headSpan.start, tailSpan.start);
    expect(sweep / circumference).toBeLessThanOrEqual(0.5);
  });

  it("trails a shorter, fainter, thinner tail that meets the head", () => {
    // The ring runs clockwise, the way the arc turns, so the tail sits before the head.
    expect(tailSpan.start).toBeLessThan(headSpan.start);
    expect(tailSpan.end).toBeGreaterThanOrEqual(headSpan.start);
    expect(tail.dash[0]).toBeLessThan(head.dash[0]);
    expect(SQUIRE_ARC_TAIL_OPACITY).toBeLessThan(1);
    expect(SQUIRE_ARC_TAIL_WIDTH).toBeLessThan(SQUIRE_ARC_HEAD_WIDTH);
  });
});

describe("squire mark geometry", () => {
  it("rebuilds the v5 strand path and measures it for the trace dash", () => {
    expect(SQUIRE_MARK_STRAND_PATH).toBe("M16 4C9 2 5 6 7 9C9 12 19 11 19 16C19 20 14 22 9 20");
    expect(
      cubicLength([
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    ).toBeCloseTo(3);
    // Chord sum is a lower bound and control polygon an upper bound for each cubic.
    expect(SQUIRE_MARK_STRAND_LENGTH).toBeGreaterThan(
      Math.hypot(9, 5) + Math.hypot(12, 7) + Math.hypot(10, 4),
    );
    expect(SQUIRE_MARK_STRAND_LENGTH).toBeLessThan(54);
  });
});

describe("squire palette", () => {
  it("gives the Lead gold whatever its stored palette, per theme", () => {
    expect(squireTint("sage", true, "dark").ring).toBe("#e8b23a");
    expect(squireTint("sage", false, "dark").strand).toBe("#dde5cf");
    expect(squireTint("sage", false, "light").strand).toBe("#44523a");
  });

  it("desaturates like CSS grayscale", () => {
    expect(grayscaleHex("#ffffff")).toBe("#ffffff");
    expect(grayscaleHex("#ff0000")).toBe("#363636");
  });
});
