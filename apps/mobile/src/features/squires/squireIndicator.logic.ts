import type { SquireIndicatorStateName } from "@lecturn/client-runtime/state/squire";
import type { SquireCompanion, SquirePalette } from "@lecturn/contracts";

// Below this the portrait face is unreadable, so the indicator becomes the mark.
export const SQUIRE_MIN_PORTRAIT_SIZE = 22;

export function squireIndicatorForm(size: number, presence: SquireCompanion["presence"]) {
  return presence === "emblem" || size < SQUIRE_MIN_PORTRAIT_SIZE ? "mark" : "portrait";
}

export function squireIndicatorDimmed(state: SquireIndicatorStateName) {
  return state === "idle" || state === "needs_provider";
}

/**
 * Idle reads muted, not disabled: with the file's partial desaturation, a slight dim (web's
 * `opacity-80`) keeps it apart from waiting's and working's full color without greying it out.
 */
export function squirePortraitOpacity(state: SquireIndicatorStateName) {
  return squireIndicatorDimmed(state) ? 0.8 : 1;
}

export type SquirePortraitKey =
  `${SquireCompanion["appearance"]}-${SquireCompanion["hood"]}-${SquirePalette}${"" | "-idle"}`;

/**
 * Each Squire's face wears its palette's cloth; gold belongs to the Lead. Dimmed states
 * use the pre-desaturated file (CSS `grayscale(0.6)`, as web's idle filter), so no runtime filter
 * runs.
 */
export function squirePortraitKey(
  companion: Pick<SquireCompanion, "appearance" | "hood" | "palette">,
  isLead: boolean | undefined,
  state: SquireIndicatorStateName,
): SquirePortraitKey {
  const base =
    `${companion.appearance}-${companion.hood}-${isLead ? "gold" : companion.palette}` as const;
  return squireIndicatorDimmed(state) ? `${base}-idle` : base;
}

/**
 * The working arc, as shares of the ring: a solid head and, behind it, a fainter and thinner
 * tail, so the arc tapers into the direction it came from. Head, tail, and the head's round caps
 * stay under half the ring; near full closure the arc would read as waiting's solid ring.
 */
export const SQUIRE_ARC_HEAD = 0.34;
export const SQUIRE_ARC_TAIL = 0.12;
export const SQUIRE_ARC_HEAD_WIDTH = 1.8;
export const SQUIRE_ARC_TAIL_WIDTH = 1.2;
export const SQUIRE_ARC_TAIL_OPACITY = 0.4;

/**
 * Dash, gap, and static offset of the working arc's head and tail on a ring of `radius`. The ring
 * runs clockwise from 3 o'clock, the way the arc turns, so the tail takes the start of the path
 * and the head leads from just past it.
 */
export function squireArcDash(radius: number) {
  const circumference = 2 * Math.PI * radius;
  const stroke = (share: number, offset: number) => ({
    dash: [circumference * share, circumference * (1 - share)] as const,
    offset: -circumference * offset,
  });
  return { head: stroke(SQUIRE_ARC_HEAD, SQUIRE_ARC_TAIL), tail: stroke(SQUIRE_ARC_TAIL, 0) };
}

type Point = readonly [number, number];
type Cubic = readonly [Point, Point, Point, Point];

// The strand of v5 threadkeeper-small.svg; kept as numbers so the trace knows its length,
// because react-native-svg has no `pathLength`.
const STRAND: ReadonlyArray<Cubic> = [
  [
    [16, 4],
    [9, 2],
    [5, 6],
    [7, 9],
  ],
  [
    [7, 9],
    [9, 12],
    [19, 11],
    [19, 16],
  ],
  [
    [19, 16],
    [19, 20],
    [14, 22],
    [9, 20],
  ],
];

export const SQUIRE_MARK_STRAND_PATH = `M${STRAND[0]![0].join(" ")}${STRAND.map(
  ([, c1, c2, end]) => `C${c1.join(" ")} ${c2.join(" ")} ${end.join(" ")}`,
).join("")}`;

export function cubicLength([p0, p1, p2, p3]: Cubic, samples = 256) {
  let length = 0;
  let previous = p0;
  for (let index = 1; index <= samples; index += 1) {
    const t = index / samples;
    const u = 1 - t;
    const point: Point = [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
    length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return length;
}

export const SQUIRE_MARK_STRAND_LENGTH = STRAND.reduce(
  (total, segment) => total + cubicLength(segment),
  0,
);
