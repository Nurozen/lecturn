import type { MemoryNodeType } from "@lecturn/contracts";
import {
  MAX_EDGES,
  MAX_MARKS,
  fitCamera,
  formatCount,
  hitTest,
  pickLabels,
  screenRadius,
  zoomCameraAt,
  type Camera,
  type Insets,
  type LabelCandidate,
  type MapMark,
  type MapScene,
} from "./memoryMapMarks";

/** Marmot's categorical type palette; blended toward the theme foreground. */
export const MEMORY_TYPE_COLORS: Record<MemoryNodeType, string> = {
  function: "#4C78A8",
  module: "#72B7B2",
  class: "#F58518",
  interface: "#FF9DA7",
  concept: "#E45756",
  decision: "#54A24B",
  reference: "#EECA3B",
  composite: "#B279A2",
};

/** Hollow shapes draw as outlines. */
export const HOLLOW_TYPES: ReadonlySet<MemoryNodeType> = new Set(["interface", "reference"]);

const TRANSITION_MS = 200;
const TAU = Math.PI * 2;

interface ThemeColors {
  foreground: string;
  muted: string;
  border: string;
  input: string;
  primary: string;
  background: string;
  card: string;
  types: Record<MemoryNodeType, string>;
}
interface ThemeFonts {
  display: string;
  sans: string;
  mono: string;
}

/** Readout elements the renderer writes directly, bypassing React. */
export interface MapReadout {
  readonly marks: HTMLElement | null;
  readonly edges: HTMLElement | null;
  readonly frames: HTMLElement | null;
  readonly state: HTMLElement | null;
}

interface Transition {
  readonly t0: number;
  readonly from: Camera;
  readonly to: Camera;
  /** 1 entering a deeper view, -1 leaving, 0 camera-only. */
  readonly direction: -1 | 0 | 1;
}

/**
 * Canvas 2D controller for the Memory map. Draws on demand only: input, data
 * change, or an active transition of at most 200 ms (none under reduced
 * motion). There is no idle loop; `requestDraw` coalesces into one frame.
 */
export class MemoryMapRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scene: MapScene | null = null;
  private flags: Uint8Array | null = null;
  private hover = -1;
  private camera: Camera = { x: 0, y: 0, k: 1 };
  private userMoved = false;
  private transition: Transition | null = null;
  private raf = 0;
  private frames = 0;
  private visible = 0;
  private lastState = "";
  private w = 0;
  private h = 0;
  private dpr = 1;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private colors!: ThemeColors;
  private fonts!: ThemeFonts;
  private readonly widths = new Map<string, number>();
  private readonly themeObserver: MutationObserver;
  private readonly reducedMotion: MediaQueryList;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly readout: MapReadout,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.readTheme();
    this.themeObserver = new MutationObserver(() => {
      this.readTheme();
      this.requestDraw();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.themeObserver.disconnect();
  }

  /** Swaps the scene. A view change refits the camera (with the enter/leave
      transition); a data change keeps a camera the user has moved. */
  setScene(scene: MapScene, change: { viewChanged: boolean; direction: -1 | 0 | 1 }): void {
    this.scene = scene;
    this.hover = -1;
    if (change.viewChanged || !this.userMoved) {
      const to = fitCamera(scene.marks, this.viewport(), this.insets);
      this.startTransition(to, change.viewChanged ? change.direction : 0, change.viewChanged);
      this.userMoved = false;
    }
    this.requestDraw();
  }

  setRevealFlags(flags: Uint8Array | null): void {
    this.flags = flags;
    this.requestDraw();
  }

  setInsets(insets: Insets): void {
    this.insets = insets;
    if (!this.userMoved && this.scene) {
      this.startTransition(fitCamera(this.scene.marks, this.viewport(), insets), 0, false);
      this.requestDraw();
    }
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    if (!this.userMoved && this.scene) {
      this.camera = fitCamera(this.scene.marks, this.viewport(), this.insets);
      this.transition = null;
    }
    this.requestDraw();
  }

  /** Fits the scene again, tweening from the current camera. */
  fit(): void {
    if (!this.scene) return;
    this.userMoved = false;
    this.startTransition(fitCamera(this.scene.marks, this.viewport(), this.insets), 0, false);
    this.requestDraw();
  }

  panBy(dx: number, dy: number): void {
    this.transition = null;
    this.camera = {
      ...this.camera,
      x: this.camera.x - dx / this.camera.k,
      y: this.camera.y - dy / this.camera.k,
    };
    this.userMoved = true;
    this.requestDraw();
  }

  zoomAt(px: number, py: number, deltaY: number): void {
    this.transition = null;
    this.camera = zoomCameraAt(this.camera, this.viewport(), px, py, deltaY);
    this.userMoved = true;
    this.requestDraw();
  }

  hitTest(px: number, py: number): number {
    if (!this.scene) return -1;
    return hitTest(this.scene.marks, this.camera, this.viewport(), px, py);
  }

  /** Returns true when the hovered mark changed. */
  setHover(index: number): boolean {
    if (index === this.hover) return false;
    this.hover = index;
    this.requestDraw();
    return true;
  }

  requestDraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(this.draw);
    this.writeState("drawing");
  }

  private viewport() {
    return { w: this.w, h: this.h };
  }

  private startTransition(to: Camera, direction: -1 | 0 | 1, sceneChanged: boolean): void {
    if (this.reducedMotion.matches || this.w === 0) {
      this.camera = to;
      this.transition = null;
      return;
    }
    // A new scene lives in new world coordinates: fade and scale in place.
    const from = sceneChanged ? to : this.camera;
    this.transition = { t0: performance.now(), from, to, direction };
    this.camera = from;
  }

  private readTheme(): void {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) =>
      this.normalize(style.getPropertyValue(name).trim() || fallback);
    const foreground = read("--foreground", "#302a22");
    const mix = (hex: string) => mixColors(hex, foreground, 0.12) ?? hex;
    this.colors = {
      foreground,
      muted: read("--muted-foreground", "#756650"),
      border: read("--border", "#d6c8b2"),
      input: read("--input", "#bca98a"),
      primary: read("--primary", "#805419"),
      background: read("--background", "#f4eddf"),
      card: read("--card", "#fff9ee"),
      types: Object.fromEntries(
        Object.entries(MEMORY_TYPE_COLORS).map(([type, hex]) => [type, mix(hex)]),
      ) as Record<MemoryNodeType, string>,
    };
    this.fonts = {
      display: style.getPropertyValue("--font-display").trim() || "Georgia, serif",
      sans: style.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif",
      mono: style.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
    };
    this.widths.clear();
  }

  /** Canvas-normalized color string (hex for sRGB inputs). */
  private normalize(value: string): string {
    this.ctx.fillStyle = "#000000";
    this.ctx.fillStyle = value;
    return this.ctx.fillStyle;
  }

  private writeState(state: "drawing" | "idle"): void {
    if (state === this.lastState || !this.readout.state) return;
    this.lastState = state;
    this.readout.state.dataset.state = state;
    this.readout.state.textContent = state === "idle" ? "idle, no frames until input" : "drawing";
  }

  private readonly draw = (): void => {
    this.raf = 0;
    const scene = this.scene;
    const started = performance.now();
    this.frames++;
    const { ctx, colors, fonts } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    let fade = 1;
    let scale = 1;
    const transition = this.transition;
    if (transition) {
      const p = Math.min(1, (started - transition.t0) / TRANSITION_MS);
      const e = 1 - Math.pow(1 - p, 3);
      this.camera = {
        x: transition.from.x + (transition.to.x - transition.from.x) * e,
        y: transition.from.y + (transition.to.y - transition.from.y) * e,
        k: transition.from.k + (transition.to.k - transition.from.k) * e,
      };
      if (transition.direction !== 0) {
        fade = e;
        scale = transition.direction > 0 ? 0.92 + 0.08 * e : 1.08 - 0.08 * e;
      }
      if (p >= 1) this.transition = null;
    }

    let visible = 0;
    if (scene) {
      ctx.translate(this.w / 2, this.h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-this.w / 2, -this.h / 2);
      visible = this.drawScene(scene, fade, colors, fonts);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (this.transition) this.requestDraw();
    const elapsed = performance.now() - started;
    if (this.readout.frames)
      this.readout.frames.textContent = `${this.frames} · last ${elapsed.toFixed(1)} ms`;
    if (visible !== this.visible || this.frames === 1) {
      this.visible = visible;
      if (this.readout.marks) this.readout.marks.textContent = `${visible} / ${MAX_MARKS}`;
    }
    if (this.readout.edges)
      this.readout.edges.textContent = `${scene?.edges.length ?? 0} / ${MAX_EDGES}`;
    if (!this.raf) this.writeState("idle");
  };

  private drawScene(scene: MapScene, fade: number, colors: ThemeColors, fonts: ThemeFonts) {
    const { ctx, camera } = this;
    const k = camera.k;
    const flags = this.flags;
    const hover = this.hover;
    const territories = scene.view.kind === "territories";
    const hoverSet =
      flags === null && hover >= 0 ? new Set([hover, ...(scene.adjacency[hover] ?? [])]) : null;
    const lit = (i: number) => (flags ? flags[i]! > 0 : hoverSet ? hoverSet.has(i) : true);
    const alphaOf = (i: number) => scene.marks[i]!.alpha * (lit(i) ? 1 : 0.13) * fade;
    const sx = (x: number) => (x - camera.x) * k + this.w / 2;
    const sy = (y: number) => (y - camera.y) * k + this.h / 2;

    /* edges */
    ctx.lineCap = "round";
    for (const e of scene.edges) {
      const A = scene.marks[e.a]!;
      const B = scene.marks[e.b]!;
      const on = (flags !== null || hoverSet !== null) && lit(e.a) && lit(e.b);
      const accent = territories || (flags !== null && on);
      ctx.strokeStyle = accent ? colors.primary : colors.muted;
      ctx.globalAlpha =
        Math.min(alphaOf(e.a), alphaOf(e.b)) *
        (e.faint ? 0.45 : 1) *
        (territories ? 0.5 : on ? 0.9 : 0.34);
      ctx.lineWidth = territories ? 1 + Math.min(4, e.weight / 7) : on ? 1.8 : 1;
      ctx.setLineDash(e.arc ? [5, 5] : []);
      const x1 = sx(A.x);
      const y1 = sy(A.y);
      const x2 = sx(B.x);
      const y2 = sy(B.y);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      if (e.arc) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        ctx.quadraticCurveTo(mx - (y2 - y1) * 0.22, my + (x2 - x1) * 0.22, x2, y2);
      } else ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    /* marks */
    let visible = 0;
    const labels: Array<{ i: number; x: number; y: number; r: number }> = [];
    scene.marks.forEach((m, i) => {
      const x = sx(m.x);
      const y = sy(m.y);
      const r = screenRadius(m, k);
      if (x < -r - 40 || y < -r - 40 || x > this.w + r + 40 || y > this.h + r + 40) return;
      visible++;
      const a = alphaOf(i);
      const tc = m.type ? colors.types[m.type] : colors.muted;
      ctx.globalAlpha = a;
      if (m.kind === "territory") this.drawTerritory(m, x, y, r, a, tc, i === hover, colors, fonts);
      else if (m.kind === "stub" || m.kind === "more")
        this.drawStub(m, x, y, r, tc, i === hover, colors, fonts);
      else {
        const flag = flags?.[i] ?? 0;
        if (m.hop === 0 || flag === 2) {
          ring(ctx, x, y, r + 7, colors.primary, 2);
          ctx.globalAlpha = a * 0.4;
          ring(ctx, x, y, r + 11, colors.primary, 1);
          ctx.globalAlpha = a;
        } else if (flag === 1) ring(ctx, x, y, r + 5, colors.primary, 1.3);
        if (m.landed) ring(ctx, x, y, r + 4, colors.primary, 2);
        shapePath(ctx, m.type ?? "function", x, y, r);
        if (m.type && HOLLOW_TYPES.has(m.type)) {
          ctx.fillStyle = colors.background;
          ctx.fill();
          ctx.strokeStyle = tc;
          ctx.lineWidth = Math.max(2, r * 0.42);
          ctx.stroke();
        } else {
          ctx.fillStyle = tc;
          ctx.fill();
          ctx.strokeStyle = colors.foreground;
          ctx.globalAlpha = a * 0.45;
          ctx.lineWidth = i === hover ? 2 : 0.9;
          ctx.stroke();
          ctx.globalAlpha = a;
        }
        if (m.stale) {
          ctx.setLineDash([2, 2]);
          ring(ctx, x, y, r + 3, colors.muted, 1);
          ctx.setLineDash([]);
        }
        labels.push({ i, x, y, r });
      }
    });

    this.drawLabels(scene, labels, flags, hover, alphaOf, colors, fonts);
    return visible;
  }

  private drawTerritory(
    m: MapMark,
    x: number,
    y: number,
    r: number,
    a: number,
    tc: string,
    hovered: boolean,
    colors: ThemeColors,
    fonts: ThemeFonts,
  ) {
    const { ctx } = this;
    const muted = m.muted;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = muted ? colors.card : tc;
    ctx.globalAlpha = a * (muted ? 0.75 : 0.17);
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.lineWidth = hovered ? 2.5 : 1.5;
    ctx.strokeStyle = muted ? colors.input : tc;
    ctx.setLineDash(muted ? [4, 4] : []);
    ctx.stroke();
    ctx.setLineDash([2, 4]);
    ctx.globalAlpha = a * 0.5;
    ctx.lineWidth = 1;
    ring(ctx, x, y, r * 0.66, ctx.strokeStyle, 1);
    ring(ctx, x, y, r * 0.33, ctx.strokeStyle, 1);
    ctx.setLineDash([]);
    ctx.globalAlpha = a;
    if (m.landed > 0) ring(ctx, x, y, r + 5, colors.primary, 2);
    if (m.type) {
      shapePath(ctx, m.type, x, y - 17, 5.5);
      if (HOLLOW_TYPES.has(m.type)) {
        ctx.strokeStyle = muted ? colors.muted : tc;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = muted ? colors.muted : tc;
        ctx.fill();
      }
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.max(13, Math.min(19, r * 0.3))}px ${fonts.display}`;
    halo(ctx, m.label, x, y + 2, colors);
    ctx.font = `10.5px ${fonts.mono}`;
    ctx.fillStyle = colors.muted;
    const meta = muted
      ? `${formatCount(m.count)} · never recalled`
      : `${formatCount(m.count)} nodes`;
    ctx.fillText(m.landed > 0 ? `${meta} · ${m.landed} landed` : meta, x, y + 19);
  }

  private drawStub(
    m: MapMark,
    x: number,
    y: number,
    r: number,
    tc: string,
    hovered: boolean,
    colors: ThemeColors,
    fonts: ThemeFonts,
  ) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = colors.card;
    ctx.fill();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = m.kind === "stub" ? tc : colors.muted;
    ctx.lineWidth = hovered ? 2.2 : 1.3;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (m.kind === "stub") {
      if (m.type) {
        shapePath(ctx, m.type, x, y, 5);
        ctx.fillStyle = tc;
        ctx.fill();
      }
      ctx.font = `600 12px ${fonts.display}`;
      halo(ctx, m.label, x, y + r + 11, colors);
      ctx.font = `9.5px ${fonts.mono}`;
      ctx.fillStyle = colors.muted;
      ctx.fillText("territory", x, y + r + 23);
    } else {
      ctx.font = `600 10px ${fonts.mono}`;
      ctx.fillStyle = colors.foreground;
      ctx.fillText(m.label.split(" ")[0]!, x, y);
      ctx.font = `9.5px ${fonts.mono}`;
      ctx.fillStyle = colors.muted;
      ctx.fillText(m.label.split(" ").slice(1).join(" "), x, y + r + 11);
    }
  }

  private drawLabels(
    scene: MapScene,
    placedMarks: ReadonlyArray<{ i: number; x: number; y: number; r: number }>,
    flags: Uint8Array | null,
    hover: number,
    alphaOf: (i: number) => number,
    colors: ThemeColors,
    fonts: ThemeFonts,
  ) {
    const { ctx } = this;
    const lens = scene.view.kind === "lens";
    const K = lens ? 26 : flags ? 22 : 16;
    const candidates: LabelCandidate[] = [];
    const text = new Map<number, { txt: string; font: string; lx: number; ly: number }>();
    for (const { i, x, y, r } of placedMarks) {
      if (flags && flags[i] === 0) continue;
      const m = scene.marks[i]!;
      const focus = m.hop === 0;
      const font = focus
        ? `600 14px ${fonts.display}`
        : `${i === hover ? "600 " : ""}11px ${fonts.sans}`;
      const txt = truncateLabel(m.label);
      const w = this.measure(txt, font);
      const lx = focus ? x - w / 2 : x + r + 6;
      const ly = focus ? y + r + 20 : y;
      text.set(i, { txt, font, lx, ly });
      candidates.push({
        index: i,
        x0: lx - 2,
        y0: ly - 8,
        x1: lx + w + 2,
        y1: ly + 8,
        // Reveal path first, then the lit landing, so the nodes being shown keep their names.
        priority:
          (flags ? flags[i]! * 1e4 : 0) + (m.kind === "node" && m.landed ? 1e3 : 0) + m.score,
        force: i === hover || focus,
      });
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const i of pickLabels(candidates, K)) {
      const t = text.get(i)!;
      const m = scene.marks[i]!;
      ctx.font = t.font;
      ctx.globalAlpha = Math.min(1, alphaOf(i) * (m.hop === 2 ? 1.6 : 1));
      halo(ctx, t.txt, t.lx, t.ly, colors);
    }
  }

  private measure(txt: string, font: string): number {
    const key = `${font}\u0000${txt}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(txt).width;
      if (this.widths.size > 2000) this.widths.clear();
      this.widths.set(key, w);
    }
    return w;
  }
}

function ring(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: CanvasRenderingContext2D["strokeStyle"],
  width: number,
) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function halo(ctx: CanvasRenderingContext2D, txt: string, x: number, y: number, c: ThemeColors) {
  ctx.lineWidth = 3.5;
  ctx.lineJoin = "round";
  ctx.strokeStyle = c.background;
  ctx.strokeText(txt, x, y);
  ctx.fillStyle = c.foreground;
  ctx.fillText(txt, x, y);
}

/** Keeps a " (variant)" suffix visible when shortening long labels. */
function truncateLabel(label: string): string {
  if (label.length <= 34) return label;
  const suffix = label.lastIndexOf(" (");
  return suffix > 0
    ? `${label.slice(0, Math.max(8, 31 - (label.length - suffix)))}…${label.slice(suffix)}`
    : `${label.slice(0, 32)}…`;
}

/** Type encoded by shape, matching the legend glyphs. */
export function shapePath(
  ctx: CanvasRenderingContext2D,
  type: MemoryNodeType,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  switch (type) {
    case "module": {
      const s = r * 0.9;
      ctx.roundRect(x - s, y - s, 2 * s, 2 * s, s * 0.3);
      return;
    }
    case "class":
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * r * 1.08, y + Math.sin(a) * r * 1.08);
      }
      ctx.closePath();
      return;
    case "interface":
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r * 1.15, y);
      ctx.lineTo(x, y + r * 1.15);
      ctx.lineTo(x - r * 1.15, y);
      ctx.closePath();
      return;
    case "concept":
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r * 1.12, y + r * 0.85);
      ctx.lineTo(x - r * 1.12, y + r * 0.85);
      ctx.closePath();
      return;
    case "decision":
      for (let i = 0; i < 8; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 4;
        const q = i % 2 ? r * 0.48 : r * 1.3;
        ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * q, y + Math.sin(a) * q);
      }
      ctx.closePath();
      return;
    case "composite": {
      const a = r * 0.42;
      const b = r * 1.1;
      const pts: Array<[number, number]> = [
        [-a, -b],
        [a, -b],
        [a, -a],
        [b, -a],
        [b, a],
        [a, a],
        [a, b],
        [-a, b],
        [-a, a],
        [-b, a],
        [-b, -a],
        [-a, -a],
      ];
      pts.forEach(([px, py], i) => ctx[i ? "lineTo" : "moveTo"](x + px, y + py));
      ctx.closePath();
      return;
    }
    case "reference":
      ctx.arc(x, y, r * 0.82, 0, TAU);
      return;
    default:
      ctx.arc(x, y, r, 0, TAU);
  }
}

/** Mixes two `#rrggbb` colors; null when either is not plain hex. */
function mixColors(a: string, b: string, t: number): string | null {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return null;
  const c = pa.map((v, i) => Math.round(v + (pb[i]! - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
