/*
 * <squire-emblem>: the Threadkeeper logo as an animated companion, ported from the v5
 * concept (squire-emblem.js). A drop-in swap for <squire-rig>: same attribute vocabulary,
 * methods, debugState and events. Standalone: no dependency on the rig, its art or FX.
 *
 * ATTRIBUTES (invalid values fall back to the first listed)
 *   palette brass|moonstone|sage|rose|gold  state idle|attentive|thinking  motion subtle|lively|still
 *   gaze auto|left|center|right|pointer  transitions on|off  debug false|true  label <text>
 *   seed <integer> (optional; default per instance, reflected) - clock starts at 40*hash(seed) s
 *   frame bare|orbit|seal  weight regular|fine|bold (1.5 / 2.1 / 2.9 at 128)  glow soft|bright|none
 *   surface auto|dark|light (ink for the page behind; auto reads the nearest opaque ancestor
 *   background, so the bare/orbit logo stays legible on cream; the seal is always navy)
 *   placement panel|overlay (which companion holds the single live lease; overlays outrank)
 *
 * API (same semantics as <squire-rig>)
 *   configuration / getConfiguration()  normalized attributes (+ seed).
 *   setPose({ time, gaze, state })      deterministic hold: springs settle, gestures cancel,
 *                                       transitions finish; equal inputs give equal frames.
 *   resume()                            leave the hold. Changing `motion` also leaves it.
 *   play(name)                          nod | greet | flourish | glance | listen | ponder. Promise
 *                                       { name, played, interrupted }; resolves at once (played
 *                                       false) when not animating. Unknown names reject. Wakes a
 *                                       settled emblem first.
 *   debugState                          CompanionDebugStateBase + small, surface, frame, weight,
 *                                       glow, pose { hub, star, gain, ... }.
 *   Events: squire-gesture-end {name, interrupted}, squire-transition-end {kind, completed},
 *   kind palette|frame|weight|glow|entrance (animated transitions only).
 *
 * DRAWING. The 128-unit logo: three cubic threads that meet at the star (82,22) and the lower
 * knot (49,106), a start knot (25,62) and a four-point star. Threads live once in <defs>
 * (pathLength 100) and are drawn by <use> layers: blurred glow, engraved shadow, ghost, body,
 * and light (comet) dashes. Only the three `d` strings and a handful of attributes change per
 * frame; values are cached so unchanged attributes are never rewritten. Below 40 CSS px the
 * element swaps to the 24 px drawing (two threads) and a reduced set: glow breathing and star
 * twinkle (state cues hold still; no floating, waves or comets).
 *
 * MOTION. Threads are deformed by moving bezier control points only. The knots are fixed and
 * static; the star end of the two star threads rides the star hub (at most ~5 units) so the
 * drawing never comes apart. Interior junctions move together with both of their handles
 * (tangent continuity is kept). Channels are pure functions of time t plus springs (state
 * weights, lively, ambient, gaze), as in the rig.
 *   Idle      seeded 3-sine noise per node (2 units subtle, x1.6 lively; star threads share a
 *             correlated component so they never cross), stroke breathing +-4%, glow breath
 *             ~4.4 s, star twinkle and slow rotation. Beats 6-11 s apart: an outward ripple
 *             with a shimmer along one thread, or a star glint.
 *   Attentive star lifts and brightens, threads gather toward the spine, steady warm halo.
 *   Thinking  comet light along each thread in turn, a slow travelling wave, satellites orbit
 *             (frame orbit), motes drift round the star, slower deeper glow.
 *   Still     state pose at rest (halo, lifted star, a held glint for thinking).
 *
 * SCHEDULING (port, plan D43). Frames come from companionClock() and render at most
 * COMPANION_MAX_FPS. Only the lease holder animates (others are `yielded` and keep their last
 * frame). After COMPANION_SETTLE_MS without a state change, gesture, transition or pointer
 * interaction the emblem blends to rest and stops (`settled`) until woken.
 */
import { observeResize } from "~/lib/observeResize";

import { companionClock, onCompanionFocusChange } from "./companionClock";
import { acquireCompanionLease, type CompanionLease } from "./companionLease";
import {
  COMPANION_GESTURES,
  COMPANION_MAX_FPS,
  COMPANION_SETTLE_MS,
  COMPANION_STATES,
  EMBLEM_CHOICES,
  GENUINE_PAUSE_REASONS,
  type CompanionDebugStateBase,
  type CompanionElement,
  type CompanionGesture,
  type CompanionPalette,
  type CompanionPauseReason,
  type CompanionState,
  type EmblemConfiguration,
  type GestureResult,
  type SetPoseInput,
} from "./types";

const TAU = Math.PI * 2;
const STATES = COMPANION_STATES;

// A 4 ms allowance keeps a 60 Hz display (16.7 ms frames) on every second frame.
const FRAME_GATE_MS = 1000 / COMPANION_MAX_FPS - 4;
// v5's blend to rest, seconds. The settle blend runs inside the quiet period so the emblem is
// at rest by COMPANION_SETTLE_MS after the last activity, not 0.55 s later.
const REST_BLEND = 0.55;

type Vec = [number, number];
type RGB = readonly [number, number, number];
type Curve = (s: number) => number;
type Key = readonly [number, number];
type Spring = { x: number; v: number };
type Weight = EmblemConfiguration["weight"];
type Glow = EmblemConfiguration["glow"];
type Gaze = EmblemConfiguration["gaze"];

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const smooth = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const sine = (v: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(v));
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);
const easeOutBack = (v: number, s = 1.6) => {
  const x = clamp01(v) - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const soft = (v: number, lim: number) => lim * Math.tanh(v / lim);
const frac = (v: number) => v - Math.floor(v);

function hash(seed: number, n: number) {
  let x = Math.imul(seed * 374761393 + n * 668265263, 0x85ebca6b) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

// Hermite through [t, v] keys with flat extremes (same as the rig's gesture curves).
function keyed(keys: readonly Key[]): Curve {
  const n = keys.length;
  const at = (i: number) => keys[i]!;
  const m = keys.map((key, i) => {
    if (i === 0 || i === n - 1) return 0;
    const a = key[1] - at(i - 1)[1];
    const b = at(i + 1)[1] - key[1];
    return a * b <= 0 ? 0 : (at(i + 1)[1] - at(i - 1)[1]) / (at(i + 1)[0] - at(i - 1)[0]);
  });
  const first = at(0);
  const last = at(n - 1);
  return (s) => {
    if (s <= first[0]) return first[1];
    if (s >= last[0]) return last[1];
    let i = 0;
    while (s > at(i + 1)[0]) i++;
    const [t0, v0] = at(i);
    const [t1, v1] = at(i + 1);
    const h = t1 - t0;
    const u = (s - t0) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * v0 +
      (u3 - 2 * u2 + u) * h * m[i]! +
      (-2 * u3 + 3 * u2) * v1 +
      (u3 - u2) * h * m[i + 1]!
    );
  };
}

// Exact critically damped spring step; damped spring with ratio zeta (overshoots < 1).
function spring(s: Spring, target: number, omega: number, dt: number) {
  const x0 = s.x - target;
  const v0 = s.v;
  const e = Math.exp(-omega * dt);
  s.x = target + (x0 + (v0 + omega * x0) * dt) * e;
  s.v = (v0 - omega * (v0 + omega * x0) * dt) * e;
}
function springZ(s: Spring, target: number, omega: number, zeta: number, dt: number) {
  const n = Math.max(1, Math.ceil(dt * 240));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (-omega * omega * (s.x - target) - 2 * zeta * omega * s.v) * h;
    s.x += s.v * h;
  }
}
const settle = (s: Spring, x: number) => {
  s.x = x;
  s.v = 0;
};

const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mix = (a: RGB, b: RGB, k: number): RGB => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];
const rgb = (c: RGB) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
const WHITE: RGB = [255, 255, 255];
const NAVY = hex("#0b1a26");
const COOL = hex("#cfe4ff");
const MOTIF_PALE = hex("#fff2cc");
const MOTIF_AMBER = hex("#e89a2e");

const COLOR_KEYS = ["light", "gold", "star", "glow", "comet", "halo"] as const;
type ColorKey = (typeof COLOR_KEYS)[number];
type Inks = Record<ColorKey, RGB>;
type Colors = Inks & { tone: number };
type HexInks = Record<ColorKey, string>;

const toInks = (p: HexInks): Inks => ({
  light: hex(p.light),
  gold: hex(p.gold),
  star: hex(p.star),
  glow: hex(p.glow),
  comet: hex(p.comet),
  halo: hex(p.halo),
});
const toSurface = (s: Record<CompanionPalette, HexInks>): Record<CompanionPalette, Inks> => ({
  brass: toInks(s.brass),
  moonstone: toInks(s.moonstone),
  sage: toInks(s.sage),
  rose: toInks(s.rose),
  gold: toInks(s.gold),
});
// Per surface: thread inks (light = the outer thread, gold = the others), star, glow, comet
// light and halo. Dark is the logo as drawn; light inks keep the two-tone read on cream.
// `gold` is the Lead's palette: richer and more saturated than brass.
const PALETTES = {
  dark: toSurface({
    brass: {
      light: "#e3cca8",
      gold: "#d9a34e",
      star: "#ebb558",
      glow: "#ffb24f",
      comet: "#fff4dc",
      halo: "#f2a948",
    },
    moonstone: {
      light: "#dfe8f0",
      gold: "#a6bdd2",
      star: "#cfe1f1",
      glow: "#a3c6f4",
      comet: "#f5faff",
      halo: "#93bdf0",
    },
    sage: {
      light: "#dde5cf",
      gold: "#a3b686",
      star: "#c7d9a3",
      glow: "#acdcaa",
      comet: "#f6fcee",
      halo: "#9ed39b",
    },
    rose: {
      light: "#f2dcd7",
      gold: "#d0979e",
      star: "#efb6b6",
      glow: "#f6a9bc",
      comet: "#fff3f3",
      halo: "#ef98ae",
    },
    gold: {
      light: "#f3dc9a",
      gold: "#e8b23a",
      star: "#ffd25e",
      glow: "#ffc23f",
      comet: "#fff6d6",
      halo: "#f7bd3c",
    },
  }),
  light: toSurface({
    brass: {
      light: "#6f4f2b",
      gold: "#b27a25",
      star: "#bf8424",
      glow: "#f3a032",
      comet: "#e27800",
      halo: "#efa848",
    },
    moonstone: {
      light: "#34495e",
      gold: "#62809c",
      star: "#55789a",
      glow: "#8fb6e6",
      comet: "#3f86d0",
      halo: "#8db5e8",
    },
    sage: {
      light: "#44523a",
      gold: "#718657",
      star: "#6d8a4c",
      glow: "#a7cf93",
      comet: "#5b9a3a",
      halo: "#a5cf95",
    },
    rose: {
      light: "#683d45",
      gold: "#a9636d",
      star: "#b1606c",
      glow: "#efa3b3",
      comet: "#cf4f6c",
      halo: "#eea1b2",
    },
    gold: {
      light: "#6b4708",
      gold: "#b47c06",
      star: "#c38c00",
      glow: "#ffb515",
      comet: "#e07f00",
      halo: "#ffbb2a",
    },
  }),
};

const STAR_D = "M0 -10C1 -2 2 -1 10 0C2 1 1 2 0 10C-1 2 -2 1 -10 0C-2 -1 -1 -2 0 -10Z";
const FLARE_D = "M-17 0L0 -.55L17 0L0 .55ZM0 -17L.55 0L0 17L-.55 0Z";
const RING_D = "M103.068 29.289A51 54 0 1 1 64 10";
// Arc over the star from 205 to 335 degrees, radius 15 (star units).
const CREST_D = "M-13.59 -6.34A15 15 0 0 1 13.59 -6.34";

type RawThread = { tone: "light" | "gold"; fromStar: boolean; pts: Vec[] };
type RawGeometry = {
  small: boolean;
  star: Vec;
  starScale: number;
  knotR: number;
  sealScale: number;
  stroke: Record<Weight, number>;
  center: Vec;
  knots: Vec[];
  threads: RawThread[];
};
type ThreadNode = {
  kind: "start" | "h" | "j";
  idx: number[];
  p: Vec;
  N: Vec;
  s: number;
  u: number;
  G: Vec;
  follow: number;
  fixed: boolean;
  end: boolean;
};
type Thread = RawThread & { n: number; nodes: ThreadNode[] };
type Geometry = Omit<RawGeometry, "threads"> & { threads: Thread[] };

const LARGE: RawGeometry = {
  small: false,
  star: [82, 22],
  starScale: 1,
  knotR: 2.7,
  sealScale: 0.83,
  stroke: { fine: 1.5, regular: 2.1, bold: 2.9 },
  center: [67, 63],
  knots: [
    [25, 62],
    [49, 106],
  ],
  threads: [
    {
      tone: "light",
      fromStar: true,
      pts: [
        [82, 22],
        [48, 13],
        [25, 29],
        [32, 48],
        [39, 67],
        [95, 62],
        [97, 86],
        [98.5, 104],
        [75, 113],
        [49, 106],
      ],
    },
    {
      tone: "gold",
      fromStar: true,
      pts: [
        [82, 22],
        [55, 17],
        [44, 34],
        [51, 46],
        [61, 61],
        [101, 61],
        [105, 83],
        [110, 103],
        [79, 114],
        [49, 106],
      ],
    },
    {
      tone: "gold",
      fromStar: false,
      pts: [
        [25, 62],
        [24, 80],
        [48, 82],
        [65, 84],
        [87, 87],
        [91, 104],
        [49, 106],
      ],
    },
  ],
};
const S = 16 / 3; // 24 px drawing scaled into the 128-unit space.
const up = (pts: Vec[]): Vec[] => pts.map(([x, y]) => [x * S, y * S]);
const SMALL: RawGeometry = {
  small: true,
  star: [16 * S, 4 * S],
  starScale: (2.5 * S) / 10,
  knotR: S,
  sealScale: 0.76,
  stroke: { fine: 1.05 * S, regular: 1.25 * S, bold: 1.55 * S },
  center: [62.7, 62.7],
  knots: up([
    [4.5, 12],
    [9, 20],
  ]),
  threads: [
    {
      tone: "light",
      fromStar: true,
      pts: up([
        [16, 4],
        [9, 2],
        [5, 6],
        [7, 9],
        [9, 12],
        [19, 11],
        [19, 16],
        [19, 20],
        [14, 22],
        [9, 20],
      ]),
    },
    {
      tone: "gold",
      fromStar: false,
      pts: up([
        [4.5, 12],
        [4.5, 16],
        [11, 15.5],
        [14, 17],
        [17, 19],
        [13, 21],
        [9, 20],
      ]),
    },
  ],
};

// Movable nodes per thread: the start (rides the star hub, or fixed at a knot), the free
// handle after it, each interior junction with both handles, and the free handle before
// the end knot. Each node carries its outward normal, arc position s, height u (1 at the
// star), star-follow weight and gather vector.
function prepare(geo: RawGeometry): Geometry {
  const sy = geo.star[1];
  const ky = geo.knots[1]![1];
  const threads: Thread[] = geo.threads.map((th) => {
    const pts = th.pts;
    const n = (pts.length - 1) / 3;
    const nodes: ThreadNode[] = [];
    const pt = (i: number) => pts[i]!;
    const tangent = (a: number, b: number): Vec => {
      const dx = pt(b)[0] - pt(a)[0];
      const dy = pt(b)[1] - pt(a)[1];
      const l = Math.hypot(dx, dy) || 1;
      return [dx / l, dy / l];
    };
    const push = (kind: ThreadNode["kind"], idx: number[], at: number, tan: Vec) => {
      const p = pt(at);
      let N: Vec = [-tan[1], tan[0]];
      if (N[0] * (p[0] - geo.center[0]) + N[1] * (p[1] - geo.center[1]) < 0) N = [-N[0], -N[1]];
      nodes.push({
        kind,
        idx,
        p,
        N,
        s: at / (3 * n),
        u: clamp01((ky - p[1]) / (ky - sy)),
        G: [0, 0],
        follow: 0,
        fixed: false,
        end: false,
      });
    };
    push("start", [0], 0, tangent(0, 1));
    push("h", [1], 1, tangent(0, 2));
    for (let k = 1; k < n; k++)
      push("j", [3 * k - 1, 3 * k, 3 * k + 1], 3 * k, tangent(3 * k - 1, 3 * k + 1));
    push("h", [3 * n - 1], 3 * n - 1, tangent(3 * n - 2, 3 * n));
    const follow = th.fromStar ? [1, 0.55, 0.16, 0.05, 0] : [];
    nodes.forEach((node, k) => {
      node.follow = follow[k] ?? 0;
      node.fixed = node.kind === "start" && !th.fromStar;
      node.end = k === nodes.length - 1;
    });
    return { ...th, n, nodes };
  });
  if (!geo.small) {
    // The two star threads gather toward their shared spine; the lower loop tightens.
    const a = threads[0]!;
    const b = threads[1]!;
    a.nodes.forEach((na, k) => {
      const nb = b.nodes[k]!;
      const mid = [(na.p[0] + nb.p[0]) / 2, (na.p[1] + nb.p[1]) / 2] as const;
      na.G = [(mid[0] - na.p[0]) * 0.34, (mid[1] - na.p[1]) * 0.34];
      nb.G = [(mid[0] - nb.p[0]) * 0.34, (mid[1] - nb.p[1]) * 0.34];
    });
    for (const node of threads[2]!.nodes) {
      if (!node.fixed) node.G = [(62 - node.p[0]) * 0.15, (70 - node.p[1]) * 0.15];
    }
  } else {
    for (const th of threads) {
      for (const node of th.nodes) {
        node.G = [(geo.center[0] - node.p[0]) * 0.07, (geo.center[1] - node.p[1]) * 0.07];
      }
    }
  }
  for (const th of threads) for (const node of th.nodes) if (node.kind === "start") node.G = [0, 0];
  return { ...geo, threads };
}
const GEOMETRY = { large: prepare(LARGE), small: prepare(SMALL) };
const NOD_DIR: Vec = (() => {
  const d: Vec = [49 - 82, 106 - 22];
  const l = Math.hypot(d[0], d[1]);
  return [d[0] / l, d[1] / l];
})();

// Seeded smooth noise: three incommensurate sines per axis.
type NoiseTerm = { f: number; ph: number; a: number };
type Noise = NoiseTerm[];
const NOISE_PERIODS = [8.3, 5.1, 13.7] as const;
const NOISE_AMPS = [0.52, 0.3, 0.34] as const;
function makeNoise(seed: number, id: number): Noise {
  const out: Noise = [];
  for (let axis = 0; axis < 2; axis++) {
    for (let k = 0; k < 3; k++) {
      out.push({
        f: TAU / (NOISE_PERIODS[k]! * (0.82 + 0.36 * hash(seed * 31 + axis * 7 + k, id))),
        ph: TAU * hash(seed * 17 + axis * 5 + k + 3, id),
        a: NOISE_AMPS[k]!,
      });
    }
  }
  return out;
}
function noiseAt(nz: Noise, axis: number, t: number) {
  let v = 0;
  for (let k = 0; k < 3; k++) {
    const c = nz[axis * 3 + k]!;
    v += c.a * Math.sin(c.f * t + c.ph);
  }
  return v;
}

type PoseDef = {
  lift: number;
  scale: number;
  gain: number;
  gather: number;
  halo: number;
  comet: number;
  wave: number;
  motes: number;
  float: number;
  breathPeriod: number;
  breathDepth: number;
  glow: number;
  autoGaze: number;
  /** Held four-point flare on the star (attentive). */
  flare: number;
  /** Cool inner glow and a held light along a thread (thinking). */
  cool: number;
  /** Steady warm arc over the star (attentive). */
  crest: number;
};
// Held look per state, blended by spring weights (which overshoot slightly). Each state must
// read in a single still frame at panel size: idle calm and dim with relaxed threads,
// attentive lifted and flaring inside the warm halo, thinking smaller with a cool core and a
// held light along a thread.
const POSES: Record<CompanionState, PoseDef> = {
  idle: {
    lift: 0,
    scale: 1,
    gain: 0.92,
    gather: -0.15,
    halo: 0,
    comet: 0,
    wave: 0,
    motes: 0,
    float: 1,
    breathPeriod: 4.4,
    breathDepth: 1,
    glow: 0.8,
    autoGaze: 1,
    flare: 0,
    cool: 0,
    crest: 0,
  },
  attentive: {
    lift: 5.4,
    scale: 1.24,
    gain: 1.95,
    gather: 1.5,
    halo: 1,
    comet: 0,
    wave: 0,
    motes: 0,
    float: 0.45,
    breathPeriod: 3.6,
    breathDepth: 0.3,
    glow: 1.45,
    autoGaze: 0.4,
    flare: 0.6,
    cool: 0,
    crest: 1,
  },
  thinking: {
    lift: -1.2,
    scale: 0.88,
    gain: 1.05,
    gather: 0.25,
    halo: 0,
    comet: 1,
    wave: 1,
    motes: 1,
    float: 0.55,
    breathPeriod: 6.2,
    breathDepth: 1.8,
    glow: 1.0,
    autoGaze: 0,
    flare: 0,
    cool: 1,
    crest: 0,
  },
};

const CHANNELS = [
  "hx",
  "hy",
  "along",
  "rot",
  "spin",
  "scale",
  "gain",
  "fan",
  "lean",
  "warm",
  "undraw",
  "spineA",
  "knot",
  "glint",
  "dim",
  "streak",
  "rays",
  "arcs",
  "chevrons",
  "orb",
] as const;
type Channel = (typeof CHANNELS)[number];
type ChannelValues = Record<Channel, number> & { spine: number; sparkTau?: number };
const MOTION_CHANNELS: ReadonlySet<Channel> = new Set(["hx", "hy", "along", "rot", "fan", "lean"]);
const SIZE_CHANNELS: ReadonlySet<Channel> = new Set([
  "hx",
  "hy",
  "along",
  "rot",
  "fan",
  "lean",
  "scale",
]); // Grow below ~112 px.

type RawGesture = {
  duration: number;
  sparkAt?: number;
  tracks: Partial<Record<Channel | "spine", Key[]>>;
};
type GestureTrack = { channel: Channel; curve: Curve; motion: boolean; size: boolean };
type GestureDef = {
  duration: number;
  sparkAt: number | null;
  tracks: GestureTrack[];
  spine: Curve | null;
};

// Gesture channels: hx, hy (star hub, units), along (toward the lower knot), rot (deg),
// scale, gain (star), fan (threads open; negative gather), lean (upper threads + star,
// x3.2 units), warm (halo), undraw (flourish rewind 0..1), spine/spineA (ponder light),
// knot (end-knot flare), glint (star flare), streak (glance trail), rays (greet), and the
// figure's motifs: arcs (listen), chevrons (nod), orb (ponder). Motion channels scale 1.3x
// when lively.
const RAW_GESTURES: Record<CompanionGesture, RawGesture> = {
  nod: {
    duration: 0.9,
    tracks: {
      // The dip is the peak: the star bows toward the lower knot, shrinks and dims, and the
      // knot answers. No flash, so a nod never reads as ponder's closing flare.
      along: [
        [0, 0],
        [0.14, -1.4],
        [0.4, 6],
        [0.55, 5.4],
        [0.7, -0.8],
        [0.82, 0.2],
        [0.9, 0],
      ],
      rot: [
        [0, 0],
        [0.14, 3],
        [0.4, -15],
        [0.55, -13],
        [0.7, 2],
        [0.9, 0],
      ],
      scale: [
        [0, 0],
        [0.4, -0.22],
        [0.55, -0.2],
        [0.72, 0.04],
        [0.9, 0],
      ],
      gain: [
        [0, 0],
        [0.4, -0.45],
        [0.55, -0.4],
        [0.72, 0.3],
        [0.9, 0],
      ],
      dim: [
        [0, 0],
        [0.38, 0.85],
        [0.6, 0.2],
        [0.9, 0],
      ],
      knot: [
        [0, 0],
        [0.32, 0],
        [0.5, 0.35],
        [0.9, 0],
      ],
      chevrons: [
        [0, 0],
        [0.25, 0],
        [0.4, 1],
        [0.62, 0.95],
        [0.8, 0],
        [0.9, 0],
      ],
    },
  },
  greet: {
    duration: 1.4,
    tracks: {
      // A raised hello: the star rises up-left and grows while the threads fan wide open.
      fan: [
        [0, 0],
        [0.16, -0.25],
        [0.55, 1.5],
        [0.85, 1.35],
        [1.12, -0.15],
        [1.4, 0],
      ],
      rot: [
        [0, 0],
        [0.16, 4],
        [0.6, -20],
        [0.92, -17],
        [1.16, 2.5],
        [1.4, 0],
      ],
      hy: [
        [0, 0],
        [0.16, 0.9],
        [0.6, -2.8],
        [0.92, -2.4],
        [1.16, 0.4],
        [1.4, 0],
      ],
      hx: [
        [0, 0],
        [0.6, -1.8],
        [0.92, -1.5],
        [1.4, 0],
      ],
      scale: [
        [0, 0],
        [0.6, 0.16],
        [0.92, 0.13],
        [1.4, 0],
      ],
      gain: [
        [0, 0],
        [0.6, 0.5],
        [0.92, 0.42],
        [1.4, 0],
      ],
      rays: [
        [0, 0],
        [0.3, 0],
        [0.6, 1],
        [0.92, 0.92],
        [1.2, 0],
        [1.4, 0],
      ],
    },
  },
  flourish: {
    duration: 1.3,
    sparkAt: 0.38,
    tracks: {
      undraw: [
        [0, 0],
        [0.42, 0.88],
        [0.5, 0.88],
        [1.12, 0],
        [1.3, 0],
      ],
      spin: [
        [0, 0],
        [0.3, -8],
        [0.55, 52],
        [1.05, 88],
        [1.3, 90],
      ], // ends a quarter turn: same star
      // The quarter-turn spin is invisible on a symmetric star, so the peak reads through
      // the rewind, a large pop, the flash and a burst of halo warmth. The sparks launch
      // before the pop so they are already spread out at the peak frame.
      scale: [
        [0, 0],
        [0.3, -0.16],
        [0.56, 0.55],
        [0.8, 0.05],
        [1.3, 0],
      ],
      gain: [
        [0, 0],
        [0.3, -0.3],
        [0.56, 1.5],
        [0.95, 0.15],
        [1.3, 0],
      ],
      hy: [
        [0, 0],
        [0.3, 1.5],
        [0.56, -3.4],
        [0.9, -0.4],
        [1.3, 0],
      ],
      glint: [
        [0, 0],
        [0.42, 0],
        [0.56, 1.2],
        [1.0, 0],
      ],
      warm: [
        [0, 0],
        [0.45, 0],
        [0.6, 0.9],
        [1.1, 0],
      ],
    },
  },
  glance: {
    duration: 1.1,
    tracks: {
      // Driven past the hub's soft limit so each look uses nearly the full ~5.6 unit allowance
      // (the limit, not these keys, keeps the star end attached).
      lean: [
        [0, 0],
        [0.08, 0.15],
        [0.28, -2.4],
        [0.48, -2.25],
        [0.7, 2.1],
        [0.86, 1.95],
        [1.1, 0],
      ],
      hx: [
        [0, 0],
        [0.28, -1.4],
        [0.48, -1.25],
        [0.58, 0],
        [0.7, 1.2],
        [0.86, 1.05],
        [1.1, 0],
      ],
      // A landing glint as the star arrives at each look.
      glint: [
        [0, 0],
        [0.22, 0],
        [0.3, 0.9],
        [0.44, 0.45],
        [0.56, 0],
        [0.66, 0],
        [0.72, 0.9],
        [0.86, 0.45],
        [1.0, 0],
      ],
      rot: [
        [0, 0],
        [0.08, 1],
        [0.28, -12],
        [0.48, -11],
        [0.7, 10],
        [0.86, 9],
        [1.1, 0],
      ],
      hy: [
        [0, 0],
        [0.28, -0.9],
        [0.48, -0.8],
        [0.6, 0],
        [0.7, -0.9],
        [0.86, -0.8],
        [1.1, 0],
      ],
      gain: [
        [0, 0],
        [0.28, 0.35],
        [0.48, 0.3],
        [0.6, 0.05],
        [0.7, 0.35],
        [0.86, 0.3],
        [1.1, 0],
      ],
      // The trail holds behind the star through each look, so a still shows the direction.
      streak: [
        [0, 0],
        [0.08, 0],
        [0.22, -1.1],
        [0.28, -1.3],
        [0.48, -1],
        [0.58, 0],
        [0.64, 1.1],
        [0.7, 1.3],
        [0.86, 1],
        [0.98, -0.3],
        [1.1, 0],
      ],
    },
  },
  listen: {
    duration: 1.6,
    tracks: {
      lean: [
        [0, 0],
        [0.15, -0.12],
        [0.5, 0.85],
        [1.1, 0.75],
        [1.4, -0.08],
        [1.6, 0],
      ],
      hy: [
        [0, 0],
        [0.5, -1.3],
        [1.1, -1.1],
        [1.6, 0],
      ],
      rot: [
        [0, 0],
        [0.5, 6],
        [1.1, 5],
        [1.6, 0],
      ],
      warm: [
        [0, 0],
        [0.45, 1],
        [1.15, 0.9],
        [1.6, 0],
      ],
      gain: [
        [0, 0],
        [0.45, 0.2],
        [1.15, 0.18],
        [1.6, 0],
      ],
      arcs: [
        [0, 0],
        [0.3, 0],
        [0.5, 1],
        [1.15, 0.95],
        [1.45, 0],
        [1.6, 0],
      ],
    },
  },
  ponder: {
    duration: 1.8,
    tracks: {
      spine: [
        [0.12, -0.04],
        [1.42, 1.06],
      ],
      spineA: [
        [0, 0],
        [0.22, 1],
        [1.3, 1],
        [1.52, 0],
      ],
      gain: [
        [0, 0],
        [0.25, -0.5],
        [1.25, -0.45],
        [1.52, 0.8],
        [1.8, 0],
      ],
      scale: [
        [0, 0],
        [0.25, -0.07],
        [1.3, -0.06],
        [1.52, 0.14],
        [1.8, 0],
      ],
      hy: [
        [0, 0],
        [0.3, 0.9],
        [1.3, 0.8],
        [1.55, -0.7],
        [1.8, 0],
      ],
      // The figure's held orb sits at the star while the light runs the spine and stays through
      // the landing (a star flare blooming into the halo), so every peak still shows it.
      orb: [
        [0, 0],
        [0.3, 0],
        [0.55, 1],
        [1.5, 1],
        [1.66, 0.55],
        [1.8, 0],
      ],
      glint: [
        [0, 0],
        [1.38, 0],
        [1.54, 1],
        [1.8, 0],
      ],
      warm: [
        [0, 0],
        [1.3, 0],
        [1.52, 0.85],
        [1.8, 0],
      ],
    },
  },
};
function compileGesture(raw: RawGesture): GestureDef {
  const tracks: GestureTrack[] = [];
  for (const channel of CHANNELS) {
    const keys = raw.tracks[channel];
    if (keys)
      tracks.push({
        channel,
        curve: keyed(keys),
        motion: MOTION_CHANNELS.has(channel),
        size: SIZE_CHANNELS.has(channel),
      });
  }
  const spine = raw.tracks.spine;
  return {
    duration: raw.duration,
    sparkAt: raw.sparkAt ?? null,
    tracks,
    spine: spine ? keyed(spine) : null,
  };
}
const GESTURES: Record<CompanionGesture, GestureDef> = {
  nod: compileGesture(RAW_GESTURES.nod),
  greet: compileGesture(RAW_GESTURES.greet),
  flourish: compileGesture(RAW_GESTURES.flourish),
  glance: compileGesture(RAW_GESTURES.glance),
  listen: compileGesture(RAW_GESTURES.listen),
  ponder: compileGesture(RAW_GESTURES.ponder),
};
const LAG = 0.09; // Follow-through delay of the threads behind the star, seconds.
const zeroChannels = (): ChannelValues => ({
  hx: 0,
  hy: 0,
  along: 0,
  rot: 0,
  spin: 0,
  scale: 0,
  gain: 0,
  fan: 0,
  lean: 0,
  warm: 0,
  undraw: 0,
  spineA: 0,
  knot: 0,
  glint: 0,
  dim: 0,
  streak: 0,
  rays: 0,
  arcs: 0,
  chevrons: 0,
  orb: 0,
  spine: 0,
});
const EMPTY: Readonly<ChannelValues> = Object.freeze(zeroChannels());

const isGesture = (name: unknown): name is CompanionGesture =>
  COMPANION_GESTURES.some((gesture) => gesture === name);
const isState = (name: unknown): name is CompanionState => STATES.some((state) => state === name);

// Idle beats in independent 60 s windows (6-11 s apart), any time addressable.
type BeatKind = "ripple" | "glint";
type Beat = { start: number; kind: BeatKind; thread: number; intro: boolean };
type Ripple = { c: number; a: number; k: number };
const BEATS: Record<BeatKind, { duration: number }> = {
  ripple: { duration: 2.6 },
  glint: { duration: 1.1 },
};
const RIPPLE_CENTER = keyed([
  [0, -0.3],
  [2.25, 1.3],
]);
const GLINT = keyed([
  [0, 0],
  [0.22, 1],
  [0.5, 0.55],
  [1.1, 0],
]);
const GLINT_ROT = keyed([
  [0, 0],
  [0.3, 9],
  [1.1, 0],
]);
const windowCache = new Map<string, Beat[]>();
function beatWindow(seed: number, w: number): Beat[] {
  const key = `${seed}:${w}`;
  const cached = windowCache.get(key);
  if (cached) return cached;
  const base = 1013 * seed + w * 31 + 7;
  const list: Beat[] = [];
  let start = w * 60 + 6 * hash(base, 0);
  for (let k = 0; start <= (w + 1) * 60 - 6; k++) {
    list.push({
      start,
      kind: hash(base + 1, k) < 0.68 ? "ripple" : "glint",
      thread: Math.floor(hash(base + 2, k) * 3),
      intro: false,
    });
    start += lerp(6, 11, hash(base, k + 1));
  }
  windowCache.set(key, list);
  if (windowCache.size > 64) {
    const oldest = windowCache.keys().next();
    if (!oldest.done) windowCache.delete(oldest.value);
  }
  return list;
}

const AUTO_GAZE_AMOUNTS = [0.6, -0.55, 0.45, -0.6] as const;
// A small, eased look once every 19 s (the rig's schedule), quiet for 8 s after origin.
function autoGaze(time: number, origin = 0) {
  const since = time - origin;
  if (since >= 0 && since < 8) return 0;
  const cycle = Math.floor(time / 19);
  const phase = time - 19 * cycle;
  const amount = AUTO_GAZE_AMOUNTS[((cycle % 4) + 4) % 4]!;
  let v = 0;
  if (phase >= 8 && phase < 10) v = amount * smooth((phase - 8) / 2);
  else if (phase >= 10 && phase < 11) v = amount;
  else if (phase >= 11 && phase < 13) v = amount * (1 - smooth((phase - 11) / 2));
  return since >= 0 && since < 10 ? v * smooth((since - 8) / 2) : v;
}

// Light dashes along a thread (pathLength 100): head, body, tail.
const LIGHT_LAYERS = [
  { len: 2, op: 1, w: 1.22 },
  { len: 7, op: 0.5, w: 1.1 },
  { len: 20, op: 0.2, w: 1 },
] as const;
const COMET = { period: 5.4, gap: 1.8, run: 2.5 };
const FLOAT_AMP = 2.0;
type TransitionKind = "palette" | "frame" | "weight" | "glow" | "entrance";
const DURATIONS: Record<TransitionKind, number> = {
  palette: 0.4,
  frame: 0.6,
  weight: 0.4,
  glow: 0.4,
  entrance: 0.9,
};
const GLOW_STRENGTH: Record<Glow, number> = { soft: 0.82, bright: 1.6, none: 0 };
const MIN_PX: Record<Weight, number> = { fine: 0.8, regular: 1, bold: 1.3 };

const TICKS_D = (() => {
  let d = "";
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * TAU;
    const r0 = i % 8 === 0 ? 57.9 : 58.5;
    const r1 = 59.5;
    d += `M${r2(64 + r0 * Math.cos(a))} ${r2(64 + r0 * Math.sin(a))}L${r2(64 + r1 * Math.cos(a))} ${r2(64 + r1 * Math.sin(a))}`;
  }
  return d;
})();
const arc = (r: number, a0: number, a1: number) => {
  const p = (a: number) =>
    `${r2(64 + r * Math.cos((a * Math.PI) / 180))} ${r2(64 + r * Math.sin((a * Math.PI) / 180))}`;
  return `M${p(a0)}A${r} ${r} 0 0 1 ${p(a1)}`;
};

const STYLE = `
:host { display: inline-block; width: 128px; aspect-ratio: 1 / 1; vertical-align: middle; position: relative; }
:host([hidden]) { display: none; }
.stage { display: block; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.debug { fill: none; }
.debug path { vector-effect: non-scaling-stroke; }`;

const uses = (n: number, attrs = "") => Array.from({ length: n }, () => `<use ${attrs}/>`).join("");
const TEMPLATE = `
<svg class="stage" part="stage" role="img" viewBox="0 0 128 128" preserveAspectRatio="xMidYMid meet">
  <defs>
    <path data-id="t0" pathLength="100"/><path data-id="t1" pathLength="100"/><path data-id="t2" pathLength="100"/>
    <path data-id="star" d="${STAR_D}"/>
    <linearGradient data-id="light" gradientUnits="userSpaceOnUse" x1="30" y1="10" x2="100" y2="118"><stop offset="0"/><stop offset=".5"/><stop offset="1"/></linearGradient>
    <linearGradient data-id="gold" gradientUnits="userSpaceOnUse" x1="30" y1="10" x2="100" y2="118"><stop offset="0"/><stop offset=".5"/><stop offset="1"/></linearGradient>
    <radialGradient data-id="starFill" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="10"><stop offset="0"/><stop offset=".38"/><stop offset="1"/></radialGradient>
    <radialGradient data-id="starGlow"><stop offset="0" stop-opacity=".7"/><stop offset=".3" stop-opacity=".26"/><stop offset="1" stop-opacity="0"/></radialGradient>
    <radialGradient data-id="halo"><stop offset="0" stop-opacity=".5"/><stop offset=".45" stop-opacity=".17"/><stop offset=".78" stop-opacity=".05"/><stop offset="1" stop-opacity="0"/></radialGradient>
    <radialGradient data-id="cool"><stop offset="0" stop-opacity=".95"/><stop offset=".45" stop-opacity=".38"/><stop offset="1" stop-opacity="0"/></radialGradient>
    <radialGradient data-id="orb"><stop offset="0" stop-color="#fffaf0"/><stop offset=".45" stop-color="#ffe3a0" stop-opacity=".95"/><stop offset=".75" stop-color="#f2b552" stop-opacity=".6"/><stop offset="1" stop-color="#c7802a" stop-opacity="0"/></radialGradient>
    <radialGradient data-id="orbGlow"><stop offset="0" stop-color="#ffe3a0" stop-opacity=".5"/><stop offset="1" stop-color="#ffe3a0" stop-opacity="0"/></radialGradient>
    <radialGradient data-id="disc" cx=".4" cy=".32" r=".78"><stop offset="0" stop-color="#1d3a52"/><stop offset=".55" stop-color="#11273a"/><stop offset="1" stop-color="#081521"/></radialGradient>
    <filter data-id="blur" filterUnits="userSpaceOnUse" x="8" y="0" width="122" height="128" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2.6"/></filter>
  </defs>
  <g data-l="seal">
    <circle cx="64" cy="64" r="61.5" fill="#06101a" opacity=".35" transform="translate(0 1.2)"/>
    <circle data-l="disc" cx="64" cy="64" r="61"/>
    <circle data-l="rimOuter" cx="64" cy="64" r="60.4" fill="none" stroke-width="1.1"/>
    <path data-l="ticks" d="${TICKS_D}" fill="none" stroke-width=".32"/>
    <circle data-l="rimInner" cx="64" cy="64" r="56.9" fill="none" stroke-width=".42"/>
    <path data-l="sheen" d="${arc(60.4, 196, 252)}" fill="none" stroke-width=".9" stroke-linecap="round"/>
    <path data-l="shade" d="${arc(60.4, 20, 150)}" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="1.1"/>
  </g>
  <circle data-l="halo" data-fx="halo" cx="65" cy="60" r="68"/>
  <g data-l="orbit">
    <path data-l="ring" d="${RING_D}" fill="none" stroke-linecap="round"/>
    <circle data-l="sat"/><circle data-l="sat"/><circle data-l="sat"/>
  </g>
  <g data-l="logo">
    <g data-l="glow" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g data-l="glowThreads">${uses(3)}</g>
      <g data-l="glowLights">${uses(3)}</g>
      <circle data-l="glowKnot"/><circle data-l="glowKnot"/>
    </g>
    <g data-l="shadow" fill="none" stroke-linecap="round" stroke-linejoin="round">${uses(3)}</g>
    <g data-l="ghost" fill="none" stroke-linecap="round" stroke-linejoin="round">${uses(3)}</g>
    <g data-l="threads" fill="none" stroke-linecap="round" stroke-linejoin="round">${uses(3)}</g>
    <g data-l="lights" fill="none" stroke-linecap="round">${uses(9)}</g>
    <g data-l="knots"><circle data-fx="knot"/><circle data-fx="knot"/></g>
    <path data-l="streak" d="M0 -1.15C6 -.8 14 -.25 22 0C14 .25 6 .8 0 1.15Z"/>
    <path data-l="crest" data-fx="crest" d="${CREST_D}" fill="none" stroke-linecap="round"/>
    <g data-l="rays" data-fx="rays" fill="none" stroke-linecap="round">${"<path/>".repeat(5)}</g>
    <g data-l="listenArcs" data-fx="listen-arcs" fill="none" stroke-linecap="round"><path d="M11.87 -7.42A14 14 0 0 1 11.87 7.42" data-bed="" stroke-width="3.2" opacity="0.450"/><path d="M11.87 -7.42A14 14 0 0 1 11.87 7.42" data-core="" stroke-width="1.50" opacity="1.00"/><path d="M16.11 -10.07A19 19 0 0 1 16.11 10.07" data-bed="" stroke-width="2.7" opacity="0.351"/><path d="M16.11 -10.07A19 19 0 0 1 16.11 10.07" data-core="" stroke-width="1.25" opacity="0.78"/><path d="M20.35 -12.72A24 24 0 0 1 20.35 12.72" data-bed="" stroke-width="2.2" opacity="0.252"/><path d="M20.35 -12.72A24 24 0 0 1 20.35 12.72" data-core="" stroke-width="1.00" opacity="0.56"/></g>
    <g data-l="nodChevrons" data-fx="nod-chevron" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M-6 13L0 17.3L6 13" data-bed="" stroke-width="2.3" opacity="0.450"/><path d="M-6 13L0 17.3L6 13" data-core="" stroke-width="1.15" opacity="1.0"/><path d="M-6 18.5L0 22.8L6 18.5" data-bed="" stroke-width="2.3" opacity="0.315"/><path d="M-6 18.5L0 22.8L6 18.5" data-core="" stroke-width="1.15" opacity="0.7"/></g>
    <g data-l="star">
      <circle data-l="starGlow" r="17"/>
      <circle data-l="coolGlow" r="15"/>
      <path data-l="flare" d="${FLARE_D}"/>
      <use data-l="starShape"/>
      <circle data-l="core" r="4.5"/>
    </g>
    <g data-l="ponderOrb" data-fx="ponder-orb">
      <circle data-l="orbGlow" r="16"/>
      <circle data-l="orbBall" r="7"/>
      <circle r="1.8" fill="#fffaf0"/>
    </g>
    <g data-l="motes">${"<circle/>".repeat(5)}</g>
    <g data-l="sparks">${"<circle/>".repeat(8)}</g>
  </g>
  <g class="debug" data-l="debug" hidden>
    <path data-l="dbgLines" stroke="#62e5d4" stroke-width="1" opacity=".8"/>
    <path data-l="dbgPoints" fill="#62e5d4" stroke="none"/>
    <path data-l="dbgAnchors" stroke="#ff7a6b" stroke-width="1.5"/>
    <path data-l="dbgHub" stroke="#fff" stroke-width="1"/>
  </g>
</svg>`;

// Attribute writes are cached per element so unchanged values never touch the DOM.
const attributeCache = new WeakMap<Element, Map<string, string>>();
function put(el: Element, name: string, value: string) {
  let cache = attributeCache.get(el);
  if (!cache) {
    cache = new Map();
    attributeCache.set(el, cache);
  }
  if (cache.get(name) === value) return;
  cache.set(name, value);
  el.setAttribute(name, value);
}
const shownCache = new WeakMap<SVGElement, boolean>();
function show(el: SVGElement, on: boolean) {
  if (shownCache.get(el) === on) return;
  shownCache.set(el, on);
  el.style.display = on ? "" : "none";
}

// The nearest opaque background behind the emblem (crossing shadow roots), else the page's
// color-scheme, decides whether the light-surface inks are needed.
function pageIsLight(start: Element) {
  for (let el: Element | null = start; el;) {
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg ? /rgba?\(([^)]+)\)/.exec(bg) : null;
    if (m?.[1]) {
      const [r = 0, g = 0, b = 0, a = 1] = m[1]
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      if (a > 0.5) return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
    }
    const root: Node = el.getRootNode();
    el = el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme || "";
  return !/dark/.test(scheme);
}

const svgChildren = (el: Element): SVGElement[] =>
  [...el.children].filter((child): child is SVGElement => child instanceof SVGElement);

export type EmblemPose = {
  readonly hub: Vec;
  readonly star: {
    readonly x: number;
    readonly y: number;
    readonly scale: number;
    readonly rot: number;
  };
  readonly gain: number;
  readonly glow: number;
  readonly halo: number;
  readonly gather: number;
  readonly ambient: number;
  readonly lights: ReadonlyArray<{ readonly h: number; readonly a: number } | null>;
  readonly anchors: { readonly knots: Vec[]; readonly starEnds: Vec[] };
  readonly nodes: Vec[][];
  readonly d: string[];
};

export type EmblemDebugState = CompanionDebugStateBase & {
  readonly small: boolean;
  readonly surface: "dark" | "light";
  readonly frame: EmblemConfiguration["frame"];
  readonly weight: Weight;
  readonly glow: Glow;
  readonly pose: EmblemPose | null;
};

export type EmblemGestureEndDetail = {
  readonly name: CompanionGesture;
  readonly interrupted: boolean;
};
export type EmblemTransitionEndDetail = {
  readonly kind: TransitionKind;
  readonly completed: boolean;
};

type Snapshot = {
  orbit: number;
  seal: number;
  disc: number;
  stroke: number;
  glow: number;
  colors: Colors | null;
};
type Displayed = Snapshot & { colorKey: string | null; colorsDirty: boolean };
type Transition = { kind: TransitionKind; start: number; duration: number; from: Snapshot | null };
type ActiveGesture = {
  name: CompanionGesture;
  start: number;
  def: GestureDef;
  resolve: (result: GestureResult) => void;
  fading: boolean;
  done: boolean;
  weight: Spring;
  fadeTau: number | null;
  spinFrom: number | null;
  spinTo: number;
};
type Mute = { from: number; to: number; gesture: boolean };
type Scrub = { time: number; gaze: number | undefined; state: CompanionState | undefined };
// `still` is v5's blend when motion turns still; `settle` is the port's blend into `settled`.
type Settling = { kind: "still" | "settle"; start: number; duration: number; ambient: number };
type Light = { h: number; a: number; k: number };

type EmblemNodes = {
  seal: SVGElement;
  disc: SVGElement;
  rimOuter: SVGElement;
  rimInner: SVGElement;
  ticks: SVGElement;
  sheen: SVGElement;
  halo: SVGElement;
  orbit: SVGElement;
  ring: SVGElement;
  sats: SVGElement[];
  logo: SVGElement;
  glow: SVGElement;
  glowThreads: SVGElement[];
  glowLights: SVGElement[];
  glowKnots: SVGElement[];
  shadow: SVGElement;
  shadowThreads: SVGElement[];
  ghost: SVGElement;
  ghostThreads: SVGElement[];
  threads: SVGElement[];
  lights: SVGElement[];
  knots: SVGElement[];
  star: SVGElement;
  starGlow: SVGElement;
  flare: SVGElement;
  starShape: SVGElement;
  streak: SVGElement;
  crest: SVGElement;
  rays: SVGElement;
  rayPaths: SVGElement[];
  listenArcs: SVGElement;
  nodChevrons: SVGElement;
  ponderOrb: SVGElement;
  orbGlow: SVGElement;
  orbBall: SVGElement;
  coolGlow: SVGElement;
  core: SVGElement;
  motesGroup: SVGElement;
  motes: SVGElement[];
  sparksGroup: SVGElement;
  sparks: SVGElement[];
  debug: SVGElement;
  dbgLines: SVGElement;
  dbgPoints: SVGElement;
  dbgAnchors: SVGElement;
  dbgHub: SVGElement;
};
type Gradients = {
  light: SVGElement[];
  gold: SVGElement[];
  star: SVGElement[];
  starGlow: SVGElement[];
  halo: SVGElement[];
  cool: SVGElement[];
};

let nextID = 0;

export class SquireEmblemElement extends HTMLElement implements CompanionElement {
  static get observedAttributes() {
    return [...Object.keys(EMBLEM_CHOICES), "debug", "label", "seed"];
  }

  private readonly _id = ++nextID;
  private _time = 0;
  private _clockSeeded = false;
  private _gaze = 0;
  private _scrub: Scrub | null = null;
  private _raf: number | null = null;
  private _lastFrame: number | null = null;
  private _frameCount = 0;
  private _fps = 0;
  private _inView = typeof IntersectionObserver === "undefined";
  private _seen = false;
  private _shown: { frame: string; weight: string; glow: string; palette: string } | null = null;
  private _entrance: "none" | "pending" | "playing" | "done" = "none";
  private _settling: Settling | null = null;
  private _settled = false;
  private _lastActivity: number | null = null;
  private readonly _transitions = new Map<TransitionKind, Transition>();
  private _gestures: ActiveGesture[] = [];
  private _gOut: Readonly<ChannelValues> = EMPTY;
  private _gLag: Readonly<ChannelValues> = EMPTY;
  private _mutes: Mute[] = [];
  private _pointerMute: Mute | null = null;
  private _lastGestureEnd = -Infinity;
  private _lastStateChange = -Infinity;
  private _stateChangeAt: number | null = null;
  private readonly _springs: Record<
    "gaze" | "pitch" | "lively" | "ambient" | "quiet" | CompanionState,
    Spring
  > = {
    gaze: { x: 0, v: 0 },
    pitch: { x: 0, v: 0 },
    lively: { x: 0, v: 0 },
    ambient: { x: 0, v: 0 },
    quiet: { x: 0, v: 0 },
    idle: { x: 1, v: 0 },
    attentive: { x: 0, v: 0 },
    thinking: { x: 0, v: 0 },
  };
  private _stateTarget: CompanionState | null = null;
  private _lastState: CompanionState | undefined = undefined;
  private _breathPhase = 0;
  private _orbitPhase = 0;
  private _pointer = { gaze: 0, pitch: 0 };
  private _lastPointer: number | null = null;
  private _pointerWatch = false;
  private _small = false;
  private _size = 0;
  private _light = false;
  private _geo: Geometry = GEOMETRY.large;
  private _now: Displayed | null = null; // Displayed tweenable values: frame weights, stroke, glow, colours.
  private _noiseSeed: number | null = null;
  private _noise: Noise[][] = [];
  private _shared: Noise[] = [];
  private _starPh: number[] = [];
  private _pose: EmblemPose | null = null;
  private _config: EmblemConfiguration | null = null;
  private _reflecting = false;
  private _media: MediaQueryList | null = null;
  private _observer: IntersectionObserver | null = null;
  private _stopResize: (() => void) | null = null;
  private _lease: CompanionLease | null = null;
  private _holding = false;
  private _stopFocusWatch: (() => void) | null = null;

  private readonly _svg: SVGSVGElement;
  private readonly _paths: SVGElement[];
  private readonly _grad: Gradients;
  private readonly _blur: Element;
  private readonly _el: EmblemNodes;
  private readonly _ref: (name: string) => string;

  private readonly _onEnvironment = () => this._syncMotion();
  private readonly _onPointerMove = (event: PointerEvent) =>
    this._pointerAt(event.clientX, event.clientY);
  private readonly _onPointerOut = (event: PointerEvent) => {
    if (!event.relatedTarget) this._pointer = { gaze: 0, pitch: 0 };
  };
  private readonly _onBlur = () => {
    this._pointer = { gaze: 0, pitch: 0 };
  };
  private readonly _onHostPointer = () => {
    const reason = this._pausedReason();
    if (reason && GENUINE_PAUSE_REASONS.has(reason)) return;
    this._wake();
  };
  private readonly _onLeaseChange = (holding: boolean) => {
    this._holding = holding;
    // The first callback fires inside acquireCompanionLease, before connectedCallback renders.
    if (this._lease) this._syncMotion();
  };

  private readonly _tick = (now: number): void => {
    this._raf = null;
    if (!this._running()) return;
    const clock = companionClock();
    if (this._lastFrame !== null && now - this._lastFrame < FRAME_GATE_MS) {
      this._raf = clock.requestFrame(this._tick);
      return;
    }
    if (this._lastFrame === null) this._lastFrame = now;
    const dt = Math.min((now - this._lastFrame) / 1000, 0.1);
    this._lastFrame = now;
    if (dt > 0) this._fps = this._fps ? lerp(this._fps, 1 / dt, 0.1) : 1 / dt;
    this._time += dt;
    if (!this._settling && this._settleDue()) this._beginSettle();
    this._step(dt);
    if (!this._running()) return;
    this._applyFrame(true);
    const settling = this._settling;
    if (settling && this._time - settling.start >= settling.duration) {
      if (settling.kind === "settle") this._settled = true;
      this._settling = null;
      this._syncMotion();
      return;
    }
    if (this._raf === null) this._raf = clock.requestFrame(this._tick);
  };

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${STYLE}</style>${TEMPLATE}`;
    const uid = (name: string) => `squire-emblem-${this._id}-${name}`;
    const svg = shadow.querySelector("svg");
    if (!svg) throw new Error("squire-emblem template has no <svg>.");
    this._svg = svg;
    const ids = new Map<string, SVGElement>();
    for (const el of shadow.querySelectorAll<SVGElement>("[data-id]")) {
      const id = el.dataset.id ?? "";
      ids.set(id, el);
      el.id = uid(id);
    }
    const byId = (name: string) => {
      const el = ids.get(name);
      if (!el) throw new Error(`squire-emblem template is missing #${name}.`);
      return el;
    };
    const ref = (name: string) => `url(#${uid(name)})`;
    const href = (name: string) => `#${uid(name)}`;
    this._paths = [byId("t0"), byId("t1"), byId("t2")];
    this._grad = {
      light: svgChildren(byId("light")),
      gold: svgChildren(byId("gold")),
      star: svgChildren(byId("starFill")),
      starGlow: svgChildren(byId("starGlow")),
      cool: svgChildren(byId("cool")),
      halo: svgChildren(byId("halo")),
    };
    const blur = byId("blur").firstElementChild;
    if (!blur) throw new Error("squire-emblem template is missing the glow blur.");
    this._blur = blur;
    const layers = new Map<string, SVGElement[]>();
    for (const el of shadow.querySelectorAll<SVGElement>("[data-l]")) {
      const name = el.dataset.l ?? "";
      const list = layers.get(name);
      if (list) list.push(el);
      else layers.set(name, [el]);
    }
    const all = (name: string) => {
      const list = layers.get(name);
      if (!list) throw new Error(`squire-emblem template is missing layer ${name}.`);
      return list;
    };
    const one = (name: string) => all(name)[0]!;
    const motesGroup = one("motes");
    const sparksGroup = one("sparks");
    this._el = {
      seal: one("seal"),
      disc: one("disc"),
      rimOuter: one("rimOuter"),
      rimInner: one("rimInner"),
      ticks: one("ticks"),
      sheen: one("sheen"),
      halo: one("halo"),
      orbit: one("orbit"),
      ring: one("ring"),
      sats: all("sat"),
      logo: one("logo"),
      glow: one("glow"),
      glowThreads: svgChildren(one("glowThreads")),
      glowLights: svgChildren(one("glowLights")),
      glowKnots: all("glowKnot"),
      shadow: one("shadow"),
      shadowThreads: svgChildren(one("shadow")),
      ghost: one("ghost"),
      ghostThreads: svgChildren(one("ghost")),
      threads: svgChildren(one("threads")),
      lights: svgChildren(one("lights")),
      knots: svgChildren(one("knots")),
      star: one("star"),
      starGlow: one("starGlow"),
      flare: one("flare"),
      starShape: one("starShape"),
      streak: one("streak"),
      crest: one("crest"),
      rays: one("rays"),
      rayPaths: svgChildren(one("rays")),
      listenArcs: one("listenArcs"),
      nodChevrons: one("nodChevrons"),
      ponderOrb: one("ponderOrb"),
      orbGlow: one("orbGlow"),
      orbBall: one("orbBall"),
      coolGlow: one("coolGlow"),
      core: one("core"),
      motesGroup,
      motes: svgChildren(motesGroup),
      sparksGroup,
      sparks: svgChildren(sparksGroup),
      debug: one("debug"),
      dbgLines: one("dbgLines"),
      dbgPoints: one("dbgPoints"),
      dbgAnchors: one("dbgAnchors"),
      dbgHub: one("dbgHub"),
    };
    const e = this._el;
    e.disc.setAttribute("fill", ref("disc"));
    e.halo.setAttribute("fill", ref("halo"));
    e.starGlow.setAttribute("fill", ref("starGlow"));
    e.starShape.setAttribute("href", href("star"));
    e.starShape.setAttribute("fill", ref("starFill"));
    e.coolGlow.setAttribute("fill", ref("cool"));
    e.core.setAttribute("fill", ref("cool"));
    e.orbGlow.setAttribute("fill", ref("orbGlow"));
    e.orbBall.setAttribute("fill", ref("orb"));
    e.glow.setAttribute("filter", ref("blur"));
    for (const list of [e.glowThreads, e.glowLights, e.shadowThreads, e.ghostThreads, e.threads]) {
      list.forEach((u, i) => u.setAttribute("href", href(`t${i}`)));
    }
    e.lights.forEach((u, i) => u.setAttribute("href", href(`t${Math.floor(i / 3)}`)));
    e.threads.forEach((u, i) => u.setAttribute("stroke", ref(i === 0 ? "light" : "gold")));
    this._ref = ref;
  }

  get configuration(): EmblemConfiguration {
    return this.getConfiguration();
  }

  getConfiguration(): EmblemConfiguration {
    const pick = <T extends string>(name: string, values: readonly T[]): T => {
      const value = (this.getAttribute(name) ?? "").trim().toLowerCase();
      return values.find((candidate) => candidate === value) ?? values[0]!;
    };
    return {
      palette: pick("palette", EMBLEM_CHOICES.palette),
      motion: pick("motion", EMBLEM_CHOICES.motion),
      gaze: pick("gaze", EMBLEM_CHOICES.gaze),
      state: pick("state", EMBLEM_CHOICES.state),
      transitions: pick("transitions", EMBLEM_CHOICES.transitions),
      frame: pick("frame", EMBLEM_CHOICES.frame),
      weight: pick("weight", EMBLEM_CHOICES.weight),
      glow: pick("glow", EMBLEM_CHOICES.glow),
      surface: pick("surface", EMBLEM_CHOICES.surface),
      placement: pick("placement", EMBLEM_CHOICES.placement),
      debug: this.getAttribute("debug") === "true",
      label: (this.getAttribute("label") ?? "").trim(),
      seed: this._seed(),
    };
  }

  private _seed() {
    const v = parseInt(this.getAttribute("seed") ?? "", 10);
    return Number.isFinite(v) ? v : this._id;
  }

  private get _origin() {
    return 40 * hash(97, this._seed());
  }

  get debugState(): EmblemDebugState {
    const reason = this._pausedReason();
    const active = this._gestures.find((g) => !g.fading && !g.done);
    const c = this._config ?? this.getConfiguration();
    const transitions = [...this._transitions.keys()];
    return {
      paused: !!reason,
      reason,
      frameCount: this._frameCount,
      pendingRAF: this._raf !== null ? 1 : 0,
      time: this._time,
      gaze: this._gaze,
      state: this._stateName(),
      stateMix: this._stateMix(),
      fps: Math.round(this._fps * 10) / 10,
      activeGesture: active ? active.name : null,
      transition: transitions[0] ?? null,
      transitions,
      motion: c.motion,
      settling: !!this._settling,
      seed: this._seed(),
      small: this._small,
      surface: this._light ? "light" : "dark",
      frame: c.frame,
      weight: c.weight,
      glow: c.glow,
      pose: this._pose ? structuredClone(this._pose) : null,
    };
  }

  connectedCallback() {
    if (!this.hasAttribute("seed")) {
      this._reflecting = true;
      this.setAttribute("seed", String(this._id));
      this._reflecting = false;
    }
    this._media = matchMedia("(prefers-reduced-motion: reduce)");
    this._media.addEventListener("change", this._onEnvironment);
    document.addEventListener("visibilitychange", this._onEnvironment);
    this._stopFocusWatch = onCompanionFocusChange(this._onEnvironment);
    this.addEventListener("pointermove", this._onHostPointer, { passive: true });
    this.addEventListener("pointerdown", this._onHostPointer, { passive: true });
    this._inView = typeof IntersectionObserver === "undefined";
    this._seen = this._inView;
    if (typeof IntersectionObserver !== "undefined") {
      this._observer = new IntersectionObserver((entries) => {
        if (!this.isConnected) return;
        const entry = entries[entries.length - 1];
        if (!entry) return;
        this._inView = entry.isIntersecting && entry.intersectionRatio > 0;
        // The entrance plays only for emblems visible when first observed.
        if (!this._seen) {
          this._seen = true;
          if (!this._inView) this._skipEntrance();
        }
        this._syncMotion();
        if (!this._running()) this._applyFrame(false);
      });
      this._observer.observe(this);
    }
    this._stopResize = observeResize(this, (entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const box = entry.contentRect;
      const before = this._size;
      if (this._measure(box.width, box.height)) this._geometryChanged();
      else if (before !== this._size && !this._running()) this._applyFrame(false);
    });
    const rect = this.getBoundingClientRect();
    this._measure(rect.width, rect.height);
    this._geo = this._small ? GEOMETRY.small : GEOMETRY.large;
    this._noiseSeed = null;
    const c = this.getConfiguration();
    if (this._entrance === "none") {
      this._entrance =
        c.transitions === "on" && c.motion !== "still" && !this._media.matches ? "pending" : "done";
    }
    this._render();
  }

  disconnectedCallback() {
    this._stopMotion();
    this._settling = null;
    this._settled = false;
    this._lastActivity = null;
    this._observer?.disconnect();
    this._observer = null;
    this._stopResize?.();
    this._stopResize = null;
    this._inView = false;
    this._media?.removeEventListener("change", this._onEnvironment);
    this._media = null;
    document.removeEventListener("visibilitychange", this._onEnvironment);
    this._stopFocusWatch?.();
    this._stopFocusWatch = null;
    this.removeEventListener("pointermove", this._onHostPointer);
    this.removeEventListener("pointerdown", this._onHostPointer);
    this._syncLease();
    this._watchPointer(false);
    this._cancelGestures();
    this._finishTransitions();
  }

  attributeChangedCallback(name: string, before: string | null, after: string | null) {
    let value = after;
    if (name === "seed" && value === null && this.isConnected && !this._reflecting) {
      this._reflecting = true;
      this.setAttribute("seed", String(this._id));
      this._reflecting = false;
      value = String(this._id);
    }
    if (before === value || !this.isConnected || this._reflecting) return;
    if (name === "motion") {
      if (!this._scrub && this._raf !== null && this.getConfiguration().motion === "still") {
        this._settling = {
          kind: "still",
          start: this._time,
          duration: REST_BLEND,
          ambient: this._springs.ambient.x,
        };
        for (const g of this._gestures) this._fadeGesture(g);
      } else this._settling = null;
      this._scrub = null;
    }
    if (name === "state") this._wake();
    if (name === "placement") this._lease?.setPlacement(this.getConfiguration().placement);
    this._render();
  }

  setPose({ time = this._time, gaze, state }: SetPoseInput = {}) {
    if (!Number.isFinite(time) || (gaze !== undefined && !Number.isFinite(gaze))) {
      throw new TypeError("setPose requires finite time and gaze numbers.");
    }
    if (state != null && !isState(state)) throw new TypeError(`Unknown state "${String(state)}".`);
    this._time = Math.max(0, time);
    this._scrub = {
      time: this._time,
      gaze: gaze === undefined ? undefined : clamp(gaze),
      state: state ?? undefined,
    };
    this._settling = null;
    this._stopMotion();
    this._syncLease();
    if (this.isConnected) this._applyHold();
  }

  resume() {
    this._scrub = null;
    this._syncMotion();
  }

  play(name: CompanionGesture): Promise<GestureResult> {
    if (!isGesture(name))
      return Promise.reject(new TypeError(`Unknown gesture "${String(name)}".`));
    const reason = this._pausedReason();
    if (!reason || reason === "settled") this._wake();
    if (!this._running() || this._settling) return Promise.resolve({ name, played: false });
    return new Promise((resolve) => {
      for (const g of this._gestures) this._fadeGesture(g);
      this._gestures.push({
        name,
        start: this._time,
        def: GESTURES[name],
        resolve,
        fading: false,
        done: false,
        weight: { x: 1, v: 0 },
        fadeTau: null,
        spinFrom: null,
        spinTo: 0,
      });
      this._mutes.push({ from: this._time, to: Infinity, gesture: true });
    });
  }

  private _touch() {
    this._lastActivity = companionClock().now();
  }

  // Restarts the settle deadline; a settled (or settling) emblem resumes ambient motion.
  private _wake() {
    this._touch();
    if (this._settling?.kind === "settle") this._settling = null;
    if (this._settled) {
      this._settled = false;
      this._syncMotion();
    }
  }

  private _settleDue() {
    return (
      this._lastActivity !== null &&
      companionClock().now() - this._lastActivity >= COMPANION_SETTLE_MS - REST_BLEND * 1000
    );
  }

  private _beginSettle() {
    this._settling = {
      kind: "settle",
      start: this._time,
      duration: REST_BLEND,
      ambient: this._springs.ambient.x,
    };
    for (const g of this._gestures) this._fadeGesture(g);
  }

  // Size class from the rendered box: the 24 px drawing below 40 CSS px (with a little
  // hysteresis). A zero box (hidden) keeps the current class.
  private _measure(width: number, height: number) {
    const size = Math.min(width || 0, height || width || 0) || width || 0;
    if (!size) return false;
    this._size = size;
    const small = this._small ? size < 40.5 : size < 39.5;
    if (small === this._small) return false;
    this._small = small;
    return true;
  }

  private _geometryChanged() {
    this._geo = this._small ? GEOMETRY.small : GEOMETRY.large;
    this._noiseSeed = null;
    this._finishTransition("weight", false);
    if (this._now && this._config) {
      this._now.stroke = this._geo.stroke[this._config.weight];
      this._now.colorKey = null;
    }
    this._drawStatic();
    if (!this._running()) this._applyFrame(false);
  }

  private _detectSurface(c: EmblemConfiguration) {
    if (c.surface !== "auto") return c.surface === "light";
    return pageIsLight(this);
  }

  private _targets(c: EmblemConfiguration) {
    return {
      orbit: c.frame === "orbit" ? 1 : 0,
      seal: c.frame === "seal" ? 1 : 0,
      stroke: this._geo.stroke[c.weight],
      glow: GLOW_STRENGTH[c.glow],
    };
  }

  private _render() {
    // Snapshot what is on screen before the new attributes change the targets.
    let snap: Snapshot | null = null;
    if (this._config && this._now) {
      const d = this._displayed();
      snap = {
        orbit: d.orbit,
        seal: d.seal,
        disc: d.disc,
        stroke: d.stroke,
        glow: d.glow,
        colors: d.colors,
      };
    }
    const c = (this._config = this.getConfiguration());
    const light = this._detectSurface(c);
    const lightChanged = light !== this._light;
    this._light = light;
    const t = this._targets(c);
    this._svg.setAttribute(
      "aria-label",
      c.label ||
        `Threadkeeper emblem${c.frame === "orbit" ? " with orbit ring" : c.frame === "seal" ? " on an engraved seal" : ""}, ${c.palette}.`,
    );
    const prev = this._shown;
    const animate =
      !!prev && c.transitions === "on" && this._running() && this._entrance !== "pending";
    if (!this._now) {
      this._now = {
        orbit: t.orbit,
        seal: t.seal,
        disc: t.seal,
        stroke: t.stroke,
        glow: t.glow,
        colors: null,
        colorKey: null,
        colorsDirty: false,
      };
    }
    if (prev && snap) {
      if (prev.frame !== c.frame) this._tween("frame", animate, snap);
      if (prev.weight !== c.weight) this._tween("weight", animate, snap);
      if (prev.glow !== c.glow) this._tween("glow", animate, snap);
      if (prev.palette !== c.palette) this._tween("palette", animate, snap);
    }
    if (lightChanged) this._now.colorKey = null;
    this._shown = { frame: c.frame, weight: c.weight, glow: c.glow, palette: c.palette };
    this._drawStatic();
    this._watchPointer(c.gaze === "pointer");
    if (this._scrub) this._applyHold();
    this._syncMotion();
    if (prev && this._raf !== null) this._applyFrame(true);
    const reason = this._pausedReason();
    if (
      !prev ||
      reason === "offscreen" ||
      reason === "document-hidden" ||
      reason === "disconnected" ||
      reason === "unfocused" ||
      reason === "yielded"
    ) {
      if (!this._running() || !prev)
        this._settleSprings(this._stateName(), this._springs.ambient.x);
      if (reason) this._applyFrame(false);
    }
  }

  private _tween(kind: TransitionKind, animate: boolean, from: Snapshot) {
    this._finishTransition(kind, false);
    if (animate) {
      this._transitions.set(kind, { kind, start: this._time, duration: DURATIONS[kind], from });
      this._touch();
    }
  }

  // Displayed tweenable values for the current time (targets eased in from snapshots).
  private _displayed(): Displayed {
    const c = this._config ?? this.getConfiguration();
    const t = this._targets(c);
    const now = (this._now ??= {
      orbit: t.orbit,
      seal: t.seal,
      disc: t.seal,
      stroke: t.stroke,
      glow: t.glow,
      colors: null,
      colorKey: null,
      colorsDirty: false,
    });
    const p = (kind: TransitionKind) => {
      const tr = this._transitions.get(kind);
      return tr ? sine((this._time - tr.start) / tr.duration) : 1;
    };
    const fr = this._transitions.get("frame");
    const wr = this._transitions.get("weight");
    const gr = this._transitions.get("glow");
    now.orbit = fr?.from ? lerp(fr.from.orbit, t.orbit, p("frame")) : t.orbit;
    now.seal = fr?.from ? lerp(fr.from.seal, t.seal, p("frame")) : t.seal;
    // The disc fades over the first 60% of the morph (and irises from 0.85), so on light
    // pages the inks never sit on a half-transparent navy disc for long.
    now.disc = fr?.from
      ? lerp(fr.from.disc, t.seal, smooth((this._time - fr.start) / (fr.duration * 0.6)))
      : t.seal;
    now.stroke = wr?.from ? lerp(wr.from.stroke, t.stroke, p("weight")) : t.stroke;
    now.glow = gr?.from ? lerp(gr.from.glow, t.glow, p("glow")) : t.glow;
    // Inks: the seal is always navy inside, so on light pages it fades the dark inks in.
    const tone = this._light ? 1 - smooth((now.disc - 0.3) / 0.4) : 0;
    const pr = this._transitions.get("palette");
    const key = `${c.palette}:${r3(tone)}:${pr ? r3(p("palette")) : 1}`;
    if (key !== now.colorKey) {
      const dark = PALETTES.dark[c.palette];
      const lite = PALETTES.light[c.palette];
      const from = pr?.from?.colors;
      const k = p("palette");
      const ink = (name: ColorKey) => {
        const target = mix(dark[name], lite[name], tone);
        return from ? mix(from[name], target, k) : target;
      };
      now.colors = {
        light: ink("light"),
        gold: ink("gold"),
        star: ink("star"),
        glow: ink("glow"),
        comet: ink("comet"),
        halo: ink("halo"),
        tone,
      };
      now.colorKey = key;
      now.colorsDirty = true;
    }
    return now;
  }

  // Elements whose look depends on configuration but not on time.
  private _drawStatic() {
    const e = this._el;
    const small = this._geo.small;
    put(e.ring, "stroke-width", small ? "3.2" : ".65");
    put(e.rimOuter, "stroke-width", small ? "3" : "1.1");
    show(e.ticks, !small);
    show(e.rimInner, !small);
    show(e.sheen, !small);
    put(this._blur, "stdDeviation", small ? "4" : "2.6");
    for (let i = 0; i < 3; i++) {
      const on = i < this._geo.threads.length;
      for (const list of [e.glowThreads, e.shadowThreads, e.ghostThreads, e.threads])
        show(list[i]!, on);
      if (!on) {
        show(e.glowLights[i]!, false);
        for (let j = 0; j < 3; j++) show(e.lights[i * 3 + j]!, false);
      }
    }
    this._geo.knots.forEach(([x, y], k) => {
      for (const el of [e.knots[k]!, e.glowKnots[k]!]) {
        put(el, "cx", String(r2(x)));
        put(el, "cy", String(r2(y)));
      }
    });
    show(e.debug, !!this._config?.debug);
  }

  private _applyColors(cl: Colors) {
    const e = this._el;
    const g = this._grad;
    const stops = (list: SVGElement[], base: RGB, hi: number, lo: number) => {
      put(list[0]!, "stop-color", rgb(mix(base, WHITE, hi)));
      put(list[1]!, "stop-color", rgb(base));
      put(list[2]!, "stop-color", rgb(mix(base, NAVY, lo)));
    };
    const tone = cl.tone;
    stops(g.light, cl.light, lerp(0.28, 0.12, tone), lerp(0.2, 0.05, tone));
    stops(g.gold, cl.gold, lerp(0.3, 0.14, tone), lerp(0.2, 0.08, tone));
    put(g.star[0]!, "stop-color", rgb(mix(cl.star, WHITE, lerp(0.7, 0.3, tone))));
    put(g.star[1]!, "stop-color", rgb(mix(cl.star, WHITE, lerp(0.15, 0.05, tone))));
    put(g.star[2]!, "stop-color", rgb(mix(cl.star, NAVY, lerp(0.12, 0.1, tone))));
    for (const s of g.starGlow) put(s, "stop-color", rgb(cl.glow));
    // Thinking's cool core: the palette's comet light pulled toward a pale blue, and toward
    // the star ink on light pages where a pale core would vanish.
    const cool = rgb(mix(mix(cl.comet, COOL, 0.45), cl.star, 0.6 * tone));
    for (const s of g.cool) put(s, "stop-color", cool);
    for (const s of g.halo) put(s, "stop-color", rgb(mix(cl.halo, cl.star, 0.5 * tone)));
    const glow = rgb(cl.glow);
    const comet = rgb(cl.comet);
    for (const u of e.glowThreads) put(u, "stroke", glow);
    for (const k of e.glowKnots) put(k, "fill", glow);
    for (const u of e.glowLights) put(u, "stroke", rgb(mix(cl.comet, cl.glow, 0.55)));
    for (const u of e.lights) put(u, "stroke", comet);
    for (const k of e.knots) put(k, "fill", rgb(cl.gold));
    e.ghostThreads.forEach((u, i) => put(u, "stroke", rgb(i === 0 ? cl.light : cl.gold)));
    const shadowInk = tone > 0.5 ? "rgb(70,48,22)" : "rgb(2,8,13)";
    for (const u of e.shadowThreads) put(u, "stroke", shadowInk);
    put(e.shadow, "opacity", String(r3(lerp(0.38, 0.13, tone))));
    put(e.shadow, "transform", tone > 0.5 ? "translate(.35 .65)" : "translate(.35 .7)");
    put(e.flare, "fill", comet);
    put(e.streak, "fill", comet);
    for (const s of e.sparks) put(s, "fill", comet);
    for (const m of e.motes) put(m, "fill", rgb(mix(cl.glow, cl.comet, 0.3)));
    put(e.ring, "stroke", rgb(cl.gold));
    for (const s of e.sats) put(s, "fill", rgb(cl.light));
    put(e.crest, "stroke", rgb(mix(cl.halo, cl.star, 0.4)));
    put(e.rays, "stroke", rgb(mix(cl.comet, cl.star, 0.35)));
    // The figure's motif inks (pale core over an amber bed), deepened on light pages where a
    // pale core would vanish.
    const motifCore = rgb(mix(MOTIF_PALE, cl.star, 0.85 * tone));
    const motifBed = rgb(mix(MOTIF_AMBER, cl.gold, 0.5 * tone));
    for (const group of [e.listenArcs, e.nodChevrons]) {
      for (const path of svgChildren(group))
        put(path, "stroke", path.hasAttribute("data-core") ? motifCore : motifBed);
    }
    // The seal is always navy: its rim uses the dark-surface ink.
    const palette = (this._config ?? this.getConfiguration()).palette;
    const sealGold = PALETTES.dark[palette].gold;
    const pr = this._transitions.get("palette");
    const rim = pr?.from?.colors ? cl.gold : sealGold;
    put(e.rimOuter, "stroke", rgb(rim));
    put(e.rimInner, "stroke", rgb(rim));
    put(e.ticks, "stroke", rgb(rim));
    put(e.sheen, "stroke", rgb(mix(rim, WHITE, 0.5)));
  }

  private _finishTransition(kind: TransitionKind, natural: boolean) {
    if (!this._transitions.has(kind)) return;
    this._transitions.delete(kind);
    if (kind === "entrance") this._entrance = "done";
    if (this._now) this._now.colorKey = null;
    const detail: EmblemTransitionEndDetail = { kind, completed: natural };
    this.dispatchEvent(new CustomEvent("squire-transition-end", { detail }));
  }

  private _finishTransitions() {
    for (const kind of Array.from(this._transitions.keys())) this._finishTransition(kind, false);
  }

  private _skipEntrance() {
    if (this._entrance === "done") return;
    this._finishTransition("entrance", false);
    this._entrance = "done";
  }

  private _endGesture(g: ActiveGesture, interrupted: boolean) {
    if (g.done) return;
    g.done = true;
    this._lastGestureEnd = this._time;
    for (const m of this._mutes) if (m.gesture && m.to === Infinity) m.to = this._time + 1.5;
    g.resolve({ name: g.name, played: true, interrupted });
    const detail: EmblemGestureEndDetail = { name: g.name, interrupted };
    this.dispatchEvent(new CustomEvent("squire-gesture-end", { detail }));
  }

  private _fadeGesture(g: ActiveGesture) {
    if (g.fading) return;
    g.fading = true;
    g.weight = { x: 1, v: 0 };
    g.fadeTau = this._time - g.start;
    this._endGesture(g, true);
  }

  private _cancelGestures() {
    for (const g of this._gestures) this._endGesture(g, true);
    this._gestures = [];
    this._gOut = EMPTY;
    this._gLag = EMPTY;
  }

  private _gestureSum(lag: number): ChannelValues {
    const out = zeroChannels();
    const amp = lerp(1, 1.3, clamp01(this._springs.lively.x));
    // Small emblems need bigger moves to read: up to 1.8x at 64 px and below.
    const sizeK = clamp(112 / Math.max(16, this._size || 128), 1, 1.8);
    let best = 0;
    for (const g of this._gestures) {
      const tau = this._time - g.start - lag;
      const w = g.fading ? g.weight.x : 1;
      for (const track of g.def.tracks) {
        if (track.channel === "spin" && g.fading) {
          // The star is quarter-turn symmetric: an interrupted spin settles on the nearest
          // quarter turn instead of unwinding backward.
          if (g.spinFrom === null) {
            g.spinFrom = track.curve(g.fadeTau ?? tau);
            g.spinTo = Math.round(g.spinFrom / 90) * 90;
          }
          out.spin += g.spinTo + (g.spinFrom - g.spinTo) * w;
          continue;
        }
        out[track.channel] +=
          track.curve(tau) * w * (track.motion ? amp : 1) * (track.size ? sizeK : 1);
      }
      if (g.def.spine && w > best) {
        best = w;
        out.spine = g.def.spine(tau);
      }
      if (g.def.sparkAt !== null && !g.fading && !lag) out.sparkTau = tau - g.def.sparkAt;
    }
    return out;
  }

  private _stepGestures(dt: number) {
    for (const g of this._gestures) {
      if (g.fading) spring(g.weight, 0, 14, dt);
      if (this._time - g.start >= g.def.duration) this._endGesture(g, false);
    }
    // Kept one lag beyond the end so the follow-through channels finish their curves.
    this._gestures = this._gestures.filter(
      (g) =>
        this._time - g.start < g.def.duration + LAG + 0.02 && !(g.fading && g.weight.x < 0.002),
    );
    this._gOut = this._gestures.length ? this._gestureSum(0) : EMPTY;
    this._gLag = this._gestures.length ? this._gestureSum(LAG) : EMPTY;
  }

  private _stateName(): CompanionState {
    return this._scrub?.state || (this._config ?? this.getConfiguration()).state;
  }

  private _stateMix(): Record<CompanionState, number> {
    const s = this._springs;
    const idle = clamp01(s.idle.x);
    const attentive = clamp01(s.attentive.x);
    const thinking = clamp01(s.thinking.x);
    const sum = idle + attentive + thinking || 1;
    const share = (v: number) => Math.round((v / sum) * 1e4) / 1e4;
    return { idle: share(idle), attentive: share(attentive), thinking: share(thinking) };
  }

  private _blend(key: keyof PoseDef) {
    const s = this._springs;
    let total = 0;
    for (const name of STATES) total += POSES[name][key] * s[name].x;
    return total;
  }

  private _baseGaze(time: number, mode: Gaze) {
    switch (mode) {
      case "auto":
        return (
          autoGaze(time - this._origin, this._origin) *
          this._blend("autoGaze") *
          (1 - clamp01(this._springs.quiet.x))
        );
      case "pointer":
        return this._pointer.gaze;
      case "left":
        return -1;
      case "center":
        return 0;
      case "right":
        return 1;
    }
  }

  private _settleSprings(state: CompanionState, ambient: number) {
    const c = this._config ?? this.getConfiguration();
    for (const name of STATES) settle(this._springs[name], name === state ? 1 : 0);
    settle(this._springs.lively, c.motion === "lively" ? 1 : 0);
    settle(this._springs.ambient, ambient);
    settle(this._springs.pitch, 0);
    settle(this._springs.quiet, 0);
    this._stateTarget = state;
    this._lastState = state;
    this._stateChangeAt = null;
    this._mutes = [];
    this._lastGestureEnd = -Infinity;
    this._lastStateChange = -Infinity;
    this._breathPhase = this._time / POSES[state].breathPeriod;
    this._orbitPhase = state === "thinking" ? this._time : 0;
  }

  private _mute(start: number, intro: boolean) {
    const origin = this._origin;
    if (start >= origin && start < origin + 3) return true;
    const introAt = origin + 3.5 + 1.5 * hash(this._seed(), 5);
    if (!intro && start > introAt - 1 && start < introAt + 6) return true;
    for (const m of this._mutes) if (start >= m.from && start <= m.to) return true;
    return false;
  }

  // Idle beats active at `time`: ripples per thread { c, a } and a star glint amount.
  private _beats(time: number) {
    const out: { ripple: Array<Ripple | undefined>; glint: number; rot: number } = {
      ripple: [],
      glint: 0,
      rot: 0,
    };
    const s = this._springs;
    const weight = clamp01(s.idle.x) * (1 - clamp01(s.quiet.x)) * clamp01(s.ambient.x);
    if (weight < 1e-3) return out;
    const seed = this._seed();
    const w = Math.floor(time / 60);
    const intro: Beat = {
      start: this._origin + 3.5 + 1.5 * hash(seed, 5),
      kind: "glint",
      thread: 0,
      intro: true,
    };
    const level = 1 + 0.5 * clamp01(s.lively.x);
    for (const ev of [...beatWindow(seed, w - 1), ...beatWindow(seed, w), intro]) {
      const tau = time - ev.start;
      if (tau < 0 || tau > BEATS[ev.kind].duration) continue;
      if (this._mute(ev.start, ev.intro)) continue;
      if (ev.kind === "ripple" && !this._geo.small) {
        const thread = ev.thread % this._geo.threads.length;
        const env = Math.pow(Math.sin(Math.PI * clamp01(tau / BEATS.ripple.duration)), 0.7);
        out.ripple[thread] = {
          c: RIPPLE_CENTER(tau),
          a: 3 * level * env * weight,
          k: env * weight,
        };
      } else if (ev.kind === "glint" || this._geo.small) {
        out.glint = Math.max(out.glint, GLINT(Math.min(tau, 1.1)) * weight * level);
        out.rot += GLINT_ROT(Math.min(tau, 1.1)) * weight;
      }
    }
    return out;
  }

  private _step(dt: number) {
    const c = this._config;
    if (!c) return;
    const s = this._springs;
    const settling = this._settling;
    if (c.state !== this._lastState) {
      this._stateChangeAt = this._time;
      this._mutes.push({ from: this._time, to: this._time + 2.5, gesture: false });
      this._lastStateChange = this._time;
      this._lastState = c.state;
    }
    // A short beat of anticipation before the state springs move (as in the rig).
    if (this._stateChangeAt != null && this._time - this._stateChangeAt >= 0.1)
      this._stateTarget = c.state;
    for (const name of STATES)
      springZ(s[name], name === (this._stateTarget || c.state) ? 1 : 0, 8, 0.75, dt);
    spring(s.lively, c.motion === "lively" ? 1 : 0, 5, dt);
    if (settling) {
      s.ambient.x =
        settling.ambient * (1 - sine((this._time - settling.start) / settling.duration));
      s.ambient.v = 0;
    } else spring(s.ambient, 1, 2.5, dt);
    const lastPointer = this._lastPointer ?? -Infinity;
    const pointerActive = c.gaze === "pointer" && this._time < lastPointer + 1.5;
    if (pointerActive) {
      const m = this._pointerMute;
      if (m && m.to >= this._time - 0.1 && this._mutes.includes(m)) m.to = lastPointer + 1.5;
      else
        this._mutes.push(
          (this._pointerMute = { from: lastPointer, to: lastPointer + 1.5, gesture: false }),
        );
    }
    const quiet =
      this._gestures.some((g) => !g.fading) ||
      this._time < this._lastGestureEnd + 0.8 ||
      pointerActive ||
      this._time < this._lastStateChange + 2.5;
    spring(s.quiet, quiet ? 1 : 0, 12, dt);
    const restGaze = c.gaze === "auto" || c.gaze === "pointer" ? 0 : this._baseGaze(0, c.gaze);
    spring(
      s.gaze,
      settling ? restGaze : this._baseGaze(this._time, c.gaze),
      c.gaze === "pointer" ? 8 : 6,
      dt,
    );
    spring(s.pitch, c.gaze === "pointer" && !settling ? this._pointer.pitch : 0, 7, dt);
    this._gaze = s.gaze.x;
    this._breathPhase += dt / Math.max(2.5, this._blend("breathPeriod"));
    this._orbitPhase += dt * clamp01(s.thinking.x);
    this._mutes = this._mutes.filter((m) => m.to > this._time - 30);
    this._stepGestures(dt);
    for (const [kind, tr] of this._transitions) {
      if (this._time - tr.start >= tr.duration) this._finishTransition(kind, true);
    }
  }

  private _applyHold() {
    const hold = this._scrub;
    if (!hold) return;
    const c = this._config ?? this.getConfiguration();
    const state = hold.state || c.state;
    this._time = hold.time;
    this._clockSeeded = true;
    this._cancelGestures();
    this._finishTransitions();
    this._skipEntrance();
    this._settleSprings(state, 1);
    const gaze =
      hold.gaze !== undefined
        ? hold.gaze
        : c.gaze === "pointer"
          ? 0
          : this._baseGaze(this._time, c.gaze);
    this._gaze = gaze;
    settle(this._springs.gaze, gaze);
    this._applyFrame(false);
  }

  private _applyRest() {
    const c = this._config;
    if (!c) return;
    this._cancelGestures();
    this._finishTransitions();
    this._skipEntrance();
    this._settleSprings(c.state, 0);
    const gaze = c.gaze === "auto" || c.gaze === "pointer" ? 0 : this._baseGaze(0, c.gaze);
    this._gaze = gaze;
    settle(this._springs.gaze, gaze);
    this._applyFrame(false);
  }

  private _ensureNoise() {
    const seed = this._seed();
    if (this._noiseSeed === seed) return;
    this._noiseSeed = seed;
    this._noise = this._geo.threads.map((th, i) =>
      th.nodes.map((_, k) => makeNoise(seed, 100 + i * 10 + k)),
    );
    this._shared = [0, 1, 2, 3, 4, 5].map((k) => makeNoise(seed, 900 + k));
    this._starPh = [0, 1, 2, 3, 4].map((k) => TAU * hash(seed * 13 + 5, k));
  }

  private _applyFrame(live: boolean) {
    const c = this._config;
    if (!c) return;
    this._frameCount++;
    this._ensureNoise();
    const e = this._el;
    const geo = this._geo;
    const small = geo.small;
    const t = this._time;
    const s = this._springs;
    const now = this._displayed();
    const colors = now.colors;
    if (!colors) return;
    if (now.colorsDirty) {
      this._applyColors(colors);
      now.colorsDirty = false;
    }
    const amb = clamp01(s.ambient.x);
    const lively = clamp01(s.lively.x);
    const level = 1 + 0.6 * lively;
    const wT = clamp01(s.thinking.x);
    const g = live ? this._gOut : EMPTY;
    const gl = live ? this._gLag : EMPTY;
    const beats = this._beats(t);
    const P = this._starPh;

    // Entrance: threads draw on in sequence from the star, knots land, the star pops.
    const ent = this._transitions.get("entrance");
    const pending = this._entrance === "pending";
    const et = pending ? 0 : ent ? (t - ent.start) / ent.duration : 1;
    const entering = pending || !!ent;
    const drawIn = (i: number) => (entering ? sine((et - 0.1 * i) / 0.5) : 1);
    const starPop = entering ? easeOutBack((et - 0.5) / 0.34, 2.2) : 1;
    const glowIn = entering ? smooth((et - 0.25) / 0.7) : 1;
    const frameIn = entering ? smooth(et / 0.55) : 1;
    const entGlint = entering ? Math.max(0, Math.sin(Math.PI * clamp01((et - 0.66) / 0.34))) : 0;

    // Star hub: lift (state), gaze lean, gestures. The star threads' first anchor rides it.
    const gaze = s.gaze.x;
    const pitch = s.pitch.x;
    const lift = this._blend("lift");
    const hubOf = (ch: Readonly<ChannelValues>): Vec => {
      const x = gaze * 2.4 + ch.hx + ch.lean * 3.2 + ch.along * NOD_DIR[0];
      const y = -lift + pitch * 1.5 - Math.abs(gaze) * 0.35 + ch.hy + ch.along * NOD_DIR[1];
      const m = Math.hypot(x, y);
      const k = m > 1e-6 ? soft(m, 5.6) / m : 1;
      return [x * k, y * k];
    };
    const hub = hubOf(g);
    const hubLag = hubOf(gl);
    const [sx, sy] = geo.star;

    // Thread deformation.
    const floatA = small ? 0 : FLOAT_AMP * level * amb * this._blend("float");
    const gatherA = this._blend("gather") - 1.25 * g.fan;
    const waveA = small ? 0 : 2.1 * (1 + 0.3 * lively) * amb * clamp01(this._blend("wave"));
    const leanA = small ? 0 : gaze * 1.5 + gl.lean * 2.8;
    // Size-aware line: never thinner than about a device pixel at small rendered sizes.
    const px = 128 / Math.max(16, this._size || 128);
    const W = small ? now.stroke : Math.max(now.stroke, MIN_PX[c.weight] * px);
    const ds: string[] = [];
    const pointsAll: Vec[][] = [];
    // The feGaussianBlur glow stays on at 80 px and up, as in v5; its cost is measured
    // separately (perf budget), not gated here.
    const blur = (this._size || 128) >= 80;
    const glowK = blur ? 1 : 0.42;
    geo.threads.forEach((th, i) => {
      const pts = th.pts.map((p): Vec => [p[0], p[1]]);
      th.nodes.forEach((node, k) => {
        if (node.fixed) return;
        let dx = 0;
        let dy = 0;
        if (node.follow) {
          const h = node.kind === "start" ? hub : hubLag;
          dx += h[0] * node.follow;
          dy += h[1] * node.follow;
        }
        if (node.kind !== "start") {
          if (floatA) {
            const own = this._noise[i]![k]!;
            const shared = this._shared[k]!;
            const endK = node.end ? 0.75 : 1;
            const corr = i < 2 ? 0.74 : 0.2;
            const solo = i < 2 ? 0.52 : 0.95;
            dx += floatA * endK * (corr * noiseAt(shared, 0, t) + solo * noiseAt(own, 0, t));
            dy += floatA * endK * (corr * noiseAt(shared, 1, t) + solo * noiseAt(own, 1, t));
          }
          dx += gatherA * node.G[0];
          dy += gatherA * node.G[1];
          if (waveA) {
            // The star threads sway nearly in phase (never into each other); the loop lags.
            const w =
              waveA *
              Math.sin((TAU * t) / 5.6 - node.s * 5.2 - (i < 2 ? 0.3 * i : 1.9)) *
              (node.end ? 0.6 : 1);
            dx += w * node.N[0];
            dy += w * node.N[1];
          }
          const rip = beats.ripple[i];
          if (rip) {
            const env =
              rip.a * Math.exp(-Math.pow((node.s - rip.c) / 0.22, 2)) * (node.end ? 0.6 : 1);
            dx += env * node.N[0];
            dy += env * node.N[1];
          }
          if (leanA) dx += leanA * Math.pow(node.u, 1.5);
          const m = Math.hypot(dx, dy);
          if (m > 4) {
            const k2 = soft(m - 4, 3.5) + 4;
            dx *= k2 / m;
            dy *= k2 / m;
          }
        }
        for (const idx of node.idx) {
          const q = pts[idx]!;
          q[0] += dx;
          q[1] += dy;
        }
      });
      pointsAll.push(pts);
      const q = (j: number) => pts[j]!;
      let d = `M${r2(q(0)[0])} ${r2(q(0)[1])}`;
      for (let j = 1; j < pts.length; j += 3) {
        d += `C${r2(q(j)[0])} ${r2(q(j)[1])} ${r2(q(j + 1)[0])} ${r2(q(j + 1)[1])} ${r2(q(j + 2)[0])} ${r2(q(j + 2)[1])}`;
      }
      ds.push(d);
      put(this._paths[i]!, "d", d);
    });

    // Breath (glow and stroke) on an integrated phase.
    const breath = 0.5 - 0.5 * Math.cos(TAU * this._breathPhase);
    const depth = this._blend("breathDepth");
    const undraw = clamp01(g.undraw);
    geo.threads.forEach((_, i) => {
      const width = W * (1 + 0.04 * amb * Math.sin(TAU * this._breathPhase + i * 1.9));
      put(e.threads[i]!, "stroke-width", String(r3(width)));
      put(e.shadowThreads[i]!, "stroke-width", String(r3(width)));
      const f = Math.min(drawIn(i), 1 - undraw * (1 - 0.1 * i));
      const dash = f < 0.999 ? `${r2(Math.max(0, f) * 100)} 200` : "none";
      for (const el of [e.threads[i]!, e.shadowThreads[i]!, e.glowThreads[i]!]) {
        put(el, "stroke-dasharray", dash);
        show(el, f > 0.004); // A zero-length dash would still draw a round cap.
      }
      put(e.glowThreads[i]!, "stroke-width", String(r2(W * (small ? 2.2 : 2.5))));
    });
    const ghost = undraw * 0.3;
    show(e.ghost, ghost > 0.003);
    if (ghost > 0.003) {
      put(e.ghost, "opacity", String(r3(ghost)));
      for (const u of e.ghostThreads) put(u, "stroke-width", String(r3(W * 0.8)));
    }

    // Lights: thinking comets, a held glint at rest, the ponder spine light, ripple shimmer.
    const lights: Array<Light | undefined> = [];
    const offer = (i: number, L: Light) => {
      const held = lights[i];
      if (i < geo.threads.length && L.a > 0.004 && (!held || L.a > held.a)) lights[i] = L;
    };
    const cometW = clamp01(this._blend("comet"));
    const liveK = smooth(amb * 2 - 1);
    const restK = 1 - smooth(amb * 2);
    if (!small && cometW > 0.004) {
      const cyc = frac(t / COMET.period) * COMET.period;
      for (let i = 0; i < geo.threads.length; i++) {
        let tau = cyc - i * COMET.gap;
        if (tau < 0) tau += COMET.period;
        const u = tau / COMET.run;
        if (u >= 0 && u <= 1)
          offer(i, {
            h: lerp(-4, 106, sine(u)),
            a: Math.pow(Math.sin(Math.PI * u), 0.45) * cometW * liveK,
            k: 1,
          });
      }
    }
    // Thinking holds a light on one thread even while the comets run, so a still reads.
    const restGlint = small ? wT : wT * lerp(0.7, 1, restK);
    offer(small ? 0 : 1, { h: small ? 52 : 58, a: restGlint * 0.9, k: 1 });
    if (g.spineA > 0.004) offer(0, { h: g.spine * 108 - 2, a: clamp01(g.spineA), k: 1.3 });
    beats.ripple.forEach((rip, i) => {
      if (rip) offer(i, { h: rip.c * 100 + 6, a: rip.k * 0.5, k: 2.2 });
    });
    for (let i = 0; i < 3; i++) {
      const L = lights[i];
      for (let j = 0; j < 3; j++) {
        const el = e.lights[i * 3 + j]!;
        const layer = LIGHT_LAYERS[j]!;
        show(el, !!L);
        if (!L) continue;
        const len = layer.len * L.k;
        put(el, "stroke-dasharray", `${r2(len)} 400`);
        put(el, "stroke-dashoffset", String(r2(-(L.h - len))));
        put(el, "stroke-width", String(r3(W * layer.w * (1 + 0.2 * colors.tone))));
        put(el, "opacity", String(r3(L.a * layer.op)));
      }
      const gl2 = e.glowLights[i]!;
      show(gl2, !!L);
      if (L) {
        const len = 14 * L.k;
        put(gl2, "stroke-dasharray", `${r2(len)} 400`);
        put(gl2, "stroke-dashoffset", String(r2(-(L.h - len * 0.8))));
        put(gl2, "stroke-width", String(r2(W * (small ? 1.6 : blur ? 3.4 : 2.4))));
        put(
          gl2,
          "opacity",
          String(r3(clamp01((0.62 * L.a * (1 - 0.45 * colors.tone)) / L.k) * (blur ? 1 : 0.6))),
        );
      }
    }

    // Glow layer (blurred) and halo. The halo holds steady: it changes with state and the
    // listen gesture's warmth, never on a timer.
    const glowS = now.glow;
    const glowLevel =
      glowS *
      this._blend("glow") *
      glowIn *
      (1 + 0.24 * depth * amb * (breath * 2 - 1)) *
      (1 - 0.45 * clamp01(g.dim));
    show(e.glow, glowS > 0.003 && glowIn > 0.003);
    // Under 80 px a blur is about a pixel wide: a soft wide stroke looks the same and keeps
    // grids of small emblems free of per-frame filter rasterization.
    put(e.glow, "filter", blur ? this._ref("blur") : "none");
    const threadGlow =
      clamp01(0.3 * glowLevel) * (colors.tone > 0.5 ? 0.75 : 1) * (small ? 0.55 : 1);
    for (let i = 0; i < geo.threads.length; i++)
      put(e.glowThreads[i]!, "opacity", String(r3(threadGlow * glowK)));
    const knotFlare = clamp01(g.knot);
    const lightInk = colors.tone;
    e.glowKnots.forEach((k, n) => {
      const flare = n === 1 ? knotFlare : 0;
      put(k, "r", String(r2(geo.knotR * ((blur ? 2.2 : 1.6) + 2.4 * flare))));
      put(
        k,
        "opacity",
        String(r3(clamp01(0.45 * glowLevel * (1 - 0.5 * lightInk) + 0.55 * flare) * glowK)),
      );
    });
    const haloF = glowS < 0.01 ? 0.7 : lerp(1, 1.2, clamp01(glowS - 1));
    const halo = (this._blend("halo") + 0.75 * g.warm) * haloF * glowIn;
    show(e.halo, halo > 0.003);
    if (halo > 0.003)
      put(e.halo, "opacity", String(r3(clamp01(halo) * lerp(1, 0.55, colors.tone))));

    // Star.
    const tw =
      amb * (0.035 * Math.sin((TAU * t) / 3.7 + P[0]!) + 0.018 * Math.sin((TAU * t) / 2.3 + P[1]!));
    const starScale = (this._blend("scale") + tw + g.scale + beats.glint * 0.08) * starPop;
    const starRot =
      amb * (3.2 * Math.sin((TAU * t) / 11.3 + P[2]!) + 1.1 * Math.sin((TAU * t) / 4.9 + P[3]!)) +
      gaze * 4 +
      g.rot +
      g.spin +
      beats.rot;
    const gain =
      this._blend("gain") +
      amb * 0.1 * Math.sin((TAU * t) / 3.7 + P[0]!) +
      g.gain +
      beats.glint * 0.45 +
      0.4 * g.glint;
    const glint = Math.max(beats.glint, clamp01(g.glint), entGlint, this._blend("flare") * glowIn);
    const starX = sx + hub[0];
    const starY = sy + hub[1];
    put(
      e.star,
      "transform",
      `translate(${r2(starX)} ${r2(starY)}) rotate(${r2(starRot)}) scale(${r3(geo.starScale * Math.max(0, starScale))})`,
    );
    const glowFactor =
      glowS < 0.01 ? 0.45 : lerp(0.75, 1, clamp01(glowS)) + 0.25 * clamp01(glowS - 1);
    const starGlow =
      clamp01((0.32 + 0.55 * (gain - 1) + 0.12 * depth * amb * (breath - 0.5)) * glowFactor) *
      glowIn *
      (1 - 0.4 * clamp01(g.dim));
    put(e.starGlow, "opacity", String(r3(starGlow * (colors.tone > 0.5 ? 0.7 : 1))));
    put(e.starGlow, "r", small ? "20" : "17");
    const cooled = clamp01(this._blend("cool")) * glowIn;
    show(e.coolGlow, cooled > 0.003);
    show(e.core, cooled > 0.003);
    if (cooled > 0.003) {
      put(e.coolGlow, "opacity", String(r3(0.85 * cooled * (glowS < 0.01 ? 0.6 : 1))));
      put(e.core, "opacity", String(r3(0.9 * cooled)));
    }
    show(e.flare, glint > 0.01);
    if (glint > 0.01) {
      put(e.flare, "opacity", String(r3(clamp01(glint) * 0.9)));
      put(e.flare, "transform", `rotate(45) scale(${r3(0.35 + 0.75 * clamp01(glint))})`);
    }

    // Glance streak: a short trail behind the moving star (points away from the motion).
    const streak = g.streak;
    show(e.streak, Math.abs(streak) > 0.01);
    if (Math.abs(streak) > 0.01) {
      const sk = clamp(112 / Math.max(16, this._size || 128), 1, 1.6);
      put(
        e.streak,
        "transform",
        `translate(${r2(starX)} ${r2(starY)}) scale(${r3(-Math.sign(streak) * (0.7 + 1.05 * Math.abs(streak)) * sk * geo.starScale)} ${r3(1.7 * sk * geo.starScale)})`,
      );
      put(e.streak, "opacity", String(r3(0.85 * Math.min(1, Math.abs(streak)))));
    }

    // Attentive crest: a steady arc over the star that follows it but never animates itself.
    const crest = clamp01(this._blend("crest")) * glowIn;
    show(e.crest, crest > 0.003);
    if (crest > 0.003) {
      put(e.crest, "transform", `translate(${r2(starX)} ${r2(starY)}) scale(${r3(geo.starScale)})`);
      put(e.crest, "stroke-width", small ? "3" : "1.3");
      put(e.crest, "opacity", String(r3(0.85 * crest * lerp(1, 0.85, colors.tone))));
    }

    // Greet's rays fan open upward above the star (spread and length grow with the channel).
    const rays = clamp01(g.rays);
    show(e.rays, rays > 0.003);
    if (rays > 0.003) {
      put(e.rays, "transform", `translate(${r2(starX)} ${r2(starY)}) scale(${r3(geo.starScale)})`);
      put(e.rays, "stroke-width", small ? "2.6" : "1.2");
      put(e.rays, "opacity", String(r3(0.95 * rays)));
      const spread = lerp(6, 28, rays);
      const r0 = 13;
      const r1 = r0 + 10 * rays;
      e.rayPaths.forEach((ray, k) => {
        const a = ((-90 + (k - 2) * spread) * Math.PI) / 180;
        put(
          ray,
          "d",
          `M${r2(r0 * Math.cos(a))} ${r2(r0 * Math.sin(a))}L${r2(r1 * Math.cos(a))} ${r2(r1 * Math.sin(a))}`,
        );
      });
    }

    // The figure's gesture motifs, static shapes at the star whose opacity alone follows the
    // gesture: listen's arcs on the side it leans toward, nod's chevrons under the star,
    // ponder's held orb at its heart.
    const starFrame = `translate(${r2(starX)} ${r2(starY)}) scale(${r3(geo.starScale)})`;
    for (const [node, k] of [
      [e.listenArcs, g.arcs],
      [e.nodChevrons, g.chevrons],
      [e.ponderOrb, g.orb],
    ] as const) {
      const amount = clamp01(k);
      show(node, amount > 0.01);
      if (amount > 0.01) {
        put(node, "transform", starFrame);
        put(node, "opacity", String(r3(amount)));
      }
    }

    // Knots: fixed, static anchors that land during the entrance; the end knot accents a nod.
    const kScale = Math.max(
      0.82 + (0.18 * W) / geo.stroke.regular,
      small ? 0 : (1.5 * px) / geo.knotR,
    );
    e.knots.forEach((k, n) => {
      const pop = entering ? easeOutBack((et - (n === 0 ? 0.28 : 0.52)) / 0.22, 2) : 1;
      const r = geo.knotR * kScale * Math.max(0, pop) + (n === 1 ? 2.4 * clamp01(g.knot) : 0);
      put(k, "r", String(r3(r)));
    });

    // Thinking motes around the star.
    const moteW = small ? 0 : clamp01(this._blend("motes")) * amb;
    show(e.motesGroup, moteW > 0.004);
    if (moteW > 0.004) {
      const seed = this._seed();
      e.motes.forEach((m, n) => {
        const h1 = hash(seed * 3 + 1, n);
        const h2 = hash(seed * 3 + 2, n);
        const a = TAU * h1 + ((t * TAU) / (9 + 4 * h2)) * (n % 2 ? -1 : 1);
        const R = 10 + 7 * h2 + 2.2 * Math.sin(t * 0.7 + n);
        put(m, "cx", String(r2(starX + R * Math.cos(a))));
        put(m, "cy", String(r2(starY + 0.62 * R * Math.sin(a) + 2)));
        put(m, "r", String(r3(0.75 + 0.55 * h1)));
        put(
          m,
          "opacity",
          String(
            r3(moteW * (0.5 + 0.5 * (0.5 + 0.5 * Math.sin((TAU * t) / (2.2 + h1) + n * 1.7)))),
          ),
        );
      });
    }

    // Flourish sparks from the star.
    const st = g.sparkTau;
    const sparkOn = st !== undefined && st >= 0 && st < 0.9;
    show(e.sparksGroup, sparkOn);
    if (sparkOn) {
      const u = st / 0.9;
      e.sparks.forEach((sp, n) => {
        const a = (n / 8) * TAU + Math.PI / 8 + (n % 2) * 0.12;
        const dist = (6 + (n % 2 ? 16 : 24) * easeOut(u)) * geo.starScale;
        put(sp, "cx", String(r2(starX + dist * Math.cos(a))));
        put(sp, "cy", String(r2(starY + dist * Math.sin(a))));
        put(sp, "r", String(r3((n % 2 ? 0.9 : 1.3) * (1 - 0.5 * u))));
        put(sp, "opacity", String(r3(Math.pow(1 - u, 1.4))));
      });
    }

    // Frames: orbit ring with satellites, engraved seal.
    const orbitW = now.orbit * frameIn;
    show(e.orbit, orbitW > 0.003);
    if (orbitW > 0.003) {
      const sc = 0.94 + 0.06 * now.orbit;
      put(e.orbit, "transform", `translate(64 64) scale(${r3(sc)}) translate(-64 -64)`);
      put(e.orbit, "opacity", String(r3(orbitW)));
      put(e.ring, "opacity", small ? ".75" : ".7");
      const base = [-40, 180, 90];
      const radii = small ? [4.6, 4, 4.6] : [1.4, 1.2, 1.4];
      e.sats.forEach((sat, n) => {
        const drift = amb * 1.8 * Math.sin((TAU * t) / (13 + 3 * n) + P[4]! + n);
        const deg = base[n]! + drift + (small ? 0 : (this._orbitPhase * 360) / 22);
        const rad = (deg * Math.PI) / 180;
        let d = (((deg + 65) % 360) + 360) % 360;
        if (d > 180) d -= 360;
        const vis = smooth((Math.abs(d) - 12) / 13);
        put(sat, "cx", String(r2(64 + 51 * Math.cos(rad))));
        put(sat, "cy", String(r2(64 + 54 * Math.sin(rad))));
        put(sat, "r", String(r3(radii[n]! * (0.6 + 0.4 * vis) * (1 + 0.6 * wT * (small ? 0 : 1)))));
        put(sat, "opacity", String(r3(vis)));
      });
    }
    const sealW = now.disc * frameIn;
    show(e.seal, sealW > 0.003);
    if (sealW > 0.003) {
      put(e.seal, "opacity", String(r3(sealW)));
      put(
        e.seal,
        "transform",
        `translate(64 64) scale(${r3(0.85 + 0.15 * now.disc)}) translate(-64 -64)`,
      );
    }
    const ls = lerp(1, geo.sealScale, now.seal);
    const [cx, cy] = geo.center;
    put(
      e.logo,
      "transform",
      now.seal > 0.001
        ? `translate(${r2(cx + (64 - cx) * now.seal)} ${r2(cy + (64 - cy) * now.seal)}) scale(${r3(ls)}) translate(${-cx} ${-cy})`
        : "",
    );

    if (c.debug) this._drawDebug(pointsAll, [starX, starY]);

    this._pose = {
      hub: [r3(hub[0]), r3(hub[1])],
      star: { x: r3(starX), y: r3(starY), scale: r3(starScale), rot: r3(starRot) },
      gain: r3(gain),
      glow: r3(glowLevel),
      halo: r3(halo),
      gather: r3(gatherA),
      ambient: r3(amb),
      lights: Array.from(lights, (L) => (L ? { h: r2(L.h), a: r3(L.a) } : null)),
      anchors: {
        knots: geo.knots.map((p): Vec => [p[0], p[1]]),
        starEnds: pointsAll
          .filter((_, i) => geo.threads[i]!.fromStar)
          .map((p): Vec => [r3(p[0]![0]), r3(p[0]![1])]),
      },
      nodes: pointsAll.map((p) => p.map((q): Vec => [r3(q[0]), r3(q[1])])),
      d: ds,
    };
  }

  private _drawDebug(pointsAll: Vec[][], star: Vec) {
    const e = this._el;
    let lines = "";
    let points = "";
    let anchors = "";
    const dot = (x: number, y: number, r: number) =>
      `M${r2(x - r)} ${r2(y)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
    for (const pts of pointsAll) {
      const q = (j: number) => pts[j]!;
      for (let j = 0; j + 3 < pts.length; j += 3) {
        lines += `M${r2(q(j)[0])} ${r2(q(j)[1])}L${r2(q(j + 1)[0])} ${r2(q(j + 1)[1])}`;
        lines += `M${r2(q(j + 3)[0])} ${r2(q(j + 3)[1])}L${r2(q(j + 2)[0])} ${r2(q(j + 2)[1])}`;
      }
      pts.forEach((p, k) => {
        if (k % 3) points += dot(p[0], p[1], 0.9);
        else if (k && k < pts.length - 1)
          points += `M${r2(p[0] - 1.3)} ${r2(p[1] - 1.3)}h2.6v2.6h-2.6z`;
      });
    }
    for (const [x, y] of this._geo.knots) anchors += dot(x, y, 4);
    put(e.dbgLines, "d", lines);
    put(e.dbgPoints, "d", points);
    put(e.dbgAnchors, "d", anchors);
    put(
      e.dbgHub,
      "d",
      `M${r2(star[0] - 5)} ${r2(star[1])}h10M${r2(star[0])} ${r2(star[1] - 5)}v10`,
    );
  }

  private _watchPointer(on: boolean) {
    if (on === this._pointerWatch) return;
    this._pointerWatch = on;
    if (on) {
      window.addEventListener("pointermove", this._onPointerMove, { passive: true });
      window.addEventListener("pointerout", this._onPointerOut, { passive: true });
      window.addEventListener("blur", this._onBlur);
    } else {
      window.removeEventListener("pointermove", this._onPointerMove);
      window.removeEventListener("pointerout", this._onPointerOut);
      window.removeEventListener("blur", this._onBlur);
      this._pointer = { gaze: 0, pitch: 0 };
    }
  }

  // The star leans toward the pointer: horizontal offset -> gaze, vertical -> a small lift.
  private _pointerAt(x: number, y: number) {
    const rect = this.getBoundingClientRect();
    if (!rect.width) return;
    const [sx, sy] = this._geo.star;
    const cx = rect.left + (rect.width * sx) / 128;
    const cy = rect.top + (rect.height * sy) / 128;
    const nx = (x - cx) / Math.max(120, rect.width * 0.8);
    const ny = (y - cy) / Math.max(160, rect.height);
    this._pointer = { gaze: Math.tanh(nx * 1.2), pitch: Math.tanh(ny * 1.3) };
    this._lastPointer = this._time;
  }

  private _pausedReason(): CompanionPauseReason | null {
    if (!this.isConnected) return "disconnected";
    if (this._scrub) return "scrub";
    if ((this._config ?? this.getConfiguration()).motion === "still") return "still";
    if (this._media?.matches) return "reduced-motion";
    if (document.visibilityState !== "visible") return "document-hidden";
    if (!this._inView) return "offscreen";
    if (!companionClock().hasFocus()) return "unfocused";
    if (!this._holding) return "yielded";
    if (this._settled) return "settled";
    return null;
  }

  private _running() {
    const reason = this._pausedReason();
    return !reason || (reason === "still" && !!this._settling);
  }

  private _stopMotion() {
    if (this._raf !== null) companionClock().cancelFrame(this._raf);
    this._raf = null;
    this._lastFrame = null;
  }

  // Only an emblem that could animate claims the lease, so a still, reduced-motion or held
  // emblem never pauses a live companion as yielded. A still blend keeps its claim until it
  // reaches rest so two loops never overlap.
  private _syncLease() {
    const c = this._config;
    const animatable =
      this.isConnected &&
      !this._scrub &&
      !this._media?.matches &&
      (c?.motion !== "still" || !!this._settling);
    if (animatable && !this._lease) {
      this._holding = false;
      this._lease = acquireCompanionLease(c?.placement ?? "panel", this._onLeaseChange);
    } else if (!animatable && this._lease) {
      const lease = this._lease;
      this._lease = null;
      this._holding = false;
      lease.release();
    }
  }

  private _syncMotion() {
    const c = this._config;
    if (!c) return;
    this._syncLease();
    const clock = companionClock();
    const reason = this._pausedReason();
    if (reason === "still" && this._settling) {
      if (this._raf === null) this._raf = clock.requestFrame(this._tick);
      return;
    }
    if (reason) {
      // A yielded emblem keeps its last frame, unless that frame is mid-entrance or
      // mid-transition: it must not stay invisible or half-swapped.
      const unfinished = this._entrance !== "done" || this._transitions.size > 0;
      this._settling = null;
      this._stopMotion();
      if (this._gestures.length) this._cancelGestures();
      if (this._transitions.size) this._finishTransitions();
      if (c.transitions === "off" || reason === "yielded") this._skipEntrance();
      if (reason === "still" || reason === "reduced-motion" || reason === "settled")
        this._applyRest();
      else if (reason === "yielded" && unfinished) this._applyFrame(false);
      return;
    }
    if (this._lastActivity === null) this._touch();
    if (!this._clockSeeded) {
      this._clockSeeded = true;
      if (this._time === 0) {
        this._time = this._origin;
        this._settleSprings(this._stateName(), this._springs.ambient.x);
      }
    }
    if (this._entrance === "pending") {
      if (c.transitions === "on") {
        this._entrance = "playing";
        this._transitions.set("entrance", {
          kind: "entrance",
          start: this._time,
          duration: DURATIONS.entrance,
          from: null,
        });
        this._touch();
      } else this._skipEntrance();
    }
    if (this._raf === null) this._raf = clock.requestFrame(this._tick);
  }
}

export function defineSquireEmblem() {
  if (!customElements.get("squire-emblem"))
    customElements.define("squire-emblem", SquireEmblemElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "squire-emblem": SquireEmblemElement;
  }
}
