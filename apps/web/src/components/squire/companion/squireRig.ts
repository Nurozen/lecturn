/*
 * <squire-rig>: layered cutout character runtime, ported from the v5 baseline
 * (artifacts/squire-concepts/v5/src/squire-rig.js). Motion constants, poses, springs, beats,
 * gesture curves, limits, transitions, and paint order are v5's; the port changes art loading
 * (imported URLs, lazy per part), cloth tinting (pre-tinted textures, no per-frame filter), and
 * scheduling (injectable clock, 30 fps gate, focus, single-rig lease, 20 s settle).
 *
 * RIG. Coordinates are RIG_ART.stage units. Bones: body (pivot 550,1300) parents head
 * (joint 560,440) and forearm (public name `arm`, the elbow at 400,990). Grip art holds forearm,
 * hands and item; the torso owns shoulder and upper arm. Paint order:
 *   aura FX | body[ nape-fill, head[ head-alt, head, hood-wrap[hood], head FX ], torso-wrap[
 *   torso, torso FX ], arm[ grip-out-wrap, grip-wrap[ grip, item FX ] ] ] | front FX
 * Head/hood render behind the torso so the collar covers the neck join. The head rocks about
 * RIG_ART.rock.nape (chin down) or .throat (chin up) so its painted cut always slides behind
 * the collar; a static head copy masked to RIG_ART.napeFill backs the nape. The raised hood
 * lives in the head bone for paint order but carries its own matrix: it follows part of the
 * head turn about its own base, and the face clip rides with it. The forearm inherits the
 * torso's exact breath matrix (elbow and any baked patch stay registered).
 *
 * MOTION. Ambient channels are pure functions of rig time t; springs smooth state weights
 * (slightly underdamped, with anticipation), gaze, eyes, motion level and the hood trail.
 *   Breath     asymmetric (inhale 40%, exhale 50%, hold 10%), seeded per-cycle period +-12%
 *              and depth 0.8-1.15, a sigh every ~25-40 s (depth 1.8, head drops).
 *   Weight     body rotation from three incommensurate sines (7.3 s, 3.1 s, 13.7 s).
 *   Head       lagged follow-through, partial counter-rotation, slow drift, pitch. Horizontal
 *              gaze is mostly eyes (frame.eye, leading the head ~80 ms).
 *   Hood       follows 45% of the head turn through a spring (trails); clip rides along.
 *   Beats      deterministic idle variations (60 s windows), muted around gestures and state
 *              changes.
 *   Levels     subtle; lively (authored gesture curves, sway x1.5, beats x2); still (held
 *              state pose; switching to still blends to rest over 0.55 s first).
 * Gesture/beat deltas only use the headroom left before a limit; every bone channel is then
 * soft-limited to the measured seam limits and passed through a final critically damped
 * filter in live mode.
 */
import { acquireCompanionLease, type CompanionLease } from "./companionLease";
import { companionClock, onCompanionFocusChange } from "./companionClock";
import { RIG_ART } from "./rigArt";
import { createSquireFx } from "./squireFx";
import {
  COMPANION_GESTURES,
  COMPANION_MAX_FPS,
  COMPANION_SETTLE_MS,
  COMPANION_STATES,
  RIG_CHOICES,
  type CompanionGesture,
  type CompanionPalette,
  type CompanionPauseReason,
  type CompanionState,
  type FxController,
  type FxFrame,
  type FxTrigger,
  type GestureResult,
  type Point,
  type Range,
  type RigAppearance,
  type RigArt,
  type RigArtImage,
  type RigConfiguration,
  type RigDebugState,
  type RigEquipment,
  type RigTestChannels,
  type SetPoseInput,
} from "./types";

const NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const STATES = COMPANION_STATES;

/** Cloth tint (r, g, b, strength). Brass is the untinted original. */
export type ClothTint = readonly [number, number, number, number];
export const CLOTH_TINTS: Readonly<Record<CompanionPalette, ClothTint>> = {
  brass: [104, 125, 154, 0],
  moonstone: [104, 125, 154, 0.7],
  sage: [99, 133, 106, 0.7],
  rose: [153, 103, 115, 0.7],
  // Pure amber rather than the ring or crest gold: screened over navy, those paler golds read
  // olive. This lands on antique gold, apart from the untinted brass palette's navy cloth.
  gold: [255, 160, 0, 0.8],
};

type LimitChannel =
  | "body"
  | "bodyY"
  | "head"
  | "headX"
  | "headY"
  | "hood"
  | "arm"
  | "armX"
  | "armY";
type Limits = Readonly<Record<LimitChannel, Range>>;

// Seam limits relative to the parent bone (degrees / stage units); RIG_ART.limits wins.
const DEFAULT_LIMITS: Limits = {
  body: [-2.5, 3],
  bodyY: [-16, 12],
  head: [-4, 4.5],
  headX: [-2.5, 2],
  headY: [-0.4, 4],
  hood: [-3.5, 2],
  arm: [-2.5, 2],
  armX: [-1.5, 1.5],
  armY: [-1.5, 1.5],
};
const ROCK = {
  nape: [455, 422],
  throat: [625, 458],
  hoodBack: [300, 470],
  hoodFront: [610, 520],
} as const;
const HOOD_FOLLOW = 0.45; // Raised hood turns with this fraction of a chin-down angle,
const HOOD_FOLLOW_UP = 0.85; // and this fraction of a chin-up angle (keeps the crown closed),
const HOOD_FOLLOW_X = 0.6; // and this fraction of its translation (forward / vertical).
const BREATH_LIFT = 0.0055; // Torso vertical scale per unit breath (sigh 1.8 -> ~1%).
const BREATH_SPREAD = -0.0016; // Horizontal counter-scale (volume preservation).
const BREATH_BOB = 1.2; // Whole-figure rise per unit breath, stage units.
const SWAY_DEG = 0.65; // Weight-shift peak, degrees.
const GAZE_DEG = 1.8; // Head turn per unit horizontal gaze (eyes do the rest),
const GAZE_DEG_POINTER = 2; // and a little more when following the pointer.
const GAZE_X = 1; // Head translation per unit gaze.
const EYE_LEAD = 0.08; // Eyes lead head-driven gaze by this many seconds.
const STILL_BLEND = 0.55; // Seconds of blend to rest before stopping (still and settle).
// The gate skips a display frame that would arrive sooner than this after the last rendered
// one; the 4 ms slack keeps a 60 Hz display at every other frame despite timestamp jitter.
const MIN_FRAME_MS = 1000 / COMPANION_MAX_FPS - 4;

type PoseDef = {
  readonly body: number;
  readonly bodyY: number;
  readonly pitch: number;
  readonly gaze: number;
  readonly eyeY: number;
  readonly arm: number;
  readonly armX: number;
  readonly armY: number;
  readonly sway: number;
  readonly breathPeriod: number;
  readonly breathDepth: number;
  readonly item: number;
  readonly counter: number;
  readonly autoGaze: number;
  readonly energy: number;
  readonly lid: number;
};
type PoseKey = keyof PoseDef;

// Held pose per state (read from a single still at panel size): idle rests with eyes lowered
// toward the item; attentive straightens and rises, lifts the chin and turns head and eyes
// back toward the viewer (negative gaze), wide-eyed, presenting the item; thinking settles
// down, bows toward the item and draws it up and in. `lid` is extra upper-lid lowering for
// FX. Attentive's turn holds (autoGaze 0) so the settled frame keeps it. Thinking is deeper
// than v5 (bow 4.4 -> 5, sink 9 -> 11, half-lid 0.35 -> 0.55). Blended by spring weights
// (which may overshoot slightly).
const POSES: Readonly<Record<CompanionState, PoseDef>> = {
  idle: {
    body: 0,
    bodyY: 0,
    pitch: 0.2,
    gaze: 0,
    eyeY: 0.8,
    arm: 0,
    armX: 0,
    armY: 0,
    sway: 1,
    breathPeriod: 4.4,
    breathDepth: 1,
    item: 1,
    counter: 0.7,
    autoGaze: 1,
    energy: 0.3,
    lid: 0.3,
  },
  attentive: {
    body: -1,
    bodyY: -14,
    pitch: -2.4,
    gaze: -1,
    eyeY: -0.5,
    arm: -1.8,
    armX: 1,
    armY: -1.2,
    sway: 0.5,
    breathPeriod: 3.6,
    breathDepth: 0.8,
    item: 0.6,
    counter: 0.6,
    autoGaze: 0,
    energy: 0.85,
    lid: 0,
  },
  thinking: {
    body: 1.8,
    bodyY: 11,
    pitch: 5,
    gaze: 0.35,
    eyeY: 1,
    arm: -2.4,
    armX: -1.2,
    armY: -1.5,
    sway: 0.5,
    breathPeriod: 6.2,
    breathDepth: 1.4,
    item: 0.25,
    counter: 0.9,
    autoGaze: 0,
    energy: 0.6,
    lid: 0.55,
  },
};
const ANTICIPATE = ["body", "bodyY", "pitch", "arm", "armX", "armY"] as const;
type AnticipateKey = (typeof ANTICIPATE)[number];

type ItemIdle = { readonly arm: number; readonly armX: number; readonly armY: number };
// Forearm idle per grip: small rotation about the elbow (+ = item dips) and translation.
const ITEM_IDLE: Readonly<Record<RigEquipment, (t: number, s: number) => ItemIdle>> = {
  helmet: (t, s) => ({ arm: 0.35 * wave(t, 5.7, 0.4) + 0.2 * s, armX: 0, armY: 0 }),
  lance: (t, s) => ({ arm: 0.6 * s + 0.3 * wave(t, 6.3, 1.2), armX: 0, armY: 0 }),
  astrolabe: (t) => {
    const k = 0.5 - 0.5 * Math.cos((t * TAU) / 6.9);
    return { arm: -0.55 * k, armX: 1 * k, armY: 0 };
  },
  grimoire: (t) => {
    const k = 0.5 - 0.5 * Math.cos((t * TAU) / 6.1 + 0.8);
    return { arm: -0.6 * k, armX: 0, armY: -0.9 * k };
  },
  armillary: (t) => {
    const k = 0.5 - 0.5 * Math.cos((t * TAU) / 7.4 + 2.1);
    return { arm: -0.5 * k, armX: 0.9 * k, armY: 0 };
  },
  none: (t) => {
    const k = 0.5 - 0.5 * Math.cos((t * TAU) / 5.2 + 0.3);
    return { arm: -0.65 * k, armX: 0, armY: -0.6 * k };
  },
};

const CHANNELS = [
  "body",
  "bodyY",
  "pitch",
  "gaze",
  "eyeY",
  "headX",
  "headY",
  "arm",
  "armX",
  "armY",
] as const;
type Channel = (typeof CHANNELS)[number];
type ChannelValues = Partial<Record<Channel, number>>;

type BeatDef = ChannelValues & {
  readonly hold: number;
  readonly omega: number;
  readonly rebound?: number;
  readonly after?: ChannelValues;
};
type BeatKind =
  | "lookItem"
  | "lookAway"
  | "grip"
  | "nod"
  | "glanceUp"
  | "ponder"
  | "turnItem"
  | "checkIn"
  | "consider";

// Idle beats: critically damped pulses (rise at start, release after `hold`).
const BEATS: Readonly<Record<BeatKind, BeatDef>> = {
  lookItem: { hold: 1.7, omega: 4.5, pitch: 2.6, gaze: 0.45, eyeY: 0.6, arm: -0.45 },
  lookAway: { hold: 1.1, omega: 5, gaze: -0.85, pitch: -0.8, headX: -0.8 },
  grip: { hold: 0.6, omega: 5, arm: -1.1, armY: -0.5, body: 0.12 },
  nod: { hold: 0.7, omega: 3.2, pitch: 2.2, headY: 1, rebound: 0.18 },
  glanceUp: { hold: 0.55, omega: 7, pitch: -2.2, gaze: 0.3, eyeY: -0.5 },
  ponder: { hold: 1.5, omega: 4, pitch: -2.2, gaze: -0.4, eyeY: -0.4 },
  turnItem: { hold: 0.9, omega: 5, arm: -0.8, pitch: 0.6 },
  // Attentive check-in: quick lift, eyes further toward the viewer, tiny bounce.
  checkIn: {
    hold: 0.35,
    omega: 9,
    bodyY: -3,
    pitch: -1.4,
    gaze: -0.25,
    eyeY: -0.3,
    arm: -0.5,
    rebound: 0.35,
  },
  // Thinking consider: head tilts, item turns/lifts, eyes down then up.
  consider: {
    hold: 1.1,
    omega: 4.5,
    pitch: 1.2,
    headX: 0.7,
    arm: -1,
    armY: -0.4,
    eyeY: 0.5,
    after: { eyeY: -0.9, pitch: -0.6 },
  },
};
const INTRO_BEAT: Readonly<Record<CompanionState, BeatKind>> = {
  idle: "lookItem",
  attentive: "checkIn",
  thinking: "consider",
};
type Schedule = {
  readonly seed: number;
  readonly first: number;
  readonly gap: Range;
  readonly kinds: readonly BeatKind[];
  readonly repeats?: boolean;
};
const SCHEDULES: Readonly<Record<CompanionState, Schedule>> = {
  idle: { seed: 11, first: 3.2, gap: [6, 11], kinds: ["lookItem", "lookAway", "grip", "nod"] },
  attentive: {
    seed: 23,
    first: 3,
    gap: [3.5, 5],
    kinds: ["checkIn", "checkIn", "glanceUp"],
    repeats: true,
  },
  thinking: {
    seed: 37,
    first: 3.5,
    gap: [5, 7],
    kinds: ["consider", "consider", "turnItem", "ponder"],
    repeats: true,
  },
};
const OUTPUT_CHANNELS = [
  "body",
  "bodyY",
  "head",
  "headX",
  "headY",
  "headPitch",
  "gaze",
  "arm",
  "armX",
  "armY",
  "breath",
] as const;
type OutputChannel = (typeof OUTPUT_CHANNELS)[number];
const OUTPUT_OMEGA = 16;
const OUTPUT_OMEGA_HEAD = 12; // Head and pitch: rounds beat reversals at their peaks.

type Keys = readonly (readonly [number, number])[];
type Track = (s: number) => number;
type GestureLevel = Partial<Record<Channel, Keys>>;
type GestureSource = {
  readonly duration: number;
  readonly energy: number;
  readonly fxAt?: number;
  readonly subtle: GestureLevel;
  readonly lively: GestureLevel;
};

// Gesture tracks: [seconds, value] keys, Hermite-interpolated with flat extremes. Each level
// is authored inside the seam limits (blended by the lively spring, never scaled up and
// clamped). Holds keep 0.2-0.3 deg of drift so they stay alive.
// Raised past v5 so each reads at the 340 px panel, where a degree of head turn is under 2 px,
// and each peak is its own still: nod sinks and bows with the chin tucked (the head drops
// ~8 px) then rebounds chin-up; greet draws up, turns head and eyes to the viewer and waves the
// raised item; listen leans in with the chin up and the head drawn back toward the sound
// behind the ear; ponder sits back with the item drawn up and in, head tilting (its warm
// rising thought, not the pose, sets it apart from thinking);
// glance leans in and lifts the item as head and eyes snap down to it and back, eyes leading
// (gaze peaks ahead of the head). Soft limits keep every channel inside the seams.
const GESTURE_SOURCE: Readonly<Record<CompanionGesture, GestureSource>> = {
  nod: {
    duration: 1.05,
    energy: 0.08,
    subtle: {
      pitch: [
        [0, 0],
        [0.14, -1.1],
        [0.36, 4.2],
        [0.6, 3.95],
        [0.77, -1.4],
        [0.91, 0.3],
        [1.05, 0],
      ],
      headY: [
        [0, 0],
        [0.14, -0.4],
        [0.36, 3.6],
        [0.6, 3.4],
        [0.78, -0.5],
        [1.05, 0],
      ],
      body: [
        [0, 0],
        [0.14, -0.2],
        [0.38, 2.2],
        [0.62, 2],
        [0.82, -0.3],
        [1.05, 0],
      ],
      bodyY: [
        [0, 0],
        [0.14, -0.6],
        [0.38, 12],
        [0.62, 11.2],
        [0.8, -1],
        [1.05, 0],
      ],
      arm: [
        [0, 0],
        [0.16, -0.3],
        [0.42, 1.1],
        [0.62, 0.95],
        [1.05, 0],
      ],
      eyeY: [
        [0, 0],
        [0.34, 0.6],
        [0.62, 0.5],
        [1.05, 0],
      ],
    },
    lively: {
      pitch: [
        [0, 0],
        [0.13, -1.6],
        [0.35, 5],
        [0.6, 4.7],
        [0.77, -1.8],
        [0.91, 0.45],
        [1.05, 0],
      ],
      headY: [
        [0, 0],
        [0.13, -0.5],
        [0.35, 3.9],
        [0.6, 3.7],
        [0.78, -0.6],
        [1.05, 0],
      ],
      body: [
        [0, 0],
        [0.13, -0.3],
        [0.37, 2.6],
        [0.62, 2.4],
        [0.82, -0.4],
        [1.05, 0],
      ],
      bodyY: [
        [0, 0],
        [0.13, -0.9],
        [0.37, 12],
        [0.62, 11.2],
        [0.8, -1.4],
        [1.05, 0],
      ],
      arm: [
        [0, 0],
        [0.15, -0.4],
        [0.4, 1.5],
        [0.62, 1.3],
        [1.05, 0],
      ],
      eyeY: [
        [0, 0],
        [0.32, 0.7],
        [0.62, 0.6],
        [1.05, 0],
      ],
    },
  },
  greet: {
    duration: 1.4,
    energy: 0.15,
    subtle: {
      arm: [
        [0, 0],
        [0.18, 0.5],
        [0.5, -2.5],
        [0.66, -1.2],
        [0.82, -2.5],
        [0.98, -1.2],
        [1.18, 0.3],
        [1.4, 0],
      ],
      armX: [
        [0, 0],
        [0.55, 1.4],
        [0.9, 1.25],
        [1.4, 0],
      ],
      armY: [
        [0, 0],
        [0.55, -1.5],
        [0.9, -1.4],
        [1.4, 0],
      ],
      body: [
        [0, 0],
        [0.16, 0.3],
        [0.55, -1.2],
        [0.9, -1.05],
        [1.15, 0.15],
        [1.4, 0],
      ],
      bodyY: [
        [0, 0],
        [0.16, 0.8],
        [0.55, -10],
        [0.9, -9.2],
        [1.4, 0],
      ],
      pitch: [
        [0, 0],
        [0.16, 0.4],
        [0.6, -1.4],
        [0.92, -1.2],
        [1.16, 0.25],
        [1.4, 0],
      ],
      gaze: [
        [0, 0],
        [0.45, -1.1],
        [1, -1],
        [1.4, 0],
      ],
      eyeY: [
        [0, 0],
        [0.5, -0.2],
        [1, -0.15],
        [1.4, 0],
      ],
    },
    lively: {
      arm: [
        [0, 0],
        [0.18, 0.7],
        [0.5, -2.8],
        [0.66, -1.4],
        [0.82, -2.8],
        [0.98, -1.4],
        [1.18, 0.4],
        [1.4, 0],
      ],
      armX: [
        [0, 0],
        [0.55, 1.5],
        [0.9, 1.3],
        [1.4, 0],
      ],
      armY: [
        [0, 0],
        [0.55, -1.5],
        [0.9, -1.35],
        [1.4, 0],
      ],
      body: [
        [0, 0],
        [0.16, 0.4],
        [0.55, -2.2],
        [0.9, -1.95],
        [1.15, 0.2],
        [1.4, 0],
      ],
      bodyY: [
        [0, 0],
        [0.16, 1.1],
        [0.55, -11],
        [0.9, -10.2],
        [1.4, 0],
      ],
      pitch: [
        [0, 0],
        [0.16, 0.5],
        [0.6, -1.8],
        [0.92, -1.55],
        [1.16, 0.3],
        [1.4, 0],
      ],
      gaze: [
        [0, 0],
        [0.45, -1.25],
        [1, -1.1],
        [1.4, 0],
      ],
      eyeY: [
        [0, 0],
        [0.5, -0.25],
        [1, -0.2],
        [1.4, 0],
      ],
    },
  },
  flourish: {
    duration: 1.3,
    energy: 0.4,
    fxAt: 0.42,
    subtle: {
      arm: [
        [0, 0],
        [0.18, 0.8],
        [0.5, -2.2],
        [0.72, -1.95],
        [0.98, 0.3],
        [1.15, -0.08],
        [1.3, 0],
      ],
      bodyY: [
        [0, 0],
        [0.18, 2],
        [0.5, -6],
        [0.75, -5.4],
        [1.05, 0.6],
        [1.3, 0],
      ],
      body: [
        [0, 0],
        [0.18, 0.25],
        [0.5, -0.5],
        [0.9, -0.3],
        [1.3, 0],
      ],
      pitch: [
        [0, 0],
        [0.18, 0.8],
        [0.5, -2],
        [0.8, -1.7],
        [1.1, 0.2],
        [1.3, 0],
      ],
      eyeY: [
        [0, 0],
        [0.45, -0.4],
        [0.9, -0.3],
        [1.3, 0],
      ],
    },
    lively: {
      arm: [
        [0, 0],
        [0.18, 1.2],
        [0.5, -2.4],
        [0.72, -2.15],
        [0.98, 0.45],
        [1.15, -0.1],
        [1.3, 0],
      ],
      bodyY: [
        [0, 0],
        [0.18, 3],
        [0.5, -8],
        [0.75, -7.2],
        [1.05, 0.9],
        [1.3, 0],
      ],
      body: [
        [0, 0],
        [0.18, 0.4],
        [0.5, -0.8],
        [0.9, -0.5],
        [1.3, 0],
      ],
      pitch: [
        [0, 0],
        [0.18, 1.2],
        [0.5, -3],
        [0.8, -2.6],
        [1.1, 0.3],
        [1.3, 0],
      ],
      eyeY: [
        [0, 0],
        [0.45, -0.5],
        [0.9, -0.4],
        [1.3, 0],
      ],
    },
  },
  glance: {
    duration: 1.3,
    energy: 0.05,
    subtle: {
      gaze: [
        [0, 0],
        [0.08, -0.3],
        [0.26, 1.25],
        [0.85, 1.2],
        [1.05, -0.1],
        [1.3, 0],
      ],
      eyeY: [
        [0, 0],
        [0.24, 1],
        [0.85, 0.95],
        [1.3, 0],
      ],
      pitch: [
        [0, 0],
        [0.1, -0.7],
        [0.3, 3.4],
        [0.85, 3.2],
        [1.06, -0.4],
        [1.3, 0],
      ],
      headX: [
        [0, 0],
        [0.3, 1.5],
        [0.85, 1.4],
        [1.3, 0],
      ],
      body: [
        [0, 0],
        [0.1, -0.3],
        [0.32, 2.2],
        [0.88, 2],
        [1.1, -0.2],
        [1.3, 0],
      ],
      bodyY: [
        [0, 0],
        [0.1, -0.5],
        [0.32, 3],
        [0.88, 2.7],
        [1.3, 0],
      ],
      arm: [
        [0, 0],
        [0.32, -2.2],
        [0.88, -2],
        [1.3, 0],
      ],
      armY: [
        [0, 0],
        [0.32, -1.2],
        [0.88, -1.1],
        [1.3, 0],
      ],
    },
    lively: {
      gaze: [
        [0, 0],
        [0.08, -0.35],
        [0.24, 1.25],
        [0.85, 1.22],
        [1.05, -0.12],
        [1.3, 0],
      ],
      eyeY: [
        [0, 0],
        [0.24, 1],
        [0.85, 1],
        [1.3, 0],
      ],
      pitch: [
        [0, 0],
        [0.1, -0.8],
        [0.3, 3.9],
        [0.85, 3.7],
        [1.06, -0.45],
        [1.3, 0],
      ],
      headX: [
        [0, 0],
        [0.3, 1.6],
        [0.85, 1.5],
        [1.3, 0],
      ],
      body: [
        [0, 0],
        [0.1, -0.35],
        [0.32, 2.6],
        [0.88, 2.4],
        [1.1, -0.25],
        [1.3, 0],
      ],
      bodyY: [
        [0, 0],
        [0.1, -0.6],
        [0.32, 3.6],
        [0.88, 3.2],
        [1.3, 0],
      ],
      arm: [
        [0, 0],
        [0.32, -2.5],
        [0.88, -2.3],
        [1.3, 0],
      ],
      armY: [
        [0, 0],
        [0.32, -1.4],
        [0.88, -1.3],
        [1.3, 0],
      ],
    },
  },
  listen: {
    duration: 1.6,
    energy: 0.1,
    subtle: {
      body: [
        [0, 0],
        [0.15, -0.3],
        [0.5, 2.5],
        [1.1, 2.2],
        [1.4, -0.2],
        [1.6, 0],
      ],
      bodyY: [
        [0, 0],
        [0.15, 0.6],
        [0.5, -2.5],
        [1.1, -2.2],
        [1.4, 0.3],
        [1.6, 0],
      ],
      pitch: [
        [0, 0],
        [0.15, 0.6],
        [0.5, -3.2],
        [1.1, -2.9],
        [1.4, 0.3],
        [1.6, 0],
      ],
      headX: [
        [0, 0],
        [0.5, -1.4],
        [1.1, -1.3],
        [1.6, 0],
      ],
      gaze: [
        [0, 0],
        [0.4, -0.7],
        [1.1, -0.6],
        [1.6, 0],
      ],
      eyeY: [
        [0, 0],
        [0.4, -0.3],
        [1.1, -0.25],
        [1.6, 0],
      ],
      arm: [
        [0, 0],
        [0.5, 1.5],
        [1.1, 1.35],
        [1.6, 0],
      ],
    },
    lively: {
      body: [
        [0, 0],
        [0.15, -0.35],
        [0.5, 2.8],
        [1.1, 2.5],
        [1.4, -0.25],
        [1.6, 0],
      ],
      bodyY: [
        [0, 0],
        [0.15, 0.8],
        [0.5, -3.5],
        [1.1, -3.1],
        [1.4, 0.4],
        [1.6, 0],
      ],
      pitch: [
        [0, 0],
        [0.15, 0.7],
        [0.5, -3.6],
        [1.1, -3.3],
        [1.4, 0.35],
        [1.6, 0],
      ],
      headX: [
        [0, 0],
        [0.5, -1.5],
        [1.1, -1.4],
        [1.6, 0],
      ],
      gaze: [
        [0, 0],
        [0.4, -0.85],
        [1.1, -0.75],
        [1.6, 0],
      ],
      eyeY: [
        [0, 0],
        [0.4, -0.4],
        [1.1, -0.35],
        [1.6, 0],
      ],
      arm: [
        [0, 0],
        [0.5, 1.8],
        [1.1, 1.6],
        [1.6, 0],
      ],
    },
  },
  ponder: {
    duration: 1.8,
    energy: 0.12,
    subtle: {
      pitch: [
        [0, 0],
        [0.12, -0.6],
        [0.45, 3],
        [0.7, 2.4],
        [0.95, 3.2],
        [1.2, 2.6],
        [1.5, -0.3],
        [1.8, 0],
      ],
      headX: [
        [0, 0],
        [0.45, -1.2],
        [0.7, -0.8],
        [0.95, -1.3],
        [1.2, -0.9],
        [1.5, 0],
        [1.8, 0],
      ],
      gaze: [
        [0, 0],
        [0.45, 0.45],
        [1.2, 0.45],
        [1.8, 0],
      ],
      eyeY: [
        [0, 0],
        [0.4, 0.9],
        [1.25, 0.85],
        [1.8, 0],
      ],
      arm: [
        [0, 0],
        [0.45, -2.2],
        [1.2, -2],
        [1.8, 0],
      ],
      armX: [
        [0, 0],
        [0.45, -1.3],
        [1.2, -1.15],
        [1.8, 0],
      ],
      armY: [
        [0, 0],
        [0.45, -1.2],
        [1.2, -1.05],
        [1.8, 0],
      ],
      body: [
        [0, 0],
        [0.12, 0.25],
        [0.45, -2],
        [1.3, -1.8],
        [1.8, 0],
      ],
      bodyY: [
        [0, 0],
        [0.45, 3.6],
        [1.3, 3.2],
        [1.8, 0],
      ],
    },
    lively: {
      pitch: [
        [0, 0],
        [0.12, -0.8],
        [0.45, 3.4],
        [0.7, 2.8],
        [0.95, 3.6],
        [1.2, 3],
        [1.5, -0.4],
        [1.8, 0],
      ],
      headX: [
        [0, 0],
        [0.45, -1.4],
        [0.7, -1],
        [0.95, -1.5],
        [1.2, -1.1],
        [1.5, 0],
        [1.8, 0],
      ],
      gaze: [
        [0, 0],
        [0.45, 0.55],
        [1.2, 0.55],
        [1.8, 0],
      ],
      eyeY: [
        [0, 0],
        [0.4, 0.95],
        [1.25, 0.9],
        [1.8, 0],
      ],
      arm: [
        [0, 0],
        [0.45, -2.6],
        [1.2, -2.3],
        [1.8, 0],
      ],
      armX: [
        [0, 0],
        [0.45, -1.45],
        [1.2, -1.3],
        [1.8, 0],
      ],
      armY: [
        [0, 0],
        [0.45, -1.4],
        [1.2, -1.2],
        [1.8, 0],
      ],
      body: [
        [0, 0],
        [0.12, 0.3],
        [0.45, -2.4],
        [1.3, -2.15],
        [1.8, 0],
      ],
      bodyY: [
        [0, 0],
        [0.45, 4.6],
        [1.3, 4.2],
        [1.8, 0],
      ],
    },
  },
};

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const smooth = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const sine = (v: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(v));
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);
const easeIn = (v: number) => Math.pow(clamp01(v), 3);
const easeOutBack = (v: number, s = 1.4) => {
  const x = clamp01(v) - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const fmt = (v: number) => (Math.abs(v) < 5e-4 ? 0 : Math.round(v * 1000) / 1000);
function wave(t: number, period: number, phase = 0) {
  return Math.sin((t * TAU) / period + phase);
}

// 2D affine matrices [a b c d e f] as in SVG matrix().
type Matrix = readonly [number, number, number, number, number, number];
const mat = {
  mul: (m: Matrix, n: Matrix): Matrix => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ],
  inv: (m: Matrix): Matrix => {
    const d = m[0] * m[3] - m[1] * m[2];
    return [
      m[3] / d,
      -m[1] / d,
      -m[2] / d,
      m[0] / d,
      (m[2] * m[5] - m[3] * m[4]) / d,
      (m[1] * m[4] - m[0] * m[5]) / d,
    ];
  },
  rotate: (deg: number, [cx, cy]: Point): Matrix => {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
  },
  translate: (x: number, y: number): Matrix => [1, 0, 0, 1, x, y],
  css: (m: Matrix) => `matrix(${m.map((v) => Math.round(v * 1e6) / 1e6).join(" ")})`,
};
// Rotation about a pivot that slides between two anchors with the sign of the angle.
function rock(deg: number, negative: Point, positive: Point, softness = 0.8) {
  const k = 0.5 + 0.5 * Math.tanh(deg / softness);
  return mat.rotate(deg, [lerp(negative[0], positive[0], k), lerp(negative[1], positive[1], k)]);
}

// Gesture/beat deltas only get the headroom left in their direction, so stacked poses
// (thinking + nod) stay readable instead of pinning against the limit.
function room(base: number, delta: number, range: Range) {
  const limit = delta > 0 ? range[1] : -range[0];
  const used = Math.max(0, delta > 0 ? base : -base);
  return delta * Math.max(0.3, 1 - used / limit);
}

// Linear through 70% of the range, then eases into the limit (no hard stops).
function softLimit(v: number, range: Range) {
  const [lo, hi] = range;
  const k = 0.7;
  if (v > hi * k) {
    const r = hi * (1 - k);
    return hi * k + r * Math.tanh((v - hi * k) / r);
  }
  if (v < lo * k) {
    const r = -lo * (1 - k);
    return lo * k - r * Math.tanh((lo * k - v) / r);
  }
  return v;
}

function hash(seed: number, n: number) {
  let x = Math.imul(seed * 374761393 + n * 668265263, 0x85ebca6b) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

function keyed(keys: Keys): Track {
  const n = keys.length;
  const at = (i: number) => keys[Math.max(0, Math.min(n - 1, i))] ?? [0, 0];
  const m = keys.map((key, i) => {
    if (i === 0 || i === n - 1) return 0;
    const a = key[1] - at(i - 1)[1];
    const b = at(i + 1)[1] - key[1];
    return a * b <= 0 ? 0 : (at(i + 1)[1] - at(i - 1)[1]) / (at(i + 1)[0] - at(i - 1)[0]);
  });
  return (s) => {
    if (s <= at(0)[0]) return at(0)[1];
    if (s >= at(n - 1)[0]) return at(n - 1)[1];
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
      (u3 - 2 * u2 + u) * h * (m[i] ?? 0) +
      (-2 * u3 + 3 * u2) * v1 +
      (u3 - u2) * h * (m[i + 1] ?? 0)
    );
  };
}

type GestureDef = {
  readonly duration: number;
  readonly energy: number;
  readonly fxAt: number | undefined;
  readonly subtle: readonly (readonly [Channel, Track])[];
  readonly lively: readonly (readonly [Channel, Track])[];
};
function compileLevel(level: GestureLevel) {
  const out: (readonly [Channel, Track])[] = [];
  for (const channel of CHANNELS) {
    const keys = level[channel];
    if (keys) out.push([channel, keyed(keys)]);
  }
  return out;
}
const GESTURES = Object.fromEntries(
  COMPANION_GESTURES.map((name) => {
    const source = GESTURE_SOURCE[name];
    const def: GestureDef = {
      duration: source.duration,
      energy: source.energy,
      fxAt: source.fxAt,
      subtle: compileLevel(source.subtle),
      lively: compileLevel(source.lively),
    };
    return [name, def];
  }),
) as Record<CompanionGesture, GestureDef>;
const isGesture = (name: string): name is CompanionGesture =>
  (COMPANION_GESTURES as readonly string[]).includes(name);

type Spring = { x: number; v: number };
// Exact critically damped spring step toward a fixed target.
function spring(s: Spring, target: number, omega: number, dt: number) {
  const x0 = s.x - target;
  const v0 = s.v;
  const e = Math.exp(-omega * dt);
  s.x = target + (x0 + (v0 + omega * x0) * dt) * e;
  s.v = (v0 - omega * (v0 + omega * x0) * dt) * e;
}
// Damped spring with ratio zeta (< 1 overshoots), integrated in small substeps.
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

// Step response of a critically damped spring; up at 0, back down at `hold`.
function pulse(tau: number, hold: number, omega: number) {
  const step = (x: number) => (x <= 0 ? 0 : 1 - (1 + omega * x) * Math.exp(-omega * x));
  return step(tau) - step(tau - hold);
}

// Asymmetric breath, phase 0..1 -> lungs 0..1.
function breathShape(phase: number) {
  const u = phase - Math.floor(phase);
  if (u < 0.4) return sine(u / 0.4);
  if (u < 0.9) return 1 - sine((u - 0.4) / 0.5);
  return 0;
}
// Per-cycle variation in blocks of 8 cycles: one sigh per block (so one every 6-10 cycles,
// ~25-40 s) and period jitter (+-12%) that sums to zero across the block's other cycles, so
// every block lasts exactly BREATH_BLOCK base periods and phase lookup is O(1) at any time.
const BREATH_BLOCK = 8.4;
const sighIndex = (k: number) => 2 + Math.floor(hash(71, k) * 3);
function breathCycle(n: number) {
  const k = Math.floor(n / 8);
  const i = n - 8 * k;
  const sighAt = sighIndex(k);
  if (i === sighAt) return { period: 1.4, depth: 1.8, sigh: true };
  let mean = 0;
  for (let j = 0; j < 8; j++) if (j !== sighAt) mean += hash(53, 8 * k + j) / 7;
  return { period: 1 + 0.24 * (hash(53, n) - mean), depth: 0.8 + 0.35 * hash(59, n), sigh: false };
}
// Breath phase (cycles) at `time` for a fixed base period, as used by holds.
function breathPhaseAt(time: number, base: number) {
  const k = Math.floor(time / (base * BREATH_BLOCK));
  let t = k * base * BREATH_BLOCK;
  let n = 8 * k;
  for (let i = 0; i < 8; i++, n++) {
    const d = base * breathCycle(n).period;
    if (t + d > time) return n + (time - t) / d;
    t += d;
  }
  return n;
}

// Weight shift, roughly -1..1, never metronomic.
function sway(t: number) {
  return (
    0.6 * wave(t, 7.3) +
    0.27 * wave(t, 3.1, 1.1) +
    0.2 * wave(t, 13.7, 2.3) -
    0.27 * Math.sin(1.1) -
    0.2 * Math.sin(2.3)
  );
}

const AUTO_GAZE = [0.6, -0.55, 0.45, -0.6] as const;
// A small, eased look once every 19 seconds; quiet for the first 8 s after `origin` (when
// the instance's clock started), so a freshly shown rig settles before it looks around.
function autoGaze(time: number, origin = 0) {
  const since = time - origin;
  if (since >= 0 && since < 8) return 0;
  const cycle = Math.floor(time / 19);
  const phase = time - 19 * cycle;
  const amount = AUTO_GAZE[((cycle % 4) + 4) % 4] ?? 0;
  let v = 0;
  if (phase >= 8 && phase < 10) v = amount * smooth((phase - 8) / 2);
  else if (phase >= 10 && phase < 11) v = amount;
  else if (phase >= 11 && phase < 13) v = amount * (1 - smooth((phase - 11) / 2));
  return since >= 0 && since < 10 ? v * smooth((since - 8) / 2) : v;
}

type BeatEvent = { readonly start: number; readonly kind: BeatKind };
type MuteFn = (start: number, beat: BeatDef, prevStart: number, intro?: boolean) => boolean;
// Beat schedule in independent 60 s windows (events keep >= 6 s apart across window edges),
// so any time is addressable without walking from zero. A small cache holds recent windows.
const BEAT_WINDOW = 60;
const windowCache = new Map<string, BeatEvent[]>();
function beatWindow(state: CompanionState, w: number) {
  const key = `${state}:${w}`;
  const cached = windowCache.get(key);
  if (cached) {
    windowCache.delete(key);
    windowCache.set(key, cached);
    return cached;
  }
  const plan = SCHEDULES[state];
  const seed = plan.seed * 7919 + w * 31;
  const list: BeatEvent[] = [];
  let start = w * BEAT_WINDOW + plan.gap[0] * hash(seed, 0);
  for (let k = 0; start <= (w + 1) * BEAT_WINDOW - plan.gap[0]; k++) {
    let index = Math.floor(hash(seed + 1, k) * plan.kinds.length);
    if (k && !plan.repeats && plan.kinds.length > 1 && plan.kinds[index] === list[k - 1]?.kind) {
      index = (index + 1) % plan.kinds.length;
    }
    list.push({ start, kind: plan.kinds[index] ?? "lookItem" });
    start += lerp(plan.gap[0], plan.gap[1], hash(seed, k + 1));
  }
  windowCache.set(key, list);
  if (windowCache.size > 24) {
    const oldest = windowCache.keys().next();
    if (!oldest.done) windowCache.delete(oldest.value);
  }
  return list;
}
// Beats at `time` for a state's schedule; `mute(start, beat, prevStart)` drops events.
function beatsAt(state: CompanionState, time: number, mute: MuteFn, extra: BeatEvent) {
  const w = Math.floor(time / BEAT_WINDOW);
  const list = [...beatWindow(state, w - 1), ...beatWindow(state, w), extra];
  list.sort((a, b) => a.start - b.start);
  let lo = -1;
  for (let i = 0; i < list.length && (list[i]?.start ?? Infinity) <= time; i++) lo = i;
  const out: ChannelValues = {};
  for (const i of [lo - 1, lo]) {
    const event = list[i];
    if (!event || event.start > time) continue;
    const prev = list[i - 1];
    const beat = BEATS[event.kind];
    if (event !== extra && mute(event.start, beat, prev ? prev.start : -Infinity)) continue;
    if (event === extra && mute(event.start, beat, -Infinity, true)) continue;
    const tau = time - event.start;
    // Optional rebound (a small counter-move after release, so beats settle instead of
    // twitching) and `after` channels that move only once the beat releases.
    const x = (tau - beat.hold) * beat.omega;
    const tail = x > 0 ? x * Math.exp(1 - x) : 0;
    const k = pulse(tau, beat.hold, beat.omega) - (beat.rebound ? beat.rebound * tail : 0);
    if (Math.abs(k) < 1e-4 && tail < 1e-4) continue;
    for (const channel of CHANNELS) {
      const v = (beat[channel] ?? 0) * k + (beat.after?.[channel] ? beat.after[channel] * tail : 0);
      if (v) out[channel] = (out[channel] ?? 0) + v;
    }
  }
  return out;
}

// Transition curves (seconds).
// Equipment: both grips stay opaque; the old one swings out, they cut on one frame (under
// the FX flash), the new one swings in from below with overshoot.
const EQUIP = { duration: 0.56, swapAt: 0.09, fade: 0.05 };
const GRIP_OUT_ROT = 16;
const GRIP_OUT_Y = 6;
const GRIP_IN_ROT = keyed([
  [-0.025, 14],
  [0.2, -1.6],
  [0.33, 0.4],
  [0.46, 0],
]);
const GRIP_IN_Y = keyed([
  [-0.025, 16],
  [0.2, -1.8],
  [0.33, 0.4],
  [0.46, 0],
]);
const APPEAR = { duration: 0.5, wipeStart: 0.14, wipe: 0.12 };
const APPEAR_PITCH = keyed([
  [0, 0],
  [0.16, 2.5],
  [0.28, 2.3],
  [0.4, -0.6],
  [0.5, 0],
]);
const APPEAR_Y = keyed([
  [0, 0],
  [0.16, 2.5],
  [0.28, 2.2],
  [0.4, -0.3],
  [0.5, 0],
]);
const HOOD_UP = { duration: 0.65, travel: 0.45, fadeIn: 0.07, clipAt: 0.18, blinkAt: 0.36 };
const HOOD_LAND_PITCH = keyed([
  [0, 0],
  [0.3, 0],
  [0.42, 1.5],
  [0.65, 0],
]);
const HOOD_DOWN = { duration: 0.42, fadeOut: 0.1 };
const PALETTE_TWEEN = 0.4;

const STYLE = `
:host { display: inline-block; width: 100%; max-width: 32rem; vertical-align: middle; }
.stage { display: block; width: 100%; height: auto; overflow: visible; }
image, .fx { pointer-events: none; }
.debug { pointer-events: none; fill: none; stroke: #62e5d4; stroke-width: 2; }
.debug[hidden] { display: none; }
.debug line, .debug circle { vector-effect: non-scaling-stroke; }
.debug text { fill: #fff; stroke: #15242d; stroke-width: 4; paint-order: stroke; font: 22px ui-monospace, monospace; }`;

// Every texture in use is held by a page-lifetime Image object. The browser then serves later
// <image href> uses (swaps, transition copies, FX copies) from its in-memory image cache:
// swaps never wait on the network or decode, and a quick re-swap cannot abort an in-flight
// request. Only parts a rig actually shows are loaded (R41); others load when switched.
const preloaded = new Map<string, HTMLImageElement>();
function preload(href: string) {
  const existing = preloaded.get(href);
  if (existing) return existing;
  const image = new Image();
  image.decoding = "async";
  image.src = href;
  preloaded.set(href, image);
  return image;
}

/**
 * v5's cloth filter, per pixel, in sRGB (color-interpolation-filters="sRGB"):
 *   navy      = feColorMatrix alpha 8 (B - R), clamped (non-premultiplied input)
 *   navyMask  = navy in SourceAlpha
 *   clothTint = flood(rgb, strength) in navyMask
 *   result    = screen(SourceGraphic, clothTint), premultiplied: c = cs + cb - cs cb
 * Only cool (B > R) pixels enter the mask, so skin and metal are untouched.
 */
export function applyClothTint(pixels: Uint8ClampedArray, tint: ClothTint) {
  const [r, g, b, strength] = tint;
  const tr = Math.round(r) / 255;
  const tg = Math.round(g) / 255;
  const tb = Math.round(b) / 255;
  const s = fmt(strength);
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = (pixels[i + 3] ?? 0) / 255;
    if (alpha === 0) continue;
    const red = (pixels[i] ?? 0) / 255;
    const green = (pixels[i + 1] ?? 0) / 255;
    const blue = (pixels[i + 2] ?? 0) / 255;
    const m = s * clamp01(8 * (blue - red)) * alpha;
    if (m <= 0) continue;
    const outAlpha = alpha + m - alpha * m;
    const screen = (cs: number, cb: number) => cs + cb - cs * cb;
    pixels[i] = Math.round((255 * screen(red * alpha, tr * m)) / outAlpha);
    pixels[i + 1] = Math.round((255 * screen(green * alpha, tg * m)) / outAlpha);
    pixels[i + 2] = Math.round((255 * screen(blue * alpha, tb * m)) / outAlpha);
    pixels[i + 3] = Math.round(255 * outAlpha);
  }
}

// Tinted cloth textures, produced once per (source, palette) and shared by every rig.
const tintedTextures = new Map<string, string>();
const tintJobs = new Map<string, Promise<string>>();
const tintKey = (src: string, palette: CompanionPalette) => `${palette}|${src}`;

/** The tinted texture URL, the original for brass, or null while it is still being produced. */
export function tintedHref(src: string, palette: CompanionPalette): string | null {
  if (CLOTH_TINTS[palette][3] <= 0.001) return src;
  return tintedTextures.get(tintKey(src, palette)) ?? null;
}

async function produceTint(src: string, tint: ClothTint) {
  const source = preload(src);
  await source.decode();
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2d canvas unavailable");
  context.drawImage(source, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  applyClothTint(data.data, tint);
  context.putImageData(data, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
  const url = URL.createObjectURL(blob);
  // Decoded before any <image> uses it, so the href swap never shows an empty frame.
  await preload(url).decode();
  return url;
}

export function requestTint(src: string, palette: CompanionPalette): Promise<string> {
  const ready = tintedHref(src, palette);
  if (ready !== null) return Promise.resolve(ready);
  const key = tintKey(src, palette);
  let job = tintJobs.get(key);
  if (!job) {
    job = produceTint(src, CLOTH_TINTS[palette])
      .catch((error: unknown) => {
        console.warn("squire-rig: cloth tint failed; showing the untinted texture", error);
        return src;
      })
      .then((url) => {
        tintedTextures.set(key, url);
        return url;
      });
    tintJobs.set(key, job);
  }
  return job;
}

let nextID = 0;

type ImageName = "torso" | "head" | "headAlt" | "hood" | "grip" | "gripOut" | "napeFill";
type HeadImage = "head" | "headAlt";
const CLOTH = ["torso", "hood", "grip"] as const;
type ClothName = (typeof CLOTH)[number];
type WrapName = "hood" | "torso" | "grip" | "gripOut" | "napeFill";
type SpringName =
  | "gaze"
  | "pitch"
  | "lively"
  | "ambient"
  | "hood"
  | "quiet"
  | "eyeX"
  | "eyeY"
  | CompanionState;

type GripPose = { readonly rot: number; readonly y: number; readonly op: number };
type HoodPose = {
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly op?: number;
  readonly band?: number;
};
type Wipe = { readonly at: number; readonly from: number; readonly side: "in" | "out" };
type Transition =
  | {
      readonly kind: "equipment";
      readonly start: number;
      readonly duration: number;
      readonly from: GripPose;
    }
  | {
      readonly kind: "hood";
      readonly start: number;
      readonly duration: number;
      readonly up: boolean;
      blinked: boolean;
      readonly from: HoodPose | null;
    }
  | {
      readonly kind: "appearance";
      readonly start: number;
      duration: number;
      wipe: Wipe;
      incoming: HeadImage;
    }
  | {
      readonly kind: "palette";
      readonly start: number;
      readonly duration: number;
      readonly palette: CompanionPalette;
    }
  | { readonly kind: "entrance"; readonly start: number; readonly duration: number };
type TransitionKind = Transition["kind"];

type ActiveGesture = {
  readonly name: CompanionGesture;
  readonly start: number;
  readonly def: GestureDef;
  readonly resolve: (result: GestureResult) => void;
  fading: boolean;
  fired: boolean;
  done: boolean;
  weight: Spring;
};
type Mute = {
  readonly from: number;
  to: number;
  readonly gesture?: boolean;
  readonly dir?: number;
  readonly state?: boolean;
};
type Settling = {
  readonly kind: "still" | "settle";
  readonly start: number;
  readonly duration: number;
  readonly ambient: number;
};
type Pose = {
  body: number;
  bodyY: number;
  head: number;
  headX: number;
  headY: number;
  headPitch: number;
  gaze: number;
  eye: { x: number; y: number };
  arm: number;
  armX: number;
  armY: number;
  breath: number;
  lively: number;
  hood: number;
};
type NapeFill = NonNullable<RigArt["napeFill"][RigAppearance]>;
type Shown = {
  readonly appearance: RigAppearance;
  readonly hood: RigConfiguration["hood"];
  readonly equipment: RigEquipment;
  readonly palette: CompanionPalette;
};

function readChoice<T extends string>(
  element: Element,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = (element.getAttribute(name) ?? "").trim().toLowerCase();
  return values.find((candidate) => candidate === value) ?? fallback;
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`squire-rig: missing ${selector}`);
  return node;
}

function setAttributes(node: Element, attributes: Readonly<Record<string, string | number>>) {
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
}

const TEMPLATE = `<style>${STYLE}
</style>
<svg class="stage" part="stage" role="img" preserveAspectRatio="xMidYMid meet">
  <defs>
    <clipPath data-clip="hood-face" clipPathUnits="userSpaceOnUse"><path/></clipPath>
    <linearGradient data-grad="napeX" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
    <linearGradient data-grad="napeY" gradientUnits="userSpaceOnUse" x1="0" x2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
    <linearGradient data-grad="hoodBand" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="385" y2="425"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
    <mask data-mask="hoodBand" maskUnits="userSpaceOnUse" x="-200" y="-200" width="1522" height="1802"><rect x="-200" y="-200" width="1522" height="1802"/><rect x="-200" y="-200" width="1522" height="1802" fill="#fff"/></mask>
    <mask data-mask="napeY" maskUnits="userSpaceOnUse" x="0" y="0" width="1122" height="1402"><rect x="0" y="0" width="1122" height="1402"/></mask>
    <mask data-mask="nape" maskUnits="userSpaceOnUse" x="0" y="0" width="1122" height="1402"><g><rect/></g></mask>
    <linearGradient data-grad="in" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
    <linearGradient data-grad="out" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
    <mask data-mask="in" maskUnits="userSpaceOnUse" x="0" y="0" width="1122" height="1402"><g><rect x="0" y="0" width="1122" height="1402"/></g></mask>
    <mask data-mask="out" maskUnits="userSpaceOnUse" x="0" y="0" width="1122" height="1402"><g><rect x="0" y="0" width="1122" height="1402"/></g></mask>
  </defs>
  <g class="fx" data-fx="aura"></g>
  <g data-bone="body" part="body">
    <g data-wrap="napeFill" style="display:none"><image data-art="napeFill" preserveAspectRatio="xMidYMid meet"/></g>
    <g data-bone="head" part="head">
      <g data-wrap="lining" style="display:none"><path fill="#121a28"/></g>
      <image data-art="headAlt" preserveAspectRatio="xMidYMid meet" style="display:none"/>
      <image data-art="head" preserveAspectRatio="xMidYMid meet"/>
      <g data-wrap="hood"><image data-art="hood" preserveAspectRatio="xMidYMid meet"/><image data-art="hoodTint" preserveAspectRatio="xMidYMid meet" style="display:none"/></g>
      <g class="fx" data-fx="head"></g>
      <g class="debug" data-joint="head" aria-hidden="true"></g>
    </g>
    <g data-wrap="torso">
      <image data-art="torso" preserveAspectRatio="xMidYMid meet"/>
      <image data-art="torsoTint" preserveAspectRatio="xMidYMid meet" style="display:none"/>
      <g class="fx" data-fx="torso"></g>
    </g>
    <g data-bone="arm" part="arm">
      <g data-wrap="gripOut" style="visibility:hidden"><image data-art="gripOut" preserveAspectRatio="xMidYMid meet"/></g>
      <g data-wrap="grip">
        <image data-art="grip" preserveAspectRatio="xMidYMid meet"/>
        <image data-art="gripTint" preserveAspectRatio="xMidYMid meet" style="display:none"/>
        <g class="fx" data-fx="item"></g>
      </g>
      <g class="debug" data-joint="arm" aria-hidden="true"></g>
    </g>
    <g class="debug" data-joint="body" aria-hidden="true"></g>
  </g>
  <g class="fx" data-fx="front"></g>
</svg>`;

export class SquireRigElement extends HTMLElement {
  static get observedAttributes() {
    return [...Object.keys(RIG_CHOICES), "debug", "label", "seed"];
  }

  /** Test hook (validate.cjs seam sweeps): forces these channels exactly; null clears. */
  _testChannels: RigTestChannels | null = null;

  private readonly _art: RigArt = RIG_ART;
  private readonly _id = ++nextID;
  private _time = 0;
  private _clockSeeded = false; // The clock jumps to _origin when live motion first starts.
  private _gaze = 0; // Base gaze (schedule / fixed / pointer), smoothed.
  private _scrub: {
    time: number;
    gaze: number | undefined;
    state: CompanionState | undefined;
  } | null = null;
  private _raf: number | null = null;
  private _lastFrame: number | null = null;
  private _frameCount = 0;
  private _fps = 0;
  private _inView = !("IntersectionObserver" in window);
  private _seen = false; // Whether the IntersectionObserver has reported yet.
  private _shown: Shown | null = null; // Last rendered appearance/hood/equipment/palette.
  private _entrance: "none" | "pending" | "playing" | "done" = "none";
  private _settling: Settling | null = null; // Blend to rest before stopping (still or settle).
  private _settled = false;
  private _lastActivity: number | null = null; // Clock ms of the last wake-worthy event.
  private readonly _transitions = new Map<TransitionKind, Transition>();
  private _gestures: ActiveGesture[] = [];
  private _gestureDelta: ChannelValues = {};
  private _gestureAhead: ChannelValues = {};
  private _gestureEnergy = 0;
  private _gestureReport: { name: CompanionGesture; progress: number } | null = null;
  private _mutes: Mute[] = []; // Beat-suppression windows around gestures and state changes.
  private _lastGestureEnd = -Infinity;
  private _lastStateChange = -Infinity;
  private _lastState: CompanionState | undefined;
  private _springs: Record<SpringName, Spring> = {
    gaze: { x: 0, v: 0 },
    pitch: { x: 0, v: 0 },
    lively: { x: 0, v: 0 },
    ambient: { x: 0, v: 0 },
    hood: { x: 0, v: 0 },
    quiet: { x: 0, v: 0 },
    eyeX: { x: 0, v: 0 },
    eyeY: { x: 0, v: 0 },
    idle: { x: 1, v: 0 },
    attentive: { x: 0, v: 0 },
    thinking: { x: 0, v: 0 },
  };
  private _stateTarget: CompanionState | null = null;
  private _anticipation: { start: number; delta: Record<AnticipateKey, number> } | null = null;
  private _breathPhase = 0;
  private _blinkAnchor = 0;
  private _blinkCount = 0;
  private _pointer = { gaze: 0, pitch: 0 };
  private _lastPointer: number | undefined;
  private _pointerMute: Mute | null = null;
  private _pointerWatch = false;
  private _pose: Pose | null = null;
  private readonly _out: Partial<Record<OutputChannel, Spring>> = {};
  private _outLive = false;
  private _hoodHold = false;
  private _restPosing = false;
  private _gazeTargetNow = 0;
  private _introAt: number | undefined;
  private _limits: Limits = DEFAULT_LIMITS;
  private _napeFill: NapeFill | null = null;
  private _hoodTransition: HoodPose | null = null;
  private _hoodBandValue: number | undefined;
  private _handoff: { done: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private _fx: FxController | null = null;
  private _fxFailed = false;
  private readonly _feathers: Partial<Record<RigAppearance, string>> = {};
  private _reflecting = false;
  private _media: MediaQueryList | null = null;
  private _observer: IntersectionObserver | null = null;
  private _lease: CompanionLease | null = null;
  private _holding = false;
  private _acquiring = false;
  private _focusOff: (() => void) | null = null;
  // Palette whose tinted textures the cloth images show, and the one asked for.
  private _clothPalette: CompanionPalette = "brass";
  private _paletteWanted: CompanionPalette = "brass";
  private _artReady = true; // False until the first paint's tinted textures exist.

  private readonly _svg: SVGSVGElement;
  private readonly _defs: SVGDefsElement;
  private readonly _bones: Readonly<Record<"body" | "head" | "arm", SVGGElement>>;
  private readonly _images: Readonly<Record<ImageName, SVGImageElement>>;
  private readonly _twins: Readonly<Record<ClothName, SVGImageElement>>;
  private readonly _wraps: Readonly<Record<WrapName, SVGGElement>>;
  private readonly _layers: Readonly<
    Record<"aura" | "head" | "torso" | "item" | "front", SVGGElement>
  >;
  private readonly _hoodFaceClipID: string;
  private readonly _clipPath: SVGPathElement;
  private readonly _nape: {
    x: SVGLinearGradientElement;
    y: SVGLinearGradientElement;
    rect: SVGRectElement;
  };
  private readonly _lining: SVGGElement;
  private readonly _hoodBand: { id: string; reveal: SVGRectElement };
  private readonly _wipe: Readonly<
    Record<"in" | "out", { grad: SVGLinearGradientElement; id: string; group: SVGGElement }>
  >;

  private readonly _onEnvironment = () => this._syncMotion();
  private readonly _onFocusChange = () => this._syncMotion();
  private readonly _onPointerMove = (event: PointerEvent) => {
    this._pointerAt(event.clientX, event.clientY);
    if (this._pointerOverRig(event.clientX, event.clientY)) this._wake();
  };
  private readonly _onHostPointer = () => {
    this._wake();
  };
  private readonly _onPointerOut = (event: PointerEvent) => {
    if (!event.relatedTarget) this._pointer = { gaze: 0, pitch: 0 };
  };
  private readonly _onBlur = () => {
    this._pointer = { gaze: 0, pitch: 0 };
  };
  private readonly _tick = (now: number) => {
    this._raf = null;
    if (!this._running()) return;
    const clock = companionClock();
    if (this._lastFrame !== null && now - this._lastFrame < MIN_FRAME_MS) {
      this._raf = clock.requestFrame(this._tick);
      return;
    }
    if (this._lastFrame === null) this._lastFrame = now;
    // Do not jump after an event-loop stall or tab suspension.
    const dt = Math.min((now - this._lastFrame) / 1000, 0.1);
    this._lastFrame = now;
    if (dt > 0) this._fps = this._fps ? lerp(this._fps, 1 / dt, 0.1) : 1 / dt;
    this._time += dt;
    this._beginSettleIfDue(now);
    this._step(dt);
    // Event listeners inside _step may hold or pause the rig; never overwrite that.
    if (!this._running()) return;
    this._applyPose({ live: true, dt });
    const settling = this._settling;
    if (settling && this._time - settling.start >= settling.duration) {
      this._settling = null;
      if (settling.kind === "settle") this._settled = true;
      this._syncMotion();
      return;
    }
    if (this._raf === null) this._raf = clock.requestFrame(this._tick);
  };

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = TEMPLATE;
    const $ = <T extends Element>(selector: string) => query<T>(shadow, selector);
    this._svg = $<SVGSVGElement>("svg");
    this._defs = $<SVGDefsElement>("defs");
    const bone = (name: string) => $<SVGGElement>(`[data-bone="${name}"]`);
    this._bones = { body: bone("body"), head: bone("head"), arm: bone("arm") };
    const image = (name: string) => $<SVGImageElement>(`[data-art="${name}"]`);
    this._images = {
      torso: image("torso"),
      head: image("head"),
      headAlt: image("headAlt"),
      hood: image("hood"),
      grip: image("grip"),
      gripOut: image("gripOut"),
      napeFill: image("napeFill"),
    };
    this._twins = { torso: image("torsoTint"), hood: image("hoodTint"), grip: image("gripTint") };
    const wrap = (name: string) => $<SVGGElement>(`[data-wrap="${name}"]`);
    this._wraps = {
      hood: wrap("hood"),
      torso: wrap("torso"),
      grip: wrap("grip"),
      gripOut: wrap("gripOut"),
      napeFill: wrap("napeFill"),
    };
    const layer = (name: string) => $<SVGGElement>(`[data-fx="${name}"]`);
    this._layers = {
      aura: layer("aura"),
      head: layer("head"),
      torso: layer("torso"),
      item: layer("item"),
      front: layer("front"),
    };
    const uid = (id: string) => `squire-${id}-${this._id}`;
    this._hoodFaceClipID = uid("hood-face");
    $('[data-clip="hood-face"]').id = this._hoodFaceClipID;
    this._clipPath = $<SVGPathElement>('[data-clip="hood-face"] path');
    // Nape fill mask: a rect feathered on its left and top edges by two gradients.
    const napeX = $<SVGLinearGradientElement>('[data-grad="napeX"]');
    const napeY = $<SVGLinearGradientElement>('[data-grad="napeY"]');
    napeX.id = uid("nape-x");
    napeY.id = uid("nape-y");
    const napeYMask = $('[data-mask="napeY"]');
    const napeMask = $('[data-mask="nape"]');
    napeYMask.id = uid("nape-ymask");
    napeMask.id = uid("nape");
    query(napeYMask, "rect").setAttribute("fill", `url(#${napeY.id})`);
    query(napeMask, "g").setAttribute("mask", `url(#${napeYMask.id})`);
    const napeRect = query<SVGRectElement>(napeMask, "rect");
    napeRect.setAttribute("fill", `url(#${napeX.id})`);
    this._nape = { x: napeX, y: napeY, rect: napeRect };
    this._wraps.napeFill.setAttribute("mask", `url(#${napeMask.id})`);
    this._lining = $<SVGGElement>('[data-wrap="lining"]');
    // While the hood travels, its hard bottom edge (normally behind the collar) is faded out.
    const band = $('[data-grad="hoodBand"]');
    const bandMask = $('[data-mask="hoodBand"]');
    band.id = uid("hood-band");
    bandMask.id = uid("hood-band-mask");
    bandMask.firstElementChild?.setAttribute("fill", `url(#${band.id})`);
    const reveal = bandMask.lastElementChild;
    if (!(reveal instanceof SVGRectElement))
      throw new Error("squire-rig: missing hood band reveal");
    this._hoodBand = { id: bandMask.id, reveal };
    // Appearance wipe: complementary gradient masks for the incoming and outgoing heads.
    const wipe = (side: "in" | "out") => {
      const grad = $<SVGLinearGradientElement>(`[data-grad="${side}"]`);
      const mask = $(`[data-mask="${side}"]`);
      grad.id = uid(`wipe-grad-${side}`);
      mask.id = uid(`wipe-${side}`);
      query(mask, "rect").setAttribute("fill", `url(#${grad.id})`);
      return { grad, id: mask.id, group: query<SVGGElement>(mask, "g") };
    };
    this._wipe = { in: wipe("in"), out: wipe("out") };
  }

  get configuration(): RigConfiguration {
    return this.getConfiguration();
  }

  getConfiguration(): RigConfiguration {
    const pick = <T extends string>(name: keyof typeof RIG_CHOICES, values: readonly [T, ...T[]]) =>
      readChoice(this, name, values, values[0]);
    return {
      appearance: pick("appearance", RIG_CHOICES.appearance),
      hood: pick("hood", RIG_CHOICES.hood),
      equipment: pick("equipment", RIG_CHOICES.equipment),
      palette: pick("palette", RIG_CHOICES.palette),
      motion: pick("motion", RIG_CHOICES.motion),
      gaze: pick("gaze", RIG_CHOICES.gaze),
      state: pick("state", RIG_CHOICES.state),
      transitions: pick("transitions", RIG_CHOICES.transitions),
      crest: pick("crest", RIG_CHOICES.crest),
      placement: pick("placement", RIG_CHOICES.placement),
      debug: this.getAttribute("debug") === "true",
      label: (this.getAttribute("label") ?? "").trim(),
    };
  }

  // Per-instance seed: the `seed` attribute (integer). Without one, a stable per-instance
  // counter is reflected into the attribute on connect (so copies of a rig share its seed).
  // The clock starts at origin = 40 * hash(seed) s, so rigs on one page never move in
  // lockstep. setPose time is absolute and holds use the same seed and origin as live
  // motion: setPose({ time: debugState.time }) reproduces the live frame.
  private _seed() {
    const v = Number.parseInt(this.getAttribute("seed") ?? "", 10);
    return Number.isFinite(v) ? v : this._id;
  }

  private get _origin() {
    return 40 * hash(97, this._seed());
  }

  get debugState(): RigDebugState {
    const reason = this._pausedReason();
    const active = this._gestures.find((g) => !g.fading);
    const pose = this._pose;
    const kinds = [...this._transitions.keys()];
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
      transition: kinds[0] ?? null,
      transitions: kinds,
      motion: this.getConfiguration().motion,
      breath: pose ? pose.breath : 0,
      eye: pose ? pose.eye : { x: 0, y: 0 },
      lid: clamp01(this._blend("lid")),
      settling: !!this._settling,
      seed: this._seed(),
      pose: pose
        ? {
            body: pose.body,
            head: pose.head,
            arm: pose.arm,
            headPitch: pose.headPitch,
            gaze: pose.gaze,
            bodyY: pose.bodyY,
          }
        : null,
    };
  }

  connectedCallback() {
    if (!this.hasAttribute("seed")) {
      this._reflecting = true;
      this.setAttribute("seed", String(this._id));
      this._reflecting = false;
    }
    this._media = window.matchMedia("(prefers-reduced-motion: reduce)");
    this._media.addEventListener("change", this._onEnvironment);
    document.addEventListener("visibilitychange", this._onEnvironment);
    this._focusOff = onCompanionFocusChange(this._onFocusChange);
    this.addEventListener("pointermove", this._onHostPointer, { passive: true });
    this.addEventListener("pointerdown", this._onHostPointer, { passive: true });
    this._inView = !("IntersectionObserver" in window);
    this._seen = this._inView;
    if ("IntersectionObserver" in window) {
      this._observer = new IntersectionObserver((entries) => {
        if (!this.isConnected) return;
        const entry = entries[entries.length - 1];
        if (!entry) return;
        this._inView = entry.isIntersecting && entry.intersectionRatio > 0;
        // The entrance plays only for rigs visible when first observed; rigs that start
        // offscreen simply appear at rest (never invisible).
        if (!this._seen) {
          this._seen = true;
          if (!this._inView) this._skipEntrance();
        }
        this._syncMotion();
      });
      this._observer.observe(this);
    }
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
    this._observer?.disconnect();
    this._observer = null;
    this._inView = false;
    this._media?.removeEventListener("change", this._onEnvironment);
    this._media = null;
    document.removeEventListener("visibilitychange", this._onEnvironment);
    this._focusOff?.();
    this._focusOff = null;
    this.removeEventListener("pointermove", this._onHostPointer);
    this.removeEventListener("pointerdown", this._onHostPointer);
    this._syncLease();
    this._watchPointer(false);
    this._cancelGestures();
    this._finishTransitions();
    if (this._fx) {
      try {
        this._fx.destroy();
      } catch (error) {
        console.warn("squire-rig: FX destroy failed", error);
      }
      this._fx = null;
      for (const layer of Object.values(this._layers)) layer.replaceChildren();
    }
  }

  attributeChangedCallback(name: string, before: string | null, value: string | null) {
    let after = value;
    if (name === "seed" && after === null && this.isConnected && !this._reflecting) {
      // Keep the default seed visible on the host so copies of this rig stay in step.
      this._reflecting = true;
      this.setAttribute("seed", String(this._id));
      this._reflecting = false;
      after = String(this._id);
    }
    if (before === after || !this.isConnected || this._reflecting) return;
    if (name === "motion") {
      // Leaving a live rig for still: blend to rest over 0.55 s before stopping.
      if (!this._scrub && this._raf !== null && this.getConfiguration().motion === "still") {
        this._settling = {
          kind: "still",
          start: this._time,
          duration: STILL_BLEND,
          ambient: this._springs.ambient.x,
        };
        for (const g of this._gestures) this._fadeGesture(g);
      } else this._settling = null;
      this._scrub = null;
    } else if (name === "placement") {
      this._lease?.setPlacement(this.getConfiguration().placement);
    } else if (name === "state") {
      this._noteActivity();
      this._wake();
    }
    this._render();
  }

  setPose({ time = this._time, gaze, state }: SetPoseInput = {}) {
    if (!Number.isFinite(time) || (gaze !== undefined && !Number.isFinite(gaze))) {
      throw new TypeError("setPose requires finite time and gaze numbers.");
    }
    if (state != null && !STATES.includes(state))
      throw new TypeError(`Unknown state "${String(state)}".`);
    this._time = Math.max(0, time);
    this._scrub = {
      time: this._time,
      gaze: gaze === undefined ? undefined : clamp(gaze),
      state: state ?? undefined,
    };
    this._settling = null;
    this._stopMotion();
    this._syncLease();
    this._applyHold();
  }

  resume() {
    this._scrub = null;
    // Leaving a hold is an explicit request to go live, so it restarts the settle deadline.
    this._wake();
    this._syncMotion();
  }

  play(name: CompanionGesture): Promise<GestureResult> {
    if (!isGesture(name))
      return Promise.reject(new TypeError(`Unknown gesture "${String(name)}".`));
    // Wake first: v5 drops gestures while not running, and a settled rig must play.
    this._wake();
    // A gesture is for a figure that is present: an entrance still pending or fading in (a host
    // that remounts the rig and greets at once) finishes now, so greet never reads as a fade-in.
    if (this._entrance !== "done") this._skipEntrance();
    if (!this._running() || this._settling) return Promise.resolve({ name, played: false });
    return new Promise((resolve) => {
      for (const g of this._gestures) this._fadeGesture(g);
      const def = GESTURES[name];
      this._gestures.push({
        name,
        start: this._time,
        def,
        resolve,
        fading: false,
        fired: false,
        done: false,
        weight: { x: 1, v: 0 },
      });
      // Idle beats and auto-gaze step aside: no beat may start during or 1.5 s after.
      this._mutes.push({ from: this._time, to: Infinity, gesture: true });
      if (name === "glance" || name === "listen") this._blink("gaze");
    });
  }

  private _setImage(image: SVGImageElement, art: RigArtImage | null, cloth = false) {
    image.style.display = art ? "" : "none";
    if (!art) {
      image.removeAttribute("href");
      delete image.dataset.src;
      delete image.dataset.palette;
      return;
    }
    if (art.rotation)
      image.setAttribute("transform", `rotate(${art.rotation} ${this._art.pivots.arm.join(" ")})`);
    else image.removeAttribute("transform");
    const previousSrc = image.dataset.src;
    image.dataset.src = art.src;
    let href = art.src;
    if (cloth) {
      const ready = tintedHref(art.src, this._clothPalette);
      if (ready !== null) {
        href = ready;
        image.dataset.palette = this._clothPalette;
      } else {
        this._requestCloth(art.src, this._clothPalette);
        // Keep this part's previous tint while the new one is produced.
        const current = image.getAttribute("href");
        if (previousSrc === art.src && current !== null) href = current;
        else image.dataset.palette = "brass";
      }
    }
    preload(href);
    if (image.getAttribute("href") !== href) image.setAttribute("href", href);
    setAttributes(image, { x: art.x, y: art.y, width: art.w, height: art.h });
  }

  private _requestCloth(src: string, palette: CompanionPalette) {
    void requestTint(src, palette).then(() => this._refreshCloth());
  }

  // Swaps in tinted textures that finished producing; ends the first-paint wait.
  private _refreshCloth() {
    for (const name of CLOTH) {
      const image = this._images[name];
      const src = image.dataset.src;
      if (image.style.display === "none" || !src || image.dataset.palette === this._clothPalette)
        continue;
      const ready = tintedHref(src, this._clothPalette);
      if (ready === null) continue;
      image.setAttribute("href", ready);
      image.dataset.palette = this._clothPalette;
    }
    if (!this._artReady && this._clothReady(this._clothPalette)) {
      this._artReady = true;
      this._svg.style.visibility = "";
      this._render();
    }
  }

  private _clothSources() {
    const sources: string[] = [];
    for (const name of CLOTH) {
      const image = this._images[name];
      const src = image.dataset.src;
      if (image.style.display !== "none" && src) sources.push(src);
    }
    return sources;
  }

  private _clothReady(palette: CompanionPalette) {
    return this._clothSources().every((src) => tintedHref(src, palette) !== null);
  }

  private _setHead(image: SVGImageElement, appearance: RigAppearance, clipped: boolean) {
    this._setImage(image, this._art.heads[appearance]);
    image.dataset.appearance = appearance;
    if (clipped) image.setAttribute("clip-path", `url(#${this._hoodFaceClipID})`);
    else image.removeAttribute("clip-path");
    this._applyFeather(image);
  }

  // Heads whose image ends in a hard edge (art.heads[x].feather = [y0, y1]) fade out over that
  // band, so the image boundary never shows as a pale rectangle while the head moves.
  private _featherID(appearance: string | undefined) {
    if (appearance !== "female" && appearance !== "male") return null;
    const band = this._art.heads[appearance].feather;
    if (!band) return null;
    const existing = this._feathers[appearance];
    if (existing) return existing;
    const id = `squire-feather-${appearance}-${this._id}`;
    const grad = document.createElementNS(NS, "linearGradient");
    grad.id = `${id}-grad`;
    setAttributes(grad, {
      gradientUnits: "userSpaceOnUse",
      x1: 0,
      x2: 0,
      y1: band[0],
      y2: band[1],
    });
    grad.innerHTML = '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>';
    const mask = document.createElementNS(NS, "mask");
    mask.id = id;
    setAttributes(mask, { maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 1122, height: 1402 });
    mask.innerHTML = `<rect x="0" y="0" width="1122" height="1402" fill="url(#${grad.id})"/>`;
    this._defs.append(grad, mask);
    this._feathers[appearance] = id;
    return id;
  }

  private _applyFeather(image: SVGImageElement) {
    const id = this._featherID(image.dataset.appearance);
    if (id) image.setAttribute("mask", `url(#${id})`);
    else image.removeAttribute("mask");
  }

  private _copyImage(from: SVGImageElement, to: SVGImageElement) {
    for (const attr of ["href", "x", "y", "width", "height", "transform", "clip-path", "mask"]) {
      const value = from.getAttribute(attr);
      if (value === null) to.removeAttribute(attr);
      else to.setAttribute(attr, value);
    }
    for (const key of ["appearance", "src", "palette"] as const) {
      const value = from.dataset[key];
      if (value !== undefined) to.dataset[key] = value;
    }
    to.style.display = "";
  }

  private _render() {
    const c = this.getConfiguration();
    const art = this._art;
    this._svg.setAttribute("viewBox", `0 0 ${art.stage.join(" ")}`);
    const equipment =
      c.equipment === "none"
        ? "empty hands"
        : `holding ${c.equipment === "armillary" ? "an armillary sphere" : c.equipment === "astrolabe" ? "an astrolabe" : `a ${c.equipment}`}`;
    const palette =
      c.palette === "brass"
        ? "original navy cloth and brass details"
        : `${c.palette}-tinted navy cloth and enamel, with original skin and gold`;
    this._svg.setAttribute(
      "aria-label",
      c.label ||
        `${c.appearance === "male" ? "Male" : "Female"} squire, hood ${c.hood}, ${equipment}; ${palette}.`,
    );
    const lim = art.limits;
    this._limits = {
      ...DEFAULT_LIMITS,
      ...lim,
      ...lim.heads?.[c.appearance],
      ...lim.heads?.[`${c.appearance}-${c.hood}`],
      ...lim.grips?.[c.equipment],
    };
    this._clipPath.setAttribute("d", art.hoodFaceClip);
    // napeFill: per appearance { x, y, w, h, feather }; left and top edges fade over `feather`.
    const nf = (this._napeFill = art.napeFill[c.appearance] ?? null);
    if (nf) {
      const f = nf.feather;
      setAttributes(this._nape.rect, { x: nf.x, y: nf.y, width: nf.w, height: nf.h });
      setAttributes(this._nape.x, { x1: nf.x, x2: nf.x + f || nf.x + 0.01 });
      setAttributes(this._nape.y, { y1: nf.y, y2: nf.y + f || nf.y + 0.01 });
    }
    query(this._lining, "path").setAttribute("d", art.hoodLining);
    this._ensureFX();

    const prev = this._shown;
    const animate =
      !!prev && c.transitions === "on" && this._running() && this._entrance !== "pending";
    if (!prev) {
      // First paint loads only the parts this configuration shows; the rest load when switched.
      this._clothPalette = c.palette;
      this._paletteWanted = c.palette;
      this._setImage(this._images.torso, art.torso, true);
      this._setHead(this._images.head, c.appearance, c.hood === "up");
      this._setImage(this._images.hood, c.hood === "up" ? art.hood : null, true);
      this._setImage(this._images.grip, art.grips[c.equipment], true);
      // First paint waits for its tinted cloth rather than flashing untinted navy.
      this._artReady = this._clothReady(c.palette);
      if (!this._artReady) this._svg.style.visibility = "hidden";
    } else {
      if (prev.equipment !== c.equipment) this._swapEquipment(prev.equipment, c, animate);
      if (prev.appearance !== c.appearance) this._swapAppearance(prev, c, animate);
      if (prev.hood !== c.hood) this._swapHood(c, animate);
      if (prev.palette !== c.palette) this._swapPalette(c.palette, animate);
    }
    this._shown = {
      appearance: c.appearance,
      hood: c.hood,
      equipment: c.equipment,
      palette: c.palette,
    };
    this._fxConfigure(c);
    this._drawDebug(c.debug);
    this._watchPointer(c.gaze === "pointer");
    if (this._scrub) this._applyHold();
    this._syncMotion();
    // Live rigs write the new transition state now, so no frame shows a swap's end state first.
    if (prev && this._raf !== null) this._applyPose({ live: true, dt: 0 });
    // Paused rigs (offscreen, hidden, unfocused, yielded) still render one static frame with
    // the new attributes, already in their state's pose.
    const reason = this._pausedReason();
    if (!prev || (reason !== null && STATIC_FRAME_REASONS.has(reason))) {
      if (!this._running() || !prev)
        this._settleSprings(this._stateName(), this._springs.ambient.x);
      if (reason) this._applyPose({ live: false, dt: 0 });
    }
  }

  private _drawDebug(visible: boolean) {
    const pivots = this._art.pivots;
    for (const name of ["body", "head", "arm"] as const) {
      const group = query(this.shadowRoot ?? this, `[data-joint="${name}"]`);
      group.toggleAttribute("hidden", !visible);
      group.replaceChildren();
      if (!visible) continue;
      const [x, y] = pivots[name];
      // Local segments move with their joints; parent anchors stay in body space.
      const end = name === "arm" ? [x + 70, y + 40] : [x, y - 70];
      const line = document.createElementNS(NS, "line");
      setAttributes(line, { x1: x, y1: y, x2: end[0] ?? x, y2: end[1] ?? y });
      const circle = document.createElementNS(NS, "circle");
      setAttributes(circle, { cx: x, cy: y, r: 9 });
      const label = document.createElementNS(NS, "text");
      setAttributes(label, { x: x + 14, y: y - 14 });
      label.textContent = name === "arm" ? "elbow" : name;
      group.append(line, circle, label);
      if (name === "body") {
        for (const joint of ["head", "arm"] as const) {
          const anchor = document.createElementNS(NS, "circle");
          setAttributes(anchor, { cx: pivots[joint][0], cy: pivots[joint][1], r: 4 });
          group.append(anchor);
        }
      }
    }
  }

  private _ensureFX() {
    if (this._fx || this._fxFailed || !this.isConnected) return;
    try {
      this._fx = createSquireFx({
        NS,
        svg: this._svg,
        defs: this._defs,
        uid: (name) => `squire-${name}-${this._id}`,
        art: this._art,
        layers: { ...this._layers },
        images: {
          head: this._images.head,
          hood: this._images.hood,
          torso: this._images.torso,
          grip: this._images.grip,
        },
      });
    } catch (error) {
      this._fxFailed = true;
      console.warn("squire-rig: FX disabled", error);
    }
  }

  private _fxRun(method: string, call: (fx: FxController) => void) {
    const fx = this._fx;
    if (!fx) return;
    try {
      call(fx);
    } catch (error) {
      console.warn(`squire-rig: FX ${method} failed; FX disabled`, error);
      try {
        fx.destroy();
      } catch {
        // Already failing; the layers are cleared below either way.
      }
      this._fx = null;
      this._fxFailed = true;
      for (const layer of Object.values(this._layers)) layer.replaceChildren();
    }
  }

  private _fxConfigure(c: RigConfiguration) {
    this._fxRun("configure", (fx) => fx.configure(c));
  }

  private _fxTrigger(event: FxTrigger) {
    this._fxRun("trigger", (fx) => fx.trigger(event));
  }

  private _blink(reason: "gaze" | "state" | "hood" | "entrance") {
    if (this._running()) this._fxTrigger({ name: "blink", detail: { reason } });
  }

  private _startTransition(transition: Transition) {
    this._transitions.set(transition.kind, transition);
    this._noteActivity();
  }

  private _transitionProgress(kind: TransitionKind) {
    const t = this._transitions.get(kind);
    return t ? clamp01((this._time - t.start) / t.duration) : 1;
  }

  // Equipment: the old grip swings out (+16 deg, ease-in); the two crossfade over 50 ms
  // centred on swapAt (under the FX bloom) and the new grip swings up from +14 deg / +16
  // units with overshoot.
  private _swapEquipment(previous: RigEquipment, c: RigConfiguration, animate: boolean) {
    this._finishTransition("palette", false);
    const running = this._transitions.get("equipment");
    const tau = running ? this._time - running.start : Infinity;
    let from: GripPose = { rot: 0, y: 0, op: 1 };
    let keepOut = false;
    if (running?.kind === "equipment" && tau < EQUIP.swapAt && animate) {
      // Still before the cut: the old grip is the visible one; keep swinging it out from
      // where it is instead of swapping in the never-shown grip.
      const k = this._gripOutK(tau);
      from = {
        rot: running.from.rot + GRIP_OUT_ROT * k,
        y: running.from.y + GRIP_OUT_Y * k,
        op: 1,
      };
      keepOut = true;
      this._transitions.delete("equipment");
      this._dispatchTransitionEnd("equipment", false);
    } else {
      if (running) from = this._gripInState(tau);
      this._finishTransition("equipment", false);
    }
    if (animate) {
      if (!keepOut) this._copyImage(this._images.grip, this._images.gripOut);
      this._wraps.gripOut.style.visibility = "";
      this._startTransition({
        kind: "equipment",
        start: this._time,
        duration: EQUIP.duration,
        from,
      });
      this._fxTrigger({
        name: "equip",
        detail: {
          equipment: c.equipment,
          previous,
          duration: EQUIP.duration,
          swapAt: EQUIP.swapAt,
          fade: EQUIP.fade,
        },
      });
    }
    this._setImage(this._images.grip, this._art.grips[c.equipment], true);
    this._applyTransitions();
  }

  private _gripInState(tau: number): GripPose {
    const s = tau - EQUIP.swapAt;
    return { rot: GRIP_IN_ROT(s), y: GRIP_IN_Y(s), op: smooth((s + EQUIP.fade / 2) / EQUIP.fade) };
  }

  private _gripOutK(tau: number) {
    return easeIn((tau + 0.01) / (EQUIP.swapAt + EQUIP.fade / 2));
  }

  // Appearance: the head dips, the incoming head wipes in under a feathered gradient mask
  // (face first, then back toward the nape) over the outgoing one, then the head rises.
  // No visible <image> ever changes href (that can blank a frame while it re-decodes): the
  // new face loads into whichever head image is hidden, the two trade roles on a mid-wipe
  // flip, and a finished swap hands back to the main head image once it has loaded.
  // A hood transition can keep moving the hood while this owns the head images.
  private _swapAppearance(prev: Shown, c: RigConfiguration, animate: boolean) {
    const running = this._transitions.get("appearance");
    const hood = this._transitions.get("hood");
    if (!animate) {
      if (hood) this._finishTransition("hood", false);
      if (running) this._finishTransition("appearance", false);
      this._endHandoff();
      this._setHead(this._images.head, c.appearance, this._headClipped());
      this._applyTransitions();
      return;
    }
    this._endHandoff();
    const clipped = this._headClipped();
    if (running?.kind === "appearance") {
      // Reverse from the current edge: the outgoing image becomes the incoming one.
      const tau = this._time - running.start;
      const edge = this._wipeEdge(running.wipe, tau);
      const done = sine((tau - running.wipe.at) / APPEAR.wipe) >= 1;
      const outName: HeadImage = running.incoming === "head" ? "headAlt" : "head";
      const out = this._images[outName];
      if (out.dataset.appearance !== c.appearance || done) {
        // The other image is hidden (or wrong): load the new face into it while unseen.
        this._setHead(out, c.appearance, clipped);
        out.setAttribute("opacity", "0");
      }
      running.wipe = {
        at: tau,
        from: done ? (running.wipe.side === "in" ? 260 : 960) : edge,
        side: running.wipe.side === "in" ? "out" : "in",
      };
      running.incoming = outName;
      running.duration = Math.max(running.duration, tau + APPEAR.wipe + 0.05);
      this._noteActivity();
      this._fxTrigger({
        name: "appearance",
        detail: {
          appearance: c.appearance,
          previous: prev.appearance,
          duration: running.duration - tau,
          swapAt: 0,
          swapDuration: APPEAR.wipe,
        },
      });
      this._applyTransitions();
      return;
    }
    // Fresh swap: the hidden spare image loads the new face and wipes in over the old one.
    const spare = this._images.headAlt;
    this._setHead(spare, c.appearance, clipped);
    spare.style.display = "";
    spare.setAttribute("opacity", "0");
    this._startTransition({
      kind: "appearance",
      start: this._time,
      duration: APPEAR.duration,
      wipe: { at: APPEAR.wipeStart, from: 860, side: "in" },
      incoming: "headAlt",
    });
    this._fxTrigger({
      name: "appearance",
      detail: {
        appearance: c.appearance,
        previous: prev.appearance,
        duration: APPEAR.duration,
        swapAt: APPEAR.wipeStart,
        swapDuration: APPEAR.wipe,
      },
    });
    this._applyTransitions();
  }

  // After a swap that ended on the spare image: load the same face into the main head image
  // while it is transparent, then reveal it and hide the spare once it has loaded.
  private _beginHandoff() {
    const { head, headAlt } = this._images;
    this._copyImage(headAlt, head);
    head.setAttribute("opacity", "0");
    this._applyFeather(head);
    this._applyFeather(headAlt);
    headAlt.removeAttribute("opacity");
    headAlt.style.display = "";
    const done = () => this._endHandoff();
    this._handoff = { done, timer: setTimeout(done, 150) };
    head.addEventListener("load", done, { once: true });
  }

  private _endHandoff() {
    const h = this._handoff;
    if (!h) return;
    this._handoff = null;
    clearTimeout(h.timer);
    this._images.head.removeEventListener("load", h.done);
    this._images.head.removeAttribute("opacity");
    this._images.headAlt.style.display = "none";
    this._fxConfigure(this.getConfiguration());
  }

  // Whether the head images should carry the hood face clip right now.
  private _headClipped() {
    const t = this._transitions.get("hood");
    if (t?.kind === "hood") return t.up && this._time - t.start >= HOOD_UP.clipAt;
    // Between renders the shown hood is authoritative (swaps update it after they run).
    return (this._shown ? this._shown.hood : this.getConfiguration().hood) === "up";
  }

  private _clipHead(image: SVGImageElement, on: boolean) {
    const v = on ? `url(#${this._hoodFaceClipID})` : null;
    if (image.getAttribute("clip-path") === v) return;
    if (v) image.setAttribute("clip-path", v);
    else image.removeAttribute("clip-path");
  }

  // Wipe edge (stage x) for an appearance transition at `tau`. The incoming head shows on
  // `side` of the edge: 'in' = face side (x > edge, edge sweeps past the nape to 260),
  // 'out' = nape side (x < edge, edge sweeps past the face to 960).
  private _wipeEdge(w: Wipe, tau: number) {
    const to = w.side === "in" ? 260 : 960;
    return lerp(w.from, to, sine((tau - w.at) / APPEAR.wipe));
  }

  // Hood up fades in over 70 ms while dropping from above/behind with a back-ease and lands
  // (head settles, blink); the head stays unclipped (hair intact) until the hood covers it.
  // Hood down is the mirror: the head unclips, the hood lifts away with an ease-in and fades
  // over its last 100 ms. Head clipping is decided per frame by _headClipped().
  private _swapHood(c: RigConfiguration, animate: boolean) {
    this._finishTransition("palette", false);
    // Reversing mid-flight starts from the hood's current offset and opacity.
    const current: HoodPose | null =
      this._transitions.has("hood") && this._hoodTransition
        ? {
            ...this._hoodTransition,
            op: Number.parseFloat(this._wraps.hood.getAttribute("opacity") ?? "1"),
            band: this._hoodBandValue ?? 1,
          }
        : null;
    this._finishTransition("hood", false);
    const appearance = this._transitions.has("appearance");
    if (appearance && !animate) this._finishTransition("appearance", false);
    const up = c.hood === "up";
    if (animate) {
      this._startTransition({
        kind: "hood",
        start: this._time,
        duration: up ? HOOD_UP.duration : HOOD_DOWN.duration,
        up,
        blinked: false,
        from: current,
      });
    }
    const clipped = animate ? this._headClipped() : up;
    this._setHead(this._images.head, c.appearance, clipped);
    if (this._images.headAlt.style.display !== "none")
      this._clipHead(this._images.headAlt, clipped);
    this._setImage(this._images.hood, up || animate ? this._art.hood : null, true);
    this._applyTransitions();
  }

  // Palette: cloth textures are pre-tinted once per (part, palette). The new palette waits
  // until every shown cloth part has its texture (the previous tint stays up meanwhile),
  // then cross-fades over the old one or swaps at once.
  private _swapPalette(palette: CompanionPalette, animate: boolean) {
    this._finishTransition("palette", false);
    this._paletteWanted = palette;
    if (!this._clothReady(palette)) {
      void Promise.all(this._clothSources().map((src) => requestTint(src, palette))).then(() => {
        if (!this.isConnected || this._paletteWanted !== palette || this._clothPalette === palette)
          return;
        const c = this.getConfiguration();
        this._swapPalette(
          palette,
          c.transitions === "on" && this._running() && this._entrance !== "pending",
        );
        if (this._scrub) this._applyHold();
        else if (!this._running()) this._applyPose({ live: false, dt: 0 });
      });
      return;
    }
    if (palette === this._clothPalette) return;
    if (!animate) {
      this._clothPalette = palette;
      this._refreshCloth();
      return;
    }
    for (const name of CLOTH) {
      const main = this._images[name];
      const twin = this._twins[name];
      const src = main.dataset.src;
      const href = src && main.style.display !== "none" ? tintedHref(src, palette) : null;
      if (href === null) {
        twin.style.display = "none";
        continue;
      }
      this._copyImage(main, twin);
      twin.setAttribute("href", href);
      twin.dataset.palette = palette;
      twin.setAttribute("opacity", "0");
    }
    this._startTransition({ kind: "palette", start: this._time, duration: PALETTE_TWEEN, palette });
    this._applyTransitions();
  }

  private _setWipe(edge: number) {
    // Feathered edge travelling from the face toward the back of the head, slightly tilted,
    // so only one profile is ever visible (the faces never overlap mid-wipe).
    for (const side of ["in", "out"] as const) {
      setAttributes(this._wipe[side].grad, {
        x1: fmt(edge - 35),
        y1: 0,
        x2: fmt(edge + 35),
        y2: 20,
      });
    }
  }

  // Writes transition visuals for the current time; completes finished ones.
  private _applyTransitions() {
    const done: TransitionKind[] = [];
    const { head, headAlt } = this._images;
    const grip = this._wraps.grip;
    const gripOut = this._wraps.gripOut;
    const hoodWrap = this._wraps.hood;
    const elbow = this._art.pivots.arm.join(" ");
    let hoodTransform: HoodPose | null = null;
    let hoodOpacity = 1;
    let headOpacity: number | null = null;
    let altOpacity: number | null = null;
    let wipe: { edge: number; side: "in" | "out"; incoming: HeadImage } | null = null;
    let hoodBand: number | null = null;
    let gripTransform = "";
    let gripOpacity = 1;
    for (const t of this._transitions.values()) {
      const tau = this._time - t.start;
      const p = clamp01(tau / t.duration);
      if (p >= 1) done.push(t.kind);
      if (t.kind === "equipment") {
        const f = t.from;
        const k = this._gripOutK(tau);
        gripOut.setAttribute(
          "transform",
          `translate(0 ${fmt(f.y + GRIP_OUT_Y * k)}) rotate(${fmt(f.rot + GRIP_OUT_ROT * k)} ${elbow})`,
        );
        // Symmetric crossfade centred on swapAt; the old grip lingers slightly (cubic) so the
        // combined coverage only dips ~6% at the midpoint.
        const u = smooth((tau - EQUIP.swapAt + EQUIP.fade / 2) / EQUIP.fade);
        gripOut.setAttribute("opacity", String(fmt(f.op * (1 - u * u * u))));
        const inState = this._gripInState(tau);
        gripTransform = `translate(0 ${fmt(inState.y)}) rotate(${fmt(inState.rot)} ${elbow})`;
        gripOpacity = inState.op;
      } else if (t.kind === "hood") {
        if (t.up) {
          const k = 1 - easeOutBack(tau / HOOD_UP.travel, 1.4);
          const f = t.from ?? { x: -25, y: -90, rot: -12, op: 0, band: 0 };
          hoodTransform = { x: f.x * k, y: f.y * k, rot: f.rot * k };
          hoodOpacity = lerp(f.op ?? 0, 1, smooth(tau / HOOD_UP.fadeIn));
          hoodBand = lerp(f.band ?? 0, 1, smooth((tau - 0.16) / 0.14));
          if (!t.blinked && tau >= HOOD_UP.blinkAt) {
            t.blinked = true;
            this._blink("hood");
          }
        } else {
          // Mirror of hood up: lift away along the same path, fading over the last 100 ms.
          // Quadratic ease-in plus a small immediate tug, so the lift starts visibly.
          const v = clamp01(tau / HOOD_DOWN.duration);
          const k = 0.12 * smooth(v / 0.35) + 0.88 * v * v;
          const f = t.from ?? { x: 0, y: 0, rot: 0, op: 1, band: 1 };
          hoodTransform = { x: lerp(f.x, -25, k), y: lerp(f.y, -90, k), rot: lerp(f.rot, -12, k) };
          hoodBand = (f.band ?? 1) * (1 - smooth(tau / 0.1));
          hoodOpacity =
            (f.op ?? 1) *
            (1 - smooth((tau - (HOOD_DOWN.duration - HOOD_DOWN.fadeOut)) / HOOD_DOWN.fadeOut));
        }
      } else if (t.kind === "appearance") {
        const w = sine((tau - t.wipe.at) / APPEAR.wipe);
        wipe = { edge: this._wipeEdge(t.wipe, tau), side: t.wipe.side, incoming: t.incoming };
        // The outgoing head also fades over the last 40% so no feathered remnant lingers.
        const outOpacity = 1 - smooth((w - 0.6) / 0.4);
        if (t.incoming === "head") {
          headOpacity = 1;
          altOpacity = outOpacity;
        } else {
          altOpacity = 1;
          headOpacity = outOpacity;
        }
      } else if (t.kind === "palette") {
        const k = String(fmt(sine(p)));
        for (const name of CLOTH) {
          const twin = this._twins[name];
          if (twin.style.display !== "none") twin.setAttribute("opacity", k);
        }
      }
    }
    this._hoodTransition = hoodTransform;
    if (this._transitions.has("hood")) {
      const clip = this._headClipped();
      this._clipHead(head, clip);
      if (headAlt.style.display !== "none") this._clipHead(headAlt, clip);
      hoodWrap.setAttribute("opacity", String(fmt(hoodOpacity)));
    }
    if (hoodBand !== null) {
      this._hoodBand.reveal.setAttribute("opacity", String(fmt(hoodBand)));
      this._hoodBandValue = hoodBand;
      this._images.hood.setAttribute("mask", `url(#${this._hoodBand.id})`);
      this._twins.hood.setAttribute("mask", `url(#${this._hoodBand.id})`);
    }
    if (headOpacity !== null) head.setAttribute("opacity", String(fmt(headOpacity)));
    if (altOpacity !== null) {
      headAlt.setAttribute("opacity", String(fmt(altOpacity)));
      headAlt.style.display = altOpacity > 0 ? "" : "none";
    }
    if (wipe !== null) {
      this._setWipe(wipe.edge);
      const other = wipe.side === "in" ? "out" : "in";
      const [inImage, outImage] = wipe.incoming === "head" ? [head, headAlt] : [headAlt, head];
      for (const [side, image] of [
        [wipe.side, inImage],
        [other, outImage],
      ] as const) {
        const feather = this._featherID(image.dataset.appearance);
        if (feather) this._wipe[side].group.setAttribute("mask", `url(#${feather})`);
        else this._wipe[side].group.removeAttribute("mask");
        image.setAttribute("mask", `url(#${this._wipe[side].id})`);
      }
    }
    if (this._transitions.has("equipment")) {
      grip.setAttribute("transform", gripTransform);
      grip.setAttribute("opacity", String(fmt(gripOpacity)));
    }
    for (const kind of done) this._finishTransition(kind, true);
  }

  private _dispatchTransitionEnd(kind: TransitionKind, completed: boolean) {
    this.dispatchEvent(new CustomEvent("squire-transition-end", { detail: { kind, completed } }));
  }

  private _finishTransition(kind: TransitionKind, natural: boolean) {
    const t = this._transitions.get(kind);
    if (!t) return;
    this._transitions.delete(kind);
    if (t.kind === "equipment") {
      // Hidden with visibility (not display/href removal), so a copy that is still loading
      // finishes instead of being aborted.
      this._wraps.gripOut.style.visibility = "hidden";
      this._wraps.gripOut.removeAttribute("transform");
      this._wraps.gripOut.removeAttribute("opacity");
      this._wraps.grip.removeAttribute("transform");
      this._wraps.grip.removeAttribute("opacity");
    } else if (t.kind === "appearance") {
      if (t.incoming === "headAlt") this._beginHandoff();
      else {
        this._images.head.removeAttribute("opacity");
        this._applyFeather(this._images.head);
        this._images.headAlt.style.display = "none";
      }
    } else if (t.kind === "hood") {
      this._wraps.hood.removeAttribute("opacity");
      this._images.hood.removeAttribute("mask");
      this._twins.hood.removeAttribute("mask");
      this._hoodTransition = null;
      if (!t.up) this._setImage(this._images.hood, null);
      this._clipHead(this._images.head, t.up);
      if (this._images.headAlt.style.display !== "none") this._clipHead(this._images.headAlt, t.up);
    } else if (t.kind === "palette") {
      // The twins hold the new textures, already decoded, so the main images can swap at once.
      this._clothPalette = t.palette;
      this._refreshCloth();
      for (const name of CLOTH) {
        this._twins[name].style.display = "none";
        this._twins[name].removeAttribute("opacity");
      }
    } else if (t.kind === "entrance") {
      this._entrance = "done";
      this._bones.body.removeAttribute("opacity");
    }
    this._dispatchTransitionEnd(kind, natural);
  }

  private _finishTransitions() {
    for (const kind of this._transitions.keys()) this._finishTransition(kind, false);
  }

  private _skipEntrance() {
    if (this._entrance === "done") return;
    this._finishTransition("entrance", false);
    this._entrance = "done";
    this._bones.body.removeAttribute("opacity");
  }

  // Transient head motion owned by transitions (appearance dip/rise, hood landing).
  private _transitionPose() {
    let pitch = 0;
    let headY = 0;
    const a = this._transitions.get("appearance");
    if (a) {
      const tau = this._time - a.start;
      pitch += APPEAR_PITCH(tau);
      headY += APPEAR_Y(tau);
    }
    const h = this._transitions.get("hood");
    if (h?.kind === "hood" && h.up) pitch += HOOD_LAND_PITCH(this._time - h.start);
    return { pitch, headY };
  }

  private _endGesture(g: ActiveGesture, interrupted: boolean) {
    if (g.done) return;
    g.done = true;
    this._lastGestureEnd = this._time;
    for (const m of this._mutes) if (m.gesture && m.to === Infinity) m.to = this._time + 1.5;
    g.resolve({ name: g.name, played: true, interrupted });
    this.dispatchEvent(
      new CustomEvent("squire-gesture-end", { detail: { name: g.name, interrupted } }),
    );
  }

  private _fadeGesture(g: ActiveGesture) {
    if (g.fading) return;
    g.fading = true;
    g.weight = { x: 1, v: 0 };
    this._endGesture(g, true);
  }

  private _cancelGestures() {
    for (const g of this._gestures) this._endGesture(g, true);
    this._gestures = [];
    this._gestureDelta = {};
    this._gestureAhead = {};
    this._gestureReport = null;
    this._gestureEnergy = 0;
  }

  private _gestureAt(g: ActiveGesture, tau: number, lively: number, out: ChannelValues, w: number) {
    for (const level of ["subtle", "lively"] as const) {
      const k = (level === "lively" ? lively : 1 - lively) * w;
      if (k <= 0) continue;
      for (const [channel, track] of g.def[level])
        out[channel] = (out[channel] ?? 0) + track(tau) * k;
    }
  }

  private _stepGestures(dt: number) {
    const delta: ChannelValues = {};
    const ahead: ChannelValues = {};
    const lively = clamp01(this._springs.lively.x);
    let energy = 0;
    let report: { name: CompanionGesture; progress: number } | null = null;
    for (const g of this._gestures) {
      const tau = this._time - g.start;
      if (g.fading) spring(g.weight, 0, 14, dt);
      const w = g.fading ? g.weight.x : 1;
      this._gestureAt(g, tau, lively, delta, w);
      this._gestureAt(g, tau + EYE_LEAD, lively, ahead, w);
      const progress = clamp01(tau / g.def.duration);
      energy += g.def.energy * Math.sin(Math.PI * progress) * w;
      if (!g.fading) report = { name: g.name, progress };
      const fxAt = g.def.fxAt;
      if (!g.fired && fxAt !== undefined && tau >= fxAt && !g.fading) {
        g.fired = true;
        if (g.name === "flourish")
          this._fxTrigger({ name: "flourish", detail: { duration: g.def.duration - fxAt } });
      }
      if (tau >= g.def.duration) this._endGesture(g, false);
    }
    this._gestures = this._gestures.filter(
      (g) => this._time - g.start < g.def.duration && !(g.fading && g.weight.x < 0.002),
    );
    this._gestureDelta = delta;
    this._gestureAhead = ahead;
    this._gestureEnergy = energy;
    this._gestureReport = report;
  }

  private _stateName(): CompanionState {
    return this._scrub?.state ?? this.getConfiguration().state;
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

  private _baseGaze(time: number, mode: RigConfiguration["gaze"]) {
    if (mode === "auto") {
      return (
        autoGaze(time - this._origin, this._origin) *
        this._blend("autoGaze") *
        (1 - clamp01(this._springs.quiet.x))
      );
    }
    if (mode === "pointer") return this._pointer.gaze;
    return mode === "left" ? -1 : mode === "right" ? 1 : 0;
  }

  // State blend; weights sum to 1 but may overshoot slightly (that is the overshoot).
  private _blend(key: PoseKey) {
    const s = this._springs;
    let total = 0;
    for (const name of STATES) total += POSES[name][key] * s[name].x;
    return total;
  }

  private _settleSprings(state: CompanionState, ambient: number) {
    const c = this.getConfiguration();
    for (const name of STATES) settle(this._springs[name], name === state ? 1 : 0);
    settle(this._springs.lively, c.motion === "lively" ? 1 : 0);
    settle(this._springs.ambient, ambient);
    settle(this._springs.pitch, 0);
    settle(this._springs.quiet, 0);
    this._stateTarget = state;
    this._lastState = state;
    this._anticipation = null;
    this._mutes = [];
    this._lastGestureEnd = -Infinity;
    this._lastStateChange = -Infinity;
    this._breathPhase = breathPhaseAt(this._time, POSES[state].breathPeriod);
  }

  // Beat gating (rig time). Windows mute beats starting inside them; after a state change
  // the first beat may not pull against the direction the state just moved (pitch).
  private _mute(start: number, beat: BeatDef, prevStart: number, intro?: boolean) {
    if (start >= this._origin && start < this._origin + 3) return true;
    // Scheduled beats keep clear of the intro beat.
    if (
      !intro &&
      this._introAt !== undefined &&
      start > this._introAt - 1 &&
      start < this._introAt + 6
    )
      return true;
    for (const m of this._mutes) {
      if (start >= m.from && start <= m.to) return true;
      // Beats already running at a state change fade out with `quiet`, then are dropped.
      if (m.state && start < m.from && start > m.from - 5 && this._time >= m.from + 0.6)
        return true;
      if (
        m.dir &&
        beat.pitch &&
        Math.sign(beat.pitch) !== m.dir &&
        prevStart < m.to &&
        start > m.to
      )
        return true;
    }
    return false;
  }

  private _step(dt: number) {
    const c = this.getConfiguration();
    const s = this._springs;
    const settling = this._settling;
    // State change: blink, anticipate (small counter-move), then spring with overshoot.
    if (c.state !== this._lastState) {
      const delta = {} as Record<AnticipateKey, number>;
      for (const ch of ANTICIPATE) delta[ch] = POSES[c.state][ch] - this._blend(ch);
      this._anticipation = { start: this._time, delta };
      const dir = Math.sign(POSES[c.state].pitch - POSES[this._lastState ?? c.state].pitch);
      this._mutes.push({ from: this._time, to: this._time + 2.5, dir, state: true });
      this._lastStateChange = this._time;
      if (this._lastState !== undefined) this._blink("state");
      this._lastState = c.state;
    }
    if (this._anticipation && this._time - this._anticipation.start >= 0.1)
      this._stateTarget = c.state;
    for (const name of STATES)
      springZ(s[name], name === (this._stateTarget ?? c.state) ? 1 : 0, 8, 0.75, dt);
    spring(s.lively, c.motion === "lively" ? 1 : 0, 5, dt);
    if (settling) {
      s.ambient.x =
        settling.ambient * (1 - sine((this._time - settling.start) / settling.duration));
      s.ambient.v = 0;
    } else spring(s.ambient, 1, 2.5, dt);
    const pointerActive =
      c.gaze === "pointer" && this._time < (this._lastPointer ?? -Infinity) + 1.5;
    if (pointerActive && this._lastPointer !== undefined) {
      const m = this._pointerMute;
      if (m && m.to >= this._time - 0.1 && this._mutes.includes(m)) m.to = this._lastPointer + 1.5;
      else
        this._mutes.push(
          (this._pointerMute = { from: this._lastPointer, to: this._lastPointer + 1.5 }),
        );
    }
    const quiet =
      this._gestures.some((g) => !g.fading) ||
      this._time < this._lastGestureEnd + 0.8 ||
      pointerActive ||
      this._time < this._lastStateChange + 2.5;
    spring(s.quiet, quiet ? 1 : 0, 12, dt);
    const restGaze = c.gaze === "auto" || c.gaze === "pointer" ? 0 : this._baseGaze(0, c.gaze);
    const gazeTarget = settling ? restGaze : this._baseGaze(this._time, c.gaze);
    spring(s.gaze, gazeTarget, c.gaze === "pointer" ? 8 : 6, dt);
    spring(s.pitch, c.gaze === "pointer" && !settling ? this._pointer.pitch : 0, 7, dt);
    this._gaze = s.gaze.x;
    const n = Math.floor(this._breathPhase);
    this._breathPhase += dt / (Math.max(3, this._blend("breathPeriod")) * breathCycle(n).period);
    this._mutes = this._mutes.filter((m) => m.to > this._time - 30);
    this._stepGestures(dt);
    this._applyTransitions();
    // Large gaze shifts get a blink about 70% of the time (deterministic sequence).
    if (Math.abs(gazeTarget - this._blinkAnchor) > 0.5) {
      this._blinkAnchor = gazeTarget;
      if (hash(77, ++this._blinkCount) < 0.7) this._blink("gaze");
    }
  }

  // The pose _applyRest will show, computed without disturbing live state.
  private _restPose() {
    const springs = Object.fromEntries(
      Object.entries(this._springs).map(([k, v]) => [k, { ...v }]),
    );
    const keep = {
      breathPhase: this._breathPhase,
      mutes: this._mutes,
      lastState: this._lastState,
      stateTarget: this._stateTarget,
      anticipation: this._anticipation,
      lastGestureEnd: this._lastGestureEnd,
      gestureDelta: this._gestureDelta,
      gestureAhead: this._gestureAhead,
      gaze: this._gaze,
      gazeTargetNow: this._gazeTargetNow,
      lastStateChange: this._lastStateChange,
    };
    const c = this.getConfiguration();
    this._settleSprings(c.state, 0);
    const gaze = c.gaze === "auto" || c.gaze === "pointer" ? 0 : this._baseGaze(0, c.gaze);
    settle(this._springs.gaze, gaze);
    this._gazeTargetNow = gaze;
    this._gestureDelta = {};
    this._gestureAhead = {};
    this._restPosing = true;
    const pose = this._computePose(this._time);
    this._restPosing = false;
    for (const [k, v] of Object.entries(springs)) {
      const target = this._springs[k as SpringName];
      target.x = v.x;
      target.v = v.v;
    }
    this._breathPhase = keep.breathPhase;
    this._mutes = keep.mutes;
    this._lastState = keep.lastState;
    this._stateTarget = keep.stateTarget;
    this._anticipation = keep.anticipation;
    this._lastGestureEnd = keep.lastGestureEnd;
    this._gestureDelta = keep.gestureDelta;
    this._gestureAhead = keep.gestureAhead;
    this._gaze = keep.gaze;
    this._gazeTargetNow = keep.gazeTargetNow;
    this._lastStateChange = keep.lastStateChange;
    return pose;
  }

  // Inspection hold: deterministic in (time, gaze, state).
  private _applyHold() {
    const hold = this._scrub;
    if (!hold) return;
    const c = this.getConfiguration();
    const state = hold.state ?? c.state;
    this._time = hold.time;
    this._clockSeeded = true;
    this._cancelGestures();
    this._finishTransitions();
    this._skipEntrance();
    this._settleSprings(state, 1);
    const gaze = hold.gaze ?? (c.gaze === "pointer" ? 0 : this._baseGaze(this._time, c.gaze));
    this._gaze = gaze;
    settle(this._springs.gaze, gaze);
    this._blinkAnchor = gaze;
    this._hoodHold = true;
    this._applyPose({ live: false, dt: 0 });
  }

  // Still, reduced motion, and settled: the state's held pose with ambient layers at rest.
  private _applyRest() {
    const c = this.getConfiguration();
    this._cancelGestures();
    this._finishTransitions();
    this._skipEntrance();
    this._settleSprings(c.state, 0);
    const gaze = c.gaze === "auto" || c.gaze === "pointer" ? 0 : this._baseGaze(0, c.gaze);
    this._gaze = gaze;
    settle(this._springs.gaze, gaze);
    this._blinkAnchor = gaze;
    this._hoodHold = true;
    this._applyPose({ live: false, dt: 0 });
  }

  private _computePose(time: number): Pose {
    const c = this.getConfiguration();
    const L = this._limits;
    const s = this._springs;
    const lively = clamp01(s.lively.x);
    const amb = clamp01(s.ambient.x);
    const blend = (key: PoseKey) => this._blend(key);

    // Idle beats from each state's schedule, weighted by the state mix; muted near gestures.
    const at = time;
    const beats: ChannelValues = {};
    const beatsAhead: ChannelValues = {};
    const beatScale = (1 + lively) * amb * (1 - clamp01(s.quiet.x));
    const mute: MuteFn = (start, beat, prev, intro) => this._mute(start, beat, prev, intro);
    if (beatScale > 1e-3) {
      for (const name of STATES) {
        const w = clamp01(s[name].x);
        if (w < 1e-3) continue;
        // Every rig gets one guaranteed beat 3.5-5 s after its clock starts (per seed).
        const intro: BeatEvent = {
          start: this._origin + 3.5 + 1.5 * hash(41, this._seed()),
          kind: INTRO_BEAT[name],
        };
        this._introAt = intro.start;
        for (const [target, t] of [
          [beats, at],
          [beatsAhead, at + EYE_LEAD],
        ] as const) {
          const b = beatsAt(name, t, mute, intro);
          for (const ch of CHANNELS) {
            const v = b[ch];
            if (v !== undefined) target[ch] = (target[ch] ?? 0) + v * w * beatScale;
          }
        }
      }
    }
    const g = this._gestureDelta;
    const ga = this._gestureAhead;
    const v = (ch: Channel) => (beats[ch] ?? 0) + (g[ch] ?? 0);
    const vAhead = (ch: Channel) => (beatsAhead[ch] ?? 0) + (ga[ch] ?? 0);
    const tp = this._restPosing ? { pitch: 0, headY: 0 } : this._transitionPose();
    // State anticipation: a short counter-move before the spring takes the new pose.
    const antic = (ch: AnticipateKey) => {
      const a = this._anticipation;
      if (!a) return 0;
      const tau = time - a.start;
      return tau < 0.3 ? -0.15 * a.delta[ch] * Math.sin(Math.PI * clamp01(tau / 0.3)) : 0;
    };

    const swayAmp = SWAY_DEG * (1 + 0.5 * lively) * blend("sway") * amb;
    const sw = sway(at) * swayAmp;
    const cycle = breathCycle(Math.floor(this._breathPhase));
    // Capped so the deepest sigh keeps the torso stretch near 1%.
    const breath = softLimit(
      breathShape(this._breathPhase) *
        cycle.depth *
        blend("breathDepth") *
        (1 + 0.1 * lively) *
        amb,
      [-1, 1.85],
    );
    const sigh = cycle.sigh ? breath : 0;

    const bodyBase = sw + blend("body") + antic("body");
    const body = softLimit(bodyBase + room(bodyBase, v("body"), L.body), L.body);
    const bodyYBase = blend("bodyY") + antic("bodyY") - BREATH_BOB * breath;
    const bodyY = softLimit(bodyYBase + room(bodyYBase, v("bodyY"), L.bodyY), L.bodyY);
    const gazeBase = s.gaze.x + blend("gaze");
    const gaze = softLimit(gazeBase + v("gaze"), [-1.25, 1.25]);
    const drift = (0.35 * wave(at, 9.7, 1.3) + 0.2 * wave(at, 5.9, 0.4)) * amb;
    const pitchDrift = 0.3 * wave(at, 12.3, 2) * amb;
    const pitchBase =
      blend("pitch") +
      antic("pitch") +
      s.pitch.x +
      pitchDrift -
      0.3 * breath +
      0.6 * sigh +
      tp.pitch;
    const pitch = pitchBase + v("pitch");
    // Head lags the body (delayed sway) and partly counter-rotates.
    const follow = swayAmp * (0.55 * (sway(at - 0.45) - sway(at)) - 0.2 * sway(at));
    const gazeDeg = c.gaze === "pointer" ? GAZE_DEG_POINTER : GAZE_DEG;
    const headBase = follow + drift + gazeBase * gazeDeg + pitchBase;
    const head = softLimit(
      headBase + room(headBase, (gaze - gazeBase) * gazeDeg + v("pitch"), L.head),
      L.head,
    );
    const headX = softLimit(gaze * GAZE_X + v("headX"), L.headX);
    const headY = softLimit(v("headY") + tp.headY + 0.45 * Math.max(0, pitch), L.headY);

    // Eyes: aim slightly ahead in time so they lead the head.
    const eye = {
      x: clamp(this._gazeTargetNow + blend("gaze") + vAhead("gaze")),
      y: clamp(
        blend("eyeY") +
          vAhead("eyeY") +
          (this._pointer.pitch / 4) * (c.gaze === "pointer" ? 1 : 0) +
          vAhead("pitch") / 6,
      ),
    };

    // Forearm motion relative to the torso, optionally scaled per grip.
    const grip = this._art.grips[c.equipment];
    const k = grip.armMotion ?? 1;
    const itemScale = blend("item") * (1 + 0.3 * lively) * amb;
    const idle = ITEM_IDLE[c.equipment](at, sw / SWAY_DEG);
    const counter = c.equipment === "lance" ? 0.15 : blend("counter");
    const armBase =
      k * (-counter * sw + idle.arm * itemScale + blend("arm") + antic("arm") - 0.35 * breath);
    const arm = softLimit(armBase + room(armBase, k * v("arm"), L.arm), L.arm);
    const armX = softLimit(
      k * (idle.armX * itemScale + blend("armX") + antic("armX") + v("armX")),
      L.armX,
    );
    const armY = softLimit(
      k * (idle.armY * itemScale + blend("armY") + antic("armY") + v("armY")),
      L.armY,
    );
    return {
      body,
      bodyY,
      head,
      headX,
      headY,
      headPitch: pitch,
      gaze,
      eye,
      arm,
      armX,
      armY,
      breath,
      lively,
      hood: 0,
    };
  }

  private _applyPose({ live, dt }: { live: boolean; dt: number }) {
    const art = this._art;
    const c = this.getConfiguration();
    this._gazeTargetNow = live ? this._baseGaze(this._time, c.gaze) : this._springs.gaze.x;
    // Test hook (seam sweeps): rig._testChannels = { head: 3, arm: -2, ... } replaces those
    // computed channels exactly (no smoothing) until set back to null.
    const forced: RigTestChannels = this._testChannels ?? {};
    const pose: Pose = Object.assign(this._computePose(this._time), forced);
    // Final critically damped filter on bone channels: absorbs any residual step (equipment
    // swaps, interrupted gestures, limit exits). Holds and rests settle it exactly.
    for (const ch of OUTPUT_CHANNELS) {
      const sp = this._out[ch] ?? (this._out[ch] = { x: pose[ch], v: 0 });
      if (ch !== "headPitch" && ch !== "gaze" && ch in forced) settle(sp, pose[ch]);
      else if (live && dt > 0) {
        spring(
          sp,
          pose[ch],
          ch === "head" || ch === "headPitch" ? OUTPUT_OMEGA_HEAD : OUTPUT_OMEGA,
          dt,
        );
        pose[ch] = sp.x;
      } else if (live && this._outLive) pose[ch] = sp.x;
      else settle(sp, pose[ch]);
    }
    // Eyes are fast but still smoothed.
    for (const axis of ["x", "y"] as const) {
      const sp = this._springs[axis === "x" ? "eyeX" : "eyeY"];
      if (!live || !this._outLive) settle(sp, pose.eye[axis]);
      else if (dt > 0) spring(sp, pose.eye[axis], 22, dt);
      pose.eye[axis] = Math.round(sp.x * 1e4) / 1e4;
    }
    this._outLive = live;
    // Settling to rest: ease every channel onto the exact rest pose, so the final rest
    // frame (applied when frames stop) matches the last animated frame.
    let settleK = 0;
    let rest: Pose | null = null;
    if (this._settling && live) {
      settleK = sine((this._time - this._settling.start) / this._settling.duration);
      rest = this._restPose();
      for (const ch of OUTPUT_CHANNELS) pose[ch] = lerp(pose[ch], rest[ch], settleK);
      pose.eye = {
        x: lerp(pose.eye.x, rest.eye.x, settleK),
        y: lerp(pose.eye.y, rest.eye.y, settleK),
      };
    }
    const p = art.pivots;
    const [px, py] = p.body;
    const sx = 1 + BREATH_SPREAD * pose.breath;
    const sy = 1 + BREATH_LIFT * pose.breath;
    // Children follow the torso's breath displacement at their own pivots.
    const hdx = (p.head[0] - px) * (sx - 1);
    const hdy = (p.head[1] - py) * (sy - 1);

    // A raised hood turns with part of the head angle through a spring, so it trails.
    // It follows chin-up turns more closely so the crown never opens a wedge over the hair.
    const hs = this._springs.hood;
    const L = this._limits;
    const hoodTarget = (pose.head < 0 ? HOOD_FOLLOW_UP : HOOD_FOLLOW) * pose.head;
    if (this._hoodHold || !live) {
      settle(hs, hoodTarget);
      this._hoodHold = false;
    } else spring(hs, hoodTarget, 10, dt);
    if (!("hood" in forced)) pose.hood = softLimit(hs.x, L.hood);
    if (rest) {
      pose.hood = lerp(
        pose.hood,
        softLimit((rest.head < 0 ? HOOD_FOLLOW_UP : HOOD_FOLLOW) * rest.head, L.hood),
        settleK,
      );
    }

    let rise = 0;
    let opacity: number | null = null;
    const entrance = this._transitions.get("entrance");
    if (entrance) {
      const tau = this._time - entrance.start;
      rise = 9 * (1 - easeOut(tau / 0.7));
      opacity = smooth(tau / 0.5);
    } else if (this._entrance === "pending" && !this._seen) opacity = 0;
    const body = this._bones.body;
    body.setAttribute(
      "transform",
      `translate(0 ${fmt(pose.bodyY + rise)}) rotate(${fmt(pose.body)} ${px} ${py})`,
    );
    if (opacity !== null) body.setAttribute("opacity", String(fmt(opacity)));
    else body.removeAttribute("opacity");
    const breathM: Matrix = [sx, 0, 0, sy, px * (1 - sx), py * (1 - sy)];
    this._wraps.torso.setAttribute("transform", mat.css(breathM));
    // Static head copy behind the moving head, clipped to the nape band (hood down only).
    const fill = this._images.napeFill;
    const fillOn =
      !!this._napeFill &&
      this._shown?.hood === "down" &&
      !this._transitions.has("hood") &&
      !this._transitions.has("appearance");
    if (fillOn) {
      const href = this._images.head.getAttribute("href");
      if (fill.getAttribute("href") !== href) this._copyImage(this._images.head, fill);
      this._wraps.napeFill.style.display = "";
      this._wraps.napeFill.setAttribute("transform", mat.css(mat.translate(hdx, hdy)));
    } else this._wraps.napeFill.style.display = "none";
    const rockAt = art.rock ?? ROCK;
    const headM = mat.mul(
      mat.translate(hdx + pose.headX, hdy + pose.headY),
      rock(pose.head, rockAt.throat, rockAt.nape),
    );
    this._bones.head.setAttribute("transform", mat.css(headM));
    if (this._images.hood.style.display !== "none") {
      // The hood lives in the head bone for paint order, so cancel the head transform and
      // apply its own; the face clip rides with the hood (including its transition travel)
      // so the opening stays sealed. Backward shifts are mostly absorbed inside the hood.
      const followX = pose.headX * (0.375 + 0.225 * Math.tanh(pose.headX / 0.5));
      let hoodM = mat.mul(
        mat.translate(hdx + followX, hdy + HOOD_FOLLOW_X * pose.headY),
        rock(pose.hood, rockAt.hoodFront, rockAt.hoodBack),
      );
      const t = this._hoodTransition;
      if (t)
        hoodM = mat.mul(
          hoodM,
          mat.mul(mat.translate(t.x, t.y), mat.rotate(t.rot, rockAt.hoodBack)),
        );
      const local = mat.css(mat.mul(mat.inv(headM), hoodM));
      this._wraps.hood.setAttribute("transform", local);
      this._clipPath.setAttribute("transform", local);
      // Hood interior behind the head: any brim/hair gap shows lining, never background.
      if (art.hoodLining) {
        // Group clipped by the (hood-relative) face clip; the path itself rides the hood.
        this._lining.style.display = "";
        this._lining.setAttribute("clip-path", `url(#${this._hoodFaceClipID})`);
        this._lining.firstElementChild?.setAttribute("transform", local);
        const op = this._wraps.hood.getAttribute("opacity");
        if (op === null) this._lining.removeAttribute("opacity");
        else this._lining.setAttribute("opacity", op);
      }
    } else this._lining.style.display = "none";
    // The forearm inherits the torso's breath matrix exactly, so the elbow stays registered.
    this._bones.arm.setAttribute(
      "transform",
      mat.css(
        mat.mul(breathM, mat.mul(mat.translate(pose.armX, pose.armY), mat.rotate(pose.arm, p.arm))),
      ),
    );
    this._pose = pose;
    this._frameCount++;

    if (this._fx) {
      const kinds = [...this._transitions.keys()];
      const transition = kinds.length
        ? Object.fromEntries(kinds.map((kind) => [kind, this._transitionProgress(kind)]))
        : null;
      const frame: FxFrame = {
        time: this._time,
        dt: live ? dt : 0,
        live,
        hold: !!this._scrub,
        seed: this._seed(),
        settle: live ? settleK : this._scrub ? 0 : 1,
        state: this._stateName(),
        stateMix: this._stateMix(),
        energy: clamp01(this._blend("energy") + (live ? this._gestureEnergy : 0)),
        lid: clamp01(this._blend("lid")),
        breath: clamp01(pose.breath) * 2 - 1,
        gesture: live ? this._gestureReport : null,
        eye: pose.eye,
        pose: {
          body: pose.body,
          head: pose.head,
          arm: pose.arm,
          headPitch: pose.headPitch,
          gaze: pose.gaze,
        },
        transition,
      };
      this._fxRun("update", (fx) => fx.update(frame));
    }
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

  // Horizontal offset -> gaze (mostly eyes); vertical -> head pitch up to about +-4 deg.
  private _pointerAt(x: number, y: number) {
    const rect = this.getBoundingClientRect();
    if (!rect.width) return;
    const [w, h] = this._art.stage;
    const [hx, hy] = this._art.pivots.head;
    // mirrored="on": the host page flips the figure with scaleX(-1), so the head sits at the
    // mirrored x and the figure's forward (positive gaze) points screen-left.
    const flip = this.getAttribute("mirrored") === "on" ? -1 : 1;
    const cx = flip < 0 ? rect.right - (rect.width * hx) / w : rect.left + (rect.width * hx) / w;
    const cy = rect.top + (rect.height * hy) / h;
    const nx = (flip * (x - cx)) / Math.max(120, rect.width * 0.45);
    const ny = (y - cy) / Math.max(180, rect.height * 0.6);
    this._pointer = {
      gaze: Math.tanh(nx * 1.2),
      pitch: ny > 0 ? 4 * Math.tanh(ny * 1.3) : 3.5 * Math.tanh(ny * 1.3),
    };
    // Following the pointer is the act: idle beats stay out of the way for 1.5 s.
    this._lastPointer = this._time;
  }

  private _pointerOverRig(x: number, y: number) {
    const rect = this.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  private _pausedReason(): CompanionPauseReason | null {
    if (!this.isConnected) return "disconnected";
    if (!this._artReady) return "missing-art";
    if (this._scrub) return "scrub";
    if (this.getConfiguration().motion === "still") return "still";
    if (this._media?.matches) return "reduced-motion";
    if (document.visibilityState !== "visible") return "document-hidden";
    if (!this._inView) return "offscreen";
    if (!companionClock().hasFocus()) return "unfocused";
    if (!this._holding) return "yielded";
    if (this._settled) return "settled";
    return null;
  }

  // Frames run while unpaused, and briefly after motion="still" while settling to rest.
  private _running() {
    const reason = this._pausedReason();
    return !reason || (reason === "still" && !!this._settling);
  }

  // A state change, gesture, transition, or pointer interaction restarts the settle deadline.
  private _noteActivity() {
    this._lastActivity = companionClock().now();
  }

  // Wakes a settled (or settling) rig. Genuine pauses win: nothing changes under them.
  private _wake() {
    const reason = this._pausedReason();
    if (reason !== null && reason !== "settled") return;
    this._noteActivity();
    if (this._settling?.kind === "settle") this._settling = null;
    if (this._settled) {
      this._settled = false;
      this._syncMotion();
    }
  }

  // The blend runs over the deadline's last 0.55 s, so the rig is still at 20 s.
  private _beginSettleIfDue(now: number) {
    if (this._settling || this._lastActivity === null) return;
    if (now - this._lastActivity < COMPANION_SETTLE_MS - STILL_BLEND * 1000) return;
    this._settling = {
      kind: "settle",
      start: this._time,
      duration: STILL_BLEND,
      ambient: this._springs.ambient.x,
    };
    for (const g of this._gestures) this._fadeGesture(g);
  }

  private _stopMotion() {
    if (this._raf !== null) companionClock().cancelFrame(this._raf);
    this._raf = null;
    this._lastFrame = null;
  }

  // Only a rig that could animate claims the lease: still, reduced-motion, and held rigs show
  // one frame and must not pause the live one. A still blend keeps it until the blend ends.
  private _syncLease() {
    const c = this.getConfiguration();
    const wants =
      this.isConnected &&
      !this._scrub &&
      !this._media?.matches &&
      (c.motion !== "still" || !!this._settling);
    if (wants && !this._lease && !this._acquiring) {
      // Our own claim's callback fires inside acquire; the caller reads `_holding` after.
      this._acquiring = true;
      try {
        this._lease = acquireCompanionLease(c.placement, (holding) => {
          this._holding = holding;
          if (this.isConnected && !this._acquiring) this._syncMotion();
        });
      } finally {
        this._acquiring = false;
      }
    } else if (!wants && this._lease) {
      const lease = this._lease;
      this._lease = null;
      this._holding = false;
      lease.release();
    }
  }

  private _syncMotion() {
    this._syncLease();
    const reason = this._pausedReason();
    const clock = companionClock();
    if (reason === "still" && this._settling) {
      if (this._raf === null) this._raf = clock.requestFrame(this._tick);
      return;
    }
    if (reason) {
      this._settling = null;
      this._stopMotion();
      if (reason === "yielded") {
        // Keep the last frame exactly: only release gesture promises and never leave an
        // entrance unfinished (it would hold the figure transparent).
        if (this._gestures.length) this._cancelGestures();
        this._skipEntrance();
        return;
      }
      // Nothing animates while paused: cut gestures and transitions short.
      if (this._gestures.length) this._cancelGestures();
      if (this._transitions.size) this._finishTransitions();
      if (this.getConfiguration().transitions === "off") this._skipEntrance();
      if (reason === "still" || reason === "reduced-motion" || reason === "settled")
        this._applyRest();
      return;
    }
    if (!this._clockSeeded) {
      // First live start: seed the clock so instances are out of phase.
      this._clockSeeded = true;
      if (this._time === 0) {
        this._time = this._origin;
        this._settleSprings(this._stateName(), this._springs.ambient.x);
      }
    }
    if (this._lastActivity === null) this._noteActivity();
    if (this._entrance === "pending") {
      if (this.getConfiguration().transitions === "on") {
        this._entrance = "playing";
        this._startTransition({ kind: "entrance", start: this._time, duration: 0.7 });
        this._fxTrigger({ name: "entrance", detail: { duration: 0.7 } });
      } else this._skipEntrance();
    }
    if (this._raf === null) this._raf = clock.requestFrame(this._tick);
  }
}

// Paused rigs that keep their last frame still repaint once when an attribute changes.
const STATIC_FRAME_REASONS: ReadonlySet<CompanionPauseReason> = new Set([
  "missing-art",
  "offscreen",
  "document-hidden",
  "unfocused",
  "yielded",
]);

declare global {
  interface HTMLElementTagNameMap {
    "squire-rig": SquireRigElement;
  }
}

export function defineSquireRig() {
  if (!customElements.get("squire-rig")) customElements.define("squire-rig", SquireRigElement);
}
