/*
 * Painted-in light effects for <squire-rig>, ported from v5 `squire-fx.js`. The rig creates one
 * controller per element and drives configure / update / trigger / destroy. FX draw only inside
 * the layer groups the rig hands over; every coordinate below is in stage units (1122 x 1402).
 *
 * Ambient effects (blink, glints, twinkles, travellers, motes, flutter) are pure functions of
 * rig time and frame.seed, so a setPose frame (frame.hold) is reproducible per seed. Live
 * frames fade ambient effects toward rest over frame.settle (the runtime's settle-to-still);
 * rest frames (still, reduced motion, offscreen refresh) show rest values. Travellers and the
 * palette tint integrate dt while live. Bursts from trigger() run on the companion clock and
 * are dropped on any non-live frame.
 *
 * Attentive is steady (spec P16.3): the head halo and chest aura hold constant values once the
 * attentive blend is full, and v5's attentive beacon ring and lift sparkles are gone.
 *
 * Cost: transforms / opacity on small vector shapes, blend modes on small clipped shapes, and
 * one budgeted filter (pennant flutter, clipped to the pennant, updated at <= 30 Hz).
 */
import { companionClock } from "./companionClock";
import {
  LEAD_CREST_FILL,
  LEAD_CREST_PATHS,
  LEAD_CREST_STROKE,
  LEAD_CREST_STROKE_WIDTH,
  LEAD_CREST_VIEWBOX,
} from "./leadCrest";
import type {
  CompanionPalette,
  FxConfig,
  FxContext,
  FxController,
  FxFrame,
  FxTrigger,
  RigAppearance,
  RigEquipment,
} from "./types";

type Vec2 = readonly [number, number];
type Circle = readonly [number, number, number];
type Rgb = readonly [number, number, number];
type Attrs = Readonly<Record<string, string | number | null>>;

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const smooth = (v: number) => {
  const c = clamp01(v);
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
// Gesture-peak envelope: full at mid-gesture, zero at both ends.
const peakOf = (progress: number) => Math.pow(Math.sin(Math.PI * clamp01(progress)), 2);
const frac = (v: number) => v - Math.floor(v);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function hash(seed: number, n: number) {
  let x = Math.imul(seed * 374761393 + n * 668265263, 0x85ebca6b) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`squireFx: index ${index} outside ${list.length}`);
  return value;
}

type EyeLandmarks = {
  readonly T: readonly Vec2[];
  readonly O: readonly Vec2[];
  readonly D: readonly Vec2[];
  readonly closed: {
    readonly a: Vec2;
    readonly b: Vec2;
    readonly sag: number;
    readonly peak: number;
  };
  readonly hook: Vec2;
  readonly width: number;
  readonly shift: number;
  readonly opening: readonly Vec2[];
  readonly iris: Circle;
  readonly catch: Circle;
  readonly sclera: readonly [string, string, string];
  readonly travel: Vec2;
  readonly band?: readonly Vec2[];
  readonly far?: Circle;
};

type SweepSpec = {
  readonly angle: number;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly width: number;
};
type ArmillaryRing = {
  readonly c: Vec2;
  readonly a: number;
  readonly b: number;
  readonly rot: number;
  readonly speed: number;
  readonly phase: number;
};

type ItemLandmarkBase = {
  readonly focal: Vec2;
  readonly hands: Vec2;
  /** Thinking's held thought-light, hovering in open air beside the item (clear of every grip). */
  readonly thought: Vec2;
  /** Flourish burst at the item tip when the glint sits too near the stage edge (lance). */
  readonly burst?: Vec2;
  /** Ponder's held orb when the item's own light point would hide it (the helmet star). */
  readonly ponder?: Vec2;
  readonly glint?: Vec2;
  /** Greet's wave marks, in open air on the item's outer side (default: beside the glint). */
  readonly wave?: Vec2;
  readonly arrive?: Vec2;
  /** [cx, cy, rx, ry] thinking-mote orbit. */
  readonly motes?: readonly [number, number, number, number];
  readonly core?: Circle;
  readonly coreGain?: number;
  readonly hotspot?: Circle;
  readonly rise?: Vec2;
  readonly toward?: Vec2;
};
type HelmetLandmarks = ItemLandmarkBase & {
  readonly star: Circle;
  readonly poly: readonly Vec2[];
  readonly sweep: SweepSpec;
};
type LanceLandmarks = ItemLandmarkBase & {
  readonly tip: Vec2;
  readonly blade: readonly Vec2[];
  readonly sweep: SweepSpec;
  readonly pole: Vec2;
  readonly pennant: readonly Vec2[];
  readonly flutterCenter: Vec2;
  readonly flutterRadius: Vec2;
  readonly flutterTilt: number;
  readonly ripple: readonly Vec2[];
  readonly rippleDir: Vec2;
};
type AstrolabeLandmarks = ItemLandmarkBase & {
  readonly ring: { readonly c: Vec2; readonly r: number; readonly hidden: readonly Vec2[] };
  readonly pointer: Vec2;
};
type GrimoireLandmarks = ItemLandmarkBase & { readonly stars: readonly Circle[] };
type ArmillaryLandmarks = ItemLandmarkBase & { readonly rings: readonly ArmillaryRing[] };
type NoneLandmarks = ItemLandmarkBase & { readonly palm: Vec2; readonly wisp: Vec2 };

type DebugLandmarks = ItemLandmarkBase & {
  readonly poly?: readonly Vec2[];
  readonly blade?: readonly Vec2[];
  readonly pennant?: readonly Vec2[];
  readonly ring?: { readonly c: Vec2; readonly r: number };
  readonly rings?: readonly ArmillaryRing[];
  readonly tip?: Vec2;
  readonly pointer?: Vec2;
  readonly palm?: Vec2;
  readonly wisp?: Vec2;
  readonly pole?: Vec2;
  readonly stars?: readonly Circle[];
};

type FaceLandmarks = {
  /** The ear on the viewer side (listen arcs sit just behind it). */
  readonly ear: Vec2;
  /** Open air ahead of the mouth and chin, never under the raised hood (nod chevrons). */
  readonly nod: Vec2;
  /** Ponder's rising thought: from just ahead of the brow up to its spark above the head. */
  readonly muse: readonly [Vec2, Vec2];
};

export type SquireFxLandmarks = {
  readonly eyes: Readonly<Record<RigAppearance, EyeLandmarks>>;
  readonly faces: Readonly<Record<RigAppearance, FaceLandmarks>>;
  readonly cloak: {
    readonly stars: readonly Circle[];
    readonly brooch: Circle;
    /** Star index -> grips that cover it; such a star is never chosen to twinkle under them. */
    readonly covered: Readonly<Record<number, readonly RigEquipment[]>>;
    /** [cx, cy, size] of the square Lead crest. */
    readonly crest: Circle;
  };
  readonly items: {
    readonly helmet: HelmetLandmarks;
    readonly lance: LanceLandmarks;
    readonly astrolabe: AstrolabeLandmarks;
    readonly grimoire: GrimoireLandmarks;
    readonly armillary: ArmillaryLandmarks;
    readonly none: NoneLandmarks;
  };
};

// Hand/forearm centre per grip (arm space), for the equipment exchange bloom.
const HANDS: Readonly<Record<RigEquipment, Vec2>> = {
  helmet: [790, 990],
  lance: [850, 975],
  astrolabe: [800, 1025],
  grimoire: [800, 1025],
  armillary: [800, 1025],
  none: [820, 1030],
};

// Landmarks are stage units measured on renders of the v5 parts. Per-item keys: focal (bursts,
// motes fallback), core [x, y, r] (item light), hotspot [x, y, r] (white-paint warm-up), motes
// [cx, cy, rx, ry], glint (nod sparkle), arrive (exchange sparkle target), hands (exchange bloom
// centre), plus item-specific: helmet star/poly/sweep; lance tip/blade/sweep/pole/pennant/
// flutter*/ripple*; astrolabe ring/pointer; grimoire stars; armillary rings; none palm/wisp.
export const SQUIRE_FX_LANDMARKS: SquireFxLandmarks = {
  // Eyes (stage units, outer corner left -> inner corner right).
  //   T  top edge of the painted upper-lid band: lid skin covers from here down.
  //   O  centre of the lash band when open (the moving lid edge starts here).
  //   D  lower boundary of the opening (outset ~1u): the lower lid rises to meet the lid.
  //   closed: corners of the closed lid line and its sag; hook = the painted wing tip the
  //   closed line curls into (kept visible). opening/iris drive the gaze shift; sclera is
  //   the sampled eye-white ramp (top under the lid -> bottom). shift = how far below the
  //   cheek skin that fills the closed lid is sampled from the head image itself.
  eyes: {
    female: {
      T: [
        [622, 266.0],
        [628, 263.6],
        [636, 261.4],
        [648, 258.6],
        [660, 256.9],
        [667, 257.0],
        [673, 260.5],
      ],
      O: [
        [622, 267.2],
        [628, 265.6],
        [636, 264.4],
        [648, 262.2],
        [660, 261.0],
        [667, 261.2],
        [673, 263.6],
      ],
      D: [
        [622, 267.6],
        [630, 269.8],
        [637, 271.8],
        [644, 274.8],
        [651, 276.8],
        [658, 279.0],
        [665, 278.2],
        [669, 273.4],
        [673, 266.4],
      ],
      closed: { a: [623, 268.2], b: [673, 265.6], sag: 3.8, peak: 0.58 },
      hook: [677.2, 262.2],
      width: 4.4,
      shift: 27,
      opening: [
        [624, 267],
        [636, 267.4],
        [652, 264.6],
        [665, 264.6],
        [672.5, 266.2],
        [668.3, 272.2],
        [665, 276.8],
        [658.3, 277.6],
        [651.7, 275.5],
        [637.5, 270],
      ],
      iris: [657, 270.6, 9.6],
      catch: [653.6, 265.6, 1.5],
      sclera: ["#b8966c", "#d8b787", "#ebca9d"],
      travel: [4.5, 2.5],
      // Painted lash band incl. the outer wing tip and the inner lash flicks (copied and
      // carried down by the lid during the first third of the blink).
      band: [
        [618, 267.8],
        [628, 262.6],
        [636, 260.4],
        [648, 257.6],
        [660, 255.8],
        [667, 254.8],
        [675, 255.6],
        [681, 258.6],
        [682.5, 263],
        [680, 266],
        [672, 265.6],
        [665, 264.6],
        [655, 264.6],
        [645, 265.8],
        [635, 267.4],
        [626, 269],
        [618, 268.6],
      ],
      // The far eye's catchlight shows past the nose bridge; it dims with the blink.
      far: [700.6, 268.8, 1.9],
    },
    male: {
      T: [
        [625, 247.1],
        [632, 245.0],
        [640, 243.0],
        [650, 241.2],
        [658, 240.6],
        [664, 241.0],
        [669, 243.4],
      ],
      O: [
        [625, 248.0],
        [632, 247.0],
        [640, 246.0],
        [650, 244.6],
        [658, 244.0],
        [664, 244.3],
        [669, 245.2],
      ],
      D: [
        [625, 248.8],
        [632, 250.6],
        [639, 253.4],
        [646, 256.4],
        [652, 258.4],
        [658, 258.2],
        [663, 254.4],
        [669, 247.6],
      ],
      closed: { a: [626, 249.2], b: [668.5, 246.6], sag: 3.4, peak: 0.6 },
      hook: [672, 244.4],
      width: 4.6,
      shift: 24,
      opening: [
        [627, 248.5],
        [640, 248.7],
        [650, 246.6],
        [659, 247],
        [664, 247],
        [663, 252.8],
        [657, 257],
        [652, 257],
        [645, 255],
        [637, 251],
      ],
      iris: [654.5, 252, 6.2],
      catch: [652.4, 249.2, 1.2],
      sclera: ["#b88c62", "#d4ab7c", "#e2bb8c"],
      travel: [3.5, 2.5],
      band: [
        [623, 249.2],
        [632, 245.8],
        [642, 243.8],
        [652, 242.2],
        [662, 241.6],
        [668, 242.2],
        [672, 244.2],
        [670, 246.4],
        [662, 246.4],
        [652, 247],
        [640, 248.4],
        [630, 249.8],
        [623, 249.8],
      ],
    },
  },
  // Measured on v5 validation renders; head-local, so they ride every head and hood pose.
  faces: {
    female: {
      ear: [515, 305],
      nod: [778, 388],
      muse: [
        [718, 178],
        [808, 74],
      ],
    },
    male: {
      ear: [510, 282],
      nod: [768, 370],
      muse: [
        [710, 160],
        [800, 62],
      ],
    },
  },
  cloak: {
    // [x, y, painted star radius] from research/landmarks.json torso.stars (verified against
    // renders); [827, 809] sits under the helmet / astrolabe / grimoire / armillary.
    stars: [
      [470, 609, 20],
      [310, 676, 20],
      [154, 1289, 24],
      [181, 1146, 16],
      [174, 890, 16],
      [409, 756, 15],
      [400, 459, 14],
      [356, 615, 10],
      [203, 773, 9],
      [337, 745, 8],
      [284, 840, 9],
      [827, 809, 7],
    ],
    brooch: [628, 561, 31],
    covered: { 11: ["helmet", "astrolabe", "grimoire", "armillary"] },
    // On the cloak drape left of the brooch: clear of the brooch glint, the hood brim, and every
    // grip (all grips sit right of x ~700 at this height). 116 keeps the star readable at 340 px.
    crest: [528, 600, 116],
  },
  items: {
    helmet: {
      focal: [801, 812],
      hands: HANDS.helmet,
      thought: [880, 540],
      ponder: [790, 705],
      glint: [1010, 735],
      motes: [870, 640, 230, 70],
      star: [801.5, 812.5, 60],
      poly: [
        [862, 631],
        [895, 647],
        [960, 685],
        [1005, 725],
        [1047, 795],
        [1047, 950],
        [1045, 965],
        [1047, 1010],
        [1010, 1025],
        [950, 1000],
        [900, 975],
        [895, 950],
        [845, 940],
        [780, 945],
        [715, 945],
        [707, 880],
        [705, 810],
        [712, 780],
        [725, 745],
        [745, 710],
        [775, 680],
        [810, 655],
        [845, 635],
      ],
      sweep: { angle: 43, from: [690, 630], to: [1070, 990], width: 80 },
    },
    // Thinking motes / rising sparkles stay around the pennant and fist (below the face).
    lance: {
      focal: [867, 200],
      hands: HANDS.lance,
      thought: [1000, 215],
      wave: [1040, 470],
      burst: [866, 78],
      arrive: [945, 425],
      glint: [866, 34],
      motes: [965, 630, 50, 120],
      rise: [950, 760],
      toward: [1000, 470],
      tip: [866, 32],
      blade: [
        [866, 26],
        [880, 90],
        [897, 165],
        [909, 205],
        [884, 232],
        [868, 250],
        [852, 232],
        [830, 205],
        [838, 165],
        [853, 90],
      ],
      sweep: { angle: -88, from: [866, 10], to: [866, 265], width: 26 },
      // Flutter: the copy is anchored at the shaft attach point; displacement only inside the
      // tilted ellipse over the free panel, fading to zero before the shaft and every rim.
      pole: [888, 295],
      pennant: [
        [889, 290],
        [930, 325],
        [975, 400],
        [1010, 470],
        [1045, 540],
        [1056, 585],
        [1050, 640],
        [1030, 700],
        [1035, 760],
        [1025, 805],
        [1010, 800],
        [1000, 740],
        [985, 690],
        [970, 620],
        [990, 575],
        [960, 535],
        [930, 520],
        [889, 478],
      ],
      flutterCenter: [955, 440],
      flutterRadius: [34, 70],
      flutterTilt: 35,
      ripple: [
        [890, 293],
        [930, 328],
        [972, 400],
        [1004, 468],
        [1010, 500],
        [970, 520],
        [930, 505],
        [890, 476],
      ],
      rippleDir: [0.6, 0.8],
    },
    astrolabe: {
      // The core is a gold medallion, not painted white: no hotspot warm-up, and the light is
      // boosted (coreGain) so it still reads as lit.
      focal: [848, 835],
      hands: HANDS.astrolabe,
      thought: [960, 560],
      glint: [1034, 756],
      arrive: [848, 835],
      motes: [880, 760, 230, 230],
      core: [848, 835, 34],
      coreGain: 1.7,
      // Traveller runs on the lettered outer band; hidden under the far hand (right rim) and
      // the near hand + stand (bottom).
      ring: {
        c: [848, 836],
        r: 163,
        hidden: [
          [0, 50],
          [345, 360],
          [78, 140],
        ],
      },
      pointer: [1034, 756],
    },
    grimoire: {
      focal: [843, 835],
      hands: HANDS.grimoire,
      thought: [900, 540],
      glint: [977, 700],
      hotspot: [843, 836, 15],
      motes: [930, 760, 190, 260],
      core: [843, 835, 42],
      stars: [
        [860, 723, 12],
        [920, 752, 10],
        [832, 941, 10],
      ],
    },
    armillary: {
      focal: [906, 828],
      hands: HANDS.armillary,
      thought: [900, 525],
      glint: [905, 615],
      hotspot: [906, 824, 15],
      motes: [900, 790, 230, 230],
      core: [906, 826, 30],
      rings: [
        { c: [905, 812], a: 148, b: 42, rot: 20, speed: 1, phase: 0.3 },
        { c: [905, 826], a: 146, b: 46, rot: -38, speed: -0.8, phase: 2.2 },
        { c: [893, 815], a: 145, b: 138, rot: 0, speed: 0.65, phase: 4.1 },
      ],
    },
    none: {
      focal: [868, 965],
      hands: HANDS.none,
      thought: [930, 800],
      motes: [900, 950, 110, 60],
      palm: [868, 1028],
      wisp: [868, 962],
    },
  },
};

// frame.lid (0..1) -> fraction of the way from the open lash line to the closed lid.
const LID_SCALE = 0.9;
// The iris travels this much further back (negative gaze: toward the viewer, attentive) than
// forward, so the held look out of the panel reads at panel size; the opening has the room.
const VIEWER_TRAVEL = 2;

// Time average of frame.breath in attentive (v5 breath shape, cycle depths, and sighs at
// attentive depth 0.8), so the steady attentive aura matches v5's mean brightness and size.
const ATTENTIVE_MEAN_BREATH = -0.23;

// Head silhouettes (upper arc) for the appearance shimmer: centre and radii.
type HeadOutline = { readonly c: Vec2; readonly rx: number; readonly ry: number };
const HEAD_OUTLINE: Readonly<Record<RigAppearance, HeadOutline>> = {
  female: { c: [545, 245], rx: 182, ry: 178 },
  male: { c: [566, 228], rx: 166, ry: 168 },
};

// Secondary glow tint per palette; cores always stay gold. Gold is the Lead's palette: deeper
// and more saturated than brass so the two never read as the same companion.
const HALO_PALETTE_LEAN = 0.25;

// Gesture motif strokes: a pale core over a dark amber bed reads over skin, hair, gold trim,
// and the dark ground alike at panel size.
const PALE = "#fff3d2";
const BED = "#8a4f12";

const TINT: Readonly<Record<CompanionPalette, Rgb>> = {
  brass: [255, 206, 120],
  moonstone: [178, 206, 242],
  sage: [184, 222, 186],
  rose: [244, 180, 194],
  gold: [232, 170, 48],
};

function smoothPath(pts: readonly Vec2[], closed = false) {
  // Catmull-Rom through pts as cubic Beziers.
  const n = pts.length;
  if (n < 2) return "";
  const P = (i: number) => at(pts, closed ? (i + n) % n : clamp(i, 0, n - 1));
  const first = at(pts, 0);
  let d = `M${r2(first[0])} ${r2(first[1])}`;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    d += `C${r2(p1[0] + (p2[0] - p0[0]) / 6)} ${r2(p1[1] + (p2[1] - p0[1]) / 6)} ${r2(p2[0] - (p3[0] - p1[0]) / 6)} ${r2(p2[1] - (p3[1] - p1[1]) / 6)} ${r2(p2[0])} ${r2(p2[1])}`;
  }
  return closed ? `${d}Z` : d;
}
const polyPath = (pts: readonly Vec2[]) => `M${pts.map((p) => `${p[0]} ${p[1]}`).join("L")}Z`;

// Resample a polyline to n points evenly in x (eye curves are x-monotone).
function resample(pts: readonly Vec2[], n: number): Vec2[] {
  const x0 = at(pts, 0)[0];
  const x1 = at(pts, pts.length - 1)[0];
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const x = lerp(x0, x1, i / (n - 1));
    let j = 0;
    while (j < pts.length - 2 && at(pts, j + 1)[0] < x) j++;
    const a = at(pts, j);
    const b = at(pts, j + 1);
    out.push([x, lerp(a[1], b[1], clamp01((x - a[0]) / (b[0] - a[0] || 1)))]);
  }
  return out;
}

// Four-point sparkle, unit arms; thin waist so it reads as engraved light, not a cartoon star.
const SPARK =
  "M0 -1C0.025 -0.14 0.14 -0.025 1 0C0.14 0.025 0.025 0.14 0 1C-0.025 0.14 -0.14 0.025 -1 0C-0.14 -0.025 -0.025 -0.14 0 -1Z";
const rgb = (c: Rgb) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

// Blink: 100 ms close (ease-in), 30 ms hold, 240 ms open (ease-out).
function blinkShape(s: number) {
  if (s < 0) return 0;
  if (s < 0.1) {
    const u = s / 0.1;
    return u * u;
  }
  if (s < 0.13) return 1;
  if (s < 0.37) {
    const u = (s - 0.13) / 0.24;
    return (1 - u) * (1 - u);
  }
  return 0;
}

// Twinkle envelope: quick swell, long soft tail.
function twinkle(u: number) {
  if (u <= 0 || u >= 1) return 0;
  return u < 0.3 ? smooth(u / 0.3) : Math.pow(1 - (u - 0.3) / 0.7, 1.8);
}

type Star = {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly g: SVGGElement;
  readonly glow: SVGCircleElement;
  readonly spark: SVGPathElement;
};

type BlinkRig = {
  readonly eye: EyeLandmarks;
  readonly T: readonly Vec2[];
  readonly O: readonly Vec2[];
  readonly C: readonly Vec2[];
  readonly D: readonly Vec2[];
  readonly N: number;
  readonly clipPath: SVGPathElement;
  readonly g: SVGGElement;
  readonly lash: SVGPathElement;
  readonly ticks: SVGPathElement;
  readonly far: SVGCircleElement | null;
  readonly band: SVGGElement | null;
  readonly shadow: SVGPathElement;
};

type GazeRig = {
  readonly g: SVGGElement;
  readonly move: SVGGElement;
  readonly lid: SVGPathElement;
  readonly cl: SVGCircleElement;
  readonly catchAt: Vec2;
  readonly O: readonly Vec2[];
  readonly travel: Vec2;
};

type Sweep = { readonly g: SVGGElement; readonly band: SVGRectElement };
type Traveller = {
  readonly g: SVGGElement;
  readonly dodge: SVGCircleElement;
  readonly tail: readonly SVGCircleElement[];
  readonly glow: SVGCircleElement;
  readonly head: SVGCircleElement;
};
type CoreLights = {
  readonly bloom: SVGCircleElement;
  readonly light: SVGCircleElement;
  readonly hot: SVGCircleElement;
};

type ItemKind =
  | {
      readonly equipment: "helmet";
      readonly lm: HelmetLandmarks;
      readonly sweep: Sweep;
      readonly starGlow: SVGCircleElement;
      readonly starSpark: SVGGElement;
    }
  | {
      readonly equipment: "lance";
      readonly lm: LanceLandmarks;
      readonly sweep: Sweep;
      readonly tipSpark: SVGGElement;
    }
  | {
      readonly equipment: "astrolabe";
      readonly lm: AstrolabeLandmarks;
      readonly trav: Traveller;
      readonly pointerSpark: SVGGElement;
    }
  | {
      readonly equipment: "grimoire";
      readonly lm: GrimoireLandmarks;
      readonly coverStars: readonly SVGGElement[];
    }
  | {
      readonly equipment: "armillary";
      readonly lm: ArmillaryLandmarks;
      readonly travs: readonly Traveller[];
    }
  | {
      readonly equipment: "none";
      readonly lm: NoneLandmarks;
      readonly fingers: SVGEllipseElement;
      readonly wisp: SVGGElement;
      readonly wispHalo: SVGCircleElement;
      readonly wispGlow: SVGCircleElement;
      readonly wispCore: SVGCircleElement;
      readonly wispSparks: readonly SVGCircleElement[];
    };

type ItemFx = ItemKind & {
  readonly core: CoreLights | null;
  readonly nodSpark: SVGGElement;
  readonly gather: SVGGElement;
  readonly greet: SVGGElement;
  readonly flourish: {
    readonly g: SVGGElement;
    readonly lines: readonly SVGPathElement[];
    readonly fade: SVGLinearGradientElement;
    readonly head: SVGGElement;
    readonly burst: SVGGElement;
  };
  readonly thought: {
    readonly g: SVGGElement;
    readonly glow: SVGEllipseElement;
    readonly orb: SVGCircleElement;
    readonly core: SVGCircleElement;
  };
  readonly rise: readonly SVGGElement[];
  readonly motes: readonly SVGGElement[];
};

type Flutter = {
  readonly outer: SVGGElement;
  readonly turb: SVGFETurbulenceElement;
  readonly disp: SVGFEDisplacementMapElement;
  readonly flood: SVGFEFloodElement;
  readonly ripple: SVGGElement;
  readonly rg: SVGLinearGradientElement;
  readonly dir: Vec2;
  readonly pole: Vec2;
};

type SprayKind = "entrance" | "appearance";
type WipeSync = { readonly swapAt: number; readonly total: number };
type ExchangePart = {
  readonly node: SVGGElement;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly lift: number;
  readonly delay: number;
  readonly size: number;
  readonly spin: number;
};
type SprayPart = {
  readonly node: SVGGElement;
  readonly x0: number;
  readonly y0: number;
  readonly dx: number;
  readonly dy: number;
  readonly size: number;
  readonly delay: number;
  readonly spin: number;
};
type BurstBase = {
  readonly g: SVGGElement;
  readonly start: number;
  readonly duration: number;
  done: boolean;
};
type Burst =
  | (BurstBase & { readonly kind: "ghost" })
  | (BurstBase & {
      readonly kind: "wipe";
      readonly band: SVGRectElement;
      readonly sync: WipeSync | null;
      readonly x0: number;
      readonly x1: number;
      lastX: number | undefined;
      synced: boolean;
    })
  | (BurstBase & {
      readonly kind: "exchange";
      readonly soft: SVGEllipseElement;
      readonly core: SVGEllipseElement;
      readonly parts: readonly ExchangePart[];
      readonly swapAt: number;
      readonly cross: number;
      readonly carry: number;
      level: number;
    })
  | (BurstBase & {
      readonly kind: SprayKind;
      readonly flash: SVGCircleElement;
      readonly parts: readonly SprayPart[];
    });
type WipeBurst = Extract<Burst, { kind: "wipe" }>;
type ExchangeBurst = Extract<Burst, { kind: "exchange" }>;

type Pose = FxFrame["pose"];

class SquireFxController implements FxController {
  private readonly ctx: FxContext;
  private readonly L: SquireFxLandmarks = SQUIRE_FX_LANDMARKS;
  private config: FxConfig | null = null;
  private cache = new WeakMap<Element, Map<string, string>>();
  private made: Element[] = [];
  private tint: number[] = [...TINT.brass];
  private tintTarget: Rgb = TINT.brass;
  private tintKey: string | null = null;
  private bursts: Burst[] = [];
  private blinkExtra: number[] = [];
  private blinkPlan: number[] | null = null;
  private lastPose: Pose | null = null;
  private lastTime = 0;
  private phase: { astro: number | null; arm: number | null } = { astro: null, arm: null };
  private flutterStamp = -1;
  private amb = 0;
  private mode: "live" | "hold" | "rest" | null = null;
  private seed = 0;
  private seedShift = 0;
  private burstSeed = 0;
  private wipeN = 0;
  private trAppear: number | undefined;
  private headKey: string | null = null;
  private itemKey: string | null = null;
  private readonly imgPool = new Map<string, SVGImageElement[]>();
  private readonly loaded = new WeakSet<SVGImageElement>();
  private parking: SVGGElement | null = null;

  private readonly defs: SVGGElement;
  private tintStops: Element[] = [];
  private haloStops: Element[] = [];
  private readonly aura: SVGEllipseElement;
  private readonly headHalo: SVGEllipseElement;
  private torsoRoot: SVGGElement | null = null;
  private stars: Star[] = [];
  private brooch: SVGGElement | null = null;
  private broochBand: SVGRectElement | null = null;
  private broochSpark: SVGGElement | null = null;
  private crest: SVGGElement | null = null;
  private readonly root: {
    head: SVGGElement;
    wipe: SVGGElement;
    item: SVGGElement;
    front: SVGGElement;
  };
  private blink: BlinkRig | null = null;
  private gazeEye: GazeRig | null = null;
  private glanceGlint: SVGGElement | null = null;
  private glanceLanding: SVGGElement | null = null;
  private glanceFlick: SVGGElement | null = null;
  private headMotifs: {
    readonly listen: SVGGElement;
    readonly nod: SVGGElement;
    readonly muse: SVGGElement;
  } | null = null;
  private item: ItemFx | null = null;
  private flutter: Flutter | null = null;

  constructor(ctx: FxContext) {
    this.ctx = ctx;
    this.defs = this.el("g", { "data-fx-defs": "" }, ctx.defs);
    this.made.push(this.defs);
    this.buildDefs();
    const aura = this.el("g", { "data-fx-part": "aura" }, ctx.layers.aura);
    this.made.push(aura);
    // Soft vertical ellipse centred on the chest, behind the whole figure.
    this.aura = this.el(
      "ellipse",
      {
        "data-fx": "aura",
        cx: 545,
        cy: 760,
        rx: 430,
        ry: 660,
        fill: `url(#${this.id("halo")})`,
        opacity: 0,
      },
      aura,
    );
    // Attentive: a gold nimbus centred on the head, held steady (no breathing). Saturated
    // with a broad plateau so it reads behind the dark hair on light and dark panels alike;
    // its rim stays inside the stage top, where the rig's viewport would cut it flat.
    this.headHalo = this.el(
      "ellipse",
      {
        "data-fx": "halo",
        cx: 572,
        cy: 268,
        rx: 292,
        ry: 266,
        fill: `url(#${this.id("nimbus")})`,
        opacity: 0,
      },
      aura,
    );
    this.buildTorso();
    this.root = {
      head: this.el("g", { "data-fx-part": "head" }, ctx.layers.head),
      wipe: this.el("g", { "data-fx-part": "wipe" }, ctx.layers.head),
      item: this.el("g", { "data-fx-part": "item" }, ctx.layers.item),
      front: this.el("g", { "data-fx-part": "front" }, ctx.layers.front),
    };
    this.made.push(this.root.head, this.root.wipe, this.root.item, this.root.front);
  }

  private id(name: string) {
    return this.ctx.uid(`fx-${name}`);
  }

  private el<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Attrs | null,
    parent: Element | null,
  ): SVGElementTagNameMap[K] {
    const e = document.createElementNS(this.ctx.NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) if (v !== null) e.setAttribute(k, String(v));
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  private set(e: Element, k: string, v: string | number) {
    let m = this.cache.get(e);
    if (!m) {
      m = new Map();
      this.cache.set(e, m);
    }
    const s = String(v);
    if (m.get(k) === s) return;
    m.set(k, s);
    e.setAttribute(k, s);
  }

  private show(e: Element, on: boolean) {
    this.set(e, "display", on ? "inline" : "none");
  }

  private radial(
    name: string,
    stops: ReadonlyArray<readonly [number, string, number]>,
    attrs?: Attrs,
  ) {
    const g = this.el("radialGradient", { id: this.id(name), ...attrs }, this.defs);
    for (const [o, c, a] of stops)
      this.el("stop", { offset: o, "stop-color": c, "stop-opacity": a }, g);
    return g;
  }

  private buildDefs() {
    const defs = this.defs;
    // Warm gold light: white-hot centre, amber falloff.
    this.radial("gold", [
      [0, "#fff8e2", 1],
      [0.18, "#ffe3a0", 0.85],
      [0.45, "#f2b552", 0.32],
      [0.75, "#c7802a", 0.08],
      [1, "#a0601c", 0],
    ]);
    this.radial("core", [
      [0, "#fffdf2", 1],
      [0.35, "#ffe9b0", 0.7],
      [1, "#ffc766", 0],
    ]);
    // Equipment exchange: a near-opaque warm core over the hands, a wide soft screen halo.
    this.radial("xcore", [
      [0, "#fff1cf", 1],
      [0.35, "#f8d692", 0.96],
      [0.62, "#eeba6c", 0.72],
      [0.85, "#dda04c", 0.26],
      [1, "#d99a45", 0],
    ]);
    this.radial("xsoft", [
      [0, "#ffe2a6", 0.9],
      [0.45, "#f0b862", 0.45],
      [1, "#d99a45", 0],
    ]);
    const wb = this.el(
      "linearGradient",
      { id: this.id("wipeband"), x1: 0, y1: 0, x2: 1, y2: 0 },
      defs,
    );
    for (const [o, c, a] of [
      [0, "#d99a45", 0],
      [0.2, "#f0b45a", 0.3],
      [0.38, "#fbd084", 0.68],
      [0.5, "#ffe4a8", 0.82],
      [0.62, "#fbd084", 0.68],
      [0.8, "#f0b45a", 0.3],
      [1, "#d99a45", 0],
    ] as const) {
      this.el("stop", { offset: o, "stop-color": c, "stop-opacity": a }, wb);
    }
    // Item cores: warm gold, never white, so the face stays the focal point.
    this.radial("corelight", [
      [0, "#f4c779", 0.9],
      [0.4, "#eab060", 0.45],
      [1, "#d99a45", 0],
    ]);
    this.radial("warmcore", [
      [0, "#ffc562", 1],
      [0.45, "#ffcf7a", 0.85],
      [1, "#ffffff", 0],
    ]);
    this.radial("itemcore", [
      [0, "#f4c779", 1],
      [0.45, "#e9b35e", 0.55],
      [1, "#d99a45", 0],
    ]);
    this.tintStops = [
      ...this.radial("tint", [
        [0, "#ffe2a8", 0.55],
        [0.5, "#ffce78", 0.18],
        [1, "#ffce78", 0],
      ]).children,
    ];
    this.haloStops = [
      ...this.radial("halo", [
        [0, "#ffdca0", 1],
        [0.45, "#e8b060", 0.5],
        [0.8, "#c08840", 0.12],
        [1, "#c08840", 0],
      ]).children,
    ];
    this.radial("nimbus", [
      [0, "#ffd36e", 1],
      [0.5, "#f7bb45", 0.9],
      [0.76, "#eda43a", 0.45],
      [1, "#e39a30", 0],
    ]);
    // Thinking's cool light: blue, so it never reads as attentive's gold.
    this.radial("cool", [
      [0, "#c9dcff", 0.95],
      [0.45, "#86a9ee", 0.55],
      [1, "#5f86d6", 0],
    ]);
    this.radial("coolorb", [
      [0, "#f5f9ff", 1],
      [0.14, "#dbe8ff", 0.95],
      [0.36, "#97b8f4", 0.7],
      [0.66, "#6a90dc", 0.3],
      [1, "#5a80d0", 0],
    ]);
    this.radial("spark", [
      [0, "#fffaf0", 1],
      [0.2, "#fff0c4", 0.95],
      [0.6, "#ffd078", 0.5],
      [1, "#ffbf55", 0],
    ]);
    this.radial("wisp", [
      [0, "#fffaf0", 1],
      [0.1, "#fff0c8", 0.95],
      [0.3, "#ffd27a", 0.62],
      [0.6, "#f0a848", 0.26],
      [1, "#e09040", 0],
    ]);
    // Ponder's held orb: a defined lit ball, not a soft glow, so it reads as a held light.
    this.radial("orb", [
      [0, "#fffaf0", 1],
      [0.5, "#ffe7ae", 1],
      [0.78, "#f2b552", 0.85],
      [1, "#c7802a", 0],
    ]);
    this.radial("ember", [
      [0, "#fff6dc", 1],
      [0.3, "#ffd88a", 0.75],
      [1, "#f0a040", 0],
    ]);
    this.radial("warm", [
      [0, "#ffc477", 0.75],
      [0.55, "#f0a050", 0.25],
      [1, "#e08a3a", 0],
    ]);
    // Colour-dodge light: lifts metal and skin it passes over, leaves dark enamel almost alone.
    this.radial("dodge", [
      [0, "#d2a462", 1],
      [0.3, "#a67c44", 0.78],
      [0.65, "#5c4226", 0.32],
      [1, "#000", 0],
    ]);
    // Sheen band for colour-dodge glints: black = no change, warm grey brightens metal only.
    const band = this.el(
      "linearGradient",
      { id: this.id("band"), x1: 0, y1: 0, x2: 1, y2: 0 },
      defs,
    );
    for (const [o, c] of [
      [0, "#000"],
      [0.32, "#2a1f10"],
      [0.5, "#b89462"],
      [0.68, "#2a1f10"],
      [1, "#000"],
    ] as const) {
      this.el("stop", { offset: o, "stop-color": c }, band);
    }
  }

  private sparkleGlyph(parent: Element, attrs: Attrs) {
    const s = this.el("g", attrs, parent);
    this.el("circle", { r: 1, fill: `url(#${this.id("gold")})` }, s);
    this.el("path", { d: SPARK, fill: `url(#${this.id("spark")})` }, s);
    return s;
  }

  // A dark amber edge under a sparkle so it reads over the light panel and bright metal too.
  private bedded(s: SVGGElement) {
    const star = s.lastElementChild;
    if (star) {
      const edge: Attrs = {
        stroke: BED,
        "stroke-width": 0.22,
        "stroke-opacity": 0.75,
        "paint-order": "stroke",
      };
      for (const [k, v] of Object.entries(edge)) star.setAttribute(k, String(v));
    }
    return s;
  }

  // Glance flick: a short spindle on the eye-to-target line that ends just short of the target,
  // pointed at both ends and widest near its head, ~130 units whatever the distance.
  private drawFlick(g: SVGGElement, [x0, y0]: Vec2, [x1, y1]: Vec2, k: number) {
    this.show(g, k > 0.01);
    if (k <= 0.01) return;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const p = (along: number, side: number) =>
      `${r2(x0 + ux * along - uy * side)} ${r2(y0 + uy * along + ux * side)}`;
    const spindle = (a: number, b: number, w: number) => {
      const m = a + (b - a) * 0.7;
      return `M${p(a, 0)}Q${p(m, w)} ${p(b, 0)}Q${p(m, -w)} ${p(a, 0)}Z`;
    };
    const [bed, core] = [...g.children];
    const end = len - 26;
    if (bed) this.set(bed, "d", spindle(end - 140, end, 11));
    if (core) this.set(core, "d", spindle(end - 132, end - 4, 5));
    this.set(g, "opacity", r3(k * this.amb));
  }

  // Cloak star twinkles and brooch glint.
  private buildTorso() {
    if (this.torsoRoot) {
      const old = this.torsoRoot;
      old.remove();
      this.made = this.made.filter((n) => n !== old);
    }
    const g = this.el("g", { "data-fx-part": "torso" }, this.ctx.layers.torso);
    this.made.push(g);
    this.torsoRoot = g;
    this.stars = this.L.cloak.stars.map(([x, y, r]) => {
      const s = this.el("g", { display: "none", style: "mix-blend-mode:screen" }, g);
      const glow = this.el("circle", { cx: 0, cy: 0, r: 1, fill: `url(#${this.id("gold")})` }, s);
      const spark = this.el("path", { d: SPARK, fill: `url(#${this.id("spark")})` }, s);
      return { x, y, r, g: s, glow, spark };
    });
    const [bx, by, br] = this.L.cloak.brooch;
    const clip = this.el("clipPath", { id: this.id("brooch"), clipPathUnits: "userSpaceOnUse" }, g);
    this.el("circle", { cx: bx, cy: by, r: br }, clip);
    this.brooch = this.el(
      "g",
      {
        display: "none",
        "clip-path": `url(#${this.id("brooch")})`,
        style: "mix-blend-mode:color-dodge",
      },
      g,
    );
    this.broochBand = this.el(
      "rect",
      { x: -14, y: -50, width: 28, height: 100, fill: `url(#${this.id("band")})` },
      this.brooch,
    );
    this.broochSpark = this.sparkleGlyph(g, { display: "none", style: "mix-blend-mode:screen" });
  }

  // The Lead crest (star over thread), worn on the cloak. It sits in the torso layer so it rides
  // the torso breath, and never animates on its own. A faint metal gradient keeps the flat
  // badge fill from reading as a sticker against the embroidered cloth.
  private syncCrest(on: boolean) {
    if (!on) {
      if (this.crest) {
        const old = this.crest;
        old.remove();
        this.made = this.made.filter((n) => n !== old);
        this.crest = null;
      }
      return;
    }
    if (this.crest) return;
    const [cx, cy, size] = this.L.cloak.crest;
    const k = size / LEAD_CREST_VIEWBOX;
    const g = this.el(
      "g",
      {
        "data-fx": "crest",
        "data-fx-part": "crest",
        opacity: 0.95,
        transform: `translate(${r2(cx - size / 2)} ${r2(cy - size / 2)}) scale(${r3(k)})`,
      },
      this.ctx.layers.torso,
    );
    this.made.push(g);
    this.crest = g;
    const metal = this.el(
      "linearGradient",
      { id: this.id("crest-metal"), gradientUnits: "userSpaceOnUse", x1: 4, y1: 2, x2: 20, y2: 22 },
      g,
    );
    for (const [o, c] of [
      [0, "#fbe7a6"],
      [0.5, LEAD_CREST_FILL],
      [1, "#dcaa48"],
    ] as const) {
      this.el("stop", { offset: o, "stop-color": c }, metal);
    }
    for (const d of LEAD_CREST_PATHS) {
      this.el(
        "path",
        {
          d,
          fill: `url(#${this.id("crest-metal")})`,
          stroke: LEAD_CREST_STROKE,
          "stroke-width": LEAD_CREST_STROKE_WIDTH,
          "stroke-linejoin": "round",
        },
        g,
      );
    }
  }

  // A twinkle on a star the crest covers would bloom out from under the crest's edge.
  private underCrest(idx: number) {
    const star = this.L.cloak.stars[idx];
    if (!star) return false;
    const [cx, cy, size] = this.L.cloak.crest;
    const reach = size / 2 + star[2];
    return Math.abs(star[0] - cx) < reach && Math.abs(star[1] - cy) < reach;
  }

  // Copies of the rig's own images. Rebuilt layers reuse pooled, already-decoded <image>
  // elements (same href), so a rebuild never shows a frame with an undecoded copy.
  // A pooled copy keeps its href (never removed or re-set), so its request is never aborted.
  private imageCopy(src: SVGImageElement, parent: Element, pre: string) {
    const href = src.getAttribute("href") ?? "";
    const list = this.imgPool.get(href);
    let im = list?.pop() ?? null;
    if (!im) {
      const fresh = document.createElementNS(this.ctx.NS, "image");
      fresh.addEventListener("load", () => this.loaded.add(fresh), { once: true });
      fresh.setAttribute("href", href);
      im = fresh;
    }
    for (const a of Array.from(im.attributes)) if (a.name !== "href") im.removeAttribute(a.name);
    im.setAttribute(
      "preserveAspectRatio",
      src.getAttribute("preserveAspectRatio") || "xMidYMid meet",
    );
    for (const a of ["x", "y", "width", "height"]) {
      const v = src.getAttribute(a);
      if (v !== null) im.setAttribute(a, v);
    }
    const base = src.getAttribute("transform");
    im.setAttribute("transform", `${pre}${base ? ` ${base}` : ""}`);
    parent.appendChild(im);
    return im;
  }

  // Return image copies under `node` to the pool before the subtree is discarded. Copies
  // still loading are parked (hidden, still in the document) instead of detached, so their
  // request completes; they join the pool once loaded.
  private reclaimImages(node: Element) {
    if (!this.parking) {
      this.parking = this.el(
        "g",
        { "data-fx-part": "parking", opacity: 0, style: "visibility:hidden" },
        this.ctx.layers.front,
      );
      this.made.push(this.parking);
    }
    const parking = this.parking;
    for (const im of node.querySelectorAll("image")) {
      const href = im.getAttribute("href") ?? "";
      let list = this.imgPool.get(href);
      if (!list) {
        list = [];
        this.imgPool.set(href, list);
      }
      if (list.length < 6) list.push(im);
      if (this.loaded.has(im)) im.remove();
      else parking.appendChild(im);
    }
  }

  private buildBlink(appearance: RigAppearance) {
    const root = this.root.head;
    this.reclaimImages(root);
    root.replaceChildren();
    this.blink = null;
    this.gazeEye = null;
    this.glanceGlint = null;
    this.glanceLanding?.remove();
    this.glanceFlick?.remove();
    this.glanceLanding = null;
    this.glanceFlick = null;
    this.headMotifs = null;
    const eye = this.L.eyes[appearance];
    const head = this.ctx.images.head;
    if (!head.getAttribute("href")) return;
    const copyHead = (parent: Element, dx: number, dy: number) =>
      this.imageCopy(head, parent, `translate(${dx} ${dy})`);
    this.buildGaze(root, eye, copyHead);
    const N = 15;
    const T = resample(eye.T, N);
    const O = resample(eye.O, N);
    const D = resample(eye.D, N);
    // Closed lid line: corner chord plus a gentle sag peaking a little toward the inner side.
    const { a, b, sag, peak } = eye.closed;
    const C: Vec2[] = T.map((_, i) => {
      const s = i / (N - 1);
      const bump = Math.sin(Math.PI * Math.pow(s, Math.log(0.5) / Math.log(peak)));
      return [lerp(a[0], b[0], s), lerp(a[1], b[1], s) + sag * bump];
    });
    const clip = this.el("clipPath", { id: this.id("lid"), clipPathUnits: "userSpaceOnUse" }, root);
    const clipPath = this.el("path", { d: "" }, clip);
    const g = this.el("g", { display: "none" }, root);
    const skinWrap = this.el("g", { "clip-path": `url(#${this.id("lid")})` }, g);
    copyHead(skinWrap, 0, -eye.shift);
    // Lid roundness: a little shadow under the crease and toward the lash line.
    const top = Math.min(...T.map((p) => p[1]));
    const bottom = Math.max(...D.map((p) => p[1]));
    const shade = this.el(
      "linearGradient",
      {
        id: this.id("lidshade"),
        gradientUnits: "userSpaceOnUse",
        x1: 0,
        y1: top,
        x2: 0,
        y2: bottom,
      },
      root,
    );
    for (const [o, c, al] of [
      [0, "#6a3a20", 0.3],
      [0.3, "#8a5a38", 0.08],
      [0.6, "#8a5a38", 0.05],
      [1, "#6a4028", 0.12],
    ] as const) {
      this.el("stop", { offset: o, "stop-color": c, "stop-opacity": al }, shade);
    }
    this.el(
      "rect",
      {
        x: at(T, 0)[0] - 4,
        y: top - 2,
        width: at(T, N - 1)[0] - at(T, 0)[0] + 10,
        height: bottom - top + 6,
        fill: `url(#${this.id("lidshade")})`,
      },
      skinWrap,
    );
    // Lid shadow on the eye just under the moving lid edge (clipped to the opening).
    const shadow = this.el(
      "path",
      {
        fill: "#3a2414",
        opacity: 0,
        "clip-path": this.gazeEye ? `url(#${this.id("open")})` : null,
      },
      g,
    );
    let band: SVGGElement | null = null;
    if (eye.band) {
      const bclip = this.el(
        "clipPath",
        { id: this.id("lashband"), clipPathUnits: "userSpaceOnUse" },
        root,
      );
      this.el("path", { d: polyPath(eye.band) }, bclip);
      const move = this.el("g", {}, g);
      const inner = this.el("g", { "clip-path": `url(#${this.id("lashband")})` }, move);
      copyHead(inner, 0, 0);
      band = move;
    }
    const lash = this.el("path", { fill: "#2a1a10" }, g);
    const ticks = this.el(
      "path",
      {
        fill: "none",
        stroke: "#2a1a10",
        "stroke-width": 0.55,
        "stroke-linecap": "round",
        opacity: 0,
        "data-fx": "closed-lashes",
      },
      g,
    );
    const far = eye.far
      ? this.el(
          "circle",
          { cx: eye.far[0], cy: eye.far[1], r: eye.far[2], fill: "#1d1510", opacity: 0 },
          g,
        )
      : null;
    this.blink = { eye, T, O, C, D, N, clipPath, g, lash, ticks, far, band, shadow };
    // Glance accent: an eye-sized glint (unclipped, above the lids) so the sideways look
    // reads at panel size, where the iris shift alone is a pixel or two.
    this.glanceGlint = this.bedded(
      this.sparkleGlyph(root, { display: "none", "data-fx": "glance-glint" }),
    );
    // The look lands on the item as a second glint, arriving as a short tapered flick: a full
    // sightline read as a laser or a stick at panel size, and one leaving the eye crosses the
    // face on its way down to the item.
    // The landing glint sits on a warm bloom, so the item visibly lights where the look lands.
    // Both live in the front layer: the head layer paints under the item art. Stage space is
    // close enough to head space here, where the head is turned only a few degrees.
    const front = this.root.front;
    this.glanceLanding = this.el("g", { display: "none", "data-fx": "glance-landing" }, front);
    this.el("circle", { r: 1.7, fill: `url(#${this.id("warm")})` }, this.glanceLanding);
    this.bedded(this.sparkleGlyph(this.glanceLanding, {}));
    const flick = this.el("g", { display: "none", "data-fx": "glance-flick" }, front);
    this.el("path", { fill: BED, opacity: 0.7 }, flick);
    this.el("path", { fill: PALE }, flick);
    this.glanceFlick = flick;
    this.buildHeadMotifs(root, this.L.faces[appearance]);
    this.drawBlink(0);
  }

  // Gesture peak motifs on the head, head-local so they follow every head and hood pose.
  // Listen: static sound arcs centred on the ear but far enough out to clear the raised hood and
  // the hair, so they sit on the background. Nod: two bold chevrons on the open side of
  // the face (the head dip is capped by the neck bound, so the chevrons carry the read).
  private buildHeadMotifs(root: SVGGElement, face: FaceLandmarks) {
    const [ex, ey] = face.ear;
    const listen = this.el(
      "g",
      { display: "none", "data-fx": "listen-arcs", fill: "none", "stroke-linecap": "round" },
      root,
    );
    // Bold enough to read in a 2x panel capture: a near-opaque dark bed under a wide pale core.
    for (const [i, r] of [182, 218, 254].entries()) {
      const a1 = (159 * Math.PI) / 180;
      const a2 = (201 * Math.PI) / 180;
      const d = `M${r2(ex + r * Math.cos(a1))} ${r2(ey + r * Math.sin(a1))}A${r} ${r} 0 0 1 ${r2(ex + r * Math.cos(a2))} ${r2(ey + r * Math.sin(a2))}`;
      const fade = 1 - 0.12 * i;
      this.el("path", { d, stroke: BED, "stroke-width": 26 - 2 * i, opacity: 0.95 * fade }, listen);
      this.el("path", { d, stroke: PALE, "stroke-width": 12 - 1.5 * i, opacity: fade }, listen);
    }
    const [cx, cy] = face.nod;
    const nod = this.el(
      "g",
      {
        display: "none",
        "data-fx": "nod-chevron",
        fill: "none",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      root,
    );
    for (const [i, dy] of [0, 60].entries()) {
      const d = `M${cx - 68} ${cy + dy}L${cx} ${cy + dy + 48}L${cx + 68} ${cy + dy}`;
      // The listen arcs' dark amber bed under a pale core: contrast over skin, light panels,
      // and dark ground alike.
      this.el("path", { d, stroke: BED, "stroke-width": 26, opacity: 0.95 * (1 - 0.2 * i) }, nod);
      this.el("path", { d, stroke: PALE, "stroke-width": 12, opacity: 1 - 0.2 * i }, nod);
    }
    // Ponder: a warm thought rising off the brow, growing dots up to a spark above the head
    // (no glyphs or text, so it reads the same when the panel mirrors the figure).
    const [[bx, by], [mx, my]] = face.muse;
    const muse = this.el("g", { display: "none", "data-fx": "ponder-muse" }, root);
    for (const [i, r] of [9, 13, 17].entries()) {
      const k = (i + 0.6) / 3.6;
      this.el(
        "circle",
        {
          cx: r2(lerp(bx, mx, k)),
          cy: r2(lerp(by, my, k) + 14 * Math.sin(Math.PI * k)),
          r,
          fill: "#ffd98a",
          stroke: BED,
          "stroke-width": 5,
          "stroke-opacity": 0.8,
        },
        muse,
      );
    }
    this.bedded(
      this.sparkleGlyph(muse, { transform: `translate(${mx} ${my}) scale(${r2(36 * 1.3)} 36)` }),
    );
    this.headMotifs = { listen, nod, muse };
  }

  private drawHeadMotifs(listen: number, nod: number, ponder: number) {
    const m = this.headMotifs;
    if (!m) return;
    for (const [node, k] of [
      [m.listen, listen],
      [m.nod, nod],
      [m.muse, ponder],
    ] as const) {
      this.show(node, k > 0.01);
      if (k > 0.01) this.set(node, "opacity", r3(k * this.amb));
    }
  }

  // Iris/pupil shift inside the eye white: the opening is repainted with the sampled sclera
  // ramp and a copy of the painted iris slides over it (clipped to the opening).
  private buildGaze(
    root: SVGGElement,
    eye: EyeLandmarks,
    copyHead: (parent: Element, dx: number, dy: number) => void,
  ) {
    const [ix, iy, ir] = eye.iris;
    const clip = this.el(
      "clipPath",
      { id: this.id("open"), clipPathUnits: "userSpaceOnUse" },
      root,
    );
    this.el("path", { d: smoothPath(eye.opening, true) }, clip);
    const iclip = this.el(
      "clipPath",
      { id: this.id("iris"), clipPathUnits: "userSpaceOnUse" },
      root,
    );
    this.el("circle", { cx: ix, cy: iy, r: ir }, iclip);
    const ys = eye.opening.map((p) => p[1]);
    const sg = this.el(
      "linearGradient",
      {
        id: this.id("sclera"),
        gradientUnits: "userSpaceOnUse",
        x1: 0,
        y1: Math.min(...ys),
        x2: 0,
        y2: Math.max(...ys),
      },
      root,
    );
    eye.sclera.forEach((c, i) =>
      this.el("stop", { offset: at([0, 0.35, 1], i), "stop-color": c }, sg),
    );
    const g = this.el("g", { "clip-path": `url(#${this.id("open")})`, display: "none" }, root);
    this.el("path", { d: smoothPath(eye.opening, true), fill: `url(#${this.id("sclera")})` }, g);
    const move = this.el("g", {}, g);
    const iris = this.el("g", { "clip-path": `url(#${this.id("iris")})` }, move);
    copyHead(iris, 0, 0);
    // Shadow of the upper lid on the eye; it deepens when the eye looks down, as the lid
    // would follow the iris.
    const lid = this.el("path", { fill: "#3a2414", opacity: 0.28 }, g);
    // Attentive catchlight: a soft highlight riding on the iris (eyes bright, awaiting).
    const cl = this.el(
      "circle",
      { cx: eye.catch[0], cy: eye.catch[1], r: eye.catch[2], fill: "#fff8ea", opacity: 0 },
      move,
    );
    this.gazeEye = {
      g,
      move,
      lid,
      cl,
      catchAt: [eye.catch[0], eye.catch[1]],
      O: eye.O,
      travel: eye.travel,
    };
  }

  private drawGaze(ex: number, ey: number, bright = 0, glance = 0) {
    const ge = this.gazeEye;
    if (!ge) return;
    const [tx, ty] = ge.travel;
    const dx = clamp(ex, -1, 1) * tx * (ex < 0 ? VIEWER_TRAVEL : 1);
    const dy = clamp(ey, -1, 1) * ty;
    if (this.glanceGlint) {
      const [cx, cy] = ge.catchAt;
      this.drawSpark(
        this.glanceGlint,
        cx + dx * 1.6,
        cy + dy,
        15 * (0.5 + 0.5 * glance),
        0.95 * glance,
        15 * glance,
      );
    }
    const lm: ItemLandmarkBase = this.item?.lm ?? this.L.items.none;
    const [tx1, ty1] = lm.glint ?? lm.focal;
    if (this.glanceLanding) {
      const landing = this.glanceLanding;
      this.show(landing, glance > 0.01);
      if (glance > 0.01) {
        const k = 60 * (0.5 + 0.5 * glance);
        this.set(
          landing,
          "transform",
          `translate(${r2(tx1)} ${r2(ty1)}) scale(${r3(k * 1.3)} ${r3(k)})`,
        );
        this.set(landing, "opacity", r3(glance * this.amb));
      }
    }
    if (this.glanceFlick) this.drawFlick(this.glanceFlick, ge.catchAt, [tx1, ty1], glance);
    const on = Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || bright > 0.02;
    this.set(ge.cl, "opacity", r3(0.85 * bright));
    this.show(ge.g, on);
    if (!on) return;
    this.set(ge.move, "transform", `translate(${r2(dx)} ${r2(dy)})`);
    const down = Math.max(0, dy);
    const h = 2.6 + 1.3 * down;
    this.set(
      ge.lid,
      "d",
      smoothPath(ge.O.concat(ge.O.toReversed().map(([x, y]) => [x, y + h] as const)), true),
    );
    this.set(ge.lid, "opacity", r3(0.3 + 0.18 * down));
  }

  // p: blink 0..1; held: lid lowered and held (state), 0..~0.4. The blink starts from the
  // held lid; the lower lid, lash hand-over and closed lashes only follow the blink part.
  private drawBlink(p: number, held = 0) {
    const b = this.blink;
    if (!b) return;
    const k = Math.max(p, held);
    if (k <= 0.001) {
      this.show(b.g, false);
      return;
    }
    this.show(b.g, true);
    const bk = held < 0.999 ? clamp01((k - held) / (1 - held)) : 1;
    const N = b.N;
    // Upper lid edge travels from the open lash line to the closed line; the lower lid
    // retreats up to meet it over most of the stroke, so no hard iris block shows.
    const L: Vec2[] = b.O.map((o, i) => [
      lerp(o[0], at(b.C, i)[0], k),
      lerp(o[1], at(b.C, i)[1], k),
    ]);
    const kb = smooth((bk - 0.1) / 0.9);
    const B: Vec2[] = b.D.map((d, i) => [
      lerp(d[0], at(b.C, i)[0], kb),
      lerp(d[1], at(b.C, i)[1], kb),
    ]);
    // Early on, the painted lash band itself rides down with the lid (keeps its wing and
    // flicks); it hands over to a drawn lash line, which stays bold (>=2.6u) when closed.
    const bandA = 1 - smooth((bk - 0.26) / 0.16);
    const thin = smooth((bk - 0.2) / 0.5);
    const w = lerp(b.eye.width, 2.7, thin);
    const half = L.map((_, i) => {
      const s = i / (N - 1);
      return w * 0.5 * Math.pow(Math.sin(Math.PI * clamp(s * 0.9 + 0.05, 0, 1)), 0.45);
    });
    const mid = Math.floor(N / 2);
    const upper: Vec2[] = [
      ...b.T.map((q) => [q[0], q[1] - 0.6] as const),
      ...L.toReversed().map((q, i) => [q[0], q[1] + at(half, N - 1 - i) * 0.5] as const),
    ];
    const lower: Vec2[] = [
      ...B.map((q) => [q[0], q[1] - 0.4] as const),
      ...b.D.toReversed().map((q) => [q[0], q[1] + 1.2] as const),
    ];
    this.set(
      b.clipPath,
      "d",
      smoothPath(upper, true) + (kb > 0.001 ? smoothPath(lower, true) : ""),
    );
    if (b.band) {
      this.show(b.band, bandA > 0.01);
      this.set(
        b.band,
        "transform",
        `translate(${r2(at(L, mid)[0] - at(b.O, mid)[0])} ${r2(at(L, mid)[1] - at(b.O, mid)[1])})`,
      );
      this.set(b.band, "opacity", r3(bandA));
    }
    // Drawn lash: on closing it curls into the painted wing tip at the inner corner.
    const hook = b.eye.hook;
    const end = at(L, N - 1);
    const hk = smooth((bk - 0.3) / 0.7);
    const line: Vec2[] = L.concat([[lerp(end[0], hook[0], hk), lerp(end[1], hook[1], hk)]]);
    const hw = half.concat([0.45]);
    const up = line.map((q, i) => [q[0], q[1] - at(hw, i)] as const);
    const dn = line.map((q, i) => [q[0], q[1] + at(hw, i)] as const).toReversed();
    this.set(b.lash, "d", smoothPath([...up, ...dn], true));
    this.set(b.lash, "fill-opacity", r3(0.95 * (b.band ? smooth((bk - 0.18) / 0.16) : 1)));
    // Shadow the lid casts on the eye: a soft band under the lid that, as the slit narrows,
    // fills the whole slit so it reads as one dark line instead of an iris block.
    const sh = L.map((q, i) => [q[0], q[1] + at(half, i) * 0.4] as const);
    const sh2 = L.map(
      (q, i) =>
        [
          q[0],
          Math.min(q[1] + at(half, i) + 3.2 + 6 * smooth((bk - 0.35) / 0.35), at(B, i)[1] + 0.3),
        ] as const,
    ).toReversed();
    this.set(b.shadow, "d", smoothPath([...sh, ...sh2], true));
    this.set(b.shadow, "opacity", r3(0.3 * smooth(k / 0.3) + 0.5 * smooth((bk - 0.35) / 0.35)));
    // Fine lashes along the closed lid, drooping toward the cheek.
    let d = "";
    for (let j = 0; j < 6; j++) {
      const s = 0.32 + j * 0.115;
      const q = at(L, Math.round(s * (N - 1)));
      const len = 2.3 + 1.1 * Math.sin(Math.PI * s);
      d += `M${r2(q[0])} ${r2(q[1] + 0.8)}q${r2(0.25 * len)} ${r2(0.6 * len)} ${r2(0.55 * len)} ${r2(len)}`;
    }
    this.set(b.ticks, "d", d);
    this.set(b.ticks, "opacity", r3(0.75 * smooth((bk - 0.6) / 0.4)));
    if (b.far) this.set(b.far, "opacity", r3(0.9 * smooth((bk - 0.3) / 0.5)));
  }

  // Deterministic blink schedule: every 2.5-6 s, sometimes a double blink. Triggered blinks
  // (live only) suppress scheduled ones within 400 ms, and vice versa.
  private blinkAt(t: number, live: boolean) {
    if (!this.blinkPlan) this.blinkPlan = [];
    const plan = this.blinkPlan;
    while (!plan.length || (plan[plan.length - 1] ?? 0) < t + 1) {
      const n = plan.length;
      const prev = plan[n - 1] ?? 0.4;
      const next = prev + lerp(2.5, 6, hash(this.sd(71), n));
      plan.push(next);
      if (hash(this.sd(73), n) < 0.18) plan.push(next + 0.42);
    }
    let lo = 0;
    let hi = plan.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (at(plan, mid) <= t) lo = mid;
      else hi = mid - 1;
    }
    const extra = live ? this.blinkExtra : [];
    let p = 0;
    for (const s of [plan[lo], plan[lo - 1]]) {
      if (s === undefined || s > t) continue;
      if (extra.some((e) => Math.abs(e - s) < 0.4)) continue;
      p = Math.max(p, blinkShape(t - s));
    }
    for (const s of extra) if (s <= t) p = Math.max(p, blinkShape(t - s));
    return p;
  }

  private requestBlink(when: number) {
    const plan = this.blinkPlan ?? [];
    if (
      plan.some((s) => Math.abs(s - when) < 0.4) ||
      this.blinkExtra.some((s) => Math.abs(s - when) < 0.4)
    )
      return;
    this.blinkExtra = this.blinkExtra.filter((s) => s > when - 2).concat([when]);
  }

  private buildItem(equipment: RigEquipment) {
    const root = this.root.item;
    this.reclaimImages(root);
    root.replaceChildren();
    this.item = null;
    this.flutter = null;
    const items = this.L.items;
    const base: ItemLandmarkBase = items[equipment];
    const gold = `url(#${this.id("gold")})`;
    const tint = `url(#${this.id("tint")})`;
    const core = `url(#${this.id("core")})`;
    const glow = (cx: number, cy: number, r: number, fill: string) =>
      this.el("circle", { cx, cy, r, fill, style: "mix-blend-mode:screen" }, root);
    const sparkle = () =>
      this.sparkleGlyph(root, { display: "none", style: "mix-blend-mode:screen" });
    const sweep = (poly: readonly Vec2[], name: string): Sweep => {
      const clip = this.el(
        "clipPath",
        { id: this.id(name), clipPathUnits: "userSpaceOnUse" },
        root,
      );
      this.el("path", { d: polyPath(poly) }, clip);
      const g = this.el(
        "g",
        {
          display: "none",
          "clip-path": `url(#${this.id(name)})`,
          style: "mix-blend-mode:color-dodge",
        },
        root,
      );
      const band = this.el(
        "rect",
        { x: -0.5, y: -300, width: 1, height: 600, fill: `url(#${this.id("band")})` },
        g,
      );
      return { g, band };
    };
    if (base.hotspot) {
      // The art paints these cores pure white; a soft multiply tints the hotspot to warm gold
      // (#ffd98a at the centre) and leaves the surrounding gold untouched.
      const [hx, hy, hr] = base.hotspot;
      this.el(
        "circle",
        {
          cx: hx,
          cy: hy,
          r: hr,
          fill: `url(#${this.id("warmcore")})`,
          style: "mix-blend-mode:multiply",
        },
        root,
      );
    }
    let lights: CoreLights | null = null;
    if (base.core) {
      const [x, y, r] = base.core;
      lights = {
        bloom: glow(x, y, r * 2.2, tint),
        light: glow(x, y, r * 1.1, `url(#${this.id("corelight")})`),
        hot: glow(x, y, r * 0.4, `url(#${this.id("itemcore")})`),
      };
    }
    let kind: ItemKind;
    switch (equipment) {
      case "helmet": {
        const lm = items.helmet;
        const sw = sweep(lm.poly, "helmet");
        const [x, y, r] = lm.star;
        kind = {
          equipment,
          lm,
          sweep: sw,
          starGlow: glow(x, y, r, gold),
          starSpark: this.sparkleGlyph(root, {
            display: "none",
            style: "mix-blend-mode:screen",
            "data-fx": "star-glint",
          }),
        };
        break;
      }
      case "lance": {
        const lm = items.lance;
        this.buildFlutter(root, lm);
        kind = { equipment, lm, sweep: sweep(lm.blade, "blade"), tipSpark: sparkle() };
        break;
      }
      case "astrolabe":
        kind = {
          equipment,
          lm: items.astrolabe,
          trav: this.traveller(root, 5),
          pointerSpark: sparkle(),
        };
        break;
      case "grimoire":
        kind = {
          equipment,
          lm: items.grimoire,
          coverStars: items.grimoire.stars.map(() => sparkle()),
        };
        break;
      case "armillary":
        kind = {
          equipment,
          lm: items.armillary,
          travs: items.armillary.rings.map(() => this.traveller(root, 4)),
        };
        break;
      case "none": {
        // Warm light falling on the cupped fingers and thumb (dodge lifts skin, not cloth).
        const fingers = this.el(
          "ellipse",
          {
            cx: 0,
            cy: 0,
            rx: 96,
            ry: 62,
            fill: `url(#${this.id("dodge")})`,
            style: "mix-blend-mode:color-dodge",
          },
          root,
        );
        // Normal blending: a screen glow would vanish over the cream robe behind the palm.
        const wisp = this.el("g", {}, root);
        kind = {
          equipment,
          lm: items.none,
          fingers,
          wisp,
          wispHalo: this.el("circle", { r: 84, fill: tint }, wisp),
          wispGlow: this.el("circle", { r: 44, fill: `url(#${this.id("wisp")})` }, wisp),
          wispCore: this.el("circle", { r: 7, fill: core }, wisp),
          wispSparks: [0, 1, 2].map(() =>
            this.el("circle", { r: 2, fill: `url(#${this.id("ember")})` }, wisp),
          ),
        };
        break;
      }
    }
    const nodSpark = this.sparkleGlyph(root, {
      display: "none",
      style: "mix-blend-mode:screen",
      "data-fx": "nod-glint",
    });
    // Ponder accent: a light gathered and held at the item at the gesture's peak (an orb, so
    // it never reads as the helmet star brightening or as the nod glint).
    const [lx, ly] = base.ponder ?? this.lightAt(base);
    const gather = this.el(
      "g",
      { display: "none", "data-fx": "gather", transform: `translate(${lx} ${ly})` },
      root,
    );
    this.el("circle", { r: 165, fill: tint }, gather);
    this.el("circle", { r: 62, fill: `url(#${this.id("orb")})` }, gather);
    this.el("circle", { r: 15, fill: core }, gather);
    // Greet accent: a small fan of welcome sparkles arcing over the raised item (static shape;
    // only its opacity follows the gesture). Normal blending, so it reads over cloth too.
    const [ax, ay] = base.thought;
    const greet = this.el(
      "g",
      { display: "none", "data-fx": "greet-arc", transform: `translate(${ax} ${ay + 30})` },
      root,
    );
    [16, 22, 28, 22, 16].forEach((size, i) => {
      const angle = ((-160 + 35 * i) * Math.PI) / 180;
      const s = this.bedded(
        this.sparkleGlyph(greet, {
          transform: `translate(${r2(100 * Math.cos(angle))} ${r2(100 * Math.sin(angle))}) scale(${r2(size * 1.3)} ${size})`,
        }),
      );
      s.firstElementChild?.setAttribute("r", "0.55");
      s.firstElementChild?.setAttribute("opacity", "0.6");
    });
    // Wave marks: motion arcs on the item's outer side as it is waved hello (the listen arcs
    // sit at the ear, so the two never share a place). A child of greet for its opacity.
    const [wx, wy] = base.wave ?? [
      (base.glint ?? base.focal)[0] + 40,
      (base.glint ?? base.focal)[1],
    ];
    const waves = this.el(
      "g",
      {
        "data-fx": "greet-wave",
        fill: "none",
        "stroke-linecap": "round",
        transform: `translate(${wx - ax} ${wy - ay - 30})`,
      },
      greet,
    );
    for (const [i, r] of [80, 120, 160].entries()) {
      const x = 34 * i;
      const d = `M${x} ${-r * 0.45}Q${x + r * 0.42} 0 ${x} ${r * 0.45}`;
      this.el("path", { d, stroke: BED, "stroke-width": 22, opacity: 0.9 }, waves);
      this.el("path", { d, stroke: PALE, "stroke-width": 10 }, waves);
    }
    // Flourish accent: one continuous light trail sweeping over the item hand with a bright
    // head (greet is separated sparkles above the item; this is a single stroke at the hand).
    const trailFade = this.el(
      "linearGradient",
      { id: this.id("trail"), gradientUnits: "userSpaceOnUse" },
      root,
    );
    for (const [o, a] of [
      [0, 0],
      [0.6, 0.85],
      [1, 1],
    ] as const) {
      this.el("stop", { offset: o, "stop-color": PALE, "stop-opacity": a }, trailFade);
    }
    const trail = this.el(
      "g",
      { display: "none", "data-fx": "flourish-trail", fill: "none", "stroke-linecap": "round" },
      root,
    );
    const flourish = {
      g: trail,
      lines: [
        this.el("path", { stroke: BED, "stroke-width": 30, opacity: 0.6 }, trail),
        this.el("path", { stroke: `url(#${this.id("trail")})`, "stroke-width": 13 }, trail),
      ],
      fade: trailFade,
      head: this.sparkleGlyph(trail, {}),
      burst: this.buildBurst(root, base.burst ?? base.glint ?? base.focal),
    };
    // Thinking: a held cool thought-light at the item, steady so a single still reads as
    // thinking. Normal blending throughout: a screen glow would vanish over the cream robe.
    const tg = this.el(
      "g",
      { display: "none", "data-fx": "thought", transform: `translate(${ax} ${ay})` },
      root,
    );
    const thought = {
      g: tg,
      glow: this.el("ellipse", { rx: 190, ry: 170, fill: `url(#${this.id("cool")})` }, tg),
      orb: this.el("circle", { r: 50, fill: `url(#${this.id("coolorb")})` }, tg),
      core: this.el("circle", { r: 11, fill: "#f5f9ff" }, tg),
    };
    // Thinking: occasional sparkles drifting up toward the head.
    const rise = [0, 1, 2].map(() => sparkle());
    // Thinking motes ride with the item.
    const motes: SVGGElement[] = [];
    const mg = this.el("g", {}, root);
    for (let i = 0; i < 12; i++) {
      const m = this.el("g", { display: "none" }, mg);
      // Sized to read at a 330 px thumbnail: a soft lit body around a small hot core.
      this.el("circle", { r: 24, fill: `url(#${this.id("coolorb")})`, opacity: 0.9 }, m);
      this.el("circle", { r: 6, fill: "#f5f9ff" }, m);
      motes.push(m);
    }
    this.item = { ...kind, core: lights, nodSpark, gather, greet, flourish, thought, rise, motes };
    if (this.config?.debug) this.drawDebug(root, kind.lm);
  }

  // progress < 0: no flourish. The head sweeps a wide arc from under the hand up its open (left)
  // side and over the item with a 200 deg tail; the radius keeps it below the face.
  // The shape depends on progress alone, so any still of the gesture is reproducible.
  private drawFlourish(item: ItemFx, progress: number) {
    const fl = item.flourish;
    const level = progress < 0 ? 0 : peakOf((progress - 0.05) / 0.9);
    this.show(fl.g, level > 0.01);
    this.show(fl.burst, level > 0.01);
    if (level <= 0.01) return;
    const [hx, hy] = item.lm.hands;
    const R = 270;
    const head = 130 + 200 * smooth((progress - 0.1) / 0.75);
    const point = (deg: number): Vec2 => {
      const a = (deg * Math.PI) / 180;
      return [r2(hx + R * Math.cos(a)), r2(hy + R * Math.sin(a))];
    };
    const [x0, y0] = point(head - 200);
    const [x1, y1] = point(head);
    for (const line of fl.lines) this.set(line, "d", `M${x0} ${y0}A${R} ${R} 0 1 1 ${x1} ${y1}`);
    this.set(fl.fade, "x1", x0);
    this.set(fl.fade, "y1", y0);
    this.set(fl.fade, "x2", x1);
    this.set(fl.fade, "y2", y1);
    this.set(fl.head, "transform", `translate(${x1} ${y1}) scale(${r2(56 * 1.3)} 56)`);
    this.set(fl.g, "opacity", r3(level * this.amb));
    this.set(fl.burst, "opacity", r3(level * this.amb));
  }

  // Flourish peak at the item tip: v5's burst made static and larger, a central star with eight
  // pale-over-amber rays (greet's sparkles sit apart, above the item, with no rays).
  private buildBurst(root: SVGGElement, [bx, by]: Vec2) {
    const g = this.el(
      "g",
      { display: "none", "data-fx": "flourish-burst", transform: `translate(${bx} ${by})` },
      root,
    );
    this.el("circle", { r: 74, fill: `url(#${this.id("tint")})` }, g);
    const rays = this.el("g", { fill: "none", "stroke-linecap": "round" }, g);
    for (let i = 0; i < 8; i++) {
      const a = ((22.5 + 45 * i) * Math.PI) / 180;
      const outer = i % 2 ? 74 : 106;
      const d = `M${r2(32 * Math.cos(a))} ${r2(32 * Math.sin(a))}L${r2(outer * Math.cos(a))} ${r2(outer * Math.sin(a))}`;
      this.el("path", { d, stroke: BED, "stroke-width": 15, opacity: 0.6 }, rays);
      this.el("path", { d, stroke: PALE, "stroke-width": 6 }, rays);
    }
    this.sparkleGlyph(g, { transform: "scale(56 46)" });
    return g;
  }

  // Where the item holds its light: the lit core, else the hand-side anchor, else the focal.
  private lightAt(base: ItemLandmarkBase): Vec2 {
    if (base.core) return [base.core[0], base.core[1]];
    return base.rise ?? base.focal;
  }

  // Light running along a ring: it lifts the metal under it (dodge) and carries a small core.
  private traveller(root: SVGGElement, size: number): Traveller {
    const dodge = this.el(
      "circle",
      {
        r: size * 6,
        fill: `url(#${this.id("dodge")})`,
        style: "mix-blend-mode:color-dodge",
        display: "none",
      },
      root,
    );
    const g = this.el("g", { display: "none", style: "mix-blend-mode:screen" }, root);
    const tail = [3, 2, 1].map((i) =>
      this.el(
        "circle",
        { r: size * (0.45 + 0.2 * i), fill: `url(#${this.id("ember")})`, opacity: 0.2 * i },
        g,
      ),
    );
    const glow = this.el("circle", { r: size * 3.2, fill: `url(#${this.id("gold")})` }, g);
    // The pinpoint is painted normally so it still reads over bright gold.
    const head = this.el(
      "circle",
      { r: size * 1.1, fill: `url(#${this.id("core")})`, display: "none" },
      root,
    );
    return { g, dodge, tail, glow, head };
  }

  // The rig may pre-tint grips to a different URL, so the placement (unique per cropped grip)
  // also identifies the lance once the rig has swapped to it.
  private gripShowsLance(grip: SVGImageElement) {
    const lance = this.ctx.art.grips.lance;
    const href = grip.getAttribute("href") ?? "";
    if (href.endsWith(lance.src)) return true;
    const near = (attr: string, v: number) => Math.abs(Number(grip.getAttribute(attr)) - v) < 0.5;
    return (
      near("x", lance.x) && near("y", lance.y) && near("width", lance.w) && near("height", lance.h)
    );
  }

  private buildFlutter(root: SVGGElement, lm: LanceLandmarks) {
    const grip = this.ctx.images.grip;
    if (!grip.getAttribute("href")) return;
    // Only copy the grip once it actually shows the lance (configure runs again on the swap).
    if (!this.gripShowsLance(grip)) return;
    const [px, py] = lm.pole;
    const rel = lm.pennant.map(([x, y]) => [x - px, y - py] as const);
    const xs = rel.map((p) => p[0]);
    const ys = rel.map((p) => p[1]);
    const box = {
      x: Math.min(...xs) - 8,
      y: Math.min(...ys) - 8,
      w: Math.max(...xs) - Math.min(...xs) + 16,
      h: Math.max(...ys) - Math.min(...ys) + 16,
    };
    const f = this.el(
      "filter",
      {
        id: this.id("flutter"),
        filterUnits: "userSpaceOnUse",
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        "color-interpolation-filters": "sRGB",
      },
      root,
    );
    const turb = this.el(
      "feTurbulence",
      {
        type: "fractalNoise",
        baseFrequency: "0.016 0.007",
        numOctaves: 1,
        seed: 7,
        result: "noise",
      },
      f,
    );
    this.el(
      "feColorMatrix",
      {
        in: "noise",
        type: "matrix",
        values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1",
        result: "map",
      },
      f,
    );
    const disp = this.el(
      "feDisplacementMap",
      {
        in: "SourceGraphic",
        in2: "map",
        scale: 0,
        xChannelSelector: "R",
        yChannelSelector: "G",
        result: "moved",
      },
      f,
    );
    // Mirror of the rig's cloth tint so the displaced copy matches a filter-tinted pennant.
    this.el(
      "feColorMatrix",
      {
        in: "moved",
        type: "matrix",
        values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -8 0 8 0 0",
        result: "navy",
      },
      f,
    );
    this.el("feComposite", { in: "navy", in2: "moved", operator: "in", result: "navyMask" }, f);
    const flood = this.el(
      "feFlood",
      { "flood-color": "#687d9a", "flood-opacity": 0, result: "tint" },
      f,
    );
    this.el("feComposite", { in: "tint", in2: "navyMask", operator: "in", result: "clothTint" }, f);
    this.el("feBlend", { in: "moved", in2: "clothTint", mode: "screen" }, f);
    const clip = this.el(
      "clipPath",
      { id: this.id("pennant"), clipPathUnits: "userSpaceOnUse" },
      root,
    );
    this.el("path", { d: polyPath(rel) }, clip);
    // Displacement weight: the free lobe moves, the pole and the hem against the cloak stay put.
    const [cx, cy] = lm.flutterCenter;
    const [rx, ry] = lm.flutterRadius;
    const mg = this.el(
      "radialGradient",
      {
        id: this.id("pennantW"),
        gradientUnits: "userSpaceOnUse",
        cx: cx - px,
        cy: cy - py,
        r: rx,
        gradientTransform: `translate(${cx - px} ${cy - py}) rotate(${lm.flutterTilt}) scale(1 ${r3(ry / rx)}) translate(${px - cx} ${py - cy})`,
      },
      root,
    );
    for (const [o, c] of [
      [0, "#fff"],
      [0.4, "#fff"],
      [1, "#000"],
    ] as const)
      this.el("stop", { offset: o, "stop-color": c }, mg);
    const mask = this.el(
      "mask",
      {
        id: this.id("pennantM"),
        maskUnits: "userSpaceOnUse",
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
      },
      root,
    );
    this.el(
      "rect",
      { x: box.x, y: box.y, width: box.w, height: box.h, fill: `url(#${this.id("pennantW")})` },
      mask,
    );
    const outer = this.el("g", { transform: `translate(${px} ${py})`, display: "none" }, root);
    const masked = this.el(
      "g",
      { "clip-path": `url(#${this.id("pennant")})`, mask: `url(#${this.id("pennantM")})` },
      outer,
    );
    const filtered = this.el("g", { filter: `url(#${this.id("flutter")})` }, masked);
    this.imageCopy(grip, filtered, `translate(${-px} ${-py})`);
    // Folds: soft-light stripes (grey = no change) drifting from the pole toward the tip.
    const [dx, dy] = lm.rippleDir;
    const rg = this.el(
      "linearGradient",
      {
        id: this.id("ripple"),
        gradientUnits: "userSpaceOnUse",
        x1: 0,
        y1: 0,
        x2: r2(dx * 78),
        y2: r2(dy * 78),
        spreadMethod: "repeat",
      },
      root,
    );
    for (const [o, c] of [
      [0, "#808080"],
      [0.22, "#b4b0a8"],
      [0.42, "#808080"],
      [0.7, "#4a4a50"],
      [1, "#808080"],
    ] as const) {
      this.el("stop", { offset: o, "stop-color": c }, rg);
    }
    const rclip = this.el(
      "clipPath",
      { id: this.id("rippleC"), clipPathUnits: "userSpaceOnUse" },
      root,
    );
    this.el("path", { d: smoothPath(lm.ripple, true) }, rclip);
    const ripple = this.el(
      "g",
      {
        "clip-path": `url(#${this.id("rippleC")})`,
        style: "mix-blend-mode:soft-light",
        display: "none",
      },
      root,
    );
    const xs2 = lm.ripple.map((p) => p[0]);
    const ys2 = lm.ripple.map((p) => p[1]);
    this.el(
      "rect",
      {
        x: Math.min(...xs2) - 4,
        y: Math.min(...ys2) - 4,
        width: Math.max(...xs2) - Math.min(...xs2) + 8,
        height: Math.max(...ys2) - Math.min(...ys2) + 8,
        fill: `url(#${this.id("ripple")})`,
      },
      ripple,
    );
    this.flutter = { outer, turb, disp, flood, ripple, rg, dir: lm.rippleDir, pole: lm.pole };
  }

  private drawDebug(root: SVGGElement, lm: DebugLandmarks) {
    const g = this.el(
      "g",
      { fill: "none", stroke: "#62e5d4", "stroke-width": 1, opacity: 0.8 },
      root,
    );
    const dot = ([x, y]: Vec2, r = 4) => this.el("circle", { cx: x, cy: y, r }, g);
    dot(lm.focal, 6);
    if (lm.core) dot([lm.core[0], lm.core[1]], lm.core[2]);
    for (const poly of [lm.poly, lm.blade, lm.pennant])
      if (poly) this.el("path", { d: polyPath(poly) }, g);
    if (lm.ring) this.el("circle", { cx: lm.ring.c[0], cy: lm.ring.c[1], r: lm.ring.r }, g);
    for (const e of lm.rings ?? []) {
      this.el(
        "ellipse",
        {
          cx: e.c[0],
          cy: e.c[1],
          rx: e.a,
          ry: e.b,
          transform: `rotate(${e.rot} ${e.c[0]} ${e.c[1]})`,
        },
        g,
      );
    }
    for (const p of [lm.tip, lm.pointer, lm.palm, lm.wisp, lm.pole]) if (p) dot(p, 3);
    for (const s of lm.stars ?? []) dot([s[0], s[1]], s[2]);
  }

  private drawDebugHead() {
    const b = this.blink;
    if (!b) return;
    const g = this.el("g", { fill: "none", "stroke-width": 0.5, opacity: 0.9 }, this.root.head);
    this.el("path", { d: smoothPath(b.T), stroke: "#ff5" }, g);
    this.el("path", { d: smoothPath(b.O), stroke: "#5ff" }, g);
    this.el("path", { d: smoothPath(b.C), stroke: "#f5f" }, g);
  }

  private sd(base: number) {
    return base + 7919 * this.seed;
  }

  private resetDynamic() {
    const config = this.config;
    if (!config) return;
    this.clearBursts();
    this.cache = new WeakMap();
    this.blinkExtra = [];
    this.blinkPlan = null;
    this.phase = { astro: null, arm: null };
    this.flutterStamp = -1;
    this.tint = [...this.tintTarget];
    this.tintKey = null;
    this.paintTint();
    for (const n of [this.root.front, this.root.wipe]) n.removeAttribute("opacity");
    this.buildTorso();
    this.buildBlink(config.appearance);
    if (config.debug) this.drawDebugHead();
    this.buildItem(config.equipment);
  }

  configure(c: FxConfig) {
    const first = this.config === null;
    this.config = c;
    const headKey = `${c.appearance}|${this.ctx.images.head.getAttribute("href")}|${c.debug}`;
    if (headKey !== this.headKey) {
      this.headKey = headKey;
      this.buildBlink(c.appearance);
      if (c.debug) this.drawDebugHead();
    }
    const itemKey = `${c.equipment}|${this.ctx.images.grip.getAttribute("href")}|${c.debug}`;
    if (itemKey !== this.itemKey) {
      this.itemKey = itemKey;
      this.buildItem(c.equipment);
    }
    this.tintTarget = TINT[c.palette];
    if (first) this.tint = [...this.tintTarget];
    this.paintTint();
    this.syncCrest(c.crest === "on");
  }

  private paintTint() {
    const [t0 = 0, t1 = 0, t2 = 0] = this.tint;
    const t: Rgb = [t0, t1, t2];
    const key = t.map(Math.round).join(",");
    if (key === this.tintKey) return;
    this.tintKey = key;
    // Secondary glows lean toward the palette; their inner stop keeps some gold.
    const mid: Rgb = [lerp(255, t0, 0.6), lerp(214, t1, 0.6), lerp(150, t2, 0.6)];
    this.set(at(this.tintStops, 0), "stop-color", rgb(mid));
    this.set(at(this.tintStops, 1), "stop-color", rgb(t));
    this.set(at(this.tintStops, 2), "stop-color", rgb(t));
    // The halo and aura stay warm on every palette (a cool palette read as a blue-white halo):
    // they lean only a quarter of the way from brass toward the palette, so brass is unchanged.
    const [b0, b1, b2] = TINT.brass;
    const warm: Rgb = [
      lerp(b0, t0, HALO_PALETTE_LEAN),
      lerp(b1, t1, HALO_PALETTE_LEAN),
      lerp(b2, t2, HALO_PALETTE_LEAN),
    ];
    const halo: Rgb = [
      lerp(255, warm[0], 0.75),
      lerp(220, warm[1], 0.75),
      lerp(160, warm[2], 0.75),
    ];
    this.set(at(this.haloStops, 0), "stop-color", rgb(halo));
    for (const i of [1, 2, 3]) this.set(at(this.haloStops, i), "stop-color", rgb(warm));
  }

  trigger(event: FxTrigger) {
    const now = companionClock().now() / 1000;
    const eq = event.name === "equip" ? event.detail.equipment : (this.config?.equipment ?? "none");
    const lm: ItemLandmarkBase = this.L.items[eq];
    switch (event.name) {
      case "blink":
        this.requestBlink(this.lastTime);
        return;
      case "equip": {
        const detail = event.detail;
        // Rapid changes never stack: earlier ghosts go, an earlier exchange hands its current
        // glow level to the new one (no dip, never brighter than one exchange).
        let carry = 0;
        for (const b of this.bursts) {
          if (b.kind === "ghost") {
            b.done = true;
            b.g.remove();
          }
          if (b.kind === "exchange" && !b.done) {
            carry = Math.max(carry, b.level);
            b.done = true;
            b.g.remove();
          }
        }
        // The outgoing item's light fades with its grip instead of cutting.
        this.ghostItem(now, 0.11);
        // Runtime cuts old -> new grip at swapAt (crossfading over `fade`): a warm bloom over
        // the hands and forearms covers the exchange, then sparkles drift from the hands up to
        // the new item's focal point.
        const swapAt = Number.isFinite(detail.swapAt) ? detail.swapAt : 0.09;
        const cross = Number.isFinite(detail.fade) ? Math.max(0, detail.fade) : 0;
        const prev = this.L.items[detail.previous].hands;
        const next = lm.hands;
        this.addExchange(
          now,
          swapAt,
          cross,
          [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2],
          Math.hypot(prev[0] - next[0], prev[1] - next[1]) / 2,
          next,
          lm.arrive ?? lm.focal,
          carry,
        );
        return;
      }
      case "flourish":
        // The flourish reads through its gesture-driven trail around the hand (updateItem);
        // v5's burst at the item focal looked like ponder's orb or greet's sparkles.
        return;
      case "appearance": {
        const detail = event.detail;
        const a = detail.appearance;
        const swapAt = Number.isFinite(detail.swapAt) ? detail.swapAt : 0.14;
        const dur = Number.isFinite(detail.swapDuration) ? detail.swapDuration : 0.12;
        // One appearance effect at a time: pending (not yet started) bands and sparkles from
        // an earlier change are dropped; a visible band reverses (handled in addWipe).
        let shown = false;
        for (const b of this.bursts) {
          if (b.kind === "appearance") {
            b.done = true;
            b.g.remove();
          }
          if (b.kind === "wipe" && !b.done) {
            if (b.lastX === undefined) {
              b.done = true;
              b.g.remove();
            } else shown = true;
          }
        }
        // A reversal before the first band was visible barely moves the edge (off the face).
        if (swapAt > 0 || shown) {
          this.addWipe(now + swapAt, dur, detail.previous, a, {
            swapAt,
            total: Number.isFinite(detail.duration) ? detail.duration : 0.5,
          });
        }
        const outline = HEAD_OUTLINE[a];
        this.addBurst(
          "appearance",
          this.worldHead(outline.c),
          now + swapAt + dur * 0.5,
          0.6,
          6,
          outline,
        );
        return;
      }
      case "entrance":
        this.addBurst("entrance", [575, 720], now, 1.4, 8);
        // One blink as the entrance settles (rig time).
        this.requestBlink(this.lastTime + (event.detail.duration || 0.7) + 0.12);
        return;
    }
  }

  // Item-space point to stage space using the last pose (front layer is unparented).
  private world([x, y]: Vec2): Vec2 {
    const p = this.lastPose;
    const rot = (deg: number, [cx, cy]: Vec2, [px, py]: Vec2): Vec2 => {
      const r = (deg * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      return [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c];
    };
    return rot(p?.body ?? 0, [550, 1300], rot(p?.arm ?? 0, [400, 990], [x, y]));
  }

  private worldHead(pt: Vec2): Vec2 {
    const r = ((this.lastPose?.body ?? 0) * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [
      550 + (pt[0] - 550) * c - (pt[1] - 1300) * s,
      1300 + (pt[0] - 550) * s + (pt[1] - 1300) * c,
    ];
  }

  private armTransform() {
    const p = this.lastPose;
    return `rotate(${r3(p?.body ?? 0)} 550 1300) rotate(${r3(p?.arm ?? 0)} 400 990)`;
  }

  // Fade a copy of the current item's lights out in front (used when the item swaps).
  private ghostItem(now: number, duration: number) {
    const it = this.item;
    if (!it) return;
    const nodes: Element[] = [];
    if (it.core) nodes.push(it.core.bloom, it.core.light, it.core.hot);
    if (it.equipment === "none") nodes.push(it.fingers, it.wisp);
    if (!nodes.length) return;
    const g = this.el("g", { transform: this.armTransform() }, this.root.front);
    for (const n of nodes) g.appendChild(n.cloneNode(true));
    this.bursts.push({ kind: "ghost", g, start: now, duration, done: false });
  }

  // Soft gold band riding the runtime's appearance wipe edge (head-local; same geometry as
  // the rig's mask: edge x 860 -> 320 with smoothstep, tilted ~16 deg), masked to both heads.
  private addWipe(
    start: number,
    duration: number,
    from: RigAppearance,
    to: RigAppearance,
    sync: WipeSync,
  ) {
    const head = this.ctx.images.head;
    const art = this.ctx.art;
    const href = head.getAttribute("href") ?? "";
    // The trigger arrives before the rig swaps the href, so match either head's src.
    if (![from, to].some((a) => href.endsWith(art.heads[a].src))) return;
    this.wipeN += 1;
    const id = this.id(`wipe${this.wipeN}`);
    const g = this.el("g", { display: "none" }, this.root.wipe);
    const mask = this.el(
      "mask",
      {
        id,
        maskUnits: "userSpaceOnUse",
        x: 0,
        y: 0,
        width: 1122,
        height: 1402,
        style: "mask-type:alpha",
      },
      g,
    );
    for (const a of new Set([from, to])) {
      const h = art.heads[a];
      this.el(
        "image",
        {
          href: h.src,
          x: h.x,
          y: h.y,
          width: h.w,
          height: h.h,
          preserveAspectRatio: "xMidYMid meet",
        },
        mask,
      );
    }
    const body = this.el("g", { mask: `url(#${id})` }, g);
    const clip = head.getAttribute("clip-path");
    if (clip) body.setAttribute("clip-path", clip);
    const band = this.el(
      "rect",
      {
        x: -55,
        y: -320,
        width: 110,
        height: 760,
        fill: `url(#${this.id("wipeband")})`,
        style: "mix-blend-mode:screen",
      },
      body,
    );
    // Matches the rig's edge: 860 -> 260 normally; a mid-wipe reversal (swapAt 0) continues
    // from the running edge toward the opposite side (960 / 260), on wall time.
    const running = this.bursts.find(
      (o): o is WipeBurst => o.kind === "wipe" && !o.done && o.lastX !== undefined,
    );
    let x0 = 860;
    let x1 = 260;
    let wipeSync: WipeSync | null = sync;
    if (running?.lastX !== undefined && sync.swapAt === 0) {
      x0 = running.lastX;
      x1 = running.x1 === 260 ? 960 : 260;
      wipeSync = null;
      running.done = true;
      running.g.remove();
    }
    this.bursts.push({
      kind: "wipe",
      g,
      band,
      start,
      duration,
      sync: wipeSync,
      x0,
      x1,
      lastX: undefined,
      synced: false,
      done: false,
    });
  }

  private addExchange(
    now: number,
    swapAt: number,
    cross: number,
    center: Vec2,
    spread: number,
    hand: Vec2,
    focal: Vec2,
    carry: number,
  ) {
    // Lives in arm space (rotated like the forearm at trigger time).
    const g = this.el("g", { display: "none", transform: this.armTransform() }, this.root.front);
    const R = 215 + spread * 0.6;
    const soft = this.el(
      "ellipse",
      {
        cx: center[0],
        cy: center[1] + 10,
        rx: R,
        ry: R * 0.8,
        fill: `url(#${this.id("xsoft")})`,
        style: "mix-blend-mode:screen",
      },
      g,
    );
    const core = this.el(
      "ellipse",
      {
        cx: center[0],
        cy: center[1],
        rx: R * 0.82,
        ry: R * 0.62,
        fill: `url(#${this.id("xcore")})`,
      },
      g,
    );
    const parts: ExchangePart[] = [];
    this.burstSeed += 1;
    const seed = this.burstSeed * 17;
    for (let i = 0; i < 7; i++) {
      const h = (k: number) => hash(seed, i * 5 + k);
      const node = this.el("g", {}, g);
      this.el(
        "circle",
        { r: 1.3, fill: `url(#${this.id("gold")})`, opacity: 0.8, style: "mix-blend-mode:screen" },
        node,
      );
      this.el("path", { d: SPARK, fill: `url(#${this.id("spark")})` }, node);
      parts.push({
        node,
        from: [hand[0] + lerp(-55, 55, h(0)), hand[1] + lerp(-30, 30, h(1))],
        to: [focal[0] + lerp(-40, 40, h(2)), focal[1] + lerp(-40, 40, h(3))],
        lift: lerp(40, 110, h(4)),
        delay: i * 0.04 + h(4) * 0.03,
        size: lerp(14, 24, h(0) * 0.5 + h(3) * 0.5),
        spin: lerp(-30, 30, h(1)),
      });
    }
    this.bursts.push({
      kind: "exchange",
      g,
      soft,
      core,
      parts,
      start: now,
      swapAt,
      cross,
      carry,
      level: carry,
      duration: swapAt + cross + 0.95,
      done: false,
    });
  }

  // Envelope: eases in over the 70 ms before the cut, holds through the crossfade, releases.
  private drawExchange(b: ExchangeBurst, tau: number) {
    if (tau >= b.duration) {
      b.done = true;
      return;
    }
    this.show(b.g, true);
    // Full over the runtime's crossfade (centred on swapAt) and at least two frames past
    // the cut, so the exchange registers as light, not a pop. A carried-over level from an
    // interrupted exchange is the floor of the ramp-in.
    const t1 = b.swapAt - b.cross / 2;
    const t0 = t1 - 0.07;
    const t2 = b.swapAt + Math.max(b.cross / 2, 0.035);
    const ramp = tau < t0 ? 0 : tau < t1 ? 1 - Math.pow(1 - (tau - t0) / 0.07, 2) : 1;
    const e = tau < t2 ? Math.max(ramp, b.carry) : 1 - smooth((tau - t2) / 0.3);
    b.level = e;
    this.set(b.core, "opacity", r3(0.86 * e));
    this.set(b.soft, "opacity", r3(0.75 * (tau < t2 ? e : 1 - smooth((tau - t2) / 0.4))));
    for (const q of b.parts) {
      const u = (tau - t2 - 0.03 - q.delay) / 0.62;
      if (u <= 0 || u >= 1) {
        this.set(q.node, "opacity", 0);
        continue;
      }
      const m = 1 - Math.pow(1 - u, 2.2);
      const x = lerp(q.from[0], q.to[0], m);
      const y = lerp(q.from[1], q.to[1], m) - q.lift * Math.sin(Math.PI * m) * 0.5;
      const life = smooth(u / 0.12) * (1 - smooth((u - 0.7) / 0.3));
      this.set(
        q.node,
        "transform",
        `translate(${r2(x)} ${r2(y)}) rotate(${r2(q.spin * u)}) scale(${r3(q.size * (0.6 + 0.4 * Math.sin(Math.PI * u)))})`,
      );
      this.set(q.node, "opacity", r3(life));
    }
  }

  private addBurst(
    kind: SprayKind,
    origin: Vec2,
    start: number,
    duration: number,
    count: number,
    outline?: HeadOutline,
  ) {
    const g = this.el("g", { display: "none" }, this.root.front);
    this.burstSeed += 1;
    const seed = this.burstSeed * 13 + kind.length;
    const flash = this.el(
      "circle",
      {
        cx: origin[0],
        cy: origin[1],
        r: 1,
        fill: `url(#${this.id("gold")})`,
        style: "mix-blend-mode:screen",
      },
      g,
    );
    const parts: SprayPart[] = [];
    for (let i = 0; i < count; i++) {
      const h = (k: number) => hash(seed, i * 7 + k);
      let ang: number;
      let dist: number;
      let size: number;
      let x0 = origin[0];
      let y0 = origin[1];
      if (kind === "entrance") {
        x0 += lerp(-260, 260, h(0));
        y0 += lerp(-80, 420, h(1));
        ang = -Math.PI / 2 + lerp(-0.4, 0.4, h(2));
        dist = lerp(40, 110, h(3));
        size = lerp(9, 16, h(4));
      } else {
        // On the head outline (upper arc), drifting at most ~12u outward.
        const o = outline ?? HEAD_OUTLINE.female;
        const th = lerp(-Math.PI * 1.05, Math.PI * 0.05, (i + h(2)) / count);
        x0 += Math.cos(th) * o.rx;
        y0 += Math.sin(th) * o.ry;
        ang = th;
        dist = lerp(6, 12, h(3));
        size = lerp(7, 11, h(4));
      }
      const node = this.el("g", {}, g);
      if (i % 3 === 2) this.el("circle", { r: 0.42, fill: `url(#${this.id("ember")})` }, node);
      else if (i % 3 === 1) {
        this.el("circle", { r: 0.9, fill: `url(#${this.id("gold")})`, opacity: 0.7 }, node);
        this.el("path", { d: SPARK, fill: `url(#${this.id("spark")})` }, node);
      } else this.el("path", { d: SPARK, fill: `url(#${this.id("spark")})` }, node);
      const lift = kind === "appearance" ? 4 : 18;
      parts.push({
        node,
        x0,
        y0,
        dx: Math.cos(ang) * dist,
        dy: Math.sin(ang) * dist * 0.85 - lift,
        size,
        delay: h(5) * 0.12,
        spin: lerp(-40, 40, h(6)),
      });
    }
    this.bursts.push({ kind, g, flash, parts, start, duration, done: false });
  }

  private drawBursts(now: number) {
    for (const b of this.bursts) {
      const tau = now - b.start;
      if (b.kind === "wipe") {
        this.drawWipe(b, tau);
        continue;
      }
      if (b.kind === "exchange") {
        this.drawExchange(b, tau);
        continue;
      }
      if (tau < 0) {
        this.show(b.g, false);
        continue;
      }
      this.show(b.g, true);
      const u = clamp01(tau / b.duration);
      if (b.kind === "ghost") {
        this.set(b.g, "opacity", r3(1 - smooth(u)));
        if (u >= 1) b.done = true;
        continue;
      }
      const fr = b.kind === "entrance" ? 220 : 110;
      const fa = b.kind === "entrance" ? 0.3 : 0.18;
      const fu = clamp01(tau / (b.duration * 0.55));
      this.set(b.flash, "r", r2(fr * (0.35 + 0.65 * (1 - Math.pow(1 - fu, 3)))));
      this.set(b.flash, "opacity", r3(fa * Math.pow(1 - fu, 1.6) * smooth(tau / 0.06)));
      for (const p of b.parts) {
        const s = clamp01((tau - p.delay) / (b.duration - p.delay));
        const travel = 1 - Math.pow(1 - s, 3.2);
        const x = p.x0 + p.dx * travel;
        const y = p.y0 + p.dy * travel - 14 * s;
        const life = smooth(s / 0.06) * Math.pow(1 - s, 0.85);
        const tw = 0.75 + 0.25 * Math.sin((tau + p.delay) * 22 + p.spin);
        const sc = p.size * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, s * 1.6))) * tw;
        this.set(
          p.node,
          "transform",
          `translate(${r2(x)} ${r2(y)}) rotate(${r2(p.spin * s)}) scale(${r3(Math.max(0.01, sc))})`,
        );
        this.set(p.node, "opacity", r3(life));
      }
      if (u >= 1) b.done = true;
    }
    if (this.bursts.some((b) => b.done)) {
      for (const b of this.bursts) if (b.done) b.g.remove();
      this.bursts = this.bursts.filter((b) => !b.done);
    }
  }

  // Follows the rig's transition clock when present (exactly on the mask edge), else wall time.
  private drawWipe(b: WipeBurst, tau: number) {
    const pa = this.trAppear;
    let rt: number;
    if (pa !== undefined && b.sync) {
      rt = pa * b.sync.total - b.sync.swapAt;
      b.synced = true;
    } else if (b.synced) {
      b.done = true;
      this.show(b.g, false);
      return;
    } else rt = tau;
    const u = rt / b.duration;
    if (u >= 1) b.done = true;
    const on = u > 0 && u < 1;
    this.show(b.g, on);
    if (!on) return;
    // Same easing as the rig's mask edge (sine).
    const x = lerp(b.x0, b.x1, 0.5 - 0.5 * Math.cos(Math.PI * u));
    b.lastX = x;
    this.set(b.band, "transform", `translate(${r2(x)} 10) rotate(16)`);
    this.set(b.g, "opacity", r3(smooth(u / 0.15) * (1 - smooth((u - 0.8) / 0.2))));
  }

  private clearBursts() {
    for (const b of this.bursts) b.g.remove();
    this.bursts = [];
  }

  update(f: FxFrame) {
    const t = Number.isFinite(f.time) ? f.time : 0;
    const live = f.live;
    // Entering a hold or rest frame rebuilds the dynamic layers, so a held frame is written
    // entirely from (time, seed, frame) and never carries attributes from earlier live frames.
    const mode = live ? "live" : f.hold ? "hold" : "rest";
    if (mode !== "live" && mode !== this.mode) this.resetDynamic();
    this.mode = mode;
    const dt = live && f.dt > 0 ? f.dt : 0;
    // Ambient amount: 1 while live or scrubbing (setPose hold renders time t), fading to 0
    // over the runtime's settle-to-still (frame.settle 0..1), 0 on rest frames.
    const settle = live && Number.isFinite(f.settle) ? clamp01(f.settle) : 0;
    const amb = live ? 1 - settle : f.hold ? 1 : 0;
    this.amb = amb;
    const animated = amb > 0.001;
    const mix = f.stateMix;
    const att = mix.attentive;
    const think = mix.thinking;
    const energy = clamp01(Number.isFinite(f.energy) ? f.energy : 0.3);
    const breath = Number.isFinite(f.breath) ? f.breath : 0;
    this.lastPose = f.pose;
    // Per-instance seed: rigs on one page never blink or twinkle in lockstep.
    const seed = Number.isFinite(f.seed) ? f.seed | 0 : 0;
    if (seed !== this.seed) {
      this.seed = seed;
      this.blinkPlan = null;
      this.seedShift = seed ? hash(seed, 5) * 41 : 0;
    }
    this.lastTime = t;
    // Palette tint eases over ~0.4 s while live (a dt=0 live frame holds it), snaps otherwise.
    const k = live ? 1 - Math.exp(-dt * 9) : 1;
    const target = this.tintTarget;
    if (this.tint.some((v, i) => Math.abs(v - (target[i] ?? v)) > 0.5)) {
      this.tint = this.tint.map((v, i) => lerp(v, target[i] ?? v, k));
      this.paintTint();
    }
    const tr = f.transition ?? {};
    this.trAppear = tr.appearance;

    const g = live ? f.gesture : null;
    const listen = g?.name === "listen" ? Math.sin(Math.PI * clamp01(g.progress)) : 0;
    // Idle: almost none. Attentive: chest aura plus a steady head-and-shoulders halo.
    // Thinking: a low aura only (its cue is the cool thought-light and motes at the item, never
    // a light behind the head, which reads as attentive). The aura's breath fades out as attentive
    // rises and holds at its mean, so a full attentive frame has no time-varying term.
    const auraLevel = 0.02 + 0.16 * att + 0.05 * think + 0.03 * listen;
    const auraBreathIn = lerp(breath * amb, ATTENTIVE_MEAN_BREATH, att);
    const auraBreath = 1 + 0.1 * auraBreathIn * (0.4 + att);
    let entranceGlow = 0;
    if (tr.entrance !== undefined) entranceGlow = 0.12 * Math.sin(Math.PI * clamp01(tr.entrance));
    this.set(this.aura, "opacity", r3(clamp(auraLevel * auraBreath + entranceGlow, 0, 0.22)));
    this.set(this.headHalo, "opacity", r3(clamp(0.92 * att, 0, 0.92)));
    this.set(
      this.aura,
      "transform",
      `translate(545 760) scale(${r3(1 + 0.02 * auraBreathIn)}) translate(-545 -760)`,
    );

    if (this.blink) {
      const hidden = tr.appearance !== undefined || tr.hood !== undefined;
      // Nod: the eyes close at the dip and stay shut ~0.2 s (progress 0.35-0.55 of the 1.05 s
      // nod), so the peak still reads as a nod even with the small head dip.
      const nodClosed =
        g?.name === "nod"
          ? smooth((g.progress - 0.29) / 0.06) * (1 - smooth((g.progress - 0.55) / 0.08))
          : 0;
      const p = animated && !hidden ? Math.max(this.blinkAt(t, live), nodClosed) * amb : 0;
      // Held lid per state: runtime frame.lid, else idle 0.1 / thinking 0.35 / attentive 0.
      const lidIn = Number.isFinite(f.lid) ? f.lid : 0.1 * mix.idle + 0.35 * think;
      this.drawBlink(p, hidden ? 0 : clamp(lidIn, 0, 0.6) * LID_SCALE);
      // Gaze: runtime's frame.eye (-1..1), else the head gaze channel.
      const eye = Number.isFinite(f.eye.x)
        ? f.eye
        : { x: Number.isFinite(f.pose.gaze) ? f.pose.gaze : 0, y: 0 };
      const glance = g?.name === "glance" && !hidden ? peakOf(g.progress) * (1 - p) : 0;
      this.drawGaze(
        hidden ? 0 : eye.x,
        hidden || !Number.isFinite(eye.y) ? 0 : eye.y,
        hidden ? 0 : Math.max(att, glance) * (1 - p),
        glance,
      );
      const listen = g?.name === "listen" && !hidden ? peakOf(g.progress) : 0;
      const nodAt = g?.name === "nod" && !hidden ? peakOf((g.progress - 0.15) / 0.65) : 0;
      const ponder = g?.name === "ponder" && !hidden ? peakOf((g.progress - 0.1) / 0.8) : 0;
      this.drawHeadMotifs(listen, nodAt, ponder);
    }

    this.updateTorso(t, animated);
    // Continuous item motion (shimmer, wisp, flutter, travellers) is phase-shifted per seed.
    this.updateItem(t + this.seedShift, f, animated, energy, think, att, live);

    if (live) {
      this.drawBursts(companionClock().now() / 1000);
      this.set(this.root.front, "opacity", r3(amb));
      this.set(this.root.wipe, "opacity", r3(amb));
    } else if (this.bursts.length) this.clearBursts();
  }

  private updateTorso(t: number, animated: boolean) {
    // Cloak stars: one at a time, staggered slots, low duty cycle.
    const SLOT = 2.6;
    const LIFE = 1.25;
    const active = new Map<number, number>();
    const count = this.stars.length;
    if (animated) {
      const n = Math.floor(t / SLOT);
      for (let s = n - 1; s <= n; s++) {
        if (s < 0 || hash(this.sd(91), s) > 0.72) continue;
        const start = s * SLOT + hash(this.sd(92), s) * (SLOT - 0.6);
        const u = (t - start) / LIFE;
        if (u <= 0 || u >= 1) continue;
        let idx = Math.floor(hash(this.sd(93), s) * count);
        if (s > 0 && idx === Math.floor(hash(this.sd(93), s - 1) * count)) idx = (idx + 3) % count;
        const cov = this.L.cloak.covered[idx];
        if (cov && this.config && cov.includes(this.config.equipment)) idx = (idx + 5) % count;
        if (this.crest && this.underCrest(idx)) idx = (idx + 5) % count;
        active.set(idx, Math.max(active.get(idx) ?? 0, twinkle(u)));
      }
    }
    this.stars.forEach((s, i) => {
      const a = active.get(i) ?? 0;
      this.show(s.g, a > 0.002);
      if (a <= 0.002) return;
      const sz = s.r * (0.75 + 0.55 * a);
      this.set(s.g, "transform", `translate(${s.x} ${s.y})`);
      this.set(s.glow, "r", r2(s.r * 2.1));
      this.set(s.glow, "opacity", r3(0.55 * a * this.amb));
      this.set(s.spark, "transform", `rotate(${r2(8 * a)}) scale(${r3(sz)})`);
      this.set(s.spark, "opacity", r3(0.9 * a * this.amb));
    });
    // Brooch: a slow sheen across the boss, then a pinpoint on its rim.
    const [bx, by, br] = this.L.cloak.brooch;
    let bp = -1;
    if (animated) {
      const cyc = 12.5;
      const n = Math.floor((t - 4) / cyc);
      if (n >= 0) bp = (t - (4 + n * cyc + hash(this.sd(95), n) * 3)) / 1.1;
    }
    const brooch = this.brooch;
    const broochBand = this.broochBand;
    const broochSpark = this.broochSpark;
    if (!brooch || !broochBand || !broochSpark) return;
    const sweepOn = bp > 0 && bp < 1;
    this.show(brooch, sweepOn);
    if (sweepOn) {
      const x = lerp(bx - br - 16, bx + br + 16, smooth(bp));
      this.set(
        broochBand,
        "transform",
        `translate(${r2(x)} ${r2(lerp(by - br * 0.6, by + br * 0.6, smooth(bp)))}) rotate(30)`,
      );
      this.set(brooch, "opacity", r3(Math.sin(Math.PI * bp) * this.amb));
    }
    const sp = (bp - 0.45) / 0.55;
    const spOn = sp > 0 && sp < 1;
    this.show(broochSpark, spOn);
    if (spOn) {
      const a = twinkle(sp);
      this.set(
        broochSpark,
        "transform",
        `translate(${bx + br * 0.62} ${by - br * 0.62}) scale(${r3(9 * (0.5 + 0.5 * a))})`,
      );
      this.set(broochSpark, "opacity", r3(0.85 * a * this.amb));
    }
  }

  private updateItem(
    t: number,
    f: FxFrame,
    animated: boolean,
    energy: number,
    think: number,
    att: number,
    live: boolean,
  ) {
    const item = this.item;
    if (!item) return;
    const base: ItemLandmarkBase = item.lm;
    // Item light level: energy-driven, a slow living shimmer, a measured pulse when thinking.
    // Variation stays within about +-15%.
    const A = this.amb;
    const shimmer =
      1 + A * (0.05 * Math.sin((t * TAU) / 5.3) + 0.03 * Math.sin((t * TAU) / 2.3 + 1.1));
    const pulseWave = 0.5 - 0.5 * A * Math.cos((t * TAU) / 2.6);
    // Thinking: a slow, clearly rhythmic pulse (+-22%). Attentive: brighter, steady.
    const pulse = lerp(1, 0.78 + 0.44 * pulseWave, think) * (1 + 0.3 * att);
    // Gesture cues: listen dims the light ~30%; ponder dips, then pulses the core twice.
    const gesture = live ? f.gesture : null;
    const gname = gesture?.name ?? null;
    const gp = gesture ? clamp01(gesture.progress) : 0;
    const env = Math.sin(Math.PI * gp);
    let cue = 0;
    if (gname === "listen") cue = -0.3 * smooth(gp / 0.15) * (1 - smooth((gp - 0.85) / 0.15));
    else if (gname === "ponder") {
      cue =
        gp < 0.3
          ? -0.25 * Math.sin((Math.PI * gp) / 0.3)
          : 0.3 * Math.pow(Math.sin((Math.PI * 2 * (gp - 0.3)) / 0.7), 2) * env;
    }
    const level = clamp01((0.45 + 0.55 * energy) * shimmer * pulse * (1 + cue));
    // Nod: a warm acknowledgement glint on the item as the head comes down, sized to read at
    // panel size (v5.s 16u glint was under two pixels there).
    const nod = gname === "nod" ? twinkle(clamp01((gp - 0.3) / 0.55)) : 0;
    const [nx, ny] = base.glint ?? base.focal;
    this.drawSpark(item.nodSpark, nx, ny, 44 * (0.4 + 0.6 * nod), 0.95 * nod, 20 * nod);
    const peak = gname ? peakOf(gp) : 0;
    const gathered = gname === "ponder" ? peakOf((gp - 0.1) / 0.8) : 0;
    const [lx, ly] = base.ponder ?? this.lightAt(base);
    this.show(item.gather, gathered > 0.01);
    if (gathered > 0.01) {
      this.set(
        item.gather,
        "transform",
        `translate(${lx} ${ly}) scale(${r3(1.4 - 0.4 * gathered)})`,
      );
      this.set(item.gather, "opacity", r3(0.95 * gathered * A));
    }
    this.drawFlourish(item, gname === "flourish" ? gp : -1);
    const greeted = gname === "greet" ? peak : 0;
    this.show(item.greet, greeted > 0.01);
    if (greeted > 0.01) this.set(item.greet, "opacity", r3(greeted * A));
    // A state display like the attentive halo: no time term, held on rest frames too.
    this.show(item.thought.g, think > 0.01);
    if (think > 0.01) {
      this.set(item.thought.glow, "opacity", r3(0.75 * think));
      this.set(item.thought.orb, "opacity", r3(0.9 * think));
      this.set(item.thought.core, "opacity", r3(think));
    }
    if (item.core && base.core) {
      const { bloom, light, hot } = item.core;
      const r = base.core[2];
      // Peak opacities stay <= 0.5; radii are 30% tighter than the first pass.
      const gain = base.coreGain ?? 1;
      this.set(light, "opacity", r3(Math.min(0.7, 0.48 * level * gain)));
      this.set(light, "r", r2(r * (1.0 + 0.15 * level)));
      this.set(hot, "opacity", r3(Math.min(0.6, (0.08 + 0.24 * level) * gain)));
      this.set(bloom, "opacity", r3(Math.min(0.45, (0.08 + 0.2 * level) * gain)));
      this.set(bloom, "r", r2(r * (1.9 + 0.35 * level + 0.15 * think * pulseWave)));
    }
    const speed = 1 + 1.3 * think;
    switch (item.equipment) {
      case "helmet": {
        const lm = item.lm;
        // Specular sweep every ~7-10 s; the star twinkles on its own rhythm.
        this.drawSweep(
          item.sweep,
          lm.sweep,
          this.sweepPhase(t, animated, 7.2, 2.8, 1.25, 31),
          0.95,
        );
        const [sx, sy, sr] = lm.star;
        // Greet, listen, and ponder also glint the star at their peak.
        const cueTw = gname === "greet" || gname === "listen" || gname === "ponder" ? peak : 0;
        const tw = Math.max(animated ? this.pulseAt(t, 4.6, 1.8, 1.4, 41) * A : 0, cueTw);
        const thinkGlow = 0.3 * think * (pulseWave - 0.5);
        this.set(
          item.starGlow,
          "opacity",
          r3(clamp01(0.12 + 0.25 * energy + 0.5 * tw + thinkGlow)),
        );
        this.set(item.starGlow, "r", r2(sr * (0.9 + 0.3 * tw)));
        this.drawSpark(item.starSpark, sx, sy, sr * 0.62 * (0.4 + 0.6 * tw), tw * 0.9, 12 * tw);
        break;
      }
      case "lance": {
        const lm = item.lm;
        const g = this.sweepPhase(t, animated, 6.4, 2.4, 0.9, 33);
        this.drawSweep(item.sweep, lm.sweep, g, 1);
        const tipA = g > 0 && g < 1 ? twinkle(clamp01((g - 0.05) / 0.8)) : 0;
        this.drawSpark(
          item.tipSpark,
          lm.tip[0],
          lm.tip[1] + 4,
          26 * (0.35 + 0.65 * tipA),
          0.95 * tipA,
          15 * tipA,
        );
        this.drawFlutter(t, animated, live, att, think);
        break;
      }
      case "astrolabe": {
        const lm = item.lm;
        this.phase.astro = this.advance(this.phase.astro, t, (TAU / 13) * speed, live, f.dt);
        const a = this.phase.astro;
        const ring = lm.ring;
        this.drawTraveller(
          item.trav,
          (q) => [ring.c[0] + ring.r * Math.cos(q), ring.c[1] + ring.r * Math.sin(q)],
          a,
          1,
          (0.55 + 0.45 * level) * this.ringVisible(a, ring.hidden),
          animated,
          speed,
        );
        const tw = animated ? this.pulseAt(t, 5.2, 2.2, 1.3, 45) : 0;
        this.drawSpark(
          item.pointerSpark,
          lm.pointer[0],
          lm.pointer[1],
          20 * (0.4 + 0.6 * tw),
          0.85 * tw,
          10 * tw,
        );
        break;
      }
      case "grimoire":
        item.lm.stars.forEach(([x, y, r], i) => {
          const tw = animated ? this.pulseAt(t + i * 1.7, 5.4, 2.6, 1.2, 50 + i) : 0;
          this.drawSpark(at(item.coverStars, i), x, y, r * (0.6 + 0.6 * tw), 0.75 * tw, 10 * tw);
        });
        break;
      case "armillary": {
        const phase = this.advance(this.phase.arm, t, (TAU / 9) * speed, live, f.dt);
        this.phase.arm = phase;
        item.lm.rings.forEach((e, i) => {
          const a = phase * e.speed + e.phase;
          const r = (e.rot * Math.PI) / 180;
          const cr = Math.cos(r);
          const sr = Math.sin(r);
          const ringAt = (q: number): Vec2 => {
            const lx = e.a * Math.cos(q);
            const ly = e.b * Math.sin(q);
            return [e.c[0] + lx * cr - ly * sr, e.c[1] + lx * sr + ly * cr];
          };
          // Front half bright, back half (behind the core) dim.
          const depth = 0.5 + 0.5 * Math.sin(a);
          this.drawTraveller(
            at(item.travs, i),
            ringAt,
            a,
            Math.sign(e.speed),
            (0.4 + 0.6 * depth) * (0.55 + 0.45 * level),
            animated,
            speed,
          );
        });
        break;
      }
      case "none": {
        const [wx, wy] = item.lm.wisp;
        const bob = A * (7 * Math.sin((t * TAU) / 3.3) + 2.5 * Math.sin((t * TAU) / 1.9 + 0.7));
        const sway = A * 4 * Math.sin((t * TAU) / 4.9 + 0.4);
        const flick = 1 - A * (0.1 - 0.1 * Math.sin(t * 13.1) * Math.sin(t * 7.3 + 1));
        const lv = level * flick;
        this.set(item.wisp, "transform", `translate(${r2(wx + sway)} ${r2(wy + bob)})`);
        this.set(item.wispHalo, "opacity", r3(0.45 + 0.4 * lv));
        this.set(item.wispGlow, "opacity", r3(clamp01(0.75 + 0.3 * lv)));
        this.set(item.wispGlow, "r", r2(40 + 10 * lv));
        this.set(item.wispCore, "opacity", r3(0.75 + 0.25 * lv));
        item.wispSparks.forEach((s, i) => {
          // Rising embers; their rest pose is a fixed spread, blended in as ambient fades.
          const ua = frac(t / 2.4 + i / 3);
          const ur = 0.3 + i * 0.2;
          const ember = (u: number) =>
            [
              Math.sin(u * 5 + i * 2) * 6,
              -8 - 34 * u,
              2.2 * (1 - u) + 0.6,
              0.7 * Math.sin(Math.PI * u),
            ] as const;
          const [ax, ay, ar, ao] = ember(ua);
          const [rx, ry, rr, ro] = ember(ur);
          this.set(s, "cx", r2(lerp(rx, ax, A)));
          this.set(s, "cy", r2(lerp(ry, ay, A)));
          this.set(s, "r", r2(lerp(rr, ar, A)));
          this.set(s, "opacity", r3(lerp(ro, ao, A) * lv));
        });
        // Warm light on the fingers, stronger as the wisp dips toward the palm.
        const near = clamp01(0.5 + bob / 14);
        this.set(
          item.fingers,
          "transform",
          `translate(${r2(wx + sway * 0.6)} ${r2(wy + 30 + bob * 0.4)})`,
        );
        this.set(item.fingers, "opacity", r3(clamp01((0.5 + 0.45 * lv) * (0.7 + 0.3 * near))));
        break;
      }
    }
    this.drawMotes(item, t, think);
    this.drawRise(item, t, animated, think);
  }

  // Live phases integrate (speed changes never jump; a dt=0 live frame holds the phase);
  // hold and rest frames are pure in t.
  private advance(phase: number | null, t: number, w: number, live: boolean, dt: number) {
    if (!live || phase === null) return t * w;
    return phase + w * (dt > 0 ? dt : 0);
  }

  private ringVisible(a: number, hidden: readonly Vec2[]) {
    let deg = ((a * 180) / Math.PI) % 360;
    if (deg < 0) deg += 360;
    let v = 1;
    for (const [lo, hi] of hidden) {
      const d = Math.min(deg - lo, hi - deg);
      if (d > -6) v = Math.min(v, smooth(-d / 6));
    }
    return v;
  }

  // ringAt(angle) -> [x, y] on the path; dir = +1 / -1 travel direction.
  private drawTraveller(
    tr: Traveller,
    ringAt: (angle: number) => Vec2,
    a: number,
    dir: number,
    alpha: number,
    animated: boolean,
    speed: number,
  ) {
    const on = animated && alpha > 0.01;
    this.show(tr.g, on);
    this.show(tr.dodge, on);
    this.show(tr.head, on);
    if (!on) return;
    const [x, y] = ringAt(a);
    const al = alpha * this.amb;
    this.set(tr.g, "opacity", r3(al));
    this.set(tr.dodge, "opacity", r3(al * 0.9));
    this.set(tr.head, "opacity", r3(al));
    for (const c of [tr.dodge, tr.head, tr.glow]) {
      this.set(c, "cx", r2(x));
      this.set(c, "cy", r2(y));
    }
    // Short comet tail along the path, longer when moving faster.
    tr.tail.forEach((c, i) => {
      const [px, py] = ringAt(a - dir * (3 - i) * 0.05 * Math.min(1.8, speed));
      this.set(c, "cx", r2(px));
      this.set(c, "cy", r2(py));
    });
  }

  private drawSpark(
    s: SVGGElement,
    x: number,
    y: number,
    size: number,
    alpha: number,
    rot: number,
  ) {
    const on = alpha > 0.01;
    this.show(s, on);
    if (!on) return;
    const k = Math.max(0.01, size);
    this.set(
      s,
      "transform",
      `translate(${r2(x)} ${r2(y)}) rotate(${r2(rot)}) scale(${r3(k * 1.3)} ${r3(k)})`,
    );
    this.set(s, "opacity", r3(alpha * this.amb));
    const dot = s.firstElementChild;
    if (dot) {
      this.set(dot, "r", 0.55);
      this.set(dot, "opacity", 0.45);
    }
  }

  // Returns sweep progress 0..1 while a sweep is running, else -1.
  private sweepPhase(
    t: number,
    animated: boolean,
    every: number,
    jitter: number,
    dur: number,
    seed: number,
  ) {
    if (!animated) return -1;
    const n = Math.floor((t - 1.5) / every);
    for (const k of [n, n - 1]) {
      if (k < 0) continue;
      const u = (t - (1.5 + k * every + hash(this.sd(seed), k) * jitter)) / dur;
      if (u > 0 && u < 1) return u;
    }
    return -1;
  }

  // Twinkle envelope on a jittered cadence (0..1).
  private pulseAt(t: number, every: number, jitter: number, dur: number, seed: number) {
    const n = Math.floor(t / every);
    let a = 0;
    for (const k of [n, n - 1]) {
      if (k < 0) continue;
      const u = (t - (k * every + hash(this.sd(seed), k) * jitter)) / dur;
      if (u > 0 && u < 1) a = Math.max(a, twinkle(u));
    }
    return a;
  }

  private drawSweep(sw: Sweep, spec: SweepSpec, u: number, peak: number) {
    const on = u > 0 && u < 1;
    this.show(sw.g, on);
    if (!on) return;
    const e = smooth(u);
    const x = lerp(spec.from[0], spec.to[0], e);
    const y = lerp(spec.from[1], spec.to[1], e);
    this.set(
      sw.band,
      "transform",
      `translate(${r2(x)} ${r2(y)}) rotate(${spec.angle}) scale(${spec.width} 1)`,
    );
    this.set(sw.g, "opacity", r3(peak * Math.sin(Math.PI * u) * this.amb));
  }

  private drawFlutter(t: number, animated: boolean, live: boolean, att: number, think: number) {
    const fl = this.flutter;
    if (!fl) return;
    this.show(fl.outer, animated);
    this.show(fl.ripple, animated);
    if (!animated) return;
    // Folds travel continuously (pure in t; the stripe pattern repeats every 78 units).
    const gustR = 0.8 + 0.2 * Math.sin((t * TAU) / 7.7);
    const travel = (t * 34 + 9 * Math.sin((t * TAU) / 4.3)) % 78;
    this.set(
      fl.rg,
      "gradientTransform",
      `translate(${r2(fl.pole[0] + fl.dir[0] * travel)} ${r2(fl.pole[1] + fl.dir[1] * travel)})`,
    );
    this.set(fl.ripple, "opacity", r3(0.85 * gustR * this.amb));
    // Budget: the turbulence is re-evaluated at most ~30 times a second while live.
    const stamp = Math.round(t * 30);
    if (live && stamp === this.flutterStamp && this.amb >= 0.999) return;
    this.flutterStamp = stamp;
    const gust = 0.75 + 0.25 * Math.sin((t * TAU) / 7.7) + 0.15 * att - 0.1 * think;
    const fx = 0.016 * (1 + 0.16 * Math.sin((t * TAU) / 2.9));
    const fy = 0.007 * (1 + 0.14 * Math.sin((t * TAU) / 3.7 + 1.3));
    this.set(fl.turb, "baseFrequency", `${fx.toFixed(5)} ${fy.toFixed(5)}`);
    this.set(fl.disp, "scale", r2(7 * gust * this.amb));
    // Mirror a filter-based rig tint flood; a pre-tinted grip carries its tint in the copy.
    const rigFlood = [...this.ctx.defs.querySelectorAll("filter feFlood")].find(
      (n) => !this.defs.contains(n),
    );
    if (rigFlood) {
      this.set(fl.flood, "flood-color", rigFlood.getAttribute("flood-color") ?? "#687d9a");
      const tinted = this.ctx.images.grip.getAttribute("filter");
      this.set(
        fl.flood,
        "flood-opacity",
        tinted ? (rigFlood.getAttribute("flood-opacity") ?? 0) : 0,
      );
    }
  }

  // Thinking: sparkles drift from the item toward the head and fade before the face
  // (deterministic in t; per-seed phase via t + seedShift).
  private drawRise(item: ItemFx, t: number, animated: boolean, think: number) {
    const base: ItemLandmarkBase = item.lm;
    const head = base.toward ?? [640, 420];
    const [fx2, fy2] = base.rise ?? base.focal;
    item.rise.forEach((sp, i) => {
      const pr = 2.9;
      const v = frac(t / pr + i / 3 + hash(this.sd(300 + i), Math.floor(t / pr + i / 3)) * 0.2);
      const a = animated && think > 0.02 ? think * twinkle(clamp01(v / 0.85)) : 0;
      const sx = lerp(fx2, head[0], 0.55 * v) + 18 * Math.sin(v * 7 + i * 2);
      const sy = lerp(fy2 - 40, head[1], 0.55 * v);
      this.drawSpark(sp, sx, sy, 12 * (0.5 + 0.5 * a), 0.85 * a, 20 * v);
    });
  }

  private drawMotes(item: ItemFx, t: number, think: number) {
    const base: ItemLandmarkBase = item.lm;
    const A = this.amb;
    // Orbit per item [cx, cy, rx, ry]: placed so most of the path crosses cloth or the dark
    // background rather than bright metal, where gold motes would vanish.
    const [fx, fy, RX, RY] = base.motes ?? [base.focal[0], base.focal[1], 160, 90];
    // Every other mote also holds a fixed rest spot, blended in as ambient fades, so the
    // settled thinking frame keeps its cool motes.
    item.motes.forEach((m, i) => {
      const rests = i % 2 === 0;
      const on = think > 0.02 && (A > 0.001 || rests);
      this.show(m, on);
      if (!on) return;
      const h = (k: number) => hash(this.sd(200 + i), k);
      const place = (time: number, u: number) => {
        const ang = h(2) * TAU + ((time * TAU) / lerp(9, 16, h(3))) * (h(4) > 0.5 ? 1 : -1);
        const rad = lerp(0.85, 1.2, h(5));
        const depth = 0.8 + 0.2 * Math.sin(ang);
        return {
          x: fx + Math.cos(ang) * RX * rad,
          y: fy + Math.sin(ang) * RY * rad - 60 * u + 20,
          o: Math.pow(Math.sin(Math.PI * u), 0.4) * depth,
          sc: lerp(0.7, 1.15, h(6)) * (0.75 + 0.25 * depth),
        };
      };
      const live = place(t, frac(t / lerp(5.5, 9, h(0)) + h(1)));
      const rest = rests ? place(0, 0.5) : { ...live, o: 0 };
      const x = lerp(rest.x, live.x, A);
      const y = lerp(rest.y, live.y, A);
      const sc = lerp(rest.sc, live.sc, A);
      this.set(m, "transform", `translate(${r2(x)} ${r2(y)}) scale(${r3(sc)})`);
      this.set(m, "opacity", r3(think * lerp(rest.o, live.o, A)));
    });
  }

  destroy() {
    this.clearBursts();
    for (const node of this.made) node.remove();
    this.made = [];
    this.imgPool.clear();
    this.parking = null;
    this.blink = null;
    this.item = null;
    this.flutter = null;
    this.crest = null;
  }
}

export function createSquireFx(ctx: FxContext): FxController {
  return new SquireFxController(ctx);
}
