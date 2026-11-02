// The v5 contract checks (artifacts/squire-concepts/v5/validation/validate.cjs) ported per the
// plan's D43 map, on an injected clock. Comments name the validate.cjs line each block ports.
// Per-frame step bounds are scaled by the frame interval (30 fps renders half as many frames as
// v5's 60 Hz runs, so each frame carries twice the motion); amplitude and seam bounds are v5's.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createManualCompanionClock, setCompanionClockForTests } from "./companionClock";
import { RIG_ART } from "./rigArt";
import {
  CLOTH_TINTS,
  applyClothTint,
  defineSquireRig,
  requestTint,
  tintedHref,
  type SquireRigElement,
} from "./squireRig";
import {
  COMPANION_PALETTES,
  RIG_CHOICES,
  type CompanionGesture,
  type CompanionState,
  type RigDebugState,
  type SetPoseInput,
} from "./types";

const FRAME_MS = 1000 / 120;
// v5's per-frame bounds assumed ~16.7 ms frames; the gate renders every ~33.3 ms.
const FRAME_SCALE = 2;
// Closest pair measured over seeds 1..12, two grips, both levels: greet vs listen, 8.8 px.
const PEAK_DISTANCE_PX = 7.5;
const STATE_FLOOR_PX = { attentive: 9.5, thinking: 17 };
// Per-gesture floors locking in the stronger motion (minimum over seeds 1..12 at
// subtle / lively, less ~10%): peak deviation (deg, v5 metric) and on-screen travel (px).
const GESTURE_FLOORS: Readonly<
  Record<CompanionGesture, Readonly<Record<"subtle" | "lively", { deviation: number; px: number }>>>
> = {
  nod: { subtle: { deviation: 3.2, px: 15.7 }, lively: { deviation: 3.9, px: 18.5 } },
  greet: { subtle: { deviation: 2.25, px: 8.6 }, lively: { deviation: 2.8, px: 11.5 } },
  flourish: { subtle: { deviation: 1.9, px: 6.2 }, lively: { deviation: 2.5, px: 7.3 } },
  // CP8 r2: glance now looks down at the item and back instead of v5's turn away.
  glance: { subtle: { deviation: 2.8, px: 18.7 }, lively: { deviation: 3.3, px: 21.2 } },
  listen: { subtle: { deviation: 2.95, px: 8.8 }, lively: { deviation: 3.3, px: 10.7 } },
  ponder: { subtle: { deviation: 2.9, px: 8.2 }, lively: { deviation: 3.1, px: 9.2 } },
};
// CP8: at panel size the nod's dip and greet's lift must read from the body, not only the
// motifs. The nod's peak drops the face (the lower head point) and greet's peak raises the
// item at least this far at the 340 px panel (minimum over seeds 8.4 / 8.6 px, less ~10%).
const NOD_DIP_PX = 7.5;
const GREET_LIFT_PX = 7.7;
const STATES: readonly CompanionState[] = ["idle", "attentive", "thinking"];
const GESTURES: readonly CompanionGesture[] = ["nod", "greet", "flourish", "glance"];
const EXTRA_GESTURES: readonly CompanionGesture[] = ["listen", "ponder"];
const CHOICES = RIG_CHOICES;
const DEFAULTS = {
  appearance: "female",
  hood: "down",
  equipment: "helmet",
  palette: "brass",
  motion: "subtle",
  gaze: "auto",
  state: "idle",
  transitions: "on",
  crest: "off",
  placement: "panel",
  debug: false,
  label: "",
};

type Rig = SquireRigElement;
type Clock = ReturnType<typeof createManualCompanionClock>;

let clock: Clock;
let mounted: HTMLElement[] = [];
const consoleProblems: string[] = [];

beforeAll(() => {
  for (const method of ["error", "warn"] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (method === "error" || /squire/i.test(text)) consoleProblems.push(`${method}: ${text}`);
      original(...args);
    });
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  clock = createManualCompanionClock({ frameMs: FRAME_MS });
  setCompanionClockForTests(clock);
});

afterEach(() => {
  for (const element of mounted) element.remove();
  mounted = [];
  vi.unstubAllGlobals();
  setCompanionClockForTests(null);
});

const q = <T extends Element = SVGElement>(rig: Rig, selector: string) => {
  const node = rig.shadowRoot?.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
};
const qa = <T extends Element = SVGElement>(rig: Rig, selector: string) => [
  ...(rig.shadowRoot?.querySelectorAll<T>(selector) ?? []),
];

function displayed(node: Element) {
  for (let n: Element | null = node; n; n = n.parentElement)
    if (getComputedStyle(n).display === "none") return false;
  return true;
}
function opacity(node: Element) {
  let o = 1;
  for (let n: Element | null = node; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") return 0;
    o *= Number(cs.opacity);
    if (n.tagName.toLowerCase() === "svg") break;
  }
  return o;
}
// Rendered DOM: hidden subtrees removed and attributes sorted, so only state that can reach
// pixels is compared (validate.cjs sq.serial).
function serial(rig: Rig) {
  const c = q<SVGSVGElement>(rig, "svg").cloneNode(true);
  if (!(c instanceof Element)) throw new Error("clone failed");
  for (const n of c.querySelectorAll("*")) {
    const style = n.getAttribute("style") ?? "";
    if (n.getAttribute("display") === "none" || /display:\s*none|visibility:\s*hidden/.test(style))
      n.remove();
  }
  const refs = (el: Element) =>
    [...el.attributes].flatMap((a) =>
      [...a.value.matchAll(/(?:url\(#|^#)([^)\s]+)/g)].map((m) => m[1] ?? ""),
    );
  const NR = "clipPath, mask, linearGradient, radialGradient, filter, pattern, symbol, marker";
  const defs = [...c.querySelectorAll(NR)].filter((n) => n.id && !n.parentElement?.closest(NR));
  const used = new Set<string>();
  for (const n of c.querySelectorAll("*"))
    if (!n.closest(NR)) for (const id of refs(n)) used.add(id);
  for (let grew = true; grew;) {
    grew = false;
    for (const d of defs) {
      if (!used.has(d.id)) continue;
      for (const k of [d, ...d.querySelectorAll("*")]) {
        for (const id of refs(k)) {
          if (!used.has(id)) {
            used.add(id);
            grew = true;
          }
        }
      }
    }
  }
  for (const d of defs) if (!used.has(d.id)) d.remove();
  const walk = (n: Element): string =>
    `<${n.tagName} ${[...n.attributes]
      .filter((a) => !(a.name === "style" && !a.value.trim()))
      .map((a) => `${a.name}=${a.value}`)
      .sort()
      .join(" ")}>${[...n.childNodes]
      .map((k) =>
        k instanceof Element ? walk(k) : k.nodeType === 3 ? (k.textContent ?? "").trim() : "",
      )
      .join("")}</${n.tagName}>`;
  return walk(c);
}
function diff(a: string, b: string) {
  const ta = a.split("<");
  const tb = b.split("<");
  const d: string[] = [];
  for (let k = 0; k < Math.max(ta.length, tb.length) && d.length < 3; k++) {
    const x = ta[k] ?? "";
    const y = tb[k] ?? "";
    if (x === y) continue;
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    const from = Math.max(0, i - 50);
    d.push(`<${x.split(" ")[0] ?? ""}> ...${x.slice(from, i + 70)} => ...${y.slice(from, i + 70)}`);
  }
  return d.join(" | ");
}
const fxMarkup = (rig: Rig) =>
  qa(rig, ".fx, [data-fx]")
    .map((n) => n.innerHTML)
    .join("\n");
const fxCount = (rig: Rig) =>
  qa(rig, ".fx, [data-fx]").reduce((n, g) => n + g.querySelectorAll("*").length, 0);
function stage(node: SVGGraphicsElement) {
  const svg = node.ownerSVGElement;
  const screen = node.getScreenCTM();
  const root = svg?.getScreenCTM();
  if (!screen || !root) throw new Error("no CTM");
  return root.inverse().multiply(screen);
}
const apply = (m: DOMMatrix, [x, y]: readonly [number, number]) =>
  [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as const;
const BASE_LIMITS = {
  body: [-2.5, 3],
  bodyY: [-16, 12],
  head: [-4, 4.5],
  headX: [-2.5, 2],
  headY: [-0.4, 4],
  hood: [-3.5, 2],
  arm: [-2.5, 2],
  armX: [-1.5, 1.5],
  armY: [-1.5, 1.5],
} as const;
function limits(rig: Rig) {
  const lim = { ...BASE_LIMITS, ...RIG_ART.limits };
  const c = rig.configuration;
  return {
    ...lim,
    ...lim.heads?.[c.appearance],
    ...lim.heads?.[`${c.appearance}-${c.hood}`],
    ...lim.grips?.[c.equipment],
  };
}

// A palette that was still being tinted cross-fades in on the clock once it is ready.
async function clothSettled(rig: Rig) {
  await vi.waitFor(
    () => {
      if (rig.debugState.transitions.includes("palette")) clock.advance(500);
      const palette = rig.getConfiguration().palette;
      for (const name of ["torso", "hood", "grip"]) {
        const image = q<SVGImageElement>(rig, `[data-art="${name}"]`);
        if (image.style.display !== "none") expect(image.dataset.palette).toBe(palette);
      }
      expect(rig.debugState.reason).not.toBe("missing-art");
    },
    { timeout: 10_000 },
  );
}

async function mountRig(attributes: Record<string, string> = {}, css = "") {
  defineSquireRig();
  const rig = document.createElement("squire-rig");
  rig.style.cssText = `display:block;width:400px;position:fixed;left:0;top:0;${css}`;
  for (const [name, value] of Object.entries(attributes)) rig.setAttribute(name, value);
  document.body.append(rig);
  mounted.push(rig);
  await vi.waitFor(() => expect(rig.debugState.reason).not.toBe("offscreen"));
  await clothSettled(rig);
  return rig;
}

async function config(rig: Rig, attributes: Record<string, string>, time = 2.375) {
  for (const [name, value] of Object.entries(attributes)) rig.setAttribute(name, value);
  await clothSettled(rig);
  rig.setPose({ time, gaze: 0 });
}

type Sample = RigDebugState & { elapsed: number; dt: number; extra: unknown };
// Every rendered frame for `ms` of clock time; actions run once at their offset.
function record(
  rig: Rig,
  ms: number,
  actions: { at: number; fn: (rig: Rig) => void }[] = [],
  extra?: (rig: Rig) => unknown,
) {
  const out: Sample[] = [];
  const queue = actions.map((a) => ({ ...a, done: false }));
  let elapsed = 0;
  let last = 0;
  let frames = rig.debugState.frameCount;
  while (elapsed < ms) {
    for (const a of queue) {
      if (!a.done && elapsed >= a.at) {
        a.done = true;
        a.fn(rig);
      }
    }
    clock.advance(FRAME_MS);
    elapsed += FRAME_MS;
    const ds = rig.debugState;
    if (ds.frameCount === frames) continue;
    frames = ds.frameCount;
    out.push({ ...ds, elapsed, dt: elapsed - last, extra: extra?.(rig) });
    last = elapsed;
  }
  return out;
}

const ANGLES = ["body", "head", "arm", "headPitch"] as const;
function maxFrameDelta(samples: readonly Sample[], maxDt = 40) {
  let worst = { delta: 0, channel: "", at: 0 };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a?.pose || !b?.pose || b.dt > maxDt) continue;
    for (const ch of ANGLES) {
      const d = Math.abs(b.pose[ch] - a.pose[ch]);
      if (d > worst.delta) worst = { delta: d, channel: ch, at: b.elapsed };
    }
  }
  return worst;
}
function limitViolations(
  samples: readonly { pose: RigDebugState["pose"]; time: number }[],
  lim: ReturnType<typeof limits>,
  eps: number,
  label: string,
) {
  const out: string[] = [];
  for (const s of samples) {
    if (!s.pose) continue;
    for (const ch of ["body", "head", "arm"] as const) {
      const range = lim[ch];
      if (range && (s.pose[ch] < range[0] - eps || s.pose[ch] > range[1] + eps)) {
        out.push(
          `${label} ${ch}=${s.pose[ch].toFixed(3)} outside [${range.join(",")}] at t=${s.time.toFixed(2)}`,
        );
      }
    }
  }
  return out;
}

function settledIn(rig: Rig, reason: string) {
  for (let i = 0; i < 400; i++) {
    const d = rig.debugState;
    if (d.reason === reason && !d.settling && !d.pendingRAF) return;
    clock.advance(FRAME_MS);
  }
  throw new Error(`never settled in ${reason}: ${JSON.stringify(rig.debugState.reason)}`);
}
function pauseStable(rig: Rig, reason: string) {
  settledIn(rig, reason);
  const before = { debug: rig.debugState, svg: serial(rig) };
  clock.advance(500);
  const after = { debug: rig.debugState, svg: serial(rig) };
  expect(after.debug.reason).toBe(reason);
  expect(after.debug.paused).toBe(true);
  expect(after.debug.frameCount, `${reason}: frames must stop`).toBe(before.debug.frameCount);
  expect(after.debug.time, `${reason}: rig time must stop`).toBe(before.debug.time);
  expect(after.svg === before.svg, `${reason}: rendered SVG must not change while paused`).toBe(
    true,
  );
  expect(after.debug.pendingRAF).toBe(0);
  expect(clock.pendingFrames, `${reason}: no frame may stay scheduled`).toBe(0);
}
function liveAgain(rig: Rig, label: string) {
  expect(rig.debugState.paused, label).toBe(false);
  const a = rig.debugState.frameCount;
  clock.advance(150);
  expect(rig.debugState.frameCount, `${label}: frames must advance after resuming`).toBeGreaterThan(
    a,
  );
  expect(clock.pendingFrames, `${label}: exactly one frame chain`).toBe(1);
}

function stubReducedMotion() {
  const media = Object.assign(new EventTarget(), {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
  });
  vi.stubGlobal("matchMedia", () => media);
  return (matches: boolean) => {
    media.matches = matches;
    media.dispatchEvent(new Event("change"));
  };
}

function pointerOver(rig: Rig) {
  const rect = rig.getBoundingClientRect();
  rig.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 3,
    }),
  );
}

// Crown and chin on the head bone, the item on the forearm bone (stage units).
const HEAD_POINTS = [
  [560, 110],
  [640, 420],
] as const;
const ITEM_POINT = [800, 950] as const;
const PANEL_SCALE = 340 / 1122;
function readPoints(rig: Rig) {
  const head = stage(q<SVGGElement>(rig, "[data-bone=head]"));
  const arm = stage(q<SVGGElement>(rig, "[data-bone=arm]"));
  return [...HEAD_POINTS.map((p) => apply(head, p)), apply(arm, ITEM_POINT)];
}

async function gestureRun(rig: Rig, name: CompanionGesture | null, T0 = 40) {
  rig.setPose({ time: T0 });
  rig.resume();
  clock.advance(FRAME_MS * 12);
  const events: { name: string; interrupted: boolean }[] = [];
  const onEnd = (e: Event) => {
    if (e instanceof CustomEvent) events.push(e.detail);
  };
  rig.addEventListener("squire-gesture-end", onEnd);
  const start = clock.now();
  let resolved = null as { at: number; value: unknown } | null;
  let rejected = null as string | null;
  const promise = name ? rig.play(name) : null;
  promise?.then(
    (value) => {
      resolved = { value, at: clock.now() - start };
    },
    (error: unknown) => {
      rejected = String(error);
    },
  );
  const samples: {
    time: number;
    pose: RigDebugState["pose"];
    active: string | null;
    points: (readonly [number, number])[];
  }[] = [];
  for (;;) {
    const ds = rig.debugState;
    samples.push({
      time: ds.time,
      pose: ds.pose,
      active: ds.activeGesture,
      points: readPoints(rig),
    });
    const el = clock.now() - start;
    if (el >= (name ? 4000 : 1200) || (resolved && el > resolved.at + 120) || rejected) break;
    clock.advance(1000 / 30);
    await Promise.resolve();
  }
  rig.removeEventListener("squire-gesture-end", onEnd);
  let deviation = 0;
  // Peak on-screen travel of head and item against the same moment without the gesture, in
  // pixels at the 340 px companion panel.
  let travel = 0;
  // The still at peak travel: head and item offsets from the no-gesture frame, in panel px.
  let peak: number[] = [];
  for (const s of samples) {
    rig.setPose({ time: s.time });
    const hold = rig.debugState.pose;
    if (!hold || !s.pose) continue;
    const offsets = readPoints(rig).flatMap((p, i) => {
      const live = s.points[i] ?? p;
      return [(live[0] - p[0]) * PANEL_SCALE, (live[1] - p[1]) * PANEL_SCALE];
    });
    const moved = Math.max(
      ...[0, 2, 4].map((k) => Math.hypot(offsets[k] ?? 0, offsets[k + 1] ?? 0)),
    );
    if (moved > travel) {
      travel = moved;
      peak = offsets;
    }
    for (const ch of ["body", "head", "arm", "headPitch"] as const)
      deviation = Math.max(deviation, Math.abs(s.pose[ch] - hold[ch]));
    deviation = Math.max(deviation, 3 * Math.abs(s.pose.gaze - hold.gaze));
  }
  rig.resume();
  return {
    resolved,
    rejected,
    events,
    activeSeen: samples.some((s) => s.active === name),
    deviation,
    travel,
    peak,
    samples,
  };
}

async function pixelsOf(href: string, size?: { width: number; height: number }) {
  const image = new Image();
  image.src = href;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size?.width ?? image.naturalWidth;
  canvas.height = size?.height ?? image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d context");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    width: canvas.width,
    height: canvas.height,
  };
}

describe("<squire-rig> v5 contract", () => {
  // 308 (one live rig plus stills): SVG artwork and populated FX layers.
  it("loads one live rig plus stills with SVG artwork and populated FX layers", async () => {
    const stills: Rig[] = [];
    for (const appearance of ["male", "female", "male"])
      stills.push(await mountRig({ appearance, motion: "still", hood: "up" }));
    const live = await mountRig({ equipment: "lance" });
    clock.advance(400);
    for (const rig of [...stills, live]) {
      expect(q(rig, "svg").getAttribute("viewBox")).toBe(`0 0 ${RIG_ART.stage.join(" ")}`);
      const images = qa<SVGImageElement>(rig, "image[data-art]").filter(
        (n) => displayed(n) && n.getAttribute("href"),
      );
      expect(images.length, "torso, head and grip images visible").toBeGreaterThanOrEqual(3);
      const layers = qa<SVGElement>(rig, "[data-fx]").map((n) => n.dataset.fx);
      for (const layer of ["aura", "head", "torso", "item", "front"])
        expect(layers).toContain(layer);
      expect(fxCount(rig)).toBeGreaterThan(0);
    }
    expect([...stills, live].filter((r) => !r.debugState.paused)).toEqual([live]);
  });

  // 327
  it("configuration: defaults, every listed value, normalization, invalid fallback, defensive copy, label", async () => {
    const r = await mountRig();
    expect(r.getConfiguration()).toEqual(DEFAULTS);
    const copy = r.configuration;
    copy.hood = "up";
    copy.state = "thinking";
    expect({ hood: r.configuration.hood, state: r.configuration.state }).toEqual({
      hood: "down",
      state: "idle",
    });
    for (const [k, values] of Object.entries(CHOICES)) {
      for (const v of values) {
        r.setAttribute(k, `  ${v.toUpperCase()} `);
        expect(r.configuration[k as keyof typeof CHOICES], `${k}=${v}`).toBe(v);
      }
    }
    const custom = {
      appearance: "male",
      hood: "up",
      equipment: "grimoire",
      palette: "sage",
      motion: "lively",
      gaze: "pointer",
      state: "thinking",
      transitions: "off",
      crest: "on",
      placement: "overlay",
    };
    for (const [k, v] of Object.entries({ ...custom, debug: "true", label: "  Custom squire  " }))
      r.setAttribute(k, v);
    const normalized = { ...custom, debug: true, label: "Custom squire" };
    expect(r.configuration).toEqual(normalized);
    expect(r.getConfiguration()).toEqual(normalized);
    expect(q(r, "svg").getAttribute("aria-label")).toBe("Custom squire");
    for (const k of [...Object.keys(CHOICES), "debug"]) r.setAttribute(k, "invalid");
    expect(r.configuration).toEqual({ ...DEFAULTS, label: "Custom squire" });
    const observed = (r.constructor as typeof SquireRigElement).observedAttributes;
    for (const k of [...Object.keys(CHOICES), "debug", "label"]) expect(observed).toContain(k);
    for (const k of r.getAttributeNames()) if (!["style", "seed"].includes(k)) r.removeAttribute(k);
    expect(r.configuration).toEqual(DEFAULTS);
  });

  // 351
  it("debugState exposes the contract fields", async () => {
    const r = await mountRig();
    r.setPose({ time: 1 });
    const ds = r.debugState;
    for (const [k, type] of Object.entries({
      paused: "boolean",
      frameCount: "number",
      pendingRAF: "number",
      time: "number",
      gaze: "number",
      state: "string",
      fps: "number",
    })) {
      expect(typeof ds[k as keyof RigDebugState], k).toBe(type);
    }
    for (const k of ["reason", "activeGesture", "transition"]) expect(k in ds).toBe(true);
    expect(STATES).toContain(ds.state);
  });

  // 363 + 382: structural distinctness (serialized rendered DOM, hrefs and cloth palette
  // included), not pixel hashes; the decoded layers are checked for colour by canvas readback.
  it(
    "renders every combination with the right decoded layers, all structurally distinct",
    { timeout: 120_000 },
    async () => {
      const r = await mountRig({ transitions: "off" });
      const decodedCache = new Map<
        string,
        { width: number; height: number; opaque: number; chromatic: number }
      >();
      const decode = async (href: string) => {
        const hit = decodedCache.get(href);
        if (hit) return hit;
        const image = new Image();
        image.src = href;
        await image.decode();
        const { data } = await pixelsOf(href, { width: 64, height: 64 });
        let opaque = 0;
        let chromatic = 0;
        for (let i = 0; i < data.length; i += 4) {
          if ((data[i + 3] ?? 0) <= 32) continue;
          opaque++;
          const rgb = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
          if (Math.max(...rgb) - Math.min(...rgb) > 15) chromatic++;
        }
        const entry = { width: image.naturalWidth, height: image.naturalHeight, opaque, chromatic };
        decodedCache.set(href, entry);
        return entry;
      };
      const frames = new Set<string>();
      let count = 0;
      for (const appearance of CHOICES.appearance)
        for (const hood of CHOICES.hood)
          for (const equipment of CHOICES.equipment)
            for (const palette of COMPANION_PALETTES) {
              await config(r, { appearance, hood, equipment, palette });
              const layers = qa<SVGImageElement>(r, "image[data-art]").filter(
                (n) => displayed(n) && n.getAttribute("href"),
              );
              const role = (n: string) => layers.filter((l) => l.dataset.art === n);
              const label = `${appearance}/${hood}/${equipment}/${palette}`;
              expect(
                role("head").map((l) => l.dataset.src),
                label,
              ).toEqual([RIG_ART.heads[appearance].src]);
              expect(role("head")[0]?.getAttribute("href"), "head is never tinted").toBe(
                RIG_ART.heads[appearance].src,
              );
              expect(role("grip").map((l) => l.dataset.src)).toEqual([
                RIG_ART.grips[equipment].src,
              ]);
              expect(role("torso").map((l) => l.dataset.src)).toEqual([RIG_ART.torso.src]);
              expect(role("hood").length === 1, "hood visible iff hood=up").toBe(hood === "up");
              for (const l of [...role("grip"), ...role("torso"), ...role("hood")]) {
                expect(l.getAttribute("href")).toBe(tintedHref(l.dataset.src ?? "", palette));
              }
              for (
                let n: Element | null = q(r, "[data-art=head]");
                n && n.tagName !== "svg";
                n = n.parentElement
              ) {
                expect(getComputedStyle(n).filter, "head and ancestors unfiltered").toBe("none");
              }
              for (const l of layers) {
                const d = await decode(l.getAttribute("href") ?? "");
                expect(d.width > 50 && d.height > 50).toBe(true);
                expect(
                  d.opaque > 100 && d.chromatic > 50,
                  `${l.dataset.art} decoded without colour`,
                ).toBe(true);
                const box = l.getBoundingClientRect();
                expect(box.width > 0 && box.height > 0).toBe(true);
              }
              for (const n of ["head", "grip", "torso", "hood"])
                for (const l of role(n))
                  expect(opacity(l), `${n} opaque at rest`).toBeGreaterThan(0.99);
              frames.add(serial(r));
              count++;
            }
      expect(count).toBe(2 * 2 * 6 * COMPANION_PALETTES.length);
      expect(frames.size).toBe(count);
    },
  );

  // 384: texture-level pixel readback (the rig's cloth is pre-tinted, so the texture is what
  // reaches the screen), plus the pre-tint reproducing v5's SVG filter in the browser.
  it(
    "palettes visibly change cloth while warm skin and gold stay put, and the head is untouched",
    { timeout: 60_000 },
    async () => {
      const parts = [RIG_ART.torso.src, RIG_ART.grips.helmet.src, RIG_ART.hood.src];
      for (const src of parts) {
        const base = await pixelsOf(src);
        for (const palette of COMPANION_PALETTES.slice(1)) {
          const current = await pixelsOf(await requestTint(src, palette));
          let changed = 0;
          let warm = 0;
          let warmDifference = 0;
          const drift = [0, 0, 0];
          let clothR = 0;
          let clothG = 0;
          let clothB = 0;
          let cloth = 0;
          for (let i = 0; i < base.data.length; i += 4) {
            const at = (k: number) => base.data[i + k] ?? 0;
            const now = (k: number) => current.data[i + k] ?? 0;
            if ([0, 1, 2].some((c) => Math.abs(at(c) - now(c)) > 3)) changed++;
            const [r, g, b] = [at(0), at(1), at(2)];
            if (at(3) > 250 && b > r + 20) {
              cloth++;
              clothR += now(0);
              clothG += now(1);
              clothB += now(2);
            }
            if (!(at(3) > 250 && r > 100 && r > g * 1.15 && g > b * 1.1)) continue;
            warm++;
            for (let c = 0; c < 3; c++) {
              const delta = now(c) - at(c);
              drift[c] = (drift[c] ?? 0) + delta;
              warmDifference += Math.abs(delta) / 3;
            }
          }
          const label = `${src.split("/").pop()}/${palette}`;
          expect(changed, `${label}: no visible palette effect`).toBeGreaterThan(200);
          if (src !== RIG_ART.hood.src) {
            expect(warm, `${label}: too few warm samples`).toBeGreaterThan(500);
            for (const v of drift)
              expect(Math.abs(v / warm), `${label}: warm artwork drifted`).toBeLessThan(3);
            expect(warmDifference / warm).toBeLessThan(4);
          }
          // Gold must read as warm cloth, clearly apart from brass's untinted navy, and as gold
          // rather than olive: red leads green by a clear margin (OQ22).
          if (palette === "gold") {
            expect((clothR - clothB) / cloth, `${label}: gold cloth is warm`).toBeGreaterThan(40);
            expect((clothR - clothG) / cloth, `${label}: gold cloth is not olive`).toBeGreaterThan(
              40,
            );
          }
        }
      }
      for (const palette of COMPANION_PALETTES) {
        for (const appearance of CHOICES.appearance) {
          const r = await mountRig({ palette, appearance });
          expect(q(r, "[data-art=head]").getAttribute("href")).toBe(RIG_ART.heads[appearance].src);
          expect(getComputedStyle(q(r, "[data-art=head]")).filter).toBe("none");
          r.remove();
        }
      }
    },
  );

  it(
    "pre-tinted cloth matches v5's SVG cloth filter rendered by the browser",
    { timeout: 30_000 },
    async () => {
      const src = RIG_ART.torso.src;
      const blob = await (await fetch(src)).blob();
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result)));
        reader.readAsDataURL(blob);
      });
      const { width, height } = await pixelsOf(src);
      for (const palette of ["moonstone", "gold"] as const) {
        const [r, g, b, s] = CLOTH_TINTS[palette];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>
<filter id="f" color-interpolation-filters="sRGB" x="-5%" y="-5%" width="110%" height="110%">
<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -8 0 8 0 0" result="navy"/>
<feComposite in="navy" in2="SourceAlpha" operator="in" result="navyMask"/>
<feFlood flood-color="rgb(${r},${g},${b})" flood-opacity="${s}" result="tint"/>
<feComposite in="tint" in2="navyMask" operator="in" result="clothTint"/>
<feBlend in="SourceGraphic" in2="clothTint" mode="screen"/></filter></defs>
<image href="${dataUrl}" width="${width}" height="${height}" filter="url(#f)"/></svg>`;
        const filtered = await pixelsOf(
          URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })),
          { width, height },
        );
        const ours = await pixelsOf(await requestTint(src, palette));
        let total = 0;
        let n = 0;
        let worst = 0;
        for (let i = 0; i < ours.data.length; i += 4) {
          // The parts' near-lossless alpha is ~252; the filter's 8-bit premultiplied passes round
          // those pixels by a few levels.
          if ((filtered.data[i + 3] ?? 0) < 250) continue;
          n++;
          for (let c = 0; c < 3; c++) {
            const d = Math.abs((filtered.data[i + c] ?? 0) - (ours.data[i + c] ?? 0));
            total += d;
            worst = Math.max(worst, d);
          }
        }
        expect(n).toBeGreaterThan(10_000);
        expect(total / (3 * n), `${palette}: mean channel error`).toBeLessThan(1);
        expect(worst, `${palette}: worst channel error`).toBeLessThanOrEqual(6);
      }
      // The tint math itself on a known navy pixel (alpha 1): screen with the flood.
      const px = new Uint8ClampedArray([20, 35, 60, 255]);
      applyClothTint(px, CLOTH_TINTS.gold);
      expect([...px]).toEqual([208, 145, 60, 255]);
    },
  );

  // 422
  it("anatomy hierarchy, FX layer placement and fixed torso across gear", async () => {
    const r = await mountRig({ transitions: "off" });
    await config(r, { appearance: "female", hood: "up", equipment: "helmet", palette: "brass" });
    const svg = q<SVGSVGElement>(r, "svg");
    const body = q(r, "[data-bone=body]");
    const headBone = q(r, "[data-bone=head]");
    const arm = q(r, "[data-bone=arm]");
    const head = q(r, "[data-art=head]");
    const hood = q(r, "[data-art=hood]");
    const torso = q<SVGImageElement>(r, "[data-art=torso]");
    const grip = q(r, "[data-art=grip]");
    const fx = Object.fromEntries(
      ["aura", "head", "torso", "item", "front"].map((n) => [n, q(r, `[data-fx=${n}]`)]),
    );
    const before = (a: Node | undefined, b: Node | undefined) =>
      !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const firstDrawn = [...svg.children].find(
      (n) => !["defs", "style", "title", "desc"].includes(n.tagName.toLowerCase()),
    );
    const torsoState = () => {
      const m = stage(torso);
      return JSON.stringify({
        attributes: [...torso.attributes].map((a) => [a.name, a.value]),
        m: [m.a, m.b, m.c, m.d, m.e, m.f],
      });
    };
    const ref = torsoState();
    for (const gear of [
      "helmet",
      "lance",
      "astrolabe",
      "grimoire",
      "armillary",
      "none",
      "helmet",
    ]) {
      r.setAttribute("equipment", gear);
      r.setPose({ time: 2.375, gaze: 0 });
      expect(
        torso === q(r, "[data-art=torso]") && ref === torsoState(),
        `torso changed with ${gear}`,
      ).toBe(true);
    }
    expect(head.closest("[data-bone]")).toBe(headBone);
    expect(hood.closest("[data-bone]")).toBe(headBone);
    expect(headBone.parentNode).toBe(body);
    expect(arm.parentNode).toBe(body);
    expect(torso.closest("[data-bone]")).toBe(body);
    expect(grip.closest("[data-bone]")).toBe(arm);
    expect(
      before(headBone, torso) && before(torso, arm),
      "paint order head bone, torso, arm bone",
    ).toBe(true);
    expect(firstDrawn).toBe(fx.aura);
    expect(before(body, fx.front) && !body.contains(fx.front ?? null)).toBe(true);
    expect(
      headBone.contains(fx.head ?? null) && before(head, fx.head) && before(hood, fx.head),
    ).toBe(true);
    expect(
      body.contains(fx.torso ?? null) &&
        !arm.contains(fx.torso ?? null) &&
        before(torso, fx.torso) &&
        before(fx.torso, arm),
    ).toBe(true);
    expect(arm.contains(fx.item ?? null) && before(grip, fx.item)).toBe(true);
    expect(qa(r, "[data-art=torsoFront]")).toHaveLength(0);
  });

  // 458
  it("hood toggles keep the same head node and artwork", async () => {
    const r = await mountRig();
    for (const transitions of ["off", "on"])
      for (const appearance of CHOICES.appearance) {
        r.setAttribute("transitions", transitions);
        await config(r, { appearance, hood: "down" });
        const head = q<SVGImageElement>(r, "[data-art=head]");
        const href = head.getAttribute("href");
        const parent = head.parentNode;
        for (const hood of ["up", "down", "up", "down"]) {
          r.setAttribute("hood", hood);
          r.setPose({ time: 3 });
          expect(
            head === q(r, "[data-art=head]") &&
              href === head.getAttribute("href") &&
              parent === head.parentNode,
            `${appearance}/${transitions}`,
          ).toBe(true);
          expect(opacity(head)).toBeGreaterThan(0.99);
        }
      }
  });

  // 473
  it("every grip moves rigidly with the forearm bone across arbitrary scrubs", async () => {
    const r = await mountRig({ transitions: "off" });
    for (const equipment of CHOICES.equipment) {
      await config(r, { equipment, hood: "down", appearance: "female" });
      const g = RIG_ART.grips[equipment];
      const [px, py] = RIG_ART.pivots.arm;
      const grip = q<SVGImageElement>(r, "[data-art=grip]");
      const arm = q<SVGGElement>(r, "[data-bone=arm]");
      const rad = ((g.rotation ?? 0) * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const registration = new DOMMatrix([c, s, -s, c, px - c * px + s * py, py - s * px - c * py]);
      const href = grip.getAttribute("href");
      const rect = () =>
        JSON.stringify(["x", "y", "width", "height"].map((k) => grip.getAttribute(k)));
      const rect0 = rect();
      let maxError = 0;
      let maxDeform = 0;
      for (let i = 0; i < 83; i++) {
        r.setPose({
          time: (i * 79.137) % 123.57,
          gaze: Math.sin(i * 7.133),
          state: STATES[i % 3] ?? "idle",
        });
        expect(
          grip === q(r, "[data-art=grip]") &&
            grip.getAttribute("href") === href &&
            rect() === rect0 &&
            grip.closest("[data-bone]") === arm,
          `${equipment}: grip node/href/rect/bone changed`,
        ).toBe(true);
        const m = stage(grip);
        const a = stage(arm);
        const expected = DOMMatrix.fromMatrix(a).multiply(registration);
        for (const k of ["a", "b", "c", "d", "e", "f"] as const)
          maxError = Math.max(maxError, Math.abs(m[k] - expected[k]));
        maxDeform = Math.max(
          maxDeform,
          Math.abs(Math.hypot(a.a, a.b) - 1),
          Math.abs(Math.hypot(a.c, a.d) - 1),
          Math.abs(a.a * a.c + a.b * a.d),
        );
      }
      expect(maxError, `${equipment}: grip not rigid with arm bone`).toBeLessThan(1e-3);
      expect(maxDeform, `${equipment}: forearm bone deforms (breath only)`).toBeLessThan(0.015);
    }
  });

  // 501 (neck and elbow registration = seams)
  it("neck and elbow joints stay registered to the torso across scrubs", async () => {
    const r = await mountRig();
    for (const [appearance, hood, equipment] of [
      ["female", "down", "helmet"],
      ["female", "up", "lance"],
      ["male", "down", "astrolabe"],
      ["male", "up", "none"],
    ] as const) {
      await config(r, { appearance, hood, equipment, motion: "lively" });
      const L = limits(r);
      const torso = q<SVGImageElement>(r, "[data-art=torso]");
      const arm = q<SVGGElement>(r, "[data-bone=arm]");
      const headBone = q<SVGGElement>(r, "[data-bone=head]");
      const ax = Math.max(...L.armX.map(Math.abs));
      const ay = Math.max(...L.armY.map(Math.abs));
      const elbowBound = Math.hypot(ax, ay) + 0.5;
      let elbow = 0;
      let neck = 0;
      for (let i = 0; i < 120; i++) {
        r.setPose({ time: i * 0.53, gaze: Math.sin(i * 1.7), state: STATES[i % 3] ?? "idle" });
        const t = stage(torso);
        const e1 = apply(stage(arm), RIG_ART.pivots.arm);
        const e0 = apply(t, RIG_ART.pivots.arm);
        const n1 = apply(stage(headBone), RIG_ART.pivots.head);
        const n0 = apply(t, RIG_ART.pivots.head);
        elbow = Math.max(elbow, Math.hypot(e1[0] - e0[0], e1[1] - e0[1]));
        neck = Math.max(neck, Math.hypot(n1[0] - n0[0], n1[1] - n0[1]));
      }
      r.setAttribute("motion", "subtle");
      expect(elbow, `${appearance}/${hood}/${equipment}: elbow drift`).toBeLessThanOrEqual(
        elbowBound,
      );
      expect(neck, `${appearance}/${hood}/${equipment}: neck drift`).toBeLessThanOrEqual(12);
    }
  });

  // _testChannels seam sweep: every grip held at its forearm limits keeps the elbow registered.
  it("keeps the elbow registered on all six grips with channels forced to their seam limits", async () => {
    const r = await mountRig({ transitions: "off" });
    for (const equipment of CHOICES.equipment) {
      await config(r, { equipment });
      const L = limits(r);
      const torso = q<SVGImageElement>(r, "[data-art=torso]");
      const arm = q<SVGGElement>(r, "[data-bone=arm]");
      const bound =
        Math.hypot(Math.max(...L.armX.map(Math.abs)), Math.max(...L.armY.map(Math.abs))) + 0.5;
      for (const armDeg of L.arm)
        for (const armX of L.armX)
          for (const armY of L.armY)
            for (const breath of [0, 1.85]) {
              r._testChannels = {
                arm: armDeg,
                armX,
                armY,
                breath,
                body: L.body[1],
                head: L.head[0],
              };
              r.setPose({ time: 7 });
              expect(r.debugState.pose?.arm).toBeCloseTo(armDeg, 6);
              const e1 = apply(stage(arm), RIG_ART.pivots.arm);
              const e0 = apply(stage(torso), RIG_ART.pivots.arm);
              expect(Math.hypot(e1[0] - e0[0], e1[1] - e0[1]), equipment).toBeLessThanOrEqual(
                bound,
              );
            }
      r._testChannels = null;
    }
  });

  // 526
  it("setPose: clamping, TypeErrors leave state untouched, fixed gaze values, state override", async () => {
    const r = await mountRig();
    r.setAttribute("gaze", "auto");
    r.setAttribute("state", "idle");
    r.setPose({ time: -9, gaze: 8 });
    expect([r.debugState.time, r.debugState.gaze, r.debugState.reason]).toEqual([0, 1, "scrub"]);
    r.setPose({ time: 5, gaze: 0.25 });
    const invalid: unknown[] = [
      { time: NaN },
      { time: Infinity },
      { time: "2" },
      { gaze: NaN },
      { gaze: -Infinity },
      { time: 1, state: "sleeping" },
    ];
    for (const pose of invalid) {
      const before = JSON.stringify(r.debugState) + serial(r);
      expect(() => r.setPose(pose as SetPoseInput)).toThrow(TypeError);
      expect(JSON.stringify(r.debugState) + serial(r)).toBe(before);
    }
    const gaze: Record<string, number> = {};
    for (const value of ["left", "center", "right"]) {
      r.setAttribute("gaze", value);
      r.setPose({ time: 0 });
      gaze[value] = r.debugState.gaze;
    }
    expect(gaze).toEqual({ left: -1, center: 0, right: 1 });
    r.setAttribute("gaze", "auto");
    r.setPose({ time: 4 });
    expect(Math.abs(r.debugState.gaze)).toBeLessThanOrEqual(1);
    const svgs = new Set<string>();
    for (const state of STATES) {
      r.setPose({ time: 6, state });
      expect(r.debugState.state).toBe(state);
      expect(r.debugState.stateMix[state]).toBeGreaterThan(0.99);
      svgs.add(serial(r));
    }
    expect(svgs.size, "held states render distinct poses").toBe(3);
    r.setPose({ time: 6 });
    expect(r.debugState.state).toBe("idle");
    pauseStable(r, "scrub");
  });

  // 549
  it("setPose determinism: identical SVG (bones + FX) after unrelated poses, states and gaze", async () => {
    const r = await mountRig({ transitions: "on" });
    await config(r, {
      appearance: "female",
      hood: "up",
      equipment: "lance",
      palette: "sage",
      motion: "subtle",
    });
    const cases: SetPoseInput[] = [
      { time: 0, gaze: -1 },
      { time: 1.234, gaze: 0.78 },
      { time: 4.4, state: "attentive" },
      { time: 13.37, state: "thinking" },
      { time: 27.9 },
      { time: 99, gaze: -0.43 },
    ];
    const fx = new Set<string>();
    for (const pose of cases) {
      r.setPose(pose);
      const a = serial(r);
      fx.add(fxMarkup(r));
      r.setPose({ time: 47, gaze: 1, state: "thinking" });
      r.setAttribute("gaze", "right");
      r.setAttribute("gaze", "auto");
      r.setPose(pose);
      expect(serial(r) === a, `setPose(${JSON.stringify(pose)}) not reproducible`).toBe(true);
    }
    expect(fx.size, "ambient FX vary with time").toBeGreaterThanOrEqual(3);
  });

  // 563 (DOM-level: identical serialized frames instead of screenshots)
  it("setPose determinism: identical frames incl. FX after live motion, gestures and transitions", async () => {
    const r = await mountRig();
    await config(r, {
      appearance: "male",
      hood: "up",
      equipment: "astrolabe",
      palette: "rose",
      motion: "lively",
      transitions: "on",
    });
    await Promise.all(
      [RIG_ART.torso.src, RIG_ART.hood.src, RIG_ART.grips.armillary.src].map((src) =>
        requestTint(src, "sage"),
      ),
    );
    await requestTint(RIG_ART.grips.armillary.src, "rose");
    for (const pose of [
      { time: 0.9, gaze: 0 },
      { time: 6.25, state: "thinking" },
      { time: 18.5, gaze: 0.4, state: "attentive" },
    ] as const) {
      r.resume();
      clock.advance(600);
      r.setPose(pose);
      const first = serial(r);
      r.resume();
      clock.advance(300);
      void r.play("flourish");
      r.setAttribute("equipment", "armillary");
      r.setAttribute("hood", "down");
      r.setAttribute("palette", "sage");
      clock.advance(250);
      r.setAttribute("equipment", "astrolabe");
      r.setAttribute("hood", "up");
      r.setAttribute("palette", "rose");
      r.setPose(pose);
      await clothSettled(r);
      r.setPose(pose);
      const second = serial(r);
      expect(
        second === first,
        `setPose(${JSON.stringify(pose)}) differs after live activity: ${diff(first, second)}`,
      ).toBe(true);
    }
  });

  // 584
  it("setPose determinism across instances (same inputs, separate rigs)", async () => {
    const a = await mountRig({ hood: "up", equipment: "grimoire", palette: "moonstone" });
    const attrs = Object.fromEntries(
      a
        .getAttributeNames()
        .filter((n) => n !== "style")
        .map((n) => [n, a.getAttribute(n) ?? ""]),
    );
    const b = await mountRig(attrs);
    a.resume();
    clock.advance(900);
    const strip = (s: string) => s.replace(/squire(-[a-z-]+)?-\d+/g, "squire$1-#");
    for (const pose of [
      { time: 0.9, gaze: 0 },
      { time: 1.6, gaze: 0 },
      { time: 9.3, state: "thinking" },
      { time: 21.05, gaze: -0.6 },
    ] as const) {
      a.setPose(pose);
      b.setPose(pose);
      expect(
        strip(serial(a)) === strip(serial(b)),
        `two rigs differ at setPose(${JSON.stringify(pose)})`,
      ).toBe(true);
    }
  });

  // 608
  it("setPose works in still mode and still renders distinct held state poses with FX at rest", async () => {
    const r = await mountRig();
    await config(r, {
      appearance: "female",
      hood: "down",
      equipment: "astrolabe",
      palette: "brass",
      motion: "still",
    });
    r.resume();
    const rest: Record<string, { pose: RigDebugState["pose"]; svg: string }> = {};
    for (const s of STATES) {
      r.setAttribute("state", s);
      expect(r.debugState.reason).toBe("still");
      rest[s] = { pose: r.debugState.pose, svg: serial(r) };
    }
    r.setAttribute("state", "idle");
    expect(new Set(Object.values(rest).map((v) => v.svg)).size).toBe(3);
    const pitch = (s: string) => rest[s]?.pose?.headPitch ?? NaN;
    expect(
      pitch("thinking") > pitch("idle") && pitch("idle") > pitch("attentive"),
      "held head pitch order",
    ).toBe(true);
    expect(
      Math.abs((rest.attentive?.pose?.body ?? 0) - (rest.idle?.pose?.body ?? 0)),
    ).toBeGreaterThan(0.1);
    r.setPose({ time: 2 });
    const a = serial(r);
    r.setPose({ time: 9.7 });
    expect(serial(r)).not.toBe(a);
    r.resume();
    expect(r.debugState.reason).toBe("still");
    pauseStable(r, "still");
  });

  // 629
  it("resume preserves scrub time and starts exactly one animation chain", async () => {
    const r = await mountRig({ transitions: "off" });
    r.setPose({ time: 3.2, gaze: 0.2 });
    r.resume();
    r.resume();
    r.resume();
    clock.advance(200);
    const after = r.debugState;
    expect(after.time > 3.2 && after.time - 3.2 < 0.5).toBe(true);
    expect(after.reason).toBe(null);
    expect(after.pendingRAF).toBe(1);
    expect(clock.pendingFrames).toBe(1);
  });

  // 638 replaced: the 30 fps gate, keeping "visibly alive channels, no abrupt steps".
  it("live motion: 30 fps gate, visibly alive channels, no abrupt steps", async () => {
    const r = await mountRig({ transitions: "off" });
    await config(
      r,
      {
        appearance: "female",
        hood: "down",
        equipment: "helmet",
        palette: "brass",
        motion: "subtle",
        state: "idle",
        gaze: "auto",
      },
      0,
    );
    r.resume();
    const points = (rig: Rig) =>
      qa<SVGGElement>(rig, "[data-bone]").flatMap((n) => {
        const m = stage(n);
        return [[0, 0], RIG_ART.stage].map((p) => apply(m, [p[0] ?? 0, p[1] ?? 0]));
      });
    const samples = record(r, 6000, [], points);
    const first = samples[0];
    const last = samples.at(-1);
    if (!first || !last) throw new Error("no frames");
    const elapsed = (last.elapsed - first.elapsed) / 1000;
    const frames = last.frameCount - first.frameCount;
    const range = (f: (s: Sample) => number) => {
      const v = samples.map(f);
      return Math.max(...v) - Math.min(...v);
    };
    let maxStep = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]?.extra as (readonly [number, number])[];
      const b = samples[i]?.extra as (readonly [number, number])[];
      b.forEach((p, j) => {
        const o = a[j] ?? p;
        maxStep = Math.max(maxStep, Math.hypot(p[0] - o[0], p[1] - o[1]));
      });
    }
    expect(frames / elapsed, "rendered fps").toBeLessThanOrEqual(30.5);
    expect(frames / elapsed, "rendered fps").toBeGreaterThanOrEqual(28);
    expect(Math.abs(last.fps - 30), "debugState.fps").toBeLessThan(1);
    const advanced = last.time - first.time;
    expect(
      advanced > elapsed * 0.9 && advanced < elapsed * 1.1,
      "rig time advances in real time",
    ).toBe(true);
    expect(
      range((s) => s.breath),
      "breathing visible",
    ).toBeGreaterThan(0.3);
    expect(range((s) => s.pose?.body ?? 0)).toBeGreaterThan(0.1);
    expect(range((s) => s.pose?.head ?? 0)).toBeGreaterThan(0.1);
    expect(range((s) => s.pose?.arm ?? 0)).toBeGreaterThan(0.05);
    expect(maxStep, "per-frame displacement (stage units)").toBeLessThan(4 * FRAME_SCALE);
    expect(maxFrameDelta(samples).delta, "per-frame angle step").toBeLessThan(0.5 * FRAME_SCALE);
  });

  // 659
  it("state changes blend smoothly through springs (no pops)", async () => {
    const r = await mountRig({ transitions: "off" });
    r.setPose({ time: 20 });
    r.resume();
    clock.advance(300);
    const samples = record(r, 2200, [
      { at: 200, fn: (rig) => rig.setAttribute("state", "thinking") },
      { at: 1500, fn: (rig) => rig.setAttribute("state", "attentive") },
    ]);
    const settled = samples.find((s) => s.elapsed >= 1450);
    const blending = samples.filter(
      (s) =>
        s.elapsed > 200 &&
        s.elapsed < 1500 &&
        s.stateMix.thinking > 0.02 &&
        s.stateMix.thinking < 0.95,
    );
    expect(settled?.state).toBe("thinking");
    expect(blending.length, "intermediate frames").toBeGreaterThanOrEqual(5);
    expect((blending.at(-1)?.elapsed ?? 0) - (blending[0]?.elapsed ?? 0)).toBeGreaterThanOrEqual(
      150,
    );
    expect(settled?.stateMix.thinking ?? 0).toBeGreaterThan(0.95);
    expect(maxFrameDelta(samples).delta, "pop during state change").toBeLessThan(0.5 * FRAME_SCALE);
  });

  // 673 (no pops mid-gesture)
  it("no pops when state, gaze, motion and attributes change mid-gesture", async () => {
    const r = await mountRig({ motion: "lively", transitions: "on" });
    clock.advance(700);
    const samples = record(r, 3000, [
      { at: 50, fn: (rig) => void rig.play("greet") },
      { at: 350, fn: (rig) => rig.setAttribute("state", "attentive") },
      { at: 550, fn: (rig) => rig.setAttribute("gaze", "right") },
      { at: 750, fn: (rig) => rig.setAttribute("motion", "subtle") },
      { at: 900, fn: (rig) => rig.setAttribute("equipment", "lance") },
      { at: 1100, fn: (rig) => void rig.play("flourish") },
      { at: 1300, fn: (rig) => rig.setAttribute("state", "thinking") },
      { at: 1500, fn: (rig) => rig.setAttribute("gaze", "left") },
      { at: 1700, fn: (rig) => rig.setAttribute("hood", "up") },
      { at: 1900, fn: (rig) => rig.setAttribute("appearance", "male") },
    ]);
    const delta = maxFrameDelta(samples);
    expect(delta.delta, `pop: ${JSON.stringify(delta)}`).toBeLessThan(0.75 * FRAME_SCALE);
  });

  // 713 (every gesture resolves and visibly moves: deviation above 3x baseline noise + 0.3),
  // across idle seeds and both motion levels: a gesture must read whatever the idle is doing.
  it(
    "play(): each gesture resolves, emits squire-gesture-end, reports activeGesture and visibly moves",
    { timeout: 240_000 },
    async () => {
      const failures: string[] = [];
      let margin = Infinity;
      let tightest = "";
      for (let seed = 1; seed <= 12; seed++) {
        const r = await mountRig({ seed: String(seed) });
        for (const motion of ["subtle", "lively"]) {
          await config(r, {
            appearance: "female",
            hood: "down",
            equipment: "astrolabe",
            palette: "brass",
            motion,
            state: "idle",
            gaze: "auto",
          });
          const noise = await gestureRun(r, null);
          for (const name of [...GESTURES, ...EXTRA_GESTURES]) {
            const run = await gestureRun(r, name);
            const label = `seed ${seed}/${motion}/${name}`;
            expect(run.rejected, label).toBe(null);
            expect(run.resolved, `${label} did not resolve within 4 s`).not.toBe(null);
            const ms = run.resolved?.at ?? 0;
            expect(ms > 400 && ms < 3000, `${label} resolved after ${ms} ms`).toBe(true);
            expect(
              run.events.some((e) => e.name === name),
              label,
            ).toBe(true);
            expect(run.activeSeen, label).toBe(true);
            const left = run.deviation - (3 * noise.deviation + 0.3);
            if (left < margin) {
              margin = left;
              tightest = `${label} (deviation ${run.deviation.toFixed(2)}, noise ${noise.deviation.toFixed(2)})`;
            }
            const floor = GESTURE_FLOORS[name][motion === "lively" ? "lively" : "subtle"];
            if (run.deviation < floor.deviation || run.travel < floor.px)
              failures.push(
                `${label}: deviation ${run.deviation.toFixed(2)} / ${run.travel.toFixed(1)} px under the floor`,
              );
            const dip = run.peak[3] ?? 0;
            if (name === "nod" && dip < NOD_DIP_PX)
              failures.push(`${label}: head dips ${dip.toFixed(1)} px at the peak`);
            const lift = -(run.peak[5] ?? 0);
            if (name === "greet" && lift < GREET_LIFT_PX)
              failures.push(`${label}: item lifts ${lift.toFixed(1)} px at the peak`);
            if (left <= 0)
              failures.push(
                `${label}: deviation ${run.deviation.toFixed(2)} vs noise ${noise.deviation.toFixed(2)}`,
              );
          }
        }
        r.remove();
      }
      expect(failures, `tightest: ${tightest}`).toEqual([]);
    },
  );

  // Each held state reads apart from idle in one still: head and item points move by at least
  // this many pixels at the 340 px panel (minimum over grips and times: attentive 10.6;
  // thinking 19.5, up from v5's 14.7).
  it("held states read apart from idle in one still at panel size", async () => {
    const r = await mountRig({ transitions: "off" });
    const shift: Record<string, number> = {};
    for (const equipment of CHOICES.equipment) {
      await config(r, { equipment, motion: "still" });
      for (const time of [3, 11.5, 27]) {
        r.setPose({ time, state: "idle" });
        const idle = readPoints(r);
        for (const state of ["attentive", "thinking"] as const) {
          r.setPose({ time, state });
          const moved = Math.max(
            ...readPoints(r).map((p, i) =>
              Math.hypot(p[0] - (idle[i]?.[0] ?? 0), p[1] - (idle[i]?.[1] ?? 0)),
            ),
          );
          shift[state] = Math.min(shift[state] ?? Infinity, moved * PANEL_SCALE);
        }
      }
    }
    expect(shift.attentive ?? 0).toBeGreaterThan(STATE_FLOOR_PX.attentive);
    expect(shift.thinking ?? 0).toBeGreaterThan(STATE_FLOOR_PX.thinking);
    expect(r.debugState.lid, "thinking half-lid").toBeGreaterThanOrEqual(0.5);
  });

  // Seam sweep: lively gestures in every state, on every grip, appearance, and hood, stay
  // inside the seam limits with the neck and elbow registered to the torso on every frame.
  it(
    "seam sweep: lively gestures on all grips, appearances, and hoods stay inside the seam limits",
    { timeout: 300_000 },
    async () => {
      // validate.cjs:501 bounds neck drift at 12 units on scrubs; under lively gestures v5 itself
      // reaches 12.01 (thinking + nod), and the stronger nod 12.2. Head angle, headX, and headY
      // all stay inside RIG_ART.limits, which are what the collar hides.
      const NECK_BOUND = 12.5;
      const r = await mountRig({ transitions: "off", seed: "3" });
      const violations: string[] = [];
      let worstElbow = 0;
      let worstNeck = 0;
      for (const appearance of CHOICES.appearance)
        for (const hood of CHOICES.hood)
          for (const equipment of CHOICES.equipment) {
            await config(r, { appearance, hood, equipment, motion: "lively" });
            const L = limits(r);
            const elbowBound =
              Math.hypot(Math.max(...L.armX.map(Math.abs)), Math.max(...L.armY.map(Math.abs))) +
              0.5;
            const torso = q<SVGImageElement>(r, "[data-art=torso]");
            const arm = q<SVGGElement>(r, "[data-bone=arm]");
            const headBone = q<SVGGElement>(r, "[data-bone=head]");
            for (const state of STATES) {
              r.setAttribute("state", state);
              r.setPose({ time: 30 });
              r.resume();
              clock.advance(1500);
              for (const name of [...GESTURES, ...EXTRA_GESTURES]) {
                void r.play(name);
                const label = `${appearance}/${hood}/${equipment}/${state}/${name}`;
                const frames: { time: number; pose: RigDebugState["pose"] }[] = [];
                for (let k = 0; k < 60; k++) {
                  clock.advance(1000 / 30);
                  frames.push({ time: r.debugState.time, pose: r.debugState.pose });
                  const t = stage(torso);
                  const e1 = apply(stage(arm), RIG_ART.pivots.arm);
                  const e0 = apply(t, RIG_ART.pivots.arm);
                  const n1 = apply(stage(headBone), RIG_ART.pivots.head);
                  const n0 = apply(t, RIG_ART.pivots.head);
                  const elbow = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]);
                  const neck = Math.hypot(n1[0] - n0[0], n1[1] - n0[1]);
                  worstElbow = Math.max(worstElbow, elbow / elbowBound);
                  worstNeck = Math.max(worstNeck, neck);
                  if (elbow > elbowBound)
                    violations.push(
                      `${label}: elbow ${elbow.toFixed(2)} > ${elbowBound.toFixed(2)}`,
                    );
                  if (neck > NECK_BOUND) violations.push(`${label}: neck ${neck.toFixed(2)}`);
                }
                violations.push(...limitViolations(frames, L, 0.05, label));
              }
            }
          }
      expect(violations.slice(0, 8), `${violations.length} violations`).toEqual([]);
      expect(worstElbow).toBeLessThanOrEqual(1);
      expect(worstNeck).toBeLessThanOrEqual(NECK_BOUND);
    },
  );

  // Each gesture's peak is its own still: the head and item offsets at peak (panel px) differ
  // between every pair of the six gestures by at least PEAK_DISTANCE_PX.
  it(
    "the six gesture peak poses are pairwise distinct at panel size",
    { timeout: 120_000 },
    async () => {
      const tight: string[] = [];
      let closest = Infinity;
      for (const equipment of ["astrolabe", "none"] as const)
        for (let seed = 1; seed <= 12; seed++) {
          const r = await mountRig({ seed: String(seed) });
          for (const motion of ["subtle", "lively"]) {
            await config(r, { equipment, motion, state: "idle", gaze: "auto" });
            const peaks = new Map<string, number[]>();
            for (const name of [...GESTURES, ...EXTRA_GESTURES])
              peaks.set(name, (await gestureRun(r, name)).peak);
            const names = [...peaks.keys()];
            for (const [i, a] of names.entries())
              for (const b of names.slice(i + 1)) {
                const pa = peaks.get(a) ?? [];
                const pb = peaks.get(b) ?? [];
                const d = Math.hypot(...pa.map((v, k) => v - (pb[k] ?? 0)));
                if (d < closest) closest = d;
                if (d < PEAK_DISTANCE_PX)
                  tight.push(
                    `${equipment}/seed ${seed}/${motion}: ${a} vs ${b} ${d.toFixed(1)} px`,
                  );
              }
          }
          r.remove();
        }
      expect(tight, `closest pair ${closest.toFixed(1)} px`).toEqual([]);
    },
  );

  // 739 (lively gestures inside the seam limits)
  it(
    "lively scales gestures up and every pose stays inside the measured seam limits",
    { timeout: 90_000 },
    async () => {
      const r = await mountRig();
      const amp: Record<string, number> = {};
      for (const motion of ["subtle", "lively"]) {
        r.setAttribute("motion", motion);
        clock.advance(300);
        amp[motion] = (await gestureRun(r, "nod")).deviation;
      }
      expect(amp.lively ?? 0).toBeGreaterThan((amp.subtle ?? 0) * 1.15);
      const violations: string[] = [];
      for (const [equipment, state] of [
        ["helmet", "thinking"],
        ["lance", "attentive"],
        ["grimoire", "idle"],
        ["none", "thinking"],
      ] as const) {
        r.setAttribute("transitions", "off");
        r.setAttribute("equipment", equipment);
        r.setAttribute("state", state);
        r.setAttribute("motion", "lively");
        r.setAttribute("transitions", "on");
        const lim = limits(r);
        for (const [i, name] of [...GESTURES, ...EXTRA_GESTURES].entries()) {
          const run = await gestureRun(r, name, 30 + i * 7);
          violations.push(
            ...limitViolations(run.samples, lim, 0.05, `lively/${state}/${equipment}/${name}`),
          );
        }
        const scrubbed = [];
        for (let i = 0; i < 160; i++) {
          r.setPose({ time: i * 0.371, gaze: Math.sin(i), state: STATES[i % 3] ?? "idle" });
          scrubbed.push({ time: i * 0.371, pose: r.debugState.pose });
        }
        r.resume();
        violations.push(...limitViolations(scrubbed, lim, 0.02, `scrub/${equipment}`));
      }
      expect(violations.slice(0, 8)).toEqual([]);
    },
  );

  // 757
  it("play(): interruption resolves the earlier gesture; unknown names do not throw synchronously", async () => {
    const r = await mountRig({ transitions: "off" });
    r.setPose({ time: 50 });
    r.resume();
    clock.advance(100);
    const events: string[] = [];
    r.addEventListener("squire-gesture-end", (e) => {
      if (e instanceof CustomEvent) events.push(e.detail.name);
    });
    const order: string[] = [];
    const first = r.play("nod").then(() => order.push("nod"));
    clock.advance(250);
    expect(r.debugState.activeGesture).toBe("nod");
    const second = r.play("glance").then(() => order.push("glance"));
    clock.advance(2000);
    await Promise.all([first, second]);
    expect(order).toEqual(["nod", "glance"]);
    expect(events).toEqual(["nod", "glance"]);
    expect(r.debugState.activeGesture).toBe(null);
    let outcome = "";
    const p = r.play("cartwheel" as CompanionGesture);
    expect(typeof p.then).toBe("function");
    await p.then(
      () => (outcome = "resolved"),
      (e: unknown) => (outcome = `rejected:${e instanceof TypeError}`),
    );
    expect(outcome).toBe("rejected:true");
  });

  // 780
  it("play() is ignored (resolves immediately, no motion) in still, reduced motion and scrub holds", async () => {
    const setReduced = stubReducedMotion();
    const r = await mountRig({ transitions: "off" });
    const ignored = async () => {
      const before = serial(r);
      const events: unknown[] = [];
      const on = (e: Event) => events.push(e);
      r.addEventListener("squire-gesture-end", on);
      const result = await r.play("flourish");
      clock.advance(250);
      r.removeEventListener("squire-gesture-end", on);
      expect(result.played).toBe(false);
      expect(r.debugState.activeGesture).toBe(null);
      expect(serial(r) === before, "rendered SVG changed after an ignored play()").toBe(true);
      expect(events).toEqual([]);
    };
    r.setAttribute("motion", "still");
    settledIn(r, "still");
    await ignored();
    r.setAttribute("motion", "subtle");
    r.setPose({ time: 8 });
    await ignored();
    r.resume();
    setReduced(true);
    expect(r.debugState.reason).toBe("reduced-motion");
    await ignored();
    setReduced(false);
    liveAgain(r, "after reduced");
  });

  // 801
  it(
    "animated transitions: events, overlap (no empty forearm, face never fades out), palette tween, FX burst",
    { timeout: 30_000 },
    async () => {
      const r = await mountRig({ transitions: "on" });
      await Promise.all(
        [RIG_ART.torso.src, RIG_ART.hood.src, RIG_ART.grips.lance.src].map((src) =>
          requestTint(src, "rose"),
        ),
      );
      await requestTint(RIG_ART.grips.none.src, "rose");
      clock.advance(400);
      const coverage = (rig: Rig, selector: string) =>
        1 -
        qa(rig, selector)
          .filter((n) => n.getAttribute("href"))
          .reduce((k, n) => k * (1 - opacity(n)), 1);
      const extra = (rig: Rig) => ({
        grip: coverage(rig, "image[data-art^=grip]"),
        face: coverage(rig, "image[data-art^=head]"),
        tint: qa(rig, "image[data-art$=Tint]")
          .map((n) => `${n.getAttribute("opacity")}/${opacity(n).toFixed(3)}`)
          .join(","),
        front: [...q(rig, "[data-fx=front]").querySelectorAll("*")].filter(displayed).length,
      });
      type Extra = ReturnType<typeof extra>;
      for (const [kind, attr, value] of [
        ["equipment", "equipment", "lance"],
        ["hood", "hood", "up"],
        ["appearance", "appearance", "male"],
        ["palette", "palette", "rose"],
        ["hood", "hood", "down"],
        ["equipment", "equipment", "none"],
      ] as const) {
        const events: { kind: string; ms: number }[] = [];
        const start = clock.now();
        const on = (e: Event) => {
          if (e instanceof CustomEvent)
            events.push({ kind: e.detail.kind, ms: clock.now() - start });
        };
        r.addEventListener("squire-transition-end", on);
        const samples = record(
          r,
          1600,
          [{ at: 0, fn: (rig) => rig.setAttribute(attr, value) }],
          extra,
        );
        r.removeEventListener("squire-transition-end", on);
        const label = `${attr}=${value}`;
        const ev = events.find((e) => e.kind === kind);
        expect(ev, `${label}: no squire-transition-end`).toBeDefined();
        const ms = ev?.ms ?? 0;
        expect(ms > 150 && ms < 1500, `${label}: transition took ${ms} ms`).toBe(true);
        expect(samples.some((s) => s.transitions.includes(kind))).toBe(true);
        const during = samples
          .filter((s) => s.elapsed <= ms + 20)
          .map((s) => ({ dt: s.dt, x: s.extra as Extra }));
        if (kind === "equipment") {
          let gap = 0;
          for (const s of during) if (s.x.grip < 0.5) gap += s.dt;
          expect(gap, `${label}: forearm nearly invisible`).toBeLessThanOrEqual(60);
          const front = samples.map((s) => (s.extra as Extra).front);
          expect(Math.max(...front), `${label}: equip FX burst in the front layer`).toBeGreaterThan(
            Math.min(...front),
          );
        }
        if (kind === "hood" || kind === "appearance") {
          expect(
            Math.min(...during.map((s) => s.x.face)),
            `${label}: face faded`,
          ).toBeGreaterThanOrEqual(0.9);
        }
        if (kind === "palette") {
          expect(
            new Set(during.map((s) => s.x.tint)).size,
            `${label}: tint should tween`,
          ).toBeGreaterThanOrEqual(4);
        }
      }
    },
  );

  // 839 (entrance)
  it("entrance plays once when first shown live, skipped with transitions=off", async () => {
    const run = async (transitions: string) => {
      const r = await mountRig({ transitions, motion: "subtle" });
      const events: string[] = [];
      r.addEventListener("squire-transition-end", (e) => {
        if (e instanceof CustomEvent) events.push(e.detail.kind);
      });
      const seen = new Set<string>();
      for (const s of record(r, 1500)) for (const k of s.transitions) seen.add(k);
      const body = q(r, "[data-bone=body]");
      const result = { events, seen: [...seen], opacity: opacity(body) };
      r.remove();
      return result;
    };
    const on = await run("on");
    const off = await run("off");
    expect(on.events.includes("entrance") || on.seen.includes("entrance")).toBe(true);
    expect(off.events.includes("entrance") || off.seen.includes("entrance")).toBe(false);
    expect(on.opacity > 0.99 && off.opacity > 0.99, "figure fully visible after entrance").toBe(
      true,
    );
  });

  it("still, reduced-motion, and held rigs never take the lease from a live rig", async () => {
    const setReduced = stubReducedMotion();
    const live = await mountRig({ transitions: "off" });
    const still = await mountRig({ motion: "still" });
    expect(still.debugState.reason).toBe("still");
    expect(live.debugState.paused).toBe(false);
    setReduced(true);
    const reduced = await mountRig({ transitions: "off" });
    expect(reduced.debugState.reason).toBe("reduced-motion");
    setReduced(false);
    expect(live.debugState.reason, "reduced cleared: the earlier live rig keeps holding").toBe(
      "yielded",
    );
    reduced.remove();
    expect(live.debugState.paused).toBe(false);
    const frames = live.debugState.frameCount;
    clock.advance(500);
    expect(live.debugState.frameCount).toBeGreaterThan(frames);

    const held = await mountRig({ transitions: "off" });
    expect(live.debugState.reason).toBe("yielded");
    held.setPose({ time: 3 });
    expect(held.debugState.reason).toBe("scrub");
    expect(live.debugState.paused, "a setPose hold releases the lease").toBe(false);
    held.resume();
    expect(held.debugState.paused).toBe(false);
    expect(live.debugState.reason).toBe("yielded");
    held.remove();

    still.setAttribute("motion", "subtle");
    expect(still.debugState.paused, "a still rig switched to subtle takes the lease").toBe(false);
    expect(live.debugState.reason).toBe("yielded");
    still.setAttribute("motion", "still");
    settledIn(still, "still");
    expect(live.debugState.paused, "blending to still releases the lease").toBe(false);
  });

  it("a rig mounted while another holds the lease skips its entrance and is visible", async () => {
    await mountRig({ placement: "overlay" });
    const r = await mountRig({ transitions: "on" });
    await vi.waitFor(() => expect(r.debugState.reason).toBe("yielded"));
    expect(r.debugState.transitions).toEqual([]);
    expect(opacity(q(r, "[data-bone=body]"))).toBeGreaterThan(0.99);
  });

  // 851
  it("instant swaps with transitions=off, still mode, reduced motion and scrub holds", async () => {
    const setReduced = stubReducedMotion();
    const r = await mountRig({ transitions: "off", motion: "subtle" });
    await Promise.all(
      [RIG_ART.torso.src, RIG_ART.hood.src, RIG_ART.grips.lance.src].map((src) =>
        requestTint(src, "sage"),
      ),
    );
    clock.advance(200);
    const instant = (attr: string, value: string, mode: string) => {
      const events: string[] = [];
      const on = (e: Event) => {
        if (e instanceof CustomEvent) events.push(e.detail.kind);
      };
      r.addEventListener("squire-transition-end", on);
      r.setAttribute(attr, value);
      expect(r.debugState.transitions, `${mode}: swap must be instant`).toEqual([]);
      expect(
        qa(r, "image[data-art^=grip]").filter((n) => n.getAttribute("href") && opacity(n) > 0),
        `${mode}: one grip`,
      ).toHaveLength(1);
      expect(
        qa(r, "image[data-art^=head]").filter((n) => n.getAttribute("href") && displayed(n)),
        `${mode}: one head`,
      ).toHaveLength(1);
      clock.advance(600);
      r.removeEventListener("squire-transition-end", on);
      expect(events, `${mode}: no transition events`).toEqual([]);
      expect(r.configuration[attr as "hood"]).toBe(value);
    };
    instant("equipment", "lance", "off");
    instant("hood", "up", "off");
    instant("appearance", "male", "off");
    instant("palette", "sage", "off");
    r.setAttribute("transitions", "on");
    r.setAttribute("motion", "still");
    settledIn(r, "still");
    instant("equipment", "grimoire", "still");
    instant("hood", "down", "still");
    r.setAttribute("motion", "subtle");
    r.setPose({ time: 5 });
    instant("equipment", "astrolabe", "scrub");
    instant("appearance", "female", "scrub");
    r.resume();
    setReduced(true);
    instant("equipment", "none", "reduced");
    instant("hood", "up", "reduced");
  });

  // 879
  it("pause: still stops frames; resume cannot override still; scrub holds", async () => {
    const r = await mountRig({ motion: "subtle", transitions: "off" });
    liveAgain(r, "initial");
    r.setAttribute("motion", "still");
    r.resume();
    pauseStable(r, "still");
    r.setPose({ time: 7, gaze: 0.5 });
    expect([r.debugState.time, r.debugState.gaze]).toEqual([7, 0.5]);
    pauseStable(r, "scrub");
  });

  // 885 (+ pointer resumes nothing under reduced motion)
  it("pause: reduced motion stops frames and resumes when the preference clears", async () => {
    const setReduced = stubReducedMotion();
    const r = await mountRig({ motion: "subtle", transitions: "off" });
    liveAgain(r, "subtle");
    setReduced(true);
    pauseStable(r, "reduced-motion");
    r.resume();
    pointerOver(r);
    pauseStable(r, "reduced-motion");
    setReduced(false);
    liveAgain(r, "reduced cleared");
  });

  // 892
  it("pause: hidden document stops and restores animation", async () => {
    const r = await mountRig({ motion: "subtle", transitions: "off" });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      pauseStable(r, "document-hidden");
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    }
    liveAgain(r, "visible");
  });

  // 899 (+ pointer resumes nothing while offscreen)
  it("pause: offscreen stops frames and restores one chain when visible; offscreen attribute changes still render", async () => {
    const r = await mountRig({ motion: "subtle", transitions: "off" });
    r.style.top = "3000px";
    await vi.waitFor(() => expect(r.debugState.reason).toBe("offscreen"));
    pauseStable(r, "offscreen");
    r.setAttribute("equipment", "lance");
    expect(q(r, "image[data-art=grip]").getAttribute("href")).toBe(RIG_ART.grips.lance.src);
    pointerOver(r);
    await expect(r.play("nod")).resolves.toMatchObject({ played: false });
    pauseStable(r, "offscreen");
    r.style.top = "0";
    r.setAttribute("equipment", "helmet");
    await vi.waitFor(() => expect(r.debugState.paused).toBe(false));
    liveAgain(r, "onscreen");
  });

  // 906
  it("pause: disconnect stops frames; repeated reconnect keeps at most one pending frame", async () => {
    const r = await mountRig({ motion: "subtle", transitions: "off" });
    r.remove();
    expect(r.debugState.reason).toBe("disconnected");
    pauseStable(r, "disconnected");
    let maximum = 0;
    for (let i = 0; i < 8; i++) {
      document.body.append(r);
      r.resume();
      r.resume();
      await vi.waitFor(() => expect(r.debugState.paused).toBe(false));
      maximum = Math.max(maximum, clock.pendingFrames);
      clock.advance(60);
      r.remove();
      expect(clock.pendingFrames).toBe(0);
    }
    document.body.append(r);
    await vi.waitFor(() => expect(r.debugState.paused).toBe(false));
    liveAgain(r, "reconnected");
    expect(maximum).toBeLessThanOrEqual(1);
  });

  // 919
  it("pointer gaze follows the pointer, pitches vertically, eases back when the pointer leaves", async () => {
    const r = await mountRig({ transitions: "off" });
    r.setAttribute("gaze", "pointer");
    r.resume();
    const move = (x: number, y: number) => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }));
      clock.advance(900);
    };
    move(window.innerWidth - 5, 150);
    const right = r.debugState.gaze;
    move(0, 150);
    const left = r.debugState.gaze;
    move(200, 2);
    const up = r.debugState.pose?.headPitch ?? 0;
    move(200, window.innerHeight - 2);
    const down = r.debugState.pose?.headPitch ?? 0;
    move(window.innerWidth - 5, 150);
    const leave = record(r, 1600, [
      {
        at: 0,
        fn: () => window.dispatchEvent(new PointerEvent("pointerout", { relatedTarget: null })),
      },
    ]);
    const soon = leave.find((s) => s.elapsed > 40);
    expect(right > 0.3 && right <= 1.0001, `right ${right}`).toBe(true);
    expect(left < -0.3 && left >= -1.0001, `left ${left}`).toBe(true);
    expect(down, "pointer below pitches the head down").toBeGreaterThan(up + 0.3);
    expect(soon?.gaze ?? 0, "leaving eases back (no snap)").toBeGreaterThan(0.2);
    expect(Math.abs(leave.at(-1)?.gaze ?? 1)).toBeLessThan(0.15);
  });

  // 938 replaced: four rigs on one page run one loop, inside a one-rig frame budget.
  it("runs a single live rig among four, inside a one-rig frame budget", async () => {
    const rigs: Rig[] = [];
    for (const equipment of ["helmet", "lance", "grimoire", "armillary"])
      rigs.push(await mountRig({ equipment, transitions: "off" }));
    clock.advance(1500);
    const live = rigs.filter((r) => !r.debugState.paused);
    expect(live).toEqual([rigs.at(-1)]);
    for (const r of rigs.slice(0, 3)) expect(r.debugState.reason).toBe("yielded");
    const before = rigs.map((r) => r.debugState.frameCount);
    const t0 = performance.now();
    clock.advance(5000);
    const ms = performance.now() - t0;
    const rendered = rigs.map((r, i) => r.debugState.frameCount - (before[i] ?? 0));
    expect(rendered.slice(0, 3)).toEqual([0, 0, 0]);
    expect(rendered[3]).toBeGreaterThanOrEqual(145);
    expect(rendered[3]).toBeLessThanOrEqual(151);
    // v5 allowed 8 ms per frame for four rigs with FX; one rig gets a quarter of that.
    expect(ms / (rendered[3] ?? 1), "rig + FX script ms per rendered frame").toBeLessThan(2);
  });

  // 999
  it("logs no console errors or squire warnings", () => {
    expect(consoleProblems).toEqual([]);
  });
});
