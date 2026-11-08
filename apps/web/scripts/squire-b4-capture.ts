// @effect-diagnostics nodeBuiltinImport:off - standalone dev capture script, no Effect runtime.
/**
 *   node apps/web/scripts/squire-b4-capture.ts [--only=indicators,figures,gestures,seams,attentive,settle,oracle,gold] [--headless]
 * A virtual frame clock (rAF + performance.now, frozen then stepped on demand) drives both the
 * port and the v5 baseline identically, so a peak found by sampling debugState.pose replays and
 * screenshots exactly. Writes to artifacts/squire-bar/b4/lab/.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import react from "@vitejs/plugin-react";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createServer } from "vite";

import { tailwindPlugins } from "../vite/tailwind.ts";

const webRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.resolve(webRoot, "../..");
const V5_ROOT = NodePath.resolve(repoRoot, "../artifacts/squire-concepts/v5");
// SQUIRE_B4_OUT redirects a trial run so it cannot overwrite the round being judged.
const OUT = process.env.SQUIRE_B4_OUT ?? NodePath.join(repoRoot, "artifacts/squire-bar/b4/lab");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PANEL = { width: 340, height: 500 } as const;
const DPR = 2;
const RECORD_VIEWPORT = { width: 800, height: 800 } as const;
const GESTURES = ["greet", "ponder", "listen", "nod", "flourish", "glance"] as const;
const GRIPS = ["helmet", "lance", "astrolabe", "grimoire", "armillary", "none"] as const;
const STATES = ["idle", "attentive", "thinking"] as const;
const LOOKS = [
  { appearance: "female", hood: "down" },
  { appearance: "female", hood: "up" },
  { appearance: "male", hood: "down" },
  { appearance: "male", hood: "up" },
] as const;
const STAGES = [
  "overview",
  "indicators",
  "figures",
  "gestures",
  "seams",
  "neck",
  "attentive",
  "settle",
  "oracle",
  "gold",
] as const;
type Stage = (typeof STAGES)[number];
type Gesture = (typeof GESTURES)[number];
type Grip = (typeof GRIPS)[number];

/** A companion under test; the same values drive the port stage and the v5 element. */
interface Subject {
  readonly key: string;
  readonly presence: "figure" | "emblem";
  readonly attributes: Readonly<Record<string, string>>;
}

const FIGURE_A: Subject = {
  key: "figure-a",
  presence: "figure",
  attributes: {
    appearance: "female",
    hood: "down",
    equipment: "helmet",
    palette: "brass",
    motion: "subtle",
  },
};
const FIGURE_B: Subject = {
  key: "figure-b",
  presence: "figure",
  attributes: {
    appearance: "male",
    hood: "up",
    equipment: "lance",
    palette: "moonstone",
    motion: "subtle",
  },
};
const EMBLEM: Subject = {
  key: "emblem",
  presence: "emblem",
  attributes: {
    frame: "orbit",
    weight: "regular",
    glow: "soft",
    palette: "sage",
    motion: "subtle",
  },
};
const GESTURE_SUBJECTS = [FIGURE_A, FIGURE_B, EMBLEM] as const;

/**
 * Stage-unit join points carried by the forearm bone (its local space is stage space at rest):
 * the elbow is the arm pivot (v5 validate.cjs:513-514); cuff and hand are where each grip's
 * sleeve end and hand overlap the torso art, measured on the rest renders.
 */
const ELBOW: readonly [number, number] = [400, 990];
const JOINS: Readonly<
  Record<
    Grip,
    { readonly cuff: readonly [number, number]; readonly hand: readonly [number, number] }
  >
> = {
  helmet: { cuff: [640, 1045], hand: [790, 1095] },
  lance: { cuff: [610, 1010], hand: [745, 985] },
  astrolabe: { cuff: [640, 1050], hand: [800, 1100] },
  grimoire: { cuff: [640, 1050], hand: [800, 1105] },
  armillary: { cuff: [640, 1055], hand: [810, 1110] },
  none: { cuff: [640, 1050], hand: [820, 1100] },
};

const args = new Set(process.argv.slice(2));
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const selected = new Set<Stage>(
  onlyArg
    ? onlyArg
        .slice("--only=".length)
        .split(",")
        .flatMap((name) => STAGES.filter((stage) => stage === name))
    : STAGES,
);
const headless = args.has("--headless");

function mkdir(...parts: string[]) {
  const dir = NodePath.join(OUT, ...parts);
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file: string, value: unknown) {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function log(message: string) {
  console.log(`[squire-b4] ${message}`);
}

// Seeded so a rerun keeps the same blind names unless the seed changes.
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap] as T, out[index] as T];
  }
  return out;
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startLabServer() {
  const port = await freePort();
  const server = await createServer({
    configFile: false,
    root: webRoot,
    // Its own cache, so the app's dependency cache under node_modules/.vite is never rewritten.
    cacheDir: NodePath.join(repoRoot, "artifacts/squire-bar/.vite-lab-cache"),
    logLevel: "warn",
    plugins: [react(), ...tailwindPlugins(false)],
    resolve: { alias: { "~": NodePath.join(webRoot, "src") } },
    optimizeDeps: { entries: ["scripts/squire-lab/index.html"] },
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false, watch: null },
  });
  await server.listen();
  return {
    base: `http://127.0.0.1:${port}/scripts/squire-lab/index.html`,
    close: () => server.close(),
  };
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

async function startV5Server() {
  const server = NodeHttp.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
    const file = NodePath.join(V5_ROOT, pathname);
    if (!file.startsWith(V5_ROOT) || request.method !== "GET") {
      response.writeHead(403).end();
      return;
    }
    NodeFS.readFile(file, (error, data) => {
      if (error) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, {
          "content-type": MIME[NodePath.extname(file)] ?? "application/octet-stream",
        })
        .end(data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Injected into every capture page before its scripts run. Must stay self-contained. */
function installLabRuntime() {
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const nativeNow = performance.now.bind(performance);
  let frozen = false;
  let virtualNow = 0;
  let nextId = 1;
  const pending = new Map<number, { callback: FrameRequestCallback; native: number }>();
  window.requestAnimationFrame = (callback) => {
    const id = nextId++;
    const entry = { callback, native: 0 };
    pending.set(id, entry);
    if (!frozen) {
      entry.native = nativeRequest((timestamp) => {
        // A frozen clock keeps the callback for `advance`.
        if (frozen || pending.get(id) !== entry) return;
        pending.delete(id);
        callback(timestamp);
      });
    }
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.native) nativeCancel(entry.native);
  };
  performance.now = () => (frozen ? virtualNow : nativeNow());

  type Pose = Record<string, unknown>;
  type Companion = HTMLElement & {
    debugState: {
      paused: boolean;
      reason: string | null;
      frameCount: number;
      fps: number;
      time: number;
      transition: string | null;
      activeGesture: string | null;
      stateMix?: Record<string, number>;
      pose: Pose | null;
    };
    setPose(input: { time?: number; gaze?: number; state?: string }): void;
    resume(): void;
    play(name: string): Promise<{ played: boolean; interrupted?: boolean }>;
  };

  const microtasks = async () => {
    for (let index = 0; index < 4; index++) await Promise.resolve();
  };
  const num = (value: unknown) => (typeof value === "number" ? value : 0);
  const rigDelta = (a: Pose, b: Pose) =>
    Math.max(
      ...["body", "head", "arm", "headPitch"].map((channel) =>
        Math.abs(num(a[channel]) - num(b[channel])),
      ),
      3 * Math.abs(num(a.gaze) - num(b.gaze)),
    );
  type EmblemPose = {
    star: { x: number; y: number; rot: number; scale: number };
    gain: number;
    nodes: number[][][];
  };
  const emblemDelta = (a: Pose, b: Pose) => {
    const p = a as unknown as EmblemPose;
    const q = b as unknown as EmblemPose;
    let delta = Math.max(
      Math.abs(p.star.x - q.star.x),
      Math.abs(p.star.y - q.star.y),
      Math.abs(p.star.rot - q.star.rot) / 5,
      Math.abs(p.star.scale - q.star.scale) * 20,
      Math.abs(p.gain - q.gain) * 5,
    );
    p.nodes.forEach((thread, i) =>
      thread.forEach((point, j) => {
        const other = q.nodes[i]?.[j];
        if (other)
          delta = Math.max(
            delta,
            Math.hypot(num(point[0]) - num(other[0]), num(point[1]) - num(other[1])),
          );
      }),
    );
    return delta;
  };

  const element = () => document.querySelector<Companion>("squire-rig, squire-emblem");
  const need = () => {
    const found = element();
    if (!found) throw new Error("no companion element on the page");
    return found;
  };
  const delta = (a: Pose | null, b: Pose | null) => {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    return need().localName === "squire-emblem" ? emblemDelta(a, b) : rigDelta(a, b);
  };
  const snapshot = (pose: Pose | null): Pose | null =>
    pose ? (JSON.parse(JSON.stringify(pose)) as Pose) : null;

  let replay: { index: number } | null = null;
  const step = async () => {
    lab.advance(FRAME);
    await microtasks();
  };
  const FRAME = 1000 / 60;
  const prime = async (time: number) => {
    const companion = need();
    lab.freeze();
    companion.setPose({ time });
    companion.resume();
    await microtasks();
    for (let index = 0; index < 12; index++) await step();
  };

  const lab = {
    freeze() {
      if (frozen) return;
      virtualNow = nativeNow();
      frozen = true;
    },
    advance(ms: number) {
      const end = virtualNow + ms;
      while (virtualNow + FRAME <= end + 1e-9) {
        virtualNow += FRAME;
        const batch = [...pending.values()];
        pending.clear();
        for (const entry of batch) {
          if (entry.native) nativeCancel(entry.native);
          entry.callback(virtualNow);
        }
      }
      virtualNow = end;
    },
    element,
    debug() {
      const found = element();
      return found ? { ...found.debugState, pose: snapshot(found.debugState.pose) } : null;
    },
    /** Waits until the element exists, its entrance is over, and every shown image has a source. */
    ready() {
      const found = element();
      if (!found || !found.debugState) return false;
      if (found.debugState.transition) return false;
      return lab.artReady(found);
    },
    /** Every image a companion actually shows has a source (display none does not inherit). */
    artReady(host: Element) {
      const shown = (node: Element) => {
        for (
          let current: Element | null = node;
          current && current !== host;
          current = current.parentElement
        ) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden") return false;
        }
        return true;
      };
      return [...(host.shadowRoot?.querySelectorAll("image") ?? [])].every(
        (image) => !shown(image) || !!image.getAttribute("href"),
      );
    },
    /** Plays `name` on a frozen clock from rig time `time`, sampling the pose every display frame. */
    async analyze(name: string, time: number, maxFrames: number) {
      const companion = need();
      await prime(time);
      let result: { played: boolean } | null = null;
      void companion.play(name).then((value) => {
        result = value;
      });
      const samples: Array<{ time: number; pose: Pose | null; active: string | null }> = [];
      let doneAt = -1;
      for (let index = 0; index < maxFrames; index++) {
        await step();
        const debug = companion.debugState;
        samples.push({ time: debug.time, pose: snapshot(debug.pose), active: debug.activeGesture });
        if (result && doneAt < 0) doneAt = index;
        if (doneAt >= 0 && index >= doneAt + 12) break;
      }
      // Rest is the same rig time held without the gesture (v5 validate.cjs gestureRun).
      const armDeviations: number[] = [];
      const headDeviations: number[] = [];
      const deviations = samples.map((sample) => {
        companion.setPose({ time: sample.time });
        const hold = companion.debugState.pose;
        armDeviations.push(
          sample.pose && hold ? Math.abs(num(sample.pose.arm) - num(hold.arm)) : 0,
        );
        headDeviations.push(
          sample.pose && hold
            ? Math.max(
                Math.abs(num(sample.pose.head) - num(hold.head)),
                Math.abs(num(sample.pose.headPitch) - num(hold.headPitch)),
              )
            : 0,
        );
        return delta(sample.pose, hold);
      });
      const argmax = (values: readonly number[]) =>
        values.reduce((best, value, index) => (value > (values[best] ?? 0) ? index : best), 0);
      const peak = argmax(deviations);
      // Seam crops want the frame that bends the forearm most, which is not always the pose peak.
      const armPeak = argmax(armDeviations);
      const headPeak = argmax(headDeviations);
      const played = (result as { played: boolean } | null)?.played ?? false;
      return {
        played,
        doneAt,
        frames: samples.length,
        peak,
        peakDeviation: deviations[peak] ?? 0,
        armPeak,
        armPeakDeviation: armDeviations[armPeak] ?? 0,
        headPeak,
        headPeakDeviation: headDeviations[headPeak] ?? 0,
        end: samples.length - 1,
        activeSeen: samples.some((sample) => sample.active === name),
        deviations: deviations.map((value) => Math.round(value * 1000) / 1000),
        peakPose: samples[peak]?.pose ?? null,
        armPeakPose: samples[armPeak]?.pose ?? null,
        headPeakPose: samples[headPeak]?.pose ?? null,
      };
    },
    async replayStart(name: string, time: number) {
      const companion = need();
      await prime(time);
      void companion.play(name);
      replay = { index: -1 };
    },
    async replayTo(index: number) {
      if (!replay) throw new Error("replayStart first");
      while (replay.index < index) {
        await step();
        replay.index++;
      }
      return snapshot(need().debugState.pose);
    },
    poseDelta: delta,
    /** Screen points (CSS px, viewport) of stage-unit points carried by a bone (arm, head, body). */
    bonePoints(
      host: Element | null,
      bone: string,
      points: ReadonlyArray<readonly [number, number]>,
    ) {
      const rig = (host ?? document).querySelector("squire-rig");
      const node = rig?.shadowRoot?.querySelector<SVGGElement>(`[data-bone="${bone}"]`);
      const matrix = node?.getScreenCTM();
      if (!matrix) return null;
      return points.map(([x, y]) => [
        matrix.a * x + matrix.c * y + matrix.e,
        matrix.b * x + matrix.d * y + matrix.f,
      ]);
    },
  };
  // Page callbacks are serialized, so they reach the runtime through these globals.
  Object.assign(window, { __lab: lab, labOf: () => lab });
  return lab;
}

type LabRuntime = ReturnType<typeof installLabRuntime>;
const labOf = () => (window as unknown as { __lab: LabRuntime }).__lab;

interface Session {
  readonly browser: Browser;
  readonly labBase: string;
  readonly v5Base: string;
  composer: Page | null;
}

async function newContext(
  session: Session,
  options: { video?: string; viewport?: { width: number; height: number } } = {},
) {
  // Chrome's screencast mis-scales windows narrower than its minimum window width and at DPR 2,
  // so recordings use a larger DPR 1 viewport and cutClip crops the panel from its top-left.
  const viewport = options.viewport ?? (options.video ? RECORD_VIEWPORT : PANEL);
  const context = await session.browser.newContext({
    viewport,
    deviceScaleFactor: options.video ? 1 : DPR,
    reducedMotion: "no-preference",
    ...(options.video ? { recordVideo: { dir: options.video, size: viewport } } : {}),
  });
  await context.addInitScript(installLabRuntime);
  return context;
}

function stageUrl(
  session: Session,
  subject: Subject,
  state: string,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    view: "stage",
    presence: subject.presence,
    state,
    ...subject.attributes,
    ...extra,
  });
  return `${session.labBase}?${params}`;
}

async function waitReady(page: Page, extraMs = 600) {
  try {
    await page.waitForFunction(() => labOf().ready(), null, { timeout: 30_000, polling: 100 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const element = labOf().element();
      return {
        url: location.href,
        debug: labOf().debug(),
        images: [...(element?.shadowRoot?.querySelectorAll("image") ?? [])].map((image) => ({
          art: image.getAttribute("data-art"),
          display: getComputedStyle(image).display,
          href: (image.getAttribute("href") ?? "").slice(0, 40),
        })),
      };
    });
    throw new Error(`companion never became ready: ${JSON.stringify(state)}`, { cause: error });
  }
  await page.waitForTimeout(extraMs);
}

async function openPortStage(
  session: Session,
  context: BrowserContext,
  subject: Subject,
  state: string,
  extra: Record<string, string> = {},
) {
  const page = await context.newPage();
  await page.goto(stageUrl(session, subject, state, extra));
  await waitReady(page);
  return page;
}

/** v5 has no React wrapper: load its lab for the scripts, then leave one element on a 340x500 stage. */
async function openV5Stage(
  session: Session,
  context: BrowserContext,
  subject: Subject,
  state: string,
) {
  const page = await context.newPage();
  const lab = subject.presence === "figure" ? "rig-lab.html" : "emblem-lab.html";
  const tag = subject.presence === "figure" ? "squire-rig" : "squire-emblem";
  await page.goto(`${session.v5Base}/validation/${lab}`);
  await page.waitForFunction((name) => !!customElements.get(name), tag);
  await page.evaluate(
    ({ tag, attributes, state, panel }) => {
      document.body.replaceChildren();
      document.body.style.cssText = "margin:0;background:#061522";
      const stage = document.createElement("div");
      stage.dataset.testid = "v5-stage";
      stage.style.cssText = `width:${panel.width}px;height:${panel.height}px;display:flex;align-items:center;justify-content:center;overflow:hidden`;
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      element.setAttribute("state", state);
      element.style.cssText = `display:block;width:${panel.width}px;max-width:none`;
      stage.append(element);
      document.body.append(stage);
    },
    { tag, attributes: subject.attributes, state, panel: PANEL },
  );
  await waitReady(page, 1200);
  return page;
}

async function composer(session: Session) {
  if (session.composer && !session.composer.isClosed()) return session.composer;
  const context = await session.browser.newContext({
    viewport: { width: 400, height: 300 },
    deviceScaleFactor: 1,
  });
  session.composer = await context.newPage();
  return session.composer;
}

async function closeComposer(session: Session) {
  if (!session.composer) return;
  await session.composer.context().close();
  session.composer = null;
}

interface SheetCell {
  readonly png: Buffer;
  readonly label?: string;
}

/** Lays images out in a labelled grid on a canvas; `scale` with nearest-neighbour sampling. */
async function composeSheet(
  session: Session,
  cells: readonly SheetCell[],
  options: {
    columns: number;
    scale?: number;
    title?: string;
    format?: "png" | "webp";
    quality?: number;
    smooth?: boolean;
  },
) {
  const page = await composer(session);
  const dataUrl = await page.evaluate(
    async ({ cells, options }) => {
      const images = await Promise.all(
        cells.map(
          (cell) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const image = new Image();
              image.addEventListener("load", () => resolve(image), { once: true });
              image.addEventListener("error", () => reject(new Error("image decode failed")), {
                once: true,
              });
              image.src = `data:image/png;base64,${cell.png}`;
            }),
        ),
      );
      const scale = options.scale ?? 1;
      const cellWidth = Math.max(...images.map((image) => image.width)) * scale;
      const cellHeight = Math.max(...images.map((image) => image.height)) * scale;
      const labelled = cells.some((cell) => cell.label);
      const labelHeight = labelled ? 22 : 0;
      const titleHeight = options.title ? 30 : 0;
      const gap = labelled || options.title ? 6 : 0;
      const rows = Math.ceil(cells.length / options.columns);
      const canvas = document.createElement("canvas");
      canvas.width = options.columns * (cellWidth + gap) + gap;
      canvas.height = titleHeight + rows * (cellHeight + labelHeight + gap) + gap;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      if (labelled || options.title) {
        context.fillStyle = "#0b1b29";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.imageSmoothingEnabled = options.smooth ?? false;
      context.font = "13px ui-monospace, Menlo, monospace";
      context.textBaseline = "middle";
      if (options.title) {
        context.fillStyle = "#f3dc9a";
        context.font = "bold 15px ui-monospace, Menlo, monospace";
        context.fillText(options.title, gap + 4, titleHeight / 2 + 2);
        context.font = "13px ui-monospace, Menlo, monospace";
      }
      images.forEach((image, index) => {
        const column = index % options.columns;
        const row = Math.floor(index / options.columns);
        const x = gap + column * (cellWidth + gap);
        const y = titleHeight + gap + row * (cellHeight + labelHeight + gap);
        context.drawImage(image, x, y, image.width * scale, image.height * scale);
        const label = cells[index]?.label;
        if (label) {
          context.fillStyle = "#dfc7a4";
          context.fillText(label, x + 2, y + cellHeight + labelHeight / 2, cellWidth - 4);
        }
      });
      return canvas.toDataURL(
        options.format === "webp" ? "image/webp" : "image/png",
        options.quality ?? 0.92,
      );
    },
    {
      cells: cells.map((cell) => ({ png: cell.png.toString("base64"), label: cell.label })),
      options,
    },
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

const shotStage = (page: Page, selector = '[data-testid="squire-lab-stage"]') =>
  page.locator(selector).screenshot({ animations: "allow" });

/** A square crop (CSS px) centred on a viewport point, at device resolution. */
async function cropAt(page: Page, point: readonly number[], size = 64) {
  const viewport = page.viewportSize() ?? PANEL;
  const half = size / 2;
  const x = Math.min(Math.max((point[0] ?? 0) - half, 0), viewport.width - size);
  const y = Math.min(Math.max((point[1] ?? 0) - half, 0), viewport.height - size);
  return page.screenshot({ clip: { x, y, width: size, height: size }, animations: "allow" });
}

function hasFfmpeg() {
  return NodeChildProcess.spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

/** Cuts [start, start + duration] seconds out of a Playwright recording; keeps the raw file otherwise. */
function cutClip(source: string, target: string, start: number, duration: number) {
  if (!hasFfmpeg()) {
    NodeFS.copyFileSync(source, target);
    return false;
  }
  const result = NodeChildProcess.spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      Math.max(0, start).toFixed(2),
      "-i",
      source,
      "-t",
      duration.toFixed(2),
      "-vf",
      `crop=${PANEL.width}:${PANEL.height}:0:0`,
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "30",
      target,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) NodeFS.copyFileSync(source, target);
  return result.status === 0;
}

async function saveVideo(page: Page, target: string) {
  const video = page.video();
  await page.context().close();
  if (!video) return null;
  await video.saveAs(target);
  await video.delete();
  return target;
}

/** The indicator's box plus the Lead crest, which overhangs the ring. */
async function tightBox(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`missing ${selector}`);
    const rects = [root, ...root.querySelectorAll('[data-slot="squire-crest"]')]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0);
    const left = Math.floor(Math.min(...rects.map((rect) => rect.left)));
    const top = Math.floor(Math.min(...rects.map((rect) => rect.top)));
    const right = Math.ceil(Math.max(...rects.map((rect) => rect.right)));
    const bottom = Math.ceil(Math.max(...rects.map((rect) => rect.bottom)));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, selector);
}

const INDICATOR_SUBJECTS = [
  {
    key: "portrait-female-down-brass",
    token: (state: string) => `portrait:female:down:brass:${state}:26`,
  },
  {
    key: "portrait-male-up-moonstone",
    token: (state: string) => `portrait:male:up:moonstone:${state}:26`,
  },
  { key: "lead-male-down-gold", token: (state: string) => `lead:male:down:gold:${state}:26` },
  { key: "mark-sage", token: (state: string) => `mark:-:-:sage:${state}:26` },
] as const;

async function captureIndicators(session: Session) {
  const dir = mkdir("indicators");
  const keyDir = mkdir("key");
  const combos = INDICATOR_SUBJECTS.flatMap((subject) =>
    (["idle", "working", "waiting"] as const).map((state) => ({
      subject: subject.key,
      state,
      token: subject.token(state),
    })),
  );
  const context = await newContext(session, { viewport: { width: 900, height: 200 } });
  const page = await context.newPage();
  await page.goto(
    `${session.labBase}?view=indicators&items=${combos.map((combo) => combo.token).join(",")}`,
  );
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  await page.waitForTimeout(500);
  const order = shuffled(
    combos.map((combo, index) => ({ ...combo, index })),
    0x5eed,
  );
  const key: Record<string, { subject: string; state: string }> = {};
  for (const [position, combo] of order.entries()) {
    const name = `ind-${String(position + 1).padStart(2, "0")}`;
    const box = await tightBox(
      page,
      `[data-testid="squire-lab-indicator-i${combo.index}"] [role="img"]`,
    );
    const clip = { x: box.x - 1, y: box.y - 1, width: box.width + 2, height: box.height + 2 };
    const png = await page.screenshot({ clip, animations: "allow" });
    NodeFS.writeFileSync(NodePath.join(dir, `${name}.png`), png);
    NodeFS.writeFileSync(
      NodePath.join(dir, `${name}@4x.png`),
      await composeSheet(session, [{ png }], { columns: 1, scale: 4 }),
    );
    key[name] = { subject: combo.subject, state: combo.state };
  }
  await context.close();
  writeJson(NodePath.join(keyDir, "indicators.json"), {
    note: "Key for blind classification; do not show critics.",
    seed: 0x5eed,
    key,
  });
  return { stills: order.length };
}

async function captureFigureStills(session: Session) {
  const dir = mkdir("figures");
  const combos = GESTURE_SUBJECTS.flatMap((subject) => STATES.map((state) => ({ subject, state })));
  const order = shuffled(combos, 0xf16);
  const key: Record<
    string,
    { subject: string; attributes: Record<string, string>; state: string }
  > = {};
  const context = await newContext(session);
  for (const [position, combo] of order.entries()) {
    const name = `fig-${String(position + 1).padStart(2, "0")}`;
    const page = await openPortStage(session, context, combo.subject, combo.state);
    // Past the 1.2 s state blend so the still shows the settled state, not the entrance.
    await page.waitForTimeout(2500);
    NodeFS.writeFileSync(NodePath.join(dir, `${name}.png`), await shotStage(page));
    key[name] = {
      subject: combo.subject.key,
      attributes: { ...combo.subject.attributes },
      state: combo.state,
    };
    await page.close();
  }
  await context.close();
  writeJson(NodePath.join(mkdir("key"), "figures.json"), {
    note: "Key for blind classification; do not show critics.",
    seed: 0xf16,
    key,
  });
  return { stills: order.length };
}

const GESTURE_TIME = 40;
const MAX_GESTURE_FRAMES = 240;

type Analysis = Awaited<ReturnType<LabRuntime["analyze"]>>;

/**
 * Mean absolute RGB difference (0-255) between `png` and the reference set by the last call
 * with `reference: true`. Runs on the composer page so the PNGs decode in the browser.
 */
async function pixelDifference(session: Session, png: Buffer, reference: boolean) {
  const page = await composer(session);
  return page.evaluate(
    async ({ source, reference }) => {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(new Error("image decode failed")), {
          once: true,
        });
        image.src = `data:image/png;base64,${source}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const store = window as unknown as { __diffReference?: Uint8ClampedArray };
      if (reference) store.__diffReference = pixels;
      const base = store.__diffReference;
      if (!base || base.length !== pixels.length) throw new Error("no matching reference frame");
      let total = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        total +=
          Math.abs((pixels[index] ?? 0) - (base[index] ?? 0)) +
          Math.abs((pixels[index + 1] ?? 0) - (base[index + 1] ?? 0)) +
          Math.abs((pixels[index + 2] ?? 0) - (base[index + 2] ?? 0));
      }
      return total / ((pixels.length / 4) * 3);
    },
    { source: png.toString("base64"), reference },
  );
}

type PeakBy = "arm" | "head" | { readonly pixels: () => Promise<Buffer> };

/**
 * Finds the peak on a frozen clock, then replays to start, peak, and end for screenshots.
 * `arm` and `head` pick by pose channel (seam crops); `pixels` replays every frame and picks
 * the largest visual change from the start frame, so FX bursts and emblem retraces count.
 */
async function gestureFrames(
  session: Session,
  page: Page,
  gesture: Gesture,
  shoot: (frame: "start" | "peak" | "end") => Promise<void>,
  peakBy: PeakBy,
) {
  const analysis: Analysis = await page.evaluate(
    ({ gesture, time, max }) => labOf().analyze(gesture, time, max),
    { gesture, time: GESTURE_TIME, max: MAX_GESTURE_FRAMES },
  );
  let peakIndex =
    peakBy === "arm" ? analysis.armPeak : peakBy === "head" ? analysis.headPeak : analysis.peak;
  let expected =
    peakBy === "arm"
      ? analysis.armPeakPose
      : peakBy === "head"
        ? analysis.headPeakPose
        : analysis.peakPose;
  let pixelDiffs: number[] | null = null;
  if (typeof peakBy === "object") {
    pixelDiffs = [];
    const poses: unknown[] = [];
    await page.evaluate(({ gesture, time }) => labOf().replayStart(gesture, time), {
      gesture,
      time: GESTURE_TIME,
    });
    // Only frames while the gesture runs: ambient beats after it ends must not win.
    const last = analysis.doneAt >= 0 ? analysis.doneAt : analysis.end;
    for (let index = 0; index <= last; index++) {
      poses.push(await page.evaluate((index) => labOf().replayTo(index), index));
      pixelDiffs.push(await pixelDifference(session, await peakBy.pixels(), index === 0));
    }
    peakIndex = pixelDiffs.reduce(
      (best, value, index, values) => (value > (values[best] ?? 0) ? index : best),
      0,
    );
    expected = (poses[peakIndex] ?? null) as typeof expected;
  }
  await page.evaluate(({ gesture, time }) => labOf().replayStart(gesture, time), {
    gesture,
    time: GESTURE_TIME,
  });
  await page.evaluate(() => labOf().replayTo(0));
  await shoot("start");
  const replayed = await page.evaluate((index) => labOf().replayTo(index), peakIndex);
  const replayError = await page.evaluate(([a, b]) => labOf().poseDelta(a, b), [
    replayed,
    expected,
  ] as const);
  await shoot("peak");
  await page.evaluate((index) => labOf().replayTo(index), analysis.end);
  await shoot("end");
  const {
    peakPose: _peakPose,
    armPeakPose: _armPeakPose,
    headPeakPose: _headPeakPose,
    ...rest
  } = analysis;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    ...rest,
    shotPeak: typeof peakBy === "object" ? "pixels" : peakBy,
    shotPeakIndex: peakIndex,
    pixelPeakDiff: pixelDiffs ? round(pixelDiffs[peakIndex] ?? 0) : null,
    pixelDiffs: pixelDiffs?.map(round) ?? null,
    replayError: Math.round(replayError * 1e4) / 1e4,
  };
}

/** Records every gesture in one real-time clip per subject and cuts one webm per gesture. */
async function recordGestureClips(
  session: Session,
  subject: Subject,
  source: "port" | "v5",
  dir: string,
) {
  const raw = mkdir("tmp-video");
  const context = await newContext(session, { video: raw });
  const opened = Date.now();
  const page =
    source === "port"
      ? await openPortStage(session, context, subject, "idle")
      : await openV5Stage(session, context, subject, "idle");
  const marks: Array<{ gesture: Gesture; start: number; seconds: number; played: boolean }> = [];
  for (const gesture of GESTURES) {
    const start = (Date.now() - opened) / 1000;
    const result = await page.evaluate(async (name) => {
      const element = labOf().element();
      if (!element) return { played: false, ms: 0 };
      const begin = performance.now();
      const value = await element.play(name);
      return { played: value.played, ms: performance.now() - begin };
    }, gesture);
    marks.push({ gesture, start, seconds: result.ms / 1000, played: result.played });
    await page.waitForTimeout(1200);
  }
  const rawFile = await saveVideo(page, NodePath.join(raw, `${source}-${subject.key}.webm`));
  const clips: Record<string, string> = {};
  if (rawFile) {
    for (const mark of marks) {
      const target = NodePath.join(dir, `${subject.key}-${mark.gesture}-${source}.webm`);
      cutClip(rawFile, target, mark.start - 0.5, mark.seconds + 1.2);
      clips[mark.gesture] = NodePath.relative(OUT, target);
    }
  }
  return { marks, clips };
}

async function captureGestures(session: Session) {
  const dir = mkdir("gestures");
  const results: Record<string, unknown> = {};
  for (const subject of GESTURE_SUBJECTS) {
    for (const source of ["port", "v5"] as const) {
      log(`gestures ${subject.key} ${source}: frames`);
      const context = await newContext(session);
      const page =
        source === "port"
          ? await openPortStage(session, context, subject, "idle")
          : await openV5Stage(session, context, subject, "idle");
      const selector =
        source === "port" ? '[data-testid="squire-lab-stage"]' : '[data-testid="v5-stage"]';
      for (const gesture of GESTURES) {
        const frames = await gestureFrames(
          session,
          page,
          gesture,
          async (frame) => {
            NodeFS.writeFileSync(
              NodePath.join(dir, `${subject.key}-${gesture}-${source}-${frame}.png`),
              await shotStage(page, selector),
            );
          },
          {
            pixels: () => page.locator(selector).screenshot({ animations: "allow", scale: "css" }),
          },
        );
        results[`${subject.key}/${gesture}/${source}`] = frames;
      }
      await context.close();
      log(`gestures ${subject.key} ${source}: recording`);
      results[`${subject.key}/${source}/clips`] = await recordGestureClips(
        session,
        subject,
        source,
        dir,
      );
    }
    for (const gesture of GESTURES) {
      const read = (source: string) =>
        NodeFS.readFileSync(NodePath.join(dir, `${subject.key}-${gesture}-${source}-peak.png`));
      const sheet = await composeSheet(
        session,
        [
          { png: read("port"), label: `port ${subject.key} ${gesture} peak` },
          { png: read("v5"), label: `v5 ${subject.key} ${gesture} peak` },
        ],
        {
          columns: 2,
          title: `${gesture}: port vs v5 at peak (largest pixel change from the start frame)`,
        },
      );
      NodeFS.writeFileSync(NodePath.join(dir, `${subject.key}-${gesture}-side-by-side.png`), sheet);
    }
  }
  NodeFS.rmSync(NodePath.join(OUT, "tmp-video"), { recursive: true, force: true });
  writeJson(NodePath.join(dir, "gestures.json"), results);
  const peaks = Object.fromEntries(
    Object.entries(results)
      .filter(([name]) => !name.endsWith("/clips"))
      .map(([name, value]) => {
        const frames = value as {
          played: boolean;
          peakDeviation: number;
          replayError: number;
          shotPeakIndex: number;
          pixelPeakDiff: number | null;
        };
        return [
          name,
          {
            played: frames.played,
            peakDeviation: Math.round(frames.peakDeviation * 100) / 100,
            pixelPeakFrame: frames.shotPeakIndex,
            pixelPeakDiff: frames.pixelPeakDiff,
            replayError: frames.replayError,
          },
        ];
      }),
  );
  return { peaks };
}

/** Points for the elbow, cuff, and hand of one rig on the page. */
async function joinPoints(page: Page, hostSelector: string | null, grip: Grip) {
  const join = JOINS[grip];
  return page.evaluate(
    ({ hostSelector, points }) =>
      labOf().bonePoints(hostSelector ? document.querySelector(hostSelector) : null, "arm", points),
    { hostSelector, points: [ELBOW, join.cuff, join.hand] },
  );
}

async function captureSeams(session: Session) {
  const dir = mkdir("seams");
  const rows: Array<{
    look: string;
    grip: Grip;
    state: string;
    elbow: Buffer;
    cuff: Buffer;
    hand: Buffer;
  }> = [];
  for (const look of LOOKS) {
    const lookKey = `${look.appearance}-${look.hood}`;
    const items = GRIPS.flatMap((grip) =>
      STATES.map((state) => ({
        grip,
        state,
        token: `${look.appearance}:${look.hood}:${grip}:brass:${state}:off`,
      })),
    );
    const context = await newContext(session, { viewport: { width: 2120, height: 1660 } });
    const page = await context.newPage();
    await page.goto(
      `${session.labBase}?view=stills&cols=6&items=${items.map((item) => item.token).join(",")}`,
    );
    await page.waitForFunction(
      () => {
        const rigs = [...document.querySelectorAll("squire-rig")];
        return rigs.length > 0 && rigs.every((rig) => labOf().artReady(rig));
      },
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(1500);
    const sheet = await page
      .locator('[data-testid="squire-lab-stills"]')
      .screenshot({ scale: "css" });
    NodeFS.writeFileSync(NodePath.join(dir, `rest-${lookKey}.png`), sheet);
    for (const [index, item] of items.entries()) {
      const points = await joinPoints(
        page,
        `[data-testid="squire-lab-still-s${index}"]`,
        item.grip,
      );
      if (!points) throw new Error(`no arm bone for ${lookKey}/${item.grip}`);
      const [elbow, cuff, hand] = await Promise.all(points.map((point) => cropAt(page, point)));
      if (!elbow || !cuff || !hand) throw new Error("crop failed");
      rows.push({ look: lookKey, grip: item.grip, state: item.state, elbow, cuff, hand });
    }
    await context.close();
    const lookRows = rows.filter((row) => row.look === lookKey);
    const crops = await composeSheet(
      session,
      lookRows.flatMap((row) => [
        { png: row.elbow, label: `${row.grip} ${row.state} elbow` },
        { png: row.cuff, label: `${row.grip} ${row.state} cuff` },
        { png: row.hand, label: `${row.grip} ${row.state} hand` },
      ]),
      {
        columns: 6,
        scale: 2,
        title: `${lookKey} joints at rest (64 css px crops, 2x device, 2x nearest)`,
      },
    );
    NodeFS.writeFileSync(NodePath.join(dir, `rest-joints-${lookKey}.png`), crops);
    log(`seams rest ${lookKey}`);
  }

  const peakLooks = [LOOKS[0], LOOKS[3]] as const;
  const peakGestures = ["flourish", "nod", "greet"] as const;
  const peaks: Array<{
    look: string;
    grip: Grip;
    gesture: string;
    full: Buffer;
    crops: Buffer[];
    armDegrees: number;
  }> = [];
  for (const look of peakLooks) {
    for (const grip of GRIPS) {
      const subject: Subject = {
        key: `${look.appearance}-${look.hood}-${grip}`,
        presence: "figure",
        attributes: {
          appearance: look.appearance,
          hood: look.hood,
          equipment: grip,
          palette: "brass",
          motion: "subtle",
        },
      };
      const context = await newContext(session);
      const page = await openPortStage(session, context, subject, "idle");
      for (const gesture of peakGestures) {
        const shots: Partial<Record<"start" | "peak", { full: Buffer; crops: Buffer[] }>> = {};
        const frames = await gestureFrames(
          session,
          page,
          gesture,
          async (frame) => {
            if (frame === "end") return;
            const points = await joinPoints(page, null, grip);
            if (!points) throw new Error("no arm bone");
            shots[frame] = {
              full: await shotStage(page),
              crops: await Promise.all(points.map((point) => cropAt(page, point))),
            };
          },
          "arm",
        );
        const start = shots.start;
        const peak = shots.peak;
        if (!start || !peak) throw new Error("missing seam frames");
        NodeFS.writeFileSync(NodePath.join(dir, `peak-${gesture}-${subject.key}.png`), peak.full);
        // Interleaved rest/peak per joint: elbow, cuff, hand.
        const crops = peak.crops.flatMap((crop, index) => [start.crops[index] as Buffer, crop]);
        peaks.push({
          look: `${look.appearance}-${look.hood}`,
          grip,
          gesture,
          full: peak.full,
          crops,
          armDegrees: frames.armPeakDeviation,
        });
      }
      await context.close();
      log(`seams peak ${subject.key}`);
    }
  }
  for (const gesture of peakGestures) {
    const subset = peaks.filter((peak) => peak.gesture === gesture);
    const full = await composeSheet(
      session,
      subset.map((peak) => ({
        png: peak.full,
        label: `${peak.look} ${peak.grip} forearm ${peak.armDegrees.toFixed(2)} deg`,
      })),
      {
        columns: 6,
        scale: 0.5,
        smooth: true,
        title: `${gesture} at forearm peak (max arm deviation from rest), all six grips`,
      },
    );
    NodeFS.writeFileSync(NodePath.join(dir, `peak-${gesture}-sheet.png`), full);
    const joints = ["elbow", "cuff", "hand"];
    const crops = await composeSheet(
      session,
      subset.flatMap((peak) =>
        peak.crops.map((png, index) => ({
          png,
          label: `${peak.look.replace("-", "/")} ${peak.grip} ${joints[Math.floor(index / 2)]} ${index % 2 ? "peak" : "rest"}`,
        })),
      ),
      {
        columns: 6,
        scale: 2,
        title: `${gesture}: joints at rest (gesture start) and at forearm peak`,
      },
    );
    NodeFS.writeFileSync(NodePath.join(dir, `peak-${gesture}-joints.png`), crops);
  }
  for (const file of NodeFS.readdirSync(dir).filter((name) =>
    /^peak-(flourish|nod|greet)-(female|male)-/.test(name),
  )) {
    NodeFS.renameSync(NodePath.join(dir, file), NodePath.join(mkdir("seams", "peak-frames"), file));
  }
  return {
    restCells: rows.length,
    peakFrames: peaks.length,
    forearmPeakDegrees: Object.fromEntries(
      peaks.map((peak) => [
        `${peak.gesture}/${peak.look}/${peak.grip}`,
        Math.round(peak.armDegrees * 100) / 100,
      ]),
    ),
  };
}

const FORBIDDEN_FX = '[data-fx~="beacon"],[data-fx~="ring"],[data-fx~="pulse"],[data-fx~="lift"]';

async function captureAttentive(session: Session) {
  const dir = mkdir("attentive");
  const raw = mkdir("tmp-video");
  const results: Record<string, unknown> = {};
  for (const subject of [FIGURE_A, EMBLEM]) {
    const context = await newContext(session, { video: raw });
    const opened = Date.now();
    const page = await openPortStage(session, context, subject, "attentive");
    // The halo fades in with the attentive blend; sample once it has settled.
    await page.waitForTimeout(2500);
    const start = (Date.now() - opened) / 1000;
    const samples = await page.evaluate(
      async ({ forbidden }) => {
        const element = labOf().element();
        const root = element?.shadowRoot;
        const out: Array<{
          t: number;
          opacity: number | null;
          scale: number | null;
          forbidden: number;
          reason: string | null;
          frameCount: number;
        }> = [];
        const begin = performance.now();
        for (let index = 0; index <= 100; index++) {
          const halo = root?.querySelector<SVGGraphicsElement>('[data-fx="halo"]') ?? null;
          const matrix = halo?.getCTM() ?? null;
          out.push({
            t: Math.round(performance.now() - begin),
            opacity: halo ? Number(getComputedStyle(halo).opacity) : null,
            scale: matrix ? Math.hypot(matrix.a, matrix.b) : null,
            forbidden: root?.querySelectorAll(forbidden).length ?? -1,
            reason: element?.debugState.reason ?? null,
            frameCount: element?.debugState.frameCount ?? 0,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return out;
      },
      { forbidden: FORBIDDEN_FX },
    );
    const rawFile = await saveVideo(page, NodePath.join(raw, `attentive-${subject.key}.webm`));
    if (rawFile)
      cutClip(rawFile, NodePath.join(dir, `attentive-${subject.key}-10s.webm`), start, 10.2);
    const first = samples[0];
    const spread = (pick: (sample: (typeof samples)[number]) => number | null) =>
      Math.max(
        ...samples.map((sample) =>
          Math.abs(
            (pick(sample) ?? Number.NaN) - (first ? (pick(first) ?? Number.NaN) : Number.NaN),
          ),
        ),
      );
    const opacitySpread = spread((sample) => sample.opacity);
    const scaleSpread = spread((sample) => sample.scale);
    const forbiddenNodes = Math.max(...samples.map((sample) => sample.forbidden));
    const result = {
      haloFound: samples.every((sample) => sample.opacity !== null),
      opacity: first?.opacity ?? null,
      opacitySpread,
      scaleSpread,
      forbiddenNodes,
      framesDuring: (samples.at(-1)?.frameCount ?? 0) - (first?.frameCount ?? 0),
      constant:
        samples.every((sample) => sample.opacity !== null) &&
        opacitySpread < 1e-3 &&
        scaleSpread < 1e-3,
      noCueNodes: forbiddenNodes === 0,
    };
    writeJson(NodePath.join(dir, `halo-${subject.key}.json`), { ...result, samples });
    results[subject.key] = result;
  }
  NodeFS.rmSync(raw, { recursive: true, force: true });
  return results;
}

async function captureSettle(session: Session) {
  const dir = mkdir("settle");
  const raw = mkdir("tmp-video-settle");
  const run = async (subject: Subject) => {
    const context = await newContext(session, { video: raw });
    const opened = Date.now();
    const page = await context.newPage();
    await page.goto(stageUrl(session, subject, "idle"));
    await page.waitForFunction(() => !!labOf().element()?.debugState, null, { timeout: 30_000 });
    const mounted = Date.now();
    const samples: Array<{
      s: number;
      frameCount: number;
      fps: number;
      reason: string | null;
      paused: boolean;
      visibility: string;
      focus: boolean;
    }> = [];
    for (let tick = 0; tick <= 240; tick++) {
      const wait = mounted + tick * 250 - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      const sample = await page.evaluate(() => {
        const debug = labOf().debug();
        return {
          frameCount: debug?.frameCount ?? 0,
          fps: debug?.fps ?? 0,
          reason: debug?.reason ?? null,
          paused: debug?.paused ?? true,
          visibility: document.visibilityState,
          focus: document.hasFocus(),
        };
      });
      samples.push({ s: Math.round((Date.now() - mounted) / 10) / 100, ...sample });
    }
    const settledAt = samples.find((sample) => sample.reason === "settled");
    const before = settledAt ? samples.filter((sample) => sample.s < settledAt.s) : samples;
    const wakeStart = (Date.now() - opened) / 1000;
    const wake = await page.evaluate(async () => {
      const lab = labOf();
      const element = lab.element();
      if (!element) return { played: false, moved: 0, framesDuringWake: 0, reasonBefore: null };
      const reasonBefore = element.debugState.reason;
      const framesBefore = element.debugState.frameCount;
      const first = lab.debug()?.pose ?? null;
      let moved = 0;
      let sampling = true;
      const sample = () => {
        moved = Math.max(moved, lab.poseDelta(first, lab.debug()?.pose ?? null));
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const result = await element.play("nod");
      await new Promise((resolve) => setTimeout(resolve, 300));
      sampling = false;
      return {
        played: result.played,
        moved,
        framesDuringWake: element.debugState.frameCount - framesBefore,
        reasonBefore,
      };
    });
    await page.waitForTimeout(800);
    const rawFile = await saveVideo(page, NodePath.join(raw, `settle-${subject.key}.webm`));
    if (rawFile)
      cutClip(rawFile, NodePath.join(dir, `wake-nod-${subject.key}.webm`), wakeStart - 1, 3.5);
    const result = {
      settleSeconds: settledAt?.s ?? null,
      maxFpsBeforeSettle: Math.max(...before.map((sample) => sample.fps)),
      framesBeforeSettle: settledAt?.frameCount ?? null,
      framesAfterSettle: settledAt
        ? (samples.at(-1)?.frameCount ?? 0) - settledAt.frameCount
        : null,
      pageAlwaysVisibleAndFocused: samples.every(
        (sample) => sample.visibility === "visible" && sample.focus,
      ),
      wake: { ...wake, playedAndMoved: wake.played && wake.moved > 0.3 },
    };
    writeJson(NodePath.join(dir, `settle-${subject.key}.json`), { ...result, samples });
    return result;
  };
  // Concurrent: separate pages hold separate leases, and occluded windows are not throttled.
  const [figure, emblem] = await Promise.all([run(FIGURE_A), run(EMBLEM)]);
  NodeFS.rmSync(raw, { recursive: true, force: true });
  return { figure, emblem };
}

interface OracleSubject {
  readonly id: string;
  readonly label: string;
}

/** The indicator oracle: no clipped Paint, frozen animation time, unchanged arc transform, over `seconds`. */
async function runOracle(
  session: Session,
  name: string,
  page: Page,
  subjects: readonly OracleSubject[],
  seconds: number,
  traceDir: string,
) {
  const sample = () =>
    page.evaluate(
      (ids) => {
        return ids.map((id) => {
          const host = document.querySelector(
            `[data-testid="squire-lab-indicator-${id}"] [role="img"]`,
          );
          if (!host) throw new Error(`missing indicator ${id}`);
          const rect = host.getBoundingClientRect();
          const moving = host.querySelector<Element>(
            '[data-slot="squire-arc"], [data-slot="squire-mark-trace"]',
          );
          const style = moving ? getComputedStyle(moving) : null;
          return {
            id,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            animations: host.getAnimations({ subtree: true }).map((animation) => ({
              playState: animation.playState,
              currentTime: animation.currentTime === null ? null : Number(animation.currentTime),
            })),
            transform: style?.transform ?? null,
            dashOffset: style?.strokeDashoffset ?? null,
          };
        });
      },
      subjects.map((subject) => subject.id),
    );
  const first = await sample();
  await session.browser.startTracing(page, {
    categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"],
  });
  const traceStart = Date.now();
  await page.waitForTimeout(seconds * 1000);
  const buffer = await session.browser.stopTracing();
  const traceMs = Date.now() - traceStart;
  const last = await sample();
  NodeFS.writeFileSync(NodePath.join(traceDir, `${name}.json`), buffer);
  type TraceEvent = {
    name?: string;
    ts?: number;
    args?: { data?: { clip?: number[]; frame?: string } };
  };
  const parsed = JSON.parse(buffer.toString()) as { traceEvents?: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
  const paints = events.filter((event) => event.name === "Paint");
  const clips = paints.flatMap((event) => (event.args?.data?.clip ? [event.args.data.clip] : []));
  const intersects = (
    clip: number[],
    rect: { x: number; y: number; width: number; height: number },
    scale: number,
  ) => {
    const xs = clip.filter((_, index) => index % 2 === 0);
    const ys = clip.filter((_, index) => index % 2 === 1);
    return (
      Math.min(...xs) < (rect.x + rect.width) * scale &&
      Math.max(...xs) > rect.x * scale &&
      Math.min(...ys) < (rect.y + rect.height) * scale &&
      Math.max(...ys) > rect.y * scale
    );
  };
  const results = subjects.map((subject) => {
    const before = first.find((entry) => entry.id === subject.id);
    const after = last.find((entry) => entry.id === subject.id);
    if (!before || !after) throw new Error(`missing samples for ${subject.id}`);
    // Clip quads are compared in CSS px and in device px, so either convention counts.
    const clippedPaints = clips.filter(
      (clip) => intersects(clip, before.rect, 1) || intersects(clip, before.rect, DPR),
    ).length;
    const animationsFrozen =
      before.animations.length === after.animations.length &&
      after.animations.every(
        (animation, index) =>
          (animation.playState === "paused" || animation.playState === "finished") &&
          animation.currentTime === before.animations[index]?.currentTime,
      );
    const transformUnchanged =
      before.transform === after.transform && before.dashOffset === after.dashOffset;
    return {
      id: subject.id,
      label: subject.label,
      pass: clippedPaints === 0 && animationsFrozen && transformUnchanged,
      clippedPaints,
      animationsFrozen,
      transformUnchanged,
      animations: { first: before.animations, last: after.animations },
      transform: { first: before.transform, last: after.transform },
      dashOffset: { first: before.dashOffset, last: after.dashOffset },
    };
  });
  return {
    name,
    traceMs,
    paintEvents: paints.length,
    paintsWithClip: clips.length,
    results,
    pass: results.every((result) => result.pass),
  };
}

async function captureOracle(session: Session) {
  await closeComposer(session);
  const traceDir = mkdir("oracle", "traces");
  const open = async (tokens: readonly string[], viewport = { width: 600, height: 200 }) => {
    const context = await newContext(session, { viewport });
    const page = await context.newPage();
    await page.goto(`${session.labBase}?view=indicators&items=${tokens.join(",")}`);
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    await page.waitForTimeout(1500);
    return { context, page };
  };
  const ids = (labels: readonly string[]) =>
    labels.map((label, index) => ({ id: `i${index}`, label }));
  const quietTokens = [
    "portrait:female:down:brass:idle:26",
    "portrait:female:down:brass:waiting:26",
    "lead:male:down:gold:idle:26",
    "lead:male:down:gold:waiting:26",
    "mark:-:-:sage:idle:26",
    "mark:-:-:sage:waiting:26",
  ];
  const workingTokens = ["portrait:female:down:brass:working:26", "mark:-:-:sage:working:26"];
  const workingLabels = ["portrait working", "mark working"];

  const quiet = await open(quietTokens);
  const quietRun = await runOracle(
    session,
    "quiet-idle-waiting",
    quiet.page,
    ids([
      "portrait idle",
      "portrait waiting",
      "lead idle",
      "lead waiting",
      "mark idle",
      "mark waiting",
    ]),
    10,
    traceDir,
  );
  await quiet.context.close();
  log(`oracle quiet: ${quietRun.pass ? "pass" : "FAIL"}`);

  const control = await open(workingTokens);
  await control.page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLElement | SVGElement>(
      '[data-slot="squire-arc"], [data-slot="squire-mark-trace"]',
    )) {
      node.style.setProperty("--visible-animation-state", "running");
    }
  });
  const controlFocus = await control.page.evaluate(() => ({
    focus: document.hasFocus(),
    visibility: document.visibilityState,
  }));
  const controlRun = await runOracle(
    session,
    "control-working-running",
    control.page,
    ids(workingLabels),
    10,
    traceDir,
  );
  await control.context.close();
  log(`oracle control: ${controlRun.pass ? "PASSED (control broken)" : "failed as required"}`);

  const unfocused = await open(workingTokens);
  const cdp = await unfocused.context.newCDPSession(unfocused.page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  let blurWindow: BrowserContext | null = null;
  let unfocusMethod = "cdp-focus-emulation-off";
  if (await unfocused.page.evaluate(() => document.hasFocus())) {
    blurWindow = await session.browser.newContext({ viewport: { width: 200, height: 120 } });
    const other = await blurWindow.newPage();
    await other.bringToFront();
    await unfocused.page.waitForTimeout(500);
    unfocusMethod = "cdp-focus-emulation-off+other-window";
  }
  if (await unfocused.page.evaluate(() => document.hasFocus())) {
    // Last resort when the OS keeps the window focused: the page sees an unfocused window.
    await unfocused.page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true });
      window.dispatchEvent(new Event("blur"));
    });
    await unfocused.page.waitForTimeout(100);
    unfocusMethod += "+js-hasFocus-override";
  }
  const unfocusedState = await unfocused.page.evaluate(() => ({
    focus: document.hasFocus(),
    visibility: document.visibilityState,
  }));
  const unfocusedRun = await runOracle(
    session,
    "working-unfocused",
    unfocused.page,
    ids(workingLabels),
    10,
    traceDir,
  );
  await blurWindow?.close();
  await unfocused.context.close();
  log(`oracle unfocused: ${unfocusedRun.pass ? "pass" : "FAIL"}`);

  const offscreen = await open(workingTokens.map((token) => `${token}:offscreen`));
  const offscreenRun = await runOracle(
    session,
    "working-offscreen",
    offscreen.page,
    ids(workingLabels),
    10,
    traceDir,
  );
  await offscreen.context.close();
  log(`oracle offscreen: ${offscreenRun.pass ? "pass" : "FAIL"}`);

  const reduced = await open(workingTokens);
  const reducedCdp = await reduced.context.newCDPSession(reduced.page);
  await reducedCdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await reduced.page.waitForTimeout(500);
  const reducedRun = await runOracle(
    session,
    "working-reduced-motion",
    reduced.page,
    ids(workingLabels),
    10,
    traceDir,
  );
  await reduced.context.close();
  log(`oracle reduced motion: ${reducedRun.pass ? "pass" : "FAIL"}`);

  const result = {
    quiet: quietRun,
    control: {
      ...controlRun,
      state: controlFocus,
      failedAsRequired: !controlRun.pass && controlRun.results.every((entry) => !entry.pass),
    },
    unfocused: { ...unfocusedRun, method: unfocusMethod, state: unfocusedState },
    offscreen: offscreenRun,
    reducedMotion: reducedRun,
  };
  writeJson(NodePath.join(mkdir("oracle"), "oracle.json"), result);
  const brief = (run: {
    pass: boolean;
    results: ReadonlyArray<{
      label: string;
      pass: boolean;
      clippedPaints: number;
      animationsFrozen: boolean;
      transformUnchanged: boolean;
    }>;
  }) => ({
    pass: run.pass,
    each: run.results.map((entry) => ({
      label: entry.label,
      pass: entry.pass,
      clippedPaints: entry.clippedPaints,
      animationsFrozen: entry.animationsFrozen,
      transformUnchanged: entry.transformUnchanged,
    })),
  });
  return {
    pass:
      quietRun.pass &&
      result.control.failedAsRequired &&
      unfocusedRun.pass &&
      offscreenRun.pass &&
      reducedRun.pass,
    quiet: brief(quietRun),
    control: { failedAsRequired: result.control.failedAsRequired, ...brief(controlRun) },
    unfocused: { method: unfocusMethod, state: unfocusedState, ...brief(unfocusedRun) },
    offscreen: brief(offscreenRun),
    reducedMotion: brief(reducedRun),
  };
}

/** Stage points of the neck join: head pivot, nape (chin-down rock), throat (chin-up rock). */
const NECK_POINTS: ReadonlyArray<readonly [number, number]> = [
  [560, 440],
  [455, 422],
  [625, 458],
];

/**
 * Lively `nod` in a blended-in `thinking` state, peak by max head or head-pitch deviation from
 * the held pose. Crops follow the head bone, so a collar edge sliding against the head shows as
 * a change between the rest and peak crops.
 */
async function captureNeckNodThinking(session: Session) {
  const dir = mkdir("seams", "neck-nod-thinking");
  const cells: Array<{
    key: string;
    full: Buffer;
    crops: Buffer[];
    headDegrees: number;
    headPitch: number;
    head: number;
    played: boolean;
  }> = [];
  for (const look of LOOKS) {
    for (const grip of GRIPS) {
      const key = `${look.appearance}-${look.hood}-${grip}`;
      const subject: Subject = {
        key,
        presence: "figure",
        attributes: {
          appearance: look.appearance,
          hood: look.hood,
          equipment: grip,
          palette: "brass",
          motion: "lively",
        },
      };
      const context = await newContext(session);
      const page = await openPortStage(session, context, subject, "thinking");
      // The state blend takes about 1.2 s; the frozen-clock hold then starts fully in thinking.
      await page
        .waitForFunction(() => labOf().debug()?.stateMix?.thinking === 1, null, { timeout: 10_000 })
        .catch(() => page.waitForTimeout(2000));
      const shots: Partial<Record<"start" | "peak", { full: Buffer; crops: Buffer[] }>> = {};
      const peakState: { pose: Record<string, unknown> | null } = { pose: null };
      const frames = await gestureFrames(
        session,
        page,
        "nod",
        async (frame) => {
          if (frame === "end") return;
          if (frame === "peak")
            peakState.pose = await page.evaluate(() => labOf().debug()?.pose ?? null);
          const points = await page.evaluate(
            (points) => labOf().bonePoints(null, "head", points),
            NECK_POINTS,
          );
          if (!points) throw new Error("no head bone");
          shots[frame] = {
            full: await shotStage(page),
            crops: await Promise.all(points.map((point) => cropAt(page, point))),
          };
        },
        "head",
      );
      const rest = shots.start;
      const peak = shots.peak;
      if (!rest || !peak) throw new Error(`missing neck frames for ${key}`);
      const pose = peakState.pose;
      NodeFS.writeFileSync(NodePath.join(dir, `peak-${key}.png`), peak.full);
      cells.push({
        key,
        full: peak.full,
        crops: peak.crops.flatMap((crop, index) => [rest.crops[index] as Buffer, crop]),
        headDegrees: frames.headPeakDeviation,
        head: typeof pose?.head === "number" ? pose.head : Number.NaN,
        headPitch: typeof pose?.headPitch === "number" ? pose.headPitch : Number.NaN,
        played: frames.played,
      });
      await context.close();
      log(`neck ${key}: head ${frames.headPeakDeviation.toFixed(2)} deg`);
    }
  }
  const joints = ["pivot", "nape", "throat"];
  NodeFS.writeFileSync(
    NodePath.join(dir, "neck-nod-thinking-sheet.png"),
    await composeSheet(
      session,
      cells.flatMap((cell) =>
        cell.crops.map((png, index) => ({
          png,
          label: `${cell.key} ${joints[Math.floor(index / 2)]} ${index % 2 ? `peak ${cell.headDegrees.toFixed(1)}deg` : "rest"}`,
        })),
      ),
      {
        columns: 6,
        scale: 2,
        title:
          "lively nod in thinking: neck/collar crops on the head bone, rest | peak (max head deviation)",
      },
    ),
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "neck-nod-thinking-frames.png"),
    await composeSheet(
      session,
      cells.map((cell) => ({
        png: cell.full,
        label: `${cell.key} head ${cell.headDegrees.toFixed(2)} deg`,
      })),
      {
        columns: 6,
        scale: 0.5,
        smooth: true,
        title: "lively nod in thinking at max head deviation",
      },
    ),
  );
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    cells: Object.fromEntries(
      cells.map((cell) => [
        cell.key,
        {
          played: cell.played,
          peakHeadDeviationDegrees: round(cell.headDegrees),
          head: round(cell.head),
          headPitch: round(cell.headPitch),
        },
      ]),
    ),
  };
}

/** Zeroes the color of fully transparent pixels so no stale RGB can bleed in when scaled. */
async function zeroTransparentColor(session: Session, png: Buffer) {
  const page = await composer(session);
  const dataUrl = await page.evaluate(async (source) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", () => reject(new Error("image decode failed")), {
        once: true,
      });
      image.src = `data:image/png;base64,${source}`;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      if (pixels.data[index + 3] === 0) pixels.data.fill(0, index, index + 3);
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png");
  }, png.toString("base64"));
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

function hasTool(name: string) {
  return NodeChildProcess.spawnSync(name, ["-version"], { stdio: "ignore" }).status === 0;
}

/** Counts fully transparent pixels whose decoded color is not zero (lossy chroma near edges). */
function transparentColorResidue(webp: string) {
  if (!hasTool("dwebp")) return null;
  const pam = `${webp}.pam`;
  NodeChildProcess.spawnSync("dwebp", ["-quiet", webp, "-pam", "-o", pam]);
  const bytes = NodeFS.readFileSync(pam);
  NodeFS.rmSync(pam);
  const pixels = bytes.subarray(bytes.indexOf("ENDHDR\n") + 7);
  let transparent = 0;
  let colored = 0;
  let maxChannel = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] !== 0) continue;
    transparent++;
    const channel = Math.max(pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0);
    if (channel > 0) colored++;
    maxChannel = Math.max(maxChannel, channel);
  }
  return { transparent, colored, maxChannel };
}

// 340x500 px (the panel size) keeps the painted linework under ~60 KB; a 2x still is ~190 KB.
const GOLD_SIZE = PANEL;
const GOLD_QUALITY = 85;

async function captureGold(session: Session) {
  const dir = mkdir("gold-stills");
  const scratch = mkdir("tmp-gold");
  const cwebp = hasTool("cwebp");
  const items = LOOKS.flatMap((look) =>
    GRIPS.map((grip) => ({
      ...look,
      grip,
      token: `${look.appearance}:${look.hood}:${grip}:gold:idle:on`,
    })),
  );
  const context = await newContext(session, { viewport: { width: 2120, height: 2240 } });
  const page = await context.newPage();
  await page.goto(
    `${session.labBase}?view=stills&cols=6&bg=none&items=${items.map((item) => item.token).join(",")}`,
  );
  await page.waitForFunction(
    () => {
      const rigs = [...document.querySelectorAll("squire-rig")];
      return (
        rigs.length > 0 &&
        rigs.every(
          (rig) => !!rig.shadowRoot?.querySelector('[data-fx="crest"]') && labOf().artReady(rig),
        )
      );
    },
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);
  const files: Array<{
    name: string;
    bytes: number;
    residue: ReturnType<typeof transparentColorResidue>;
  }> = [];
  const cells: SheetCell[] = [];
  for (const [index, item] of items.entries()) {
    const shot = await page
      .locator(`[data-testid="squire-lab-still-s${index}"]`)
      .screenshot({ omitBackground: true });
    const png = await zeroTransparentColor(session, shot);
    const name = `lead-${item.appearance}-${item.hood}-${item.grip}.webp`;
    const target = NodePath.join(dir, name);
    if (cwebp) {
      const source = NodePath.join(scratch, `${index}.png`);
      NodeFS.writeFileSync(source, png);
      // Lossless alpha; libwebp's rescaler premultiplies, so new transparent pixels stay zero.
      const result = NodeChildProcess.spawnSync(
        "cwebp",
        [
          "-quiet",
          "-q",
          String(GOLD_QUALITY),
          "-alpha_q",
          "100",
          "-m",
          "6",
          "-sharp_yuv",
          "-resize",
          String(GOLD_SIZE.width),
          String(GOLD_SIZE.height),
          source,
          "-o",
          target,
        ],
        { stdio: "inherit" },
      );
      if (result.status !== 0) throw new Error(`cwebp failed for ${name}`);
    } else {
      NodeFS.writeFileSync(
        target,
        await composeSheet(session, [{ png }], {
          columns: 1,
          scale: 0.5,
          smooth: true,
          format: "webp",
          quality: GOLD_QUALITY / 100,
        }),
      );
    }
    files.push({
      name,
      bytes: NodeFS.statSync(target).size,
      residue: transparentColorResidue(target),
    });
    cells.push({ png, label: name });
  }
  await context.close();
  NodeFS.rmSync(scratch, { recursive: true, force: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "contact-sheet.png"),
    await composeSheet(session, cells, {
      columns: 6,
      scale: 0.4,
      smooth: true,
      title: "24 gold Lead stills (gold, crest on, idle rest)",
    }),
  );
  const sizes = files.map((file) => file.bytes);
  const residues = files.flatMap((file) => (file.residue ? [file.residue] : []));
  return {
    stills: files.length,
    format: `webp lossy q${GOLD_QUALITY}, lossless alpha, ${GOLD_SIZE.width}x${GOLD_SIZE.height} px from a 2x capture, transparent background, RGB zeroed under alpha 0 before encoding (${cwebp ? "cwebp, no -exact" : "canvas fallback"})`,
    bytes: {
      min: Math.min(...sizes),
      max: Math.max(...sizes),
      mean: Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length),
    },
    transparentColorResidue: residues.length
      ? {
          coloredTransparentPixels: Math.max(...residues.map((residue) => residue.colored)),
          ofTransparentPixels: Math.max(...residues.map((residue) => residue.transparent)),
          maxChannel: Math.max(...residues.map((residue) => residue.maxChannel)),
        }
      : null,
  };
}

/** The interactive lab itself: a full-page still plus one gesture through its controls. */
async function captureOverview(session: Session) {
  const context = await newContext(session, { viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto(session.labBase);
  await waitReady(page, 1500);
  // Offscreen companions pause (and refuse gestures), so bring the live panel into view first.
  await page.getByTestId("squire-lab-live").scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.getByTestId("squire-lab-gesture-nod").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="squire-lab-debug"]')
        ?.textContent?.includes('"lastPlay": {'),
    null,
    { timeout: 10_000 },
  );
  await page.screenshot({ path: NodePath.join(mkdir("overview"), "lab.png"), fullPage: true });
  const readout = JSON.parse(
    (await page.getByTestId("squire-lab-debug").textContent()) ?? "{}",
  ) as Record<string, unknown>;
  await context.close();
  return { readout };
}

function writeIndex(summary: Record<string, unknown>) {
  const sections: string[] = [];
  const walk = (dir: string): string[] =>
    NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(NodePath.join(dir, entry.name)) : [NodePath.join(dir, entry.name)],
    );
  const groups = new Map<string, string[]>();
  for (const file of walk(OUT).sort()) {
    const relative = NodePath.relative(OUT, file);
    if (relative === "index.html" || relative.includes("tmp-video")) continue;
    const group = NodePath.dirname(relative);
    groups.set(group, [...(groups.get(group) ?? []), relative]);
  }
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  for (const [group, files] of groups) {
    const items = files.map((file) => {
      const link = encodeURI(file);
      if (/\.(png|webp)$/.test(file) && !file.endsWith("@4x.png"))
        return `<figure><a href="${link}"><img loading="lazy" src="${link}"></a><figcaption>${escape(NodePath.basename(file))}</figcaption></figure>`;
      if (file.endsWith(".webm"))
        return `<figure><video controls muted preload="none" src="${link}"></video><figcaption>${escape(NodePath.basename(file))}</figcaption></figure>`;
      return `<figure class="file"><a href="${link}">${escape(NodePath.basename(file))}</a></figure>`;
    });
    const warning =
      group === "key" ? "<p><b>Answer keys. Do not show these to blind critics.</b></p>" : "";
    sections.push(
      `<section><h2>${escape(group)}</h2>${warning}<div class="grid">${items.join("")}</div></section>`,
    );
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Squire B4 lab capture (CP3)</title>
<style>body{background:#061522;color:#dfc7a4;font:14px ui-monospace,Menlo,monospace;margin:20px}h2{color:#f3dc9a}
.grid{display:flex;flex-wrap:wrap;gap:10px}figure{margin:0;width:220px}figure img,figure video{max-width:220px;max-height:260px;background:#0b1b29}
figure.file{width:auto}a{color:#93bdf0}pre{background:#0b1b29;padding:10px;overflow:auto;max-height:400px}</style>
<h1>Squire B4 lab capture (CP3)</h1><p>Generated ${new Date().toISOString()}. Machine checks:</p>
<pre>${escape(JSON.stringify(summary, null, 2))}</pre>${sections.join("\n")}`;
  NodeFS.writeFileSync(NodePath.join(OUT, "index.html"), html);
}

async function main() {
  if (!NodeFS.existsSync(V5_ROOT)) throw new Error(`v5 baseline not found at ${V5_ROOT}`);
  NodeFS.mkdirSync(OUT, { recursive: true });
  const lab = await startLabServer();
  const v5 = await startV5Server();
  log(`lab ${lab.base}; v5 ${v5.base}`);
  const browser = await chromium.launch({
    headless,
    ...(NodeFS.existsSync(CHROME) ? { executablePath: CHROME } : {}),
    args: [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--force-color-profile=srgb",
    ],
  });
  const session: Session = { browser, labBase: lab.base, v5Base: v5.base, composer: null };
  const summaryFile = NodePath.join(OUT, "summary.json");
  const previous = NodeFS.existsSync(summaryFile)
    ? (JSON.parse(NodeFS.readFileSync(summaryFile, "utf8")) as Record<string, unknown>)
    : {};
  const summary: Record<string, unknown> = { ...previous };
  try {
    // Warm Vite's dependency optimizer so no capture page reloads mid-run.
    const warm = await newContext(session);
    const warmPage = await warm.newPage();
    await warmPage.goto(`${lab.base}?view=stage`);
    await warmPage.waitForTimeout(4000);
    await warm.close();
    const run = async <T>(
      stage: Stage,
      task: () => Promise<T>,
      store = (value: T) => void (summary[stage] = value),
    ) => {
      if (!selected.has(stage)) return;
      const begin = Date.now();
      log(`${stage}: start`);
      store(await task());
      log(`${stage}: done in ${Math.round((Date.now() - begin) / 1000)} s`);
      writeJson(summaryFile, { ...summary, generatedAt: new Date().toISOString() });
    };
    await run("overview", () => captureOverview(session));
    await run("oracle", () => captureOracle(session));
    await run("indicators", () => captureIndicators(session));
    await run("figures", () => captureFigureStills(session));
    await run("attentive", () => captureAttentive(session));
    await run("settle", () => captureSettle(session));
    await run("gestures", () => captureGestures(session));
    await run("seams", () => captureSeams(session));
    // Reported under seams; it runs after them so a seams rerun cannot drop it.
    await run(
      "neck",
      () => captureNeckNodThinking(session),
      (value) => {
        const seams =
          typeof summary.seams === "object" && summary.seams !== null ? summary.seams : {};
        summary.seams = { ...seams, neckNodThinking: value };
      },
    );
    await run("gold", () => captureGold(session));
  } finally {
    await browser.close();
    await v5.close();
    await lab.close();
  }
  const final = {
    ...summary,
    generatedAt: new Date().toISOString(),
    chrome: NodeFS.existsSync(CHROME) ? CHROME : "playwright chromium",
    headless,
  };
  writeJson(summaryFile, final);
  writeIndex(final);
  log(`wrote ${summaryFile} and index.html`);
}

await main();
