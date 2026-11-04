// Shared vocabulary of the ported v5 companion runtime (<squire-rig>, <squire-emblem>, FX).
// Coordinates are stage units of the v5 art (1122 x 1402) unless a comment says otherwise.

export const COMPANION_STATES = ["idle", "attentive", "thinking"] as const;
export type CompanionState = (typeof COMPANION_STATES)[number];

export const COMPANION_GESTURES = [
  "nod",
  "greet",
  "flourish",
  "glance",
  "listen",
  "ponder",
] as const;
export type CompanionGesture = (typeof COMPANION_GESTURES)[number];

// `gold` is the Lead's palette.
export const COMPANION_PALETTES = ["brass", "moonstone", "sage", "rose", "gold"] as const;
export type CompanionPalette = (typeof COMPANION_PALETTES)[number];

export const RIG_CHOICES = {
  appearance: ["female", "male"],
  hood: ["down", "up"],
  equipment: ["helmet", "lance", "astrolabe", "grimoire", "armillary", "none"],
  palette: COMPANION_PALETTES,
  motion: ["subtle", "lively", "still"],
  gaze: ["auto", "left", "center", "right", "pointer"],
  state: COMPANION_STATES,
  transitions: ["on", "off"],
  crest: ["off", "on"],
  placement: ["panel", "overlay"],
} as const;

export const EMBLEM_CHOICES = {
  palette: COMPANION_PALETTES,
  motion: ["subtle", "lively", "still"],
  gaze: ["auto", "left", "center", "right", "pointer"],
  state: COMPANION_STATES,
  transitions: ["on", "off"],
  frame: ["bare", "orbit", "seal"],
  weight: ["regular", "fine", "bold"],
  glow: ["soft", "bright", "none"],
  surface: ["auto", "dark", "light"],
  placement: ["panel", "overlay"],
} as const;

type ChoiceValues<T extends Readonly<Record<string, readonly string[]>>> = {
  -readonly [K in keyof T]: T[K][number];
};

export type RigAppearance = (typeof RIG_CHOICES.appearance)[number];
export type RigHood = (typeof RIG_CHOICES.hood)[number];
export type RigEquipment = (typeof RIG_CHOICES.equipment)[number];
export type CompanionMotion = (typeof RIG_CHOICES.motion)[number];

export type RigConfiguration = ChoiceValues<typeof RIG_CHOICES> & {
  debug: boolean;
  label: string;
};

export type EmblemConfiguration = ChoiceValues<typeof EMBLEM_CHOICES> & {
  debug: boolean;
  label: string;
  seed: number;
};

// The persisted choice as the server sends it.
export type { SquireCompanion } from "@lecturn/contracts";

/**
 * Why a companion is not animating. v5 reasons plus three added by the port:
 * `unfocused` (window lost focus), `yielded` (another live companion holds the lease), and
 * `settled` (20 s without a state change, gesture, or pointer interaction).
 */
export type CompanionPauseReason =
  | "disconnected"
  | "missing-art"
  | "scrub"
  | "still"
  | "reduced-motion"
  | "document-hidden"
  | "offscreen"
  | "unfocused"
  | "yielded"
  | "settled";

/** Pauses that pointer movement, `play()`, and state changes never override. */
export const GENUINE_PAUSE_REASONS: ReadonlySet<CompanionPauseReason> = new Set([
  "disconnected",
  "missing-art",
  "scrub",
  "still",
  "reduced-motion",
  "document-hidden",
  "offscreen",
  "unfocused",
  "yielded",
]);

export const COMPANION_SETTLE_MS = 20_000;
export const COMPANION_MAX_FPS = 30;

export type GestureResult = {
  readonly name: CompanionGesture;
  readonly played: boolean;
  readonly interrupted?: boolean;
};

export type SetPoseInput = {
  readonly time?: number;
  readonly gaze?: number;
  readonly state?: CompanionState;
};

export type RigPoseSnapshot = {
  readonly body: number;
  readonly head: number;
  readonly arm: number;
  readonly headPitch: number;
  readonly gaze: number;
  readonly bodyY: number;
};

export type CompanionDebugStateBase = {
  readonly paused: boolean;
  readonly reason: CompanionPauseReason | null;
  readonly frameCount: number;
  readonly pendingRAF: 0 | 1;
  readonly time: number;
  readonly gaze: number;
  readonly state: CompanionState;
  readonly stateMix: Readonly<Record<CompanionState, number>>;
  readonly fps: number;
  readonly activeGesture: CompanionGesture | null;
  readonly transition: string | null;
  readonly transitions: readonly string[];
  readonly motion: CompanionMotion;
  readonly settling: boolean;
  readonly seed: number;
};

export type RigDebugState = CompanionDebugStateBase & {
  readonly breath: number;
  readonly eye: { readonly x: number; readonly y: number };
  readonly lid: number;
  readonly pose: RigPoseSnapshot | null;
};

/** Channels `_testChannels` may force (validate.cjs seam sweeps). */
export type RigTestChannels = Partial<
  Record<
    "body" | "bodyY" | "head" | "headX" | "headY" | "arm" | "armX" | "armY" | "breath" | "hood",
    number
  >
>;

/** The surface both elements share (v5 contract plus the port's lease and settle behavior). */
export interface CompanionElement extends HTMLElement {
  readonly debugState: CompanionDebugStateBase;
  setPose(input?: SetPoseInput): void;
  resume(): void;
  play(name: CompanionGesture): Promise<GestureResult>;
}

export type Point = readonly [number, number];
export type Range = readonly [number, number];

/** One image layer: `src` is an imported asset URL; x/y/w/h place the (cropped) image. */
export type RigArtImage = {
  readonly src: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotation?: number;
  readonly feather?: Range;
  readonly armMotion?: number;
};

export type RigLimits = Readonly<Record<keyof RigTestChannels & string, Range>>;

export type RigArt = {
  readonly stage: Point;
  readonly torso: RigArtImage;
  readonly heads: Readonly<Record<RigAppearance, RigArtImage>>;
  readonly hood: RigArtImage;
  readonly hoodFaceClip: string;
  readonly grips: Readonly<Record<RigEquipment, RigArtImage>>;
  readonly pivots: { readonly body: Point; readonly head: Point; readonly arm: Point };
  readonly rock: {
    readonly nape: Point;
    readonly throat: Point;
    readonly hoodBack: Point;
    readonly hoodFront: Point;
  };
  readonly limits: Partial<RigLimits> & {
    readonly heads?: Readonly<Record<string, Partial<RigLimits>>>;
    readonly grips?: Readonly<Record<string, Partial<RigLimits>>>;
  };
  readonly napeFill: Readonly<
    Partial<
      Record<
        RigAppearance,
        {
          readonly x: number;
          readonly y: number;
          readonly w: number;
          readonly h: number;
          readonly feather: number;
        }
      >
    >
  >;
  readonly hoodLining: string;
};

// FX contract v1, between squireFx.ts and squireRig.ts.
export type FxLayers = {
  readonly aura: SVGGElement;
  readonly head: SVGGElement;
  readonly torso: SVGGElement;
  readonly item: SVGGElement;
  readonly front: SVGGElement;
};

export type FxImages = {
  readonly head: SVGImageElement;
  readonly hood: SVGImageElement;
  readonly torso: SVGImageElement;
  readonly grip: SVGImageElement;
};

export type FxContext = {
  readonly NS: "http://www.w3.org/2000/svg";
  readonly svg: SVGSVGElement;
  readonly defs: SVGDefsElement;
  readonly uid: (name: string) => string;
  readonly art: RigArt;
  readonly layers: FxLayers;
  readonly images: FxImages;
};

/** Normalized rig configuration handed to FX on every render and swap. */
export type FxConfig = RigConfiguration;

export type FxFrame = {
  readonly time: number;
  readonly dt: number;
  readonly live: boolean;
  /** True during setPose: render time-deterministic FX, not rest values. */
  readonly hold: boolean;
  readonly seed: number;
  /** 0 normally; 0..1 while blending to still or settling (1 = at rest). */
  readonly settle: number;
  readonly state: CompanionState;
  readonly stateMix: Readonly<Record<CompanionState, number>>;
  readonly energy: number;
  readonly breath: number;
  readonly gesture: { readonly name: CompanionGesture; readonly progress: number } | null;
  readonly eye: { readonly x: number; readonly y: number };
  readonly lid: number;
  readonly pose: {
    readonly body: number;
    readonly head: number;
    readonly arm: number;
    readonly headPitch: number;
    readonly gaze: number;
  };
  readonly transition: Readonly<Record<string, number>> | null;
};

export type FxTrigger =
  | {
      readonly name: "equip";
      readonly detail: {
        readonly equipment: RigEquipment;
        readonly previous: RigEquipment;
        readonly duration: number;
        readonly swapAt: number;
        readonly fade: number;
      };
    }
  | {
      readonly name: "appearance";
      readonly detail: {
        readonly appearance: RigAppearance;
        readonly previous: RigAppearance;
        readonly duration: number;
        readonly swapAt: number;
        readonly swapDuration: number;
      };
    }
  | { readonly name: "entrance"; readonly detail: { readonly duration: number } }
  | { readonly name: "flourish"; readonly detail: { readonly duration: number } }
  | {
      readonly name: "blink";
      readonly detail: { readonly reason: "gaze" | "state" | "hood" | "entrance" };
    };

export interface FxController {
  configure(config: FxConfig): void;
  update(frame: FxFrame): void;
  trigger(event: FxTrigger): void;
  destroy(): void;
}
