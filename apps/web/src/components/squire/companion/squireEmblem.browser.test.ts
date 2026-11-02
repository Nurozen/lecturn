// The v5 <squire-emblem> contract (v5 validation/emblem-check.cjs), ported to an injected
// clock. Behavior the port adds lives in squireEmblem.port.browser.test.ts.
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
import { defineSquireEmblem, SquireEmblemElement, type EmblemPose } from "./squireEmblem";
import emblemSource from "./squireEmblem.ts?raw";
import {
  COMPANION_GESTURES,
  EMBLEM_CHOICES,
  type CompanionGesture,
  type SetPoseInput,
} from "./types";

const FRAME = 1000 / 30;
const KNOTS = [
  [25, 62],
  [49, 106],
] as const;
const STAR = [82, 22] as const;
const DEFAULTS = {
  ...Object.fromEntries(Object.entries(EMBLEM_CHOICES).map(([key, values]) => [key, values[0]])),
  debug: false,
  label: "",
};

let clock: ReturnType<typeof createManualCompanionClock>;
let mounted: HTMLElement[] = [];
const problems: string[] = [];

type MountOptions = { size?: number; style?: string; keep?: boolean };

async function mount(attributes: Record<string, string> = {}, options: MountOptions = {}) {
  if (!options.keep) unmountAll();
  defineSquireEmblem();
  const emblem = document.createElement("squire-emblem");
  const size = options.size ?? 256;
  emblem.style.cssText = `display:block;width:${size}px;height:${size}px;position:absolute;left:0;top:0;${options.style ?? ""}`;
  for (const [name, value] of Object.entries(attributes)) emblem.setAttribute(name, value);
  document.body.append(emblem);
  mounted.push(emblem);
  await vi.waitFor(() => expect(emblem.debugState.reason).not.toBe("offscreen"));
  return emblem;
}

function unmountAll() {
  for (const element of mounted) element.remove();
  mounted = [];
}

const svgOf = (emblem: SquireEmblemElement) => emblem.shadowRoot!.querySelector("svg")!;

function displayed(node: Element) {
  for (let n: Element | null = node; n; n = n.parentElement) {
    if (getComputedStyle(n).display === "none") return false;
  }
  return true;
}

// Rendered DOM: hidden subtrees and unreferenced definitions removed, attributes sorted.
function serial(emblem: SquireEmblemElement) {
  const copy = svgOf(emblem).cloneNode(true);
  if (!(copy instanceof SVGSVGElement)) throw new Error("svg clone");
  for (const node of Array.from(copy.querySelectorAll("*"))) {
    if (
      node.getAttribute("display") === "none" ||
      /display:\s*none/.test(node.getAttribute("style") ?? "")
    )
      node.remove();
  }
  const refs = (el: Element) =>
    [...el.attributes].flatMap((a) =>
      [...a.value.matchAll(/(?:url\(#|^#)([^)\s]+)/g)].map((m) => m[1] ?? ""),
    );
  const NR = "clipPath, mask, linearGradient, radialGradient, filter, pattern, symbol, marker";
  const defs = [...copy.querySelectorAll(NR)].filter((n) => n.id && !n.parentElement?.closest(NR));
  const used = new Set<string>();
  for (const n of copy.querySelectorAll("*"))
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
        k instanceof Element
          ? walk(k)
          : k.nodeType === Node.TEXT_NODE
            ? (k.textContent ?? "").trim()
            : "",
      )
      .join("")}</${n.tagName}>`;
  return walk(copy);
}

// Thread geometry as drawn: each visible thread path's numbers -> start / end points.
function threads(emblem: SquireEmblemElement) {
  const svg = svgOf(emblem);
  const ids = new Set(
    [...svg.querySelectorAll("[data-l=threads] use")]
      .filter(displayed)
      .map((u) => (u.getAttribute("href") ?? "").slice(1)),
  );
  return [...svg.querySelectorAll("path[id]")]
    .filter((p) => /-t\d+$/.test(p.id) && ids.has(p.id) && p.getAttribute("d"))
    .map((p) => {
      const d = p.getAttribute("d") ?? "";
      const n = (d.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
      return { start: [n[0]!, n[1]!] as const, end: [n.at(-2)!, n.at(-1)!] as const, d };
    });
}

// Largest change between two emblem poses (drawing units; angles / 5, gains x 5). Without
// rotation it measures what reads on the four-fold symmetric star: a quarter-turn spin does not.
function poseDelta(a: EmblemPose | null, b: EmblemPose | null, rotation = true) {
  if (!a || !b) return Infinity;
  let d = Math.max(
    Math.abs(a.star.x - b.star.x),
    Math.abs(a.star.y - b.star.y),
    rotation ? Math.abs(a.star.rot - b.star.rot) / 5 : 0,
    Math.abs(a.star.scale - b.star.scale) * 20,
    Math.abs(a.gain - b.gain) * 5,
  );
  a.nodes.forEach((th, i) =>
    th.forEach((p, j) => {
      const q = b.nodes[i]?.[j];
      if (q) d = Math.max(d, Math.hypot(p[0] - q[0], p[1] - q[1]));
    }),
  );
  return d;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Advances one rendered frame at a time until `done` holds (bounded).
function advanceUntil(done: () => boolean, limitMs = 5000) {
  for (let spent = 0; !done() && spent < limitMs; spent += FRAME) clock.advance(FRAME);
}

// `othersLive` counts frames scheduled by other emblems on the shared clock (the lease holder).
function pauseStable(emblem: SquireEmblemElement, reason: string, othersLive = 0) {
  advanceUntil(() => {
    const d = emblem.debugState;
    return d.reason === reason && !d.settling && !d.pendingRAF;
  });
  const before = { debug: emblem.debugState, svg: serial(emblem) };
  clock.advance(350);
  const after = { debug: emblem.debugState, svg: serial(emblem) };
  expect(after.debug.reason).toBe(reason);
  expect(after.debug.paused).toBe(true);
  expect(after.debug.frameCount, `${reason}: frames must stop`).toBe(before.debug.frameCount);
  expect(after.debug.time, `${reason}: time must stop`).toBe(before.debug.time);
  expect(after.svg === before.svg, `${reason}: rendered SVG must not change while paused`).toBe(
    true,
  );
  expect(after.debug.pendingRAF).toBe(0);
  expect(clock.pendingFrames, `${reason}: no frame may stay scheduled`).toBe(othersLive);
}

async function liveAgain(emblem: SquireEmblemElement, label: string) {
  await vi.waitFor(() => expect(emblem.debugState.paused, label).toBe(false));
  const before = emblem.debugState.frameCount;
  clock.advance(150);
  expect(emblem.debugState.frameCount, `${label}: frames advance after resuming`).toBeGreaterThan(
    before,
  );
  expect(clock.pendingFrames, `${label}: exactly one frame chain`).toBe(1);
}

const FEATURES = [
  "dx",
  "dy",
  "size",
  "gain",
  "threads",
  "halo",
  "sparks",
  "streak",
  "rewind",
  "light",
  "knot",
  "flare",
  "rays",
  "trail",
  "arcs",
  "chevrons",
  "orb",
] as const;
type Feature = (typeof FEATURES)[number];
type Signature = Record<Feature, number>;

const layerOf = (e: SquireEmblemElement, name: string) =>
  e.shadowRoot!.querySelector<SVGElement>(`[data-l="${name}"]`)!;
const opacityOf = (el: Element) =>
  el instanceof SVGElement && el.style.display === "none"
    ? 0
    : Number(el.getAttribute("opacity") ?? 1);

// What a single frame shows, scaled to roughly drawing units so features compare: star
// position, size and brightness, thread gather, halo, sparks, the signed glance trail, the
// flourish rewind, thread lights, the end-knot flare and the star flare.
function frameSignature(e: SquireEmblemElement): Signature {
  const pose = e.debugState.pose!;
  const root = e.shadowRoot!;
  const streak = layerOf(e, "streak");
  const trail = Math.sign(
    Number(/scale\((-?[\d.]+)/.exec(streak.getAttribute("transform") ?? "")?.[1] ?? 0),
  );
  const dash =
    root.querySelector("[data-l=threads] use")?.getAttribute("stroke-dasharray") ?? "none";
  const knot = root.querySelectorAll('[data-fx="knot"]')[1];
  return {
    dx: pose.star.x,
    dy: pose.star.y,
    size: pose.star.scale * 20,
    gain: pose.gain * 5,
    threads: pose.gather * 5,
    halo: pose.halo * 5,
    sparks: opacityOf(layerOf(e, "sparks")) > 0 ? 5 : 0,
    streak: opacityOf(streak) * trail * 5,
    rewind: dash === "none" ? 0 : (1 - parseFloat(dash) / 100) * 5,
    light: Math.max(0, ...pose.lights.map((L) => L?.a ?? 0)) * 5,
    knot: Number(knot?.getAttribute("r") ?? 0) * 2,
    flare: opacityOf(layerOf(e, "flare")) * 5,
    rays: opacityOf(layerOf(e, "rays")) * 5,
    arcs: opacityOf(layerOf(e, "listenArcs")) * 5,
    chevrons: opacityOf(layerOf(e, "nodChevrons")) * 5,
    orb: opacityOf(layerOf(e, "ponderOrb")) * 5,
    // Trail length per 5 drawing units (the drawn path is 22 long before scaling).
    trail:
      opacityOf(streak) > 0
        ? (Math.abs(
            Number(/scale\((-?[\d.]+)/.exec(streak.getAttribute("transform") ?? "")?.[1] ?? 0),
          ) *
            22) /
          5
        : 0,
  };
}

const signatureDistance = (a: Signature, b: Signature) =>
  Math.max(...FEATURES.map((k) => Math.abs(a[k] - b[k])));

// Plays one gesture from a fresh live start at t=30 and compares each frame with the held
// (gesture-free) frame at the same time and seed. The peak frame differs most in total.
async function runGesture(e: SquireEmblemElement, name: CompanionGesture) {
  e.setPose({ time: 30 });
  e.resume();
  clock.advance(3 * FRAME);
  let ended = false;
  const onEnd = (event: Event) => {
    if (event instanceof CustomEvent && event.detail.name === name) ended = true;
  };
  e.addEventListener("squire-gesture-end", onEnd);
  const start = clock.now();
  const outcome: { result: { played: boolean; at: number } | null } = { result: null };
  void e.play(name).then((value) => {
    outcome.result = { played: value.played, at: clock.now() - start };
  });
  const samples: Array<{
    time: number;
    pose: EmblemPose | null;
    active: string | null;
    signature: Signature;
  }> = [];
  const finished = () => outcome.result !== null && clock.now() - start > outcome.result.at + 100;
  while (clock.now() - start < 4000 && !finished()) {
    clock.advance(FRAME);
    // One microtask turn delivers a resolution queued during the frame.
    await Promise.resolve();
    const ds = e.debugState;
    samples.push({
      time: ds.time,
      pose: ds.pose,
      active: ds.activeGesture,
      signature: frameSignature(e),
    });
  }
  e.removeEventListener("squire-gesture-end", onEnd);
  let deviation = 0;
  let readable = 0;
  let peak = {
    strength: 0,
    signature: Object.fromEntries(FEATURES.map((k) => [k, 0])) as Signature,
  };
  for (const sample of samples) {
    e.setPose({ time: sample.time });
    deviation = Math.max(deviation, poseDelta(sample.pose, e.debugState.pose));
    readable = Math.max(readable, poseDelta(sample.pose, e.debugState.pose, false));
    const held = frameSignature(e);
    const diff = Object.fromEntries(
      FEATURES.map((k) => [k, sample.signature[k] - held[k]]),
    ) as Signature;
    const strength = FEATURES.reduce((sum, k) => sum + Math.abs(diff[k]), 0);
    if (strength > peak.strength) peak = { strength, signature: diff };
  }
  e.resume();
  const activeSeen = samples.some((sample) => sample.active === name);
  return { result: outcome.result, ended, activeSeen, deviation, readable, peak: peak.signature };
}

// prefers-reduced-motion, flipped by the test; the element reads it on connect.
let reducedMotion: EventTarget & { matches: boolean };
function setReducedMotion(matches: boolean) {
  reducedMotion.matches = matches;
  reducedMotion.dispatchEvent(new Event("change"));
}

const onWindowError = (event: ErrorEvent) => problems.push(`pageerror: ${event.message}`);

beforeAll(() => {
  window.addEventListener("error", onWindowError);
  const record =
    (type: string) =>
    (...args: unknown[]) =>
      problems.push(`${type}: ${args.map(String).join(" ")}`);
  vi.spyOn(console, "error").mockImplementation(record("error"));
  vi.spyOn(console, "warn").mockImplementation(record("warn"));
});

afterAll(() => {
  window.removeEventListener("error", onWindowError);
});

beforeEach(() => {
  clock = createManualCompanionClock({ frameMs: 1000 / 120 });
  setCompanionClockForTests(clock);
  reducedMotion = Object.assign(new EventTarget(), {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
  });
  vi.spyOn(window, "matchMedia").mockReturnValue(reducedMotion as MediaQueryList);
});

afterEach(() => {
  unmountAll();
  setCompanionClockForTests(null);
  vi.mocked(window.matchMedia).mockRestore();
});

describe("<squire-emblem> v5 contract", () => {
  it("defines squire-emblem standalone (no rig, FX or art) and draws every instance", async () => {
    defineSquireEmblem();
    expect(() => defineSquireEmblem()).not.toThrow();
    expect(customElements.get("squire-emblem")).toBe(SquireEmblemElement);
    expect(customElements.get("squire-rig")).toBeUndefined();
    expect(emblemSource).not.toMatch(/from "\.\/(squireRig|squireFx|rigArt)"/);
    const emblems = [];
    for (let i = 0; i < 4; i++) {
      emblems.push(
        await mount(
          { frame: EMBLEM_CHOICES.frame[i % 3]! },
          { keep: true, size: 96, style: `left:${i * 100}px` },
        ),
      );
    }
    clock.advance(1000);
    for (const emblem of emblems) {
      expect(emblem.debugState.frameCount).toBeGreaterThanOrEqual(1);
      expect(threads(emblem).length).toBe(3);
    }
  });

  it("configuration: shape, defaults, every listed value, normalization, invalid fallbacks, seed", async () => {
    const e = await mount();
    const defaults = e.getConfiguration();
    const copy = e.configuration;
    copy.frame = "seal";
    expect(e.configuration.frame, "configuration must be a copy").toBe("bare");
    expect(e.getAttribute("seed"), "seed reflected on connect").not.toBeNull();
    const { seed, ...rest } = defaults;
    expect(Object.keys(defaults).sort()).toEqual([...Object.keys(DEFAULTS), "seed"].sort());
    expect(rest).toEqual(DEFAULTS);
    expect(Number.isInteger(seed)).toBe(true);

    for (const [key, values] of Object.entries(EMBLEM_CHOICES)) {
      for (const value of values) {
        e.setAttribute(key, `  ${value.toUpperCase()} `);
        expect(
          e.configuration[key as keyof typeof EMBLEM_CHOICES],
          `attribute ${key}=${value}`,
        ).toBe(value);
      }
    }
    for (const key of [...Object.keys(EMBLEM_CHOICES), "debug"]) e.setAttribute(key, "invalid");
    e.setAttribute("label", "  Keeper  ");
    e.setAttribute("seed", "42");
    const { seed: invalidSeed, ...invalid } = e.configuration;
    expect(invalid).toEqual({ ...DEFAULTS, label: "Keeper" });
    expect(invalidSeed).toBe(42);
    expect(svgOf(e).getAttribute("aria-label")).toBe("Keeper");
    e.setAttribute("seed", "not-a-number");
    expect(Number.isInteger(e.configuration.seed)).toBe(true);

    const observed = SquireEmblemElement.observedAttributes;
    for (const key of [...Object.keys(EMBLEM_CHOICES), "debug", "label", "seed"])
      expect(observed).toContain(key);
    const debugKeys = Object.keys(e.debugState);
    for (const key of [
      "paused",
      "reason",
      "frameCount",
      "pendingRAF",
      "time",
      "gaze",
      "state",
      "fps",
      "activeGesture",
      "transition",
      "small",
      "pose",
    ]) {
      expect(debugKeys).toContain(key);
    }
  });

  it("setPose determinism: identical rendered SVG after unrelated poses and attribute churn", async () => {
    const e = await mount({ frame: "orbit", palette: "moonstone", seed: "7" });
    e.resume();
    clock.advance(600);
    const poses: SetPoseInput[] = [
      { time: 0.5 },
      { time: 3.3, gaze: 0.6 },
      { time: 12.7, state: "thinking" },
      { time: 27.9, state: "attentive", gaze: -0.4 },
    ];
    for (const pose of poses) {
      e.setPose(pose);
      const a = serial(e);
      e.resume();
      clock.advance(300);
      void e.play("flourish");
      e.setAttribute("palette", "rose");
      e.setAttribute("frame", "seal");
      e.setAttribute("weight", "bold");
      e.setAttribute("glow", "bright");
      clock.advance(250);
      e.setAttribute("palette", "moonstone");
      e.setAttribute("frame", "orbit");
      e.setAttribute("weight", "regular");
      e.setAttribute("glow", "soft");
      e.setPose(pose);
      expect(serial(e), `setPose(${JSON.stringify(pose)})`).toBe(a);
      expect(threads(e).length, "emblem visibly drawn").toBe(3);
    }
  });

  it("setPose determinism across instances with the same seed", async () => {
    const a = await mount({ frame: "orbit", seed: "11" });
    const b = await mount({ frame: "orbit", seed: "11" }, { keep: true });
    clock.advance(1200);
    const normalize = (s: string) => s.replace(/squire-emblem-\d+-/g, "squire-emblem-#-");
    for (const pose of [
      { time: 0.9 },
      { time: 7.25, state: "thinking" as const },
      { time: 19.5, gaze: 0.5 },
    ]) {
      a.setPose(pose);
      b.setPose(pose);
      expect(normalize(serial(b)), `twins differ at ${JSON.stringify(pose)}`).toBe(
        normalize(serial(a)),
      );
    }
    b.setAttribute("seed", "12");
    a.setPose({ time: 5 });
    b.setPose({ time: 5 });
    expect(
      poseDelta(a.debugState.pose, b.debugState.pose),
      "different seeds desync the idle float",
    ).toBeGreaterThan(0.05);
  });

  it("hold reproduces the live frame (setPose at the live time does not jump)", async () => {
    const e = await mount({ frame: "orbit", seed: "5" });
    clock.advance(1500);
    let worst = 0;
    for (let i = 0; i < 6; i++) {
      clock.advance(400);
      const live = e.debugState;
      e.setPose({ time: live.time });
      worst = Math.max(worst, poseDelta(live.pose, e.debugState.pose));
      e.resume();
    }
    expect(worst).toBeLessThan(0.75);
  });

  it("setPose validation: clamping and TypeErrors without side effects; state override", async () => {
    const e = await mount();
    e.setPose({ time: -3, gaze: 9 });
    expect(e.debugState).toMatchObject({ time: 0, gaze: 1, reason: "scrub" });
    e.setPose({ time: 4 });
    const invalid = [
      { time: NaN },
      { time: Infinity },
      { time: "2" },
      { gaze: NaN },
      { time: 1, state: "asleep" },
    ];
    for (const pose of invalid) {
      const before = serial(e) + JSON.stringify(e.debugState);
      expect(() => e.setPose(pose as SetPoseInput), JSON.stringify(pose)).toThrow(TypeError);
      expect(serial(e) + JSON.stringify(e.debugState)).toBe(before);
    }
    const frames = new Set<string>();
    for (const state of EMBLEM_CHOICES.state) {
      e.setPose({ time: 6, state });
      expect(e.debugState.state).toBe(state);
      frames.add(serial(e));
    }
    expect(frames.size, "held states render distinct frames").toBe(3);
  });

  it("anchors: knots never move and the star stays at the top across time, states, frames, gestures", async () => {
    const found: string[] = [];
    const inspect = (label: string, emblem: SquireEmblemElement) => {
      const ends = threads(emblem).flatMap((t) => [t.start, t.end]);
      for (const k of KNOTS) {
        if (!ends.some((p) => Math.hypot(p[0] - k[0], p[1] - k[1]) < 0.02))
          found.push(`${label}: no thread end at knot ${k.join(",")}`);
      }
      for (const p of ends) {
        if (KNOTS.some((k) => Math.hypot(p[0] - k[0], p[1] - k[1]) < 0.02)) continue;
        const d = Math.hypot(p[0] - STAR[0], p[1] - STAR[1]);
        if (d > 6)
          found.push(`${label}: thread end ${p.join(",")} is ${d.toFixed(2)} from the star`);
      }
      const star = emblem.debugState.pose?.star;
      if (star && star.y > 40) found.push(`${label}: star dropped to y=${star.y}`);
    };
    for (const frame of EMBLEM_CHOICES.frame) {
      for (const motion of ["subtle", "lively"]) {
        const e = await mount({ frame, motion, transitions: "off" });
        for (let i = 0; i < 90; i++) {
          e.setPose({ time: i * 0.613, gaze: Math.sin(i), state: EMBLEM_CHOICES.state[i % 3]! });
          inspect(`${frame}/${motion} t=${(i * 0.613).toFixed(2)}`, e);
        }
      }
    }
    const e = await mount({ frame: "orbit", motion: "lively" });
    clock.advance(1000);
    for (const name of COMPANION_GESTURES) {
      void e.play(name);
      for (let spent = 0; spent < 1900; spent += FRAME) {
        clock.advance(FRAME);
        inspect(`live ${name}`, e);
      }
    }
    expect(found.slice(0, 6)).toEqual([]);
  });

  it("play(): all six gestures resolve, emit squire-gesture-end, report activeGesture, visibly move", async () => {
    const e = await mount({ frame: "orbit", seed: "9" });
    clock.advance(1200);
    for (const name of COMPANION_GESTURES) {
      const run = await runGesture(e, name);
      expect(run.result, `play('${name}') resolves`).not.toBeNull();
      expect(run.result?.played, `play('${name}') played while live`).toBe(true);
      expect(run.result?.at).toBeGreaterThan(300);
      expect(run.result?.at).toBeLessThan(3500);
      expect(run.ended, `squire-gesture-end {name:'${name}'}`).toBe(true);
      expect(run.activeSeen, `activeGesture '${name}'`).toBe(true);
      expect(run.deviation, `${name} barely visible`).toBeGreaterThan(0.5);
    }

    const order: string[] = [];
    const nod = e.play("nod").then(() => order.push("nod"));
    clock.advance(200);
    const glance = e.play("glance").then(() => order.push("glance"));
    clock.advance(2000);
    await Promise.all([nod, glance]);
    expect(order, "interrupted gesture resolves first").toEqual(["nod", "glance"]);
    const attempt: { unknown: Promise<unknown> | null } = { unknown: null };
    expect(() => {
      attempt.unknown = e.play("cartwheel" as CompanionGesture);
    }, "unknown gesture must not throw synchronously").not.toThrow();
    await expect(attempt.unknown).rejects.toThrow(TypeError);
  });

  // Floors sit at about 85% of the weakest seed measured after the contrast passes, so a
  // regression toward v5's subtler peaks fails. Readable peak deviation per gesture: v5 nod
  // 3.61, glance 4.51, flourish 6.94; now nod 4.5 (dip only, no flash), glance 7.61,
  // flourish 11.0, greet 5.71, listen 2.78, ponder 5.96.
  const FLOORS: Record<string, number> = {
    "nod.readable": 3.8,
    "greet.readable": 4.85,
    "flourish.readable": 9.3,
    "glance.readable": 6.45,
    "listen.readable": 2.35,
    "ponder.readable": 5.0,
    // Peak-frame motifs (measured minimum in parentheses).
    "nod.dips": 3.5, // (4.12)
    "nod.shrinks": 3.8, // (4.46)
    "nod.chevrons": 4.5, // (5: the figure's chevrons under the star)
    "nod.noFlash": -0.5, // (0)
    "greet.rises": 2.0, // (2.40)
    "greet.fans": 8.0, // (9.43)
    "greet.grows": 2.6, // (3.14)
    "greet.rays": 4.0, // (4.75)
    "flourish.sparks": 4.9, // (5: sparks out at the peak frame)
    "flourish.pops": 9.3, // (10.96)
    "flourish.rewinds": 3.6, // (4.26)
    "glance.shifts": 4.3, // (5.04 of the hub's ~5.6 unit allowance)
    "glance.trails": 3.6, // (4.25)
    "glance.trailLength": 7.7, // (9.08: about 45 drawing units)
    "glance.glints": 3.4, // (4.02: the landing glint)
    "glance.trailsBehind": 0.5, // (1: the trail points away from the shift)
    "listen.warms": 3.2, // (3.76)
    "listen.arcs": 4.5, // (5: the figure's ear arcs beside the star)
    "ponder.orb": 4.1, // (4.84: the figure's held orb, still there at the landing flare)
    "ponder.noKnot": -0.5, // (0: the knot accent is nod's)
  };
  // Every pair of peak frames differs by at least this much in some feature (min 5.0,
  // listen/ponder: arcs vs orb); the pairs the critics confused must differ by more.
  const DISTINCT_FLOOR = 4.3;
  const PAIR_FLOORS: Record<string, number> = {
    "distinct.nod-ponder": 7.0, // (8.29)
    "distinct.nod-greet": 8.0,
    "distinct.greet-flourish": 8.0,
    "distinct.greet-glance": 8.0, // (9.43)
    "distinct.greet-listen": 8.0,
    "distinct.greet-ponder": 8.0,
    "distinct.nod-glance": 7.7,
    "distinct.flourish-glance": 7.7, // (9.08, 10.96)
    "distinct.glance-listen": 7.7,
    "distinct.glance-ponder": 7.7, // (9.08)
  };

  // Each gesture's peak frame must carry its motif in a still (signature units, see
  // frameSignature).
  const PEAK_MOTIF: Record<CompanionGesture, (peak: Signature) => Record<string, number>> = {
    nod: (p) => ({ dips: p.dy, shrinks: -p.size, chevrons: p.chevrons, noFlash: -p.flare }),
    greet: (p) => ({ rises: -p.dy, fans: -p.threads, grows: p.size, rays: p.rays }),
    flourish: (p) => ({ sparks: p.sparks, pops: p.size, rewinds: p.rewind }),
    glance: (p) => ({
      shifts: Math.abs(p.dx),
      trails: Math.abs(p.streak),
      trailLength: p.trail,
      trailsBehind: -Math.sign(p.dx) * Math.sign(p.streak),
      glints: p.flare,
    }),
    listen: (p) => ({ warms: p.halo, arcs: p.arcs }),
    ponder: (p) => ({ orb: p.orb, noKnot: -p.knot }),
  };

  it("every gesture visibly moves for every idle seed, subtle and lively, with a motif at its peak", async () => {
    const report: Record<string, number> = {};
    const low = (key: string, value: number) => {
      report[key] = Math.min(report[key] ?? Infinity, value);
    };
    for (const motion of ["subtle", "lively"]) {
      for (let seed = 1; seed <= 12; seed++) {
        const e = await mount({ frame: "orbit", motion, seed: String(seed), transitions: "off" });
        clock.advance(1200);
        const peaks = new Map<CompanionGesture, Signature>();
        for (const name of COMPANION_GESTURES) {
          const run = await runGesture(e, name);
          const label = `${name} seed ${seed} ${motion}`;
          expect(run.result?.played, label).toBe(true);
          low(`${name}.readable`, run.readable);
          for (const [cue, value] of Object.entries(PEAK_MOTIF[name](run.peak)))
            low(`${name}.${cue}`, value);
          peaks.set(name, run.peak);
        }
        for (const [i, a] of COMPANION_GESTURES.entries()) {
          for (const b of COMPANION_GESTURES.slice(i + 1))
            low(`distinct.${a}-${b}`, signatureDistance(peaks.get(a)!, peaks.get(b)!));
        }
      }
    }
    for (const [key, value] of Object.entries(report)) {
      const floor = key.startsWith("distinct.")
        ? (PAIR_FLOORS[key] ?? DISTINCT_FLOOR)
        : FLOORS[key];
      expect(floor, `${key} has a floor`).toBeDefined();
      expect(value, `${key} (weakest seed)`).toBeGreaterThan(floor ?? Infinity);
    }
  });

  it("each state reads distinctly in one still frame, at panel size and at 24 px", async () => {
    const layer = (e: SquireEmblemElement, name: string) =>
      e.shadowRoot!.querySelector<SVGElement>(`[data-l="${name}"]`)!;
    const shown = (el: SVGElement) =>
      el.style.display === "none" ? 0 : Number(el.getAttribute("opacity") ?? 1);
    for (const size of [340, 24]) {
      const e = await mount({ seed: "3", transitions: "off" }, { size });
      const still = (state: "idle" | "attentive" | "thinking") => {
        e.setPose({ time: 12, state });
        const pose = e.debugState.pose!;
        const light = Math.max(0, ...pose.lights.map((L) => L?.a ?? 0));
        return {
          pose,
          light,
          flare: shown(layer(e, "flare")),
          core: shown(layer(e, "core")),
          halo: shown(layer(e, "halo")),
          crest: shown(layer(e, "crest")),
        };
      };
      const idle = still("idle");
      const attentive = still("attentive");
      const thinking = still("thinking");
      const label = `${size}px`;
      expect(attentive.pose.star.y, `${label}: attentive star lifts`).toBeLessThan(
        idle.pose.star.y - 3.6,
      );
      expect(attentive.crest, `${label}: attentive crest arc`).toBeGreaterThan(0.6);
      expect(attentive.pose.gather, `${label}: attentive threads gather`).toBeGreaterThan(
        idle.pose.gather + 1.4,
      );
      expect(attentive.pose.gain, `${label}: attentive star brightens`).toBeGreaterThan(
        idle.pose.gain + 0.8,
      );
      expect(attentive.halo, `${label}: attentive halo`).toBeGreaterThan(0.5);
      expect(attentive.flare, `${label}: attentive held flare`).toBeGreaterThan(0.45);
      expect(thinking.core, `${label}: thinking cool core`).toBeGreaterThan(0.8);
      expect(thinking.light, `${label}: thinking held thread light`).toBeGreaterThan(0.6);
      expect(thinking.pose.star.scale, `${label}: thinking star draws in`).toBeLessThan(
        idle.pose.star.scale - 0.08,
      );
      for (const [name, cue] of [
        ["halo", idle.halo],
        ["flare", idle.flare],
        ["core", idle.core],
        ["light", idle.light],
        ["crest", idle.crest],
      ] as const) {
        expect(cue, `${label}: idle has no ${name}`).toBeLessThan(0.05);
      }
      expect(
        thinking.halo + thinking.flare + thinking.crest + attentive.core,
        `${label}: cues stay with their state`,
      ).toBeLessThan(0.05);
    }
  });

  it("a still, reduced-motion or held emblem never takes the lease from a live one", async () => {
    const live = await mount({ transitions: "off" });
    await mount({ motion: "still" }, { keep: true, style: "left:260px" });
    const reduced = Object.assign(new EventTarget(), {
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
    });
    vi.mocked(window.matchMedia).mockReturnValueOnce(reduced as MediaQueryList);
    const calm = await mount({}, { keep: true, style: "top:260px" });
    expect(calm.debugState.reason).toBe("reduced-motion");
    await liveAgain(live, "after still and reduced-motion mounts");

    const held = await mount({ transitions: "off" }, { keep: true, style: "left:260px;top:260px" });
    expect(live.debugState.reason).toBe("yielded");
    held.setPose({ time: 3 });
    expect(held.debugState.reason).toBe("scrub");
    await liveAgain(live, "after the newer emblem holds a pose");
    held.resume();
    expect(held.debugState.paused, "a resumed emblem claims the lease again").toBe(false);
    expect(live.debugState.reason).toBe("yielded");
    held.setAttribute("motion", "still");
    advanceUntil(() => held.debugState.reason === "still" && !held.debugState.settling);
    await liveAgain(live, "after the newer emblem turns still");
  });

  it("play() is ignored (immediate, no change) in still, reduced motion and scrub holds", async () => {
    const ignored = async (e: SquireEmblemElement, label: string) => {
      const before = serial(e);
      const outcome: { value: unknown } = { value: null };
      void e.play("flourish").then((result) => {
        outcome.value = result;
      });
      await flush();
      expect(outcome.value, `${label}: resolves immediately`).toEqual({
        name: "flourish",
        played: false,
      });
      clock.advance(250);
      expect(e.debugState.activeGesture).toBeNull();
      expect(serial(e) === before, `${label}: frame unchanged`).toBe(true);
    };
    const e = await mount();
    clock.advance(300);
    e.setAttribute("motion", "still");
    advanceUntil(() => e.debugState.reason === "still" && !e.debugState.settling);
    await ignored(e, "still");
    e.setAttribute("motion", "subtle");
    e.setPose({ time: 4 });
    await ignored(e, "scrub");
    e.resume();
    setReducedMotion(true);
    expect(e.debugState.reason).toBe("reduced-motion");
    await ignored(e, "reduced");
    setReducedMotion(false);
    await liveAgain(e, "after reduced");
  });

  it("animated transitions emit events (palette, frame, weight, glow, entrance); off/still swap instantly", async () => {
    const kinds: string[] = [];
    const onEnd = (event: Event) => {
      if (event instanceof CustomEvent) kinds.push(event.detail.kind);
    };
    const e = await mount({ transitions: "on" });
    e.addEventListener("squire-transition-end", onEnd);
    clock.advance(1600);
    expect(kinds).toContain("entrance");
    for (const [attr, value] of [
      ["palette", "sage"],
      ["frame", "seal"],
      ["weight", "bold"],
      ["glow", "bright"],
      ["frame", "bare"],
    ] as const) {
      kinds.length = 0;
      const start = clock.now();
      e.setAttribute(attr, value);
      expect(e.debugState.transitions, `${attr}: debugState.transitions`).toContain(attr);
      advanceUntil(() => kinds.includes(attr), 1400);
      const ms = clock.now() - start;
      expect(kinds, `${attr}=${value}: squire-transition-end`).toContain(attr);
      expect(ms).toBeGreaterThan(150);
      expect(ms).toBeLessThan(1300);
    }
    for (const mode of ["off", "still"]) {
      const quiet = await mount(
        mode === "off" ? { transitions: "off" } : { transitions: "on", motion: "still" },
      );
      kinds.length = 0;
      quiet.addEventListener("squire-transition-end", onEnd);
      clock.advance(200);
      const immediate: string[] = [];
      for (const [attr, value] of [
        ["palette", "rose"],
        ["frame", "orbit"],
        ["weight", "fine"],
        ["glow", "none"],
      ] as const) {
        quiet.setAttribute(attr, value);
        immediate.push(...quiet.debugState.transitions);
      }
      clock.advance(700);
      expect(immediate, `${mode}: swaps must be instant`).toEqual([]);
      expect(
        kinds.filter((kind) => kind !== "entrance"),
        `${mode}: no transition events`,
      ).toEqual([]);
    }
  });

  it("pause reasons stop frames and RAF (still, scrub, reduced motion, hidden, offscreen, unfocused, yielded, settled, disconnected)", async () => {
    const e = await mount({ transitions: "off" });
    await liveAgain(e, "initial");
    e.setAttribute("motion", "still");
    pauseStable(e, "still");
    e.setAttribute("motion", "subtle");
    e.setPose({ time: 3 });
    pauseStable(e, "scrub");
    e.resume();
    await liveAgain(e, "resume");
    setReducedMotion(true);
    pauseStable(e, "reduced-motion");
    setReducedMotion(false);
    await liveAgain(e, "reduced cleared");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    try {
      pauseStable(e, "document-hidden");
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await liveAgain(e, "visible");
    e.style.top = "3000px";
    await vi.waitFor(() => expect(e.debugState.reason).toBe("offscreen"));
    pauseStable(e, "offscreen");
    e.style.top = "0px";
    await liveAgain(e, "onscreen");
    clock.setFocused(false);
    pauseStable(e, "unfocused");
    clock.setFocused(true);
    await liveAgain(e, "refocused");
    const other = await mount({ transitions: "off" }, { keep: true });
    pauseStable(e, "yielded", 1);
    other.remove();
    await liveAgain(e, "lease returned");
    clock.advance(20_100);
    pauseStable(e, "settled");
    e.setAttribute("state", "attentive");
    await liveAgain(e, "woken");
    e.remove();
    pauseStable(e, "disconnected");
    for (let i = 0; i < 5; i++) {
      document.body.append(e);
      e.resume();
      e.resume();
      expect(clock.pendingFrames).toBeLessThanOrEqual(1);
      await liveAgain(e, `reconnect ${i}`);
      e.remove();
      expect(clock.pendingFrames).toBe(0);
    }
    document.body.append(e);
    await liveAgain(e, "final");
  });

  it("offscreen emblem renders one static frame without running", async () => {
    defineSquireEmblem();
    const e = document.createElement("squire-emblem");
    e.style.cssText = "display:block;width:128px;height:128px;position:absolute;left:0;top:3000px";
    e.setAttribute("frame", "orbit");
    document.body.append(e);
    mounted.push(e);
    // The first static frame can land before layout gives the emblem its size; wait for
    // the sized redraw instead of a fixed number of animation frames.
    await vi.waitFor(() => {
      expect(e.debugState.reason).toBe("offscreen");
      expect(threads(e).length, "threads drawn offscreen").toBeGreaterThanOrEqual(2);
    });
    expect(e.debugState.frameCount, "a static frame was drawn").toBeGreaterThanOrEqual(1);
    expect(e.debugState.pendingRAF).toBe(0);
    const before = e.debugState.frameCount;
    clock.advance(300);
    expect(e.debugState.frameCount, "no frames while offscreen").toBe(before);
  });

  it("size-aware rendering switches below ~40 px (small drawing, no floating) and back", async () => {
    const out = new Map<number, { small: boolean; threads: number }>();
    for (const size of [24, 32, 39, 41, 48, 64, 128]) {
      const e = await mount({ frame: "orbit", transitions: "off" }, { size });
      out.set(size, { small: e.debugState.small, threads: threads(e).length });
    }
    for (const size of [24, 32, 39])
      expect(out.get(size)?.small, `${size}px uses the small drawing`).toBe(true);
    for (const size of [41, 48, 64, 128])
      expect(out.get(size)?.small, `${size}px uses the full drawing`).toBe(false);
    expect(out.get(24)!.threads, "small drawing is simplified").toBeLessThan(out.get(128)!.threads);

    const live = await mount({ frame: "orbit" }, { size: 64 });
    live.style.width = "30px";
    live.style.height = "30px";
    await vi.waitFor(() => expect(live.debugState.small, "shrunk").toBe(true));
    live.style.width = "96px";
    live.style.height = "96px";
    await vi.waitFor(() => expect(live.debugState.small, "grown").toBe(false));

    const small = await mount({ frame: "orbit", state: "thinking" }, { size: 32 });
    const paths = new Set<string>();
    const frames = new Set<string>();
    for (let i = 0; i < 12; i++) {
      small.setPose({ time: i * 1.37 });
      paths.add(
        threads(small)
          .map((t) => t.d)
          .join("|"),
      );
      frames.add(serial(small));
    }
    expect(paths.size, "small emblem threads must not float").toBe(1);
    expect(frames.size, "small emblem keeps glow breathing / star twinkle").toBeGreaterThan(1);
  });

  it("only one live emblem: of twenty, the others yield and hold their frames", async () => {
    defineSquireEmblem();
    const grid = document.createElement("div");
    grid.style.cssText = "display:flex;flex-wrap:wrap;width:400px;position:absolute;left:0;top:0";
    document.body.append(grid);
    mounted.push(grid);
    const emblems: SquireEmblemElement[] = [];
    for (let i = 0; i < 20; i++) {
      const e = document.createElement("squire-emblem");
      e.style.cssText = "display:block;width:96px;height:96px";
      e.setAttribute("frame", EMBLEM_CHOICES.frame[i % 3]!);
      e.setAttribute("state", EMBLEM_CHOICES.state[i % 3]!);
      e.setAttribute("seed", String(100 + i));
      grid.append(e);
      emblems.push(e);
    }
    await vi.waitFor(() => {
      for (const e of emblems) expect(e.debugState.reason).not.toBe("offscreen");
    });
    const holder = emblems.at(-1)!;
    const live = emblems.filter((e) => !e.debugState.paused);
    expect(live.length).toBe(1);
    expect(live[0]).toBe(holder);
    for (const e of emblems.slice(0, -1)) expect(e.debugState.reason).toBe("yielded");
    const before = emblems.map((e) => e.debugState.frameCount);
    clock.advance(1000);
    expect(holder.debugState.frameCount - before.at(-1)!).toBeGreaterThanOrEqual(28);
    expect(emblems.slice(0, -1).map((e) => e.debugState.frameCount)).toEqual(before.slice(0, -1));
    expect(clock.pendingFrames).toBe(1);
  });

  it("no console errors, page errors or squire warnings", () => {
    expect(problems).toEqual([]);
  });
});
