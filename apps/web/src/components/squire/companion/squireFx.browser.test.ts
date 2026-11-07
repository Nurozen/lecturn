import { describe, expect, it } from "vite-plus/test";

import { RIG_ART } from "./rigArt";
import { createSquireFx, SQUIRE_FX_LANDMARKS } from "./squireFx";
import type {
  CompanionPalette,
  CompanionState,
  FxConfig,
  FxContext,
  FxController,
  FxFrame,
  RigEquipment,
} from "./types";

const NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const EQUIPMENT: readonly RigEquipment[] = [
  "helmet",
  "lance",
  "astrolabe",
  "grimoire",
  "armillary",
  "none",
];
const STATES: readonly CompanionState[] = ["idle", "attentive", "thinking"];
const FORBIDDEN = '[data-fx~="beacon"],[data-fx~="ring"],[data-fx~="pulse"],[data-fx~="lift"]';

type Stage = { ctx: FxContext; fx: FxController; svg: SVGSVGElement };
const stages: Stage[] = [];

function image(
  parent: SVGGElement,
  part: { src: string; x: number; y: number; w: number; h: number },
) {
  const im = document.createElementNS(NS, "image");
  im.setAttribute("href", part.src);
  im.setAttribute("x", String(part.x));
  im.setAttribute("y", String(part.y));
  im.setAttribute("width", String(part.w));
  im.setAttribute("height", String(part.h));
  im.setAttribute("preserveAspectRatio", "none");
  parent.append(im);
  return im;
}

function mount(config: Partial<FxConfig> = {}, prefix = "t"): Stage {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1122 1402");
  svg.setAttribute("width", "561");
  svg.setAttribute("height", "701");
  const defs = document.createElementNS(NS, "defs");
  svg.append(defs);
  const layer = () => {
    const g = document.createElementNS(NS, "g");
    svg.append(g);
    return g;
  };
  const aura = layer();
  const torso = layer();
  const head = layer();
  const item = layer();
  const front = layer();
  const appearance = config.appearance ?? "female";
  const equipment = config.equipment ?? "helmet";
  const ctx: FxContext = {
    NS,
    svg,
    defs,
    uid: (name) => `${prefix}-${name}`,
    art: RIG_ART,
    layers: { aura, torso, head, item, front },
    images: {
      torso: image(torso, RIG_ART.torso),
      hood: image(head, RIG_ART.hood),
      head: image(head, RIG_ART.heads[appearance]),
      grip: image(item, RIG_ART.grips[equipment]),
    },
  };
  document.body.append(svg);
  const fx = createSquireFx(ctx);
  fx.configure({
    appearance,
    hood: "down",
    equipment,
    palette: "brass",
    motion: "subtle",
    gaze: "auto",
    state: "idle",
    transitions: "off",
    crest: "off",
    placement: "panel",
    debug: false,
    label: "",
    ...config,
  });
  const stage = { ctx, fx, svg };
  stages.push(stage);
  return stage;
}

function frame(state: CompanionState, time: number, overrides: Partial<FxFrame> = {}): FxFrame {
  return {
    time,
    dt: 1 / 30,
    live: true,
    hold: false,
    seed: 3,
    settle: 0,
    state,
    stateMix: { idle: 0, attentive: 0, thinking: 0, [state]: 1 },
    energy: state === "attentive" ? 0.85 : state === "thinking" ? 0.6 : 0.3,
    breath: Math.sin((time * TAU) / 3.6),
    gesture: null,
    eye: { x: 0.4 * Math.sin(time), y: 0 },
    lid: state === "thinking" ? 0.35 : state === "idle" ? 0.1 : 0,
    pose: { body: 0, head: 0, arm: 0, headPitch: 0, gaze: 0 },
    transition: null,
    ...overrides,
  };
}

function scaleOf(el: SVGGraphicsElement) {
  const m = el.getCTM();
  if (!m) throw new Error("element has no CTM");
  return Math.hypot(m.a, m.b);
}

function visible(el: Element, stop: Element) {
  for (let node: Element | null = el; node && node !== stop; node = node.parentElement) {
    if (node.getAttribute("display") === "none") return false;
  }
  return true;
}

function visibleCount(layer: Element) {
  return [...layer.querySelectorAll("*")].filter((el) => visible(el, layer)).length;
}

function snapshot(stage: Stage) {
  return Object.values(stage.ctx.layers).map((layer) => {
    const copy = layer.cloneNode(true) as SVGGElement;
    for (const parked of copy.querySelectorAll('[data-fx-part="parking"]')) parked.remove();
    return copy.innerHTML;
  });
}

function stopColors(stage: Stage) {
  return [...stage.ctx.defs.querySelectorAll("stop")].map((stop) =>
    stop.getAttribute("stop-color"),
  );
}

// Every stage a test mounts is destroyed and removed when its `using` scope ends.
function setup(): Disposable {
  stages.length = 0;
  return {
    [Symbol.dispose]() {
      for (const stage of stages) {
        stage.fx.destroy();
        stage.svg.remove();
      }
      stages.length = 0;
    },
  };
}

describe("squireFx", () => {
  it("holds the attentive halo and aura steady while time and breath vary", () => {
    using _stages = setup();
    for (const equipment of EQUIPMENT) {
      const stage = mount({ equipment });
      const halo = stage.svg.querySelector<SVGGraphicsElement>('[data-fx="halo"]');
      const aura = stage.svg.querySelector<SVGGraphicsElement>('[data-fx="aura"]');
      if (!halo || !aura) throw new Error("halo and aura must be tagged");
      const samples = [];
      for (let i = 0; i <= 300; i++) {
        stage.fx.update(frame("attentive", 4 + i / 30));
        samples.push({
          halo: Number(getComputedStyle(halo).opacity),
          haloScale: scaleOf(halo),
          aura: Number(getComputedStyle(aura).opacity),
          auraScale: scaleOf(aura),
        });
      }
      const [first] = samples;
      expect(first?.halo).toBeGreaterThan(0.3);
      for (const sample of samples) {
        expect(Math.abs(sample.halo - (first?.halo ?? 0))).toBeLessThan(1e-3);
        expect(Math.abs(sample.haloScale - (first?.haloScale ?? 0))).toBeLessThan(1e-3);
        expect(Math.abs(sample.aura - (first?.aura ?? 0))).toBeLessThan(1e-3);
        expect(Math.abs(sample.auraScale - (first?.auraScale ?? 0))).toBeLessThan(1e-3);
      }
    }
  });

  it("fades the halo in with the attentive blend instead of switching it on", () => {
    using _stages = setup();
    const stage = mount();
    const halo = stage.svg.querySelector<SVGGraphicsElement>('[data-fx="halo"]');
    if (!halo) throw new Error("halo must be tagged");
    const levels = [0, 0.25, 0.5, 0.75, 1].map((attentive) => {
      stage.fx.update(
        frame("attentive", 5, { stateMix: { idle: 1 - attentive, attentive, thinking: 0 } }),
      );
      return Number(getComputedStyle(halo).opacity);
    });
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1] ?? 0);
  });

  it("adds no item signals in attentive: no beacon ring, no lift sparkles, no tagged cue nodes", () => {
    using _stages = setup();
    for (const equipment of EQUIPMENT) {
      const idle = mount({ equipment }, "idle");
      const attentive = mount({ equipment }, "att");
      for (let i = 0; i <= 150; i++) {
        const t = 2 + i / 15;
        idle.fx.update(frame("idle", t, { energy: 0.85, breath: 0, lid: 0 }));
        attentive.fx.update(frame("attentive", t, { breath: 0 }));
        const layer = attentive.ctx.layers.item;
        expect(visibleCount(layer)).toBe(visibleCount(idle.ctx.layers.item));
        const rings = [...layer.querySelectorAll('circle[fill="none"]')].filter((el) =>
          visible(el, layer),
        );
        expect(rings).toHaveLength(0);
      }
      for (const state of STATES) {
        for (let i = 0; i < 60; i++) attentive.fx.update(frame(state, 10 + i / 10));
        expect(attentive.svg.querySelectorAll(FORBIDDEN)).toHaveLength(0);
      }
    }
  });

  it("keeps idle and thinking ambient effects moving", () => {
    using _stages = setup();
    for (const [state, equipment] of [
      ["idle", "helmet"],
      ["idle", "none"],
      ["thinking", "astrolabe"],
      ["thinking", "lance"],
    ] as const) {
      const stage = mount({ equipment });
      const seen = new Set<string>();
      for (let i = 0; i <= 300; i++) {
        stage.fx.update(frame(state, 1 + i / 30));
        seen.add(stage.ctx.layers.torso.innerHTML + stage.ctx.layers.item.innerHTML);
      }
      expect(seen.size).toBeGreaterThan(30);
    }
    const idle = mount({ equipment: "grimoire" }, "idle");
    const thinking = mount({ equipment: "grimoire" }, "think");
    idle.fx.update(frame("idle", 6));
    thinking.fx.update(frame("thinking", 6));
    expect(visibleCount(thinking.ctx.layers.item)).toBeGreaterThan(
      visibleCount(idle.ctx.layers.item),
    );
  });

  it("rests ambient effects on rest frames and once settled", () => {
    using _stages = setup();
    const stage = mount({ equipment: "none" });
    const restFrames = new Set<string>();
    for (let i = 0; i < 30; i++) {
      stage.fx.update(frame("idle", 3 + i * 0.37, { live: false, settle: 1, eye: { x: 0, y: 0 } }));
      restFrames.add(snapshot(stage).join("|"));
    }
    expect(restFrames.size).toBe(1);
    const settled = new Set<string>();
    for (let i = 0; i < 30; i++) {
      stage.fx.update(frame("idle", 20 + i * 0.37, { settle: 1, breath: 0 }));
      settled.add(stage.ctx.layers.item.innerHTML + stage.ctx.layers.torso.innerHTML);
    }
    expect(settled.size).toBe(1);
  });

  it("draws the crest on the torso only while crest is on", () => {
    using _stages = setup();
    const config = { equipment: "lance", crest: "on", palette: "gold" } as const;
    const stage = mount(config);
    const crests = () => stage.svg.querySelectorAll('[data-fx="crest"]');
    expect(crests()).toHaveLength(1);
    expect(stage.ctx.layers.torso.contains(crests()[0] ?? null)).toBe(true);
    stage.fx.update(frame("idle", 2));
    stage.fx.configure({ ...baseConfig(), ...config, crest: "off" });
    expect(crests()).toHaveLength(0);
    stage.fx.configure({ ...baseConfig(), ...config });
    stage.fx.configure({ ...baseConfig(), ...config });
    expect(crests()).toHaveLength(1);
    stage.fx.update(frame("idle", 3, { live: false, hold: true }));
    expect(crests()).toHaveLength(1);
    expect(mount({ crest: "off" }, "plain").svg.querySelector('[data-fx="crest"]')).toBeNull();
  });

  it("draws the Lead crest as a star over a thread, centred on the cloak drape", () => {
    using _stages = setup();
    const stage = mount({ equipment: "helmet", crest: "on", palette: "gold" });
    const crest = stage.svg.querySelector('[data-fx="crest"]')!;
    const svgBox = stage.svg.getBoundingClientRect();
    const toStage = 1122 / svgBox.width;
    const boxes = [...crest.querySelectorAll("path")].map((path) => {
      const r = path.getBoundingClientRect();
      return {
        left: (r.left - svgBox.left) * toStage,
        right: (r.right - svgBox.left) * toStage,
        top: (r.top - svgBox.top) * toStage,
        bottom: (r.bottom - svgBox.top) * toStage,
      };
    });
    expect(boxes).toHaveLength(2);
    const [star, thread] = boxes as [(typeof boxes)[0], (typeof boxes)[0]];
    // Star sits clear above the thread, so the two shapes stay apart at badge size.
    expect(thread.top - star.bottom).toBeGreaterThan(2);
    const left = Math.min(star.left, thread.left);
    const right = Math.max(star.right, thread.right);
    const top = star.top;
    const bottom = thread.bottom;
    expect(Math.abs((left + right) / 2 - 528)).toBeLessThan(3);
    expect(Math.abs((top + bottom) / 2 - 600)).toBeLessThan(6);
    // Inside its 116-unit square, and large enough to read at panel size.
    expect(left).toBeGreaterThanOrEqual(528 - 58);
    expect(right).toBeLessThanOrEqual(528 + 58);
    expect(top).toBeGreaterThanOrEqual(600 - 58);
    expect(bottom).toBeLessThanOrEqual(600 + 58);
    expect(bottom - top).toBeGreaterThan(90);
  });

  it("never twinkles a cloak star from under the crest", () => {
    using _stages = setup();
    const [cx, cy, size] = SQUIRE_FX_LANDMARKS.cloak.crest;
    const underCrest = SQUIRE_FX_LANDMARKS.cloak.stars
      .filter(([x, y, r]) => Math.abs(x - cx) < size / 2 + r && Math.abs(y - cy) < size / 2 + r)
      .map(([x, y]) => `translate(${x} ${y})`);
    expect(underCrest.length).toBeGreaterThan(0);
    const twinkledUnderCrest = (crest: "on" | "off") => {
      const stage = mount({ equipment: "none", crest }, `tw-${crest}`);
      let hits = 0;
      for (let i = 0; i <= 3000; i++) {
        stage.fx.update(frame("idle", 1 + i / 10));
        for (const g of stage.ctx.layers.torso.querySelectorAll('[data-fx-part="torso"] > g')) {
          const shown = g.getAttribute("display") !== "none";
          if (shown && underCrest.includes(g.getAttribute("transform") ?? "")) hits++;
        }
      }
      return hits;
    };
    expect(twinkledUnderCrest("off")).toBeGreaterThan(0);
    expect(twinkledUnderCrest("on")).toBe(0);
  });

  it("gives gold its own FX colors, distinct from brass and every other palette", () => {
    using _stages = setup();
    const palettes: readonly CompanionPalette[] = ["brass", "moonstone", "sage", "rose", "gold"];
    const colors = palettes.map((palette) => {
      const stage = mount({ palette }, "p");
      stage.fx.update(frame("attentive", 2, { live: false, hold: true }));
      const result = stopColors(stage);
      stage.fx.destroy();
      stage.svg.remove();
      stages.splice(stages.indexOf(stage), 1);
      return result;
    });
    const gold = colors[4];
    for (const other of colors.slice(0, 4)) expect(gold).not.toEqual(other);
  });

  it("renders hold frames identically for equal inputs and seed", () => {
    using _stages = setup();
    const inputs = frame("thinking", 7.3, { live: false, hold: true, seed: 5, breath: 0.2 });
    const first = mount({ equipment: "lance" }, "hold");
    first.fx.update(inputs);
    const held = snapshot(first);
    for (let i = 0; i < 90; i++)
      first.fx.update(frame(STATES[i % 3] ?? "idle", 1 + i / 30, { seed: 5 }));
    first.fx.trigger({ name: "flourish", detail: { duration: 1.2 } });
    first.fx.update(frame("idle", 5, { seed: 5 }));
    first.fx.update(inputs);
    expect(snapshot(first)).toEqual(held);
    first.fx.destroy();
    first.svg.remove();
    stages.splice(stages.indexOf(first), 1);

    const fresh = mount({ equipment: "lance" }, "hold");
    fresh.fx.update(inputs);
    expect(snapshot(fresh)).toEqual(held);
  });

  it("glints the helmet star at the peak of greet, ponder, and listen, and not at the ends", () => {
    using _stages = setup();
    const stage = mount({ equipment: "helmet" });
    const star = stage.svg.querySelector('[data-fx="star-glint"]');
    if (!star) throw new Error("helmet star glint must be tagged");
    let quiet = 1;
    while (quiet < 30) {
      stage.fx.update(frame("idle", quiet));
      if (!shown(star, stage.svg)) break;
      quiet += 0.1;
    }
    expect(shown(star, stage.svg)).toBe(false);
    for (const name of ["greet", "ponder", "listen"] as const) {
      stage.fx.update(frame("idle", quiet, { gesture: { name, progress: 0.5 } }));
      expect(shown(star, stage.svg)).toBe(true);
      expect(Number(star.getAttribute("opacity"))).toBeGreaterThan(0.8);
      stage.fx.update(frame("idle", quiet, { gesture: { name, progress: 1 } }));
      expect(shown(star, stage.svg)).toBe(false);
    }
  });

  it("gives each gesture its own steady peak motif, alone, and gone at the end", () => {
    using _stages = setup();
    const motifs = {
      nod: ["nod-glint", "nod-chevron"],
      greet: ["greet-arc"],
      listen: ["listen-arcs"],
      ponder: ["gather", "ponder-muse"],
      glance: ["glance-glint", "glance-flick", "glance-landing"],
      flourish: ["flourish-trail", "flourish-burst"],
    } as const;
    const peaks = {
      nod: 0.47,
      greet: 0.5,
      listen: 0.5,
      ponder: 0.5,
      glance: 0.5,
      flourish: 0.5,
    } as const;
    const all = Object.values(motifs).flat();
    for (const appearance of ["female", "male"] as const) {
      for (const equipment of EQUIPMENT) {
        const stage = mount({ equipment, appearance });
        const node = (tag: string) => {
          const found = stage.svg.querySelector(`[data-fx="${tag}"]`);
          if (!found) throw new Error(`${tag} motif must be tagged`);
          return found;
        };
        const lit = () => all.filter((tag) => shown(node(tag), stage.svg));
        for (const name of Object.keys(motifs) as (keyof typeof motifs)[]) {
          const at = (progress: number, time = 1) =>
            stage.fx.update(
              frame("idle", time, { gesture: { name, progress }, eye: { x: 0.3, y: 0 } }),
            );
          at(0);
          expect(lit()).toEqual([]);
          at(peaks[name]);
          expect(lit()).toEqual([...motifs[name]]);
          for (const tag of motifs[name])
            expect(Number(node(tag).getAttribute("opacity"))).toBeGreaterThan(0.6);
          const still = motifs[name].map((tag) => node(tag).outerHTML);
          at(peaks[name], 1.4);
          expect(motifs[name].map((tag) => node(tag).outerHTML)).toEqual(still);
          at(1);
          expect(lit()).toEqual([]);
        }
      }
    }
  });

  it("closes the eyes through the nod's dip so the peak still shows a nod", () => {
    using _stages = setup();
    for (const appearance of ["female", "male"] as const) {
      const stage = mount({ appearance });
      const closedness = (progress: number) => {
        stage.fx.update(frame("idle", 1, { gesture: { name: "nod", progress } }));
        const lashes = stage.svg.querySelector('[data-fx="closed-lashes"]');
        if (!lashes) throw new Error("closed-lid lashes must be tagged");
        return shown(lashes, stage.svg) ? Number(lashes.getAttribute("opacity")) : 0;
      };
      // 1.05 s nod: the dip spans progress ~0.35-0.55, about 0.2 s held shut.
      for (const progress of [0.37, 0.45, 0.53]) expect(closedness(progress)).toBeGreaterThan(0.7);
      for (const progress of [0, 0.2, 0.7, 1]) expect(closedness(progress)).toBeLessThan(0.05);
    }
  });

  // A full eye-to-item sightline read as a laser or a stick at panel size, and crossed the
  // face. The glance now arrives at the item as a short flick ending at the landing glint.
  it("lands the glance as a short flick at the item's glint, clear of the eye", () => {
    using _stages = setup();
    for (const appearance of ["female", "male"] as const) {
      for (const equipment of EQUIPMENT) {
        const stage = mount({ appearance, equipment });
        stage.ctx.layers.head.setAttribute("transform", "rotate(6 560 440) translate(4 -9)");
        stage.fx.update(
          frame("idle", 1, { gesture: { name: "glance", progress: 0.5 }, eye: { x: 0, y: 0 } }),
        );
        expect(stage.svg.querySelector('[data-fx="glance-streak"]')).toBeNull();
        const flick = stage.svg.querySelector<SVGPathElement>('[data-fx="glance-flick"] path');
        const landing = stage.svg.querySelector<SVGGraphicsElement>('[data-fx="glance-landing"]');
        const head = stage.ctx.layers.head.getScreenCTM();
        const ctm = flick?.getScreenCTM();
        if (!flick || !landing || !head || !ctm)
          throw new Error("flick, landing, and head layer must render");
        const px = Math.hypot(head.a, head.b);
        const [x, y] = SQUIRE_FX_LANDMARKS.eyes[appearance].catch;
        const eye = new DOMPoint(x, y).matrixTransform(head);
        const total = flick.getTotalLength();
        const points = Array.from({ length: 64 }, (_, i) =>
          flick.getPointAtLength((total * i) / 63).matrixTransform(ctm),
        );
        const fromEye = (p: DOMPoint) => Math.hypot(p.x - eye.x, p.y - eye.y);
        const near = points.reduce((a, p) => (fromEye(p) < fromEye(a) ? p : a));
        const far = points.reduce((a, p) => (fromEye(p) > fromEye(a) ? p : a));
        const box = landing.getBoundingClientRect();
        const glint = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
        expect(Math.hypot(far.x - glint.x, far.y - glint.y)).toBeLessThan(40 * px);
        expect(Math.hypot(far.x - near.x, far.y - near.y)).toBeLessThan(160 * px);
        // The profile ends about 70 units ahead of the eye, so the flick starts past the face.
        expect(fromEye(near)).toBeGreaterThan(100 * px);
      }
    }
  });

  it("keeps the attentive halo warm on every appearance, hood, and palette", () => {
    using _stages = setup();
    const palettes: readonly CompanionPalette[] = ["brass", "moonstone", "sage", "rose", "gold"];
    for (const appearance of ["female", "male"] as const) {
      for (const hood of ["down", "up"] as const) {
        for (const palette of palettes) {
          const stage = mount({ appearance, hood, palette }, `${appearance}-${hood}-${palette}`);
          stage.fx.update(frame("attentive", 3, { live: false, hold: true }));
          const halo = stage.svg.querySelector('[data-fx="halo"]');
          const id = /url\(#(.+)\)/.exec(halo?.getAttribute("fill") ?? "")?.[1] ?? "";
          const stops = [
            ...(stage.svg.querySelector(`[id="${id}"]`)?.querySelectorAll("stop") ?? []),
          ];
          expect(stops.length).toBeGreaterThan(0);
          for (const stop of stops) {
            const [hue, saturation] = hueOf(stop.getAttribute("stop-color") ?? "");
            expect(saturation).toBeGreaterThan(0.25);
            expect(hue).toBeGreaterThanOrEqual(15);
            expect(hue).toBeLessThanOrEqual(55);
          }
        }
      }
    }
  });

  it("holds a steady thought-light in thinking that fades in with the thinking blend", () => {
    using _stages = setup();
    for (const equipment of EQUIPMENT) {
      const stage = mount({ equipment });
      const thought = stage.svg.querySelector('[data-fx="thought"]');
      if (!thought) throw new Error("thought light must be tagged");
      stage.fx.update(frame("idle", 2));
      expect(shown(thought, stage.svg)).toBe(false);
      const states = new Set<string>();
      for (let i = 0; i <= 150; i++) {
        stage.fx.update(frame("thinking", 2 + i / 15));
        expect(shown(thought, stage.svg)).toBe(true);
        states.add(thought.outerHTML);
      }
      expect(states.size).toBe(1);
      stage.fx.update(frame("thinking", 40, { live: false, settle: 1 }));
      const rested = stage.svg.querySelector('[data-fx="thought"]');
      expect(rested?.outerHTML).toBe([...states][0]);
      const glow = (thinking: number) => {
        stage.fx.update(
          frame("thinking", 3, { stateMix: { idle: 1 - thinking, attentive: 0, thinking } }),
        );
        return Number(
          stage.svg.querySelector('[data-fx="thought"] ellipse')?.getAttribute("opacity"),
        );
      };
      expect(glow(0.3)).toBeLessThan(glow(0.6));
      expect(glow(0.6)).toBeLessThan(glow(1));
    }
  });
});

function hueOf(color: string): [number, number] {
  const probe = document.createElement("div");
  probe.style.color = color;
  document.body.append(probe);
  const [r = 0, g = 0, b = 0] = (getComputedStyle(probe).color.match(/\d+/g) ?? []).map(
    (v) => Number(v) / 255,
  );
  probe.remove();
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return [0, 0];
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const lightness = (max + min) / 2;
  return [(hue * 60 + 360) % 360, d / (1 - Math.abs(2 * lightness - 1))];
}

function shown(el: Element, root: Element) {
  return visible(el, root);
}

function baseConfig(): FxConfig {
  return {
    appearance: "female",
    hood: "down",
    equipment: "helmet",
    palette: "brass",
    motion: "subtle",
    gaze: "auto",
    state: "idle",
    transitions: "off",
    crest: "off",
    placement: "panel",
    debug: false,
    label: "",
  };
}
