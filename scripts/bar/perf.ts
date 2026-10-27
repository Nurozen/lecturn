#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off preferSchemaOverJson:off - Host-side measurement tooling driving real servers, Electron and Chrome; it runs no Effect runtime.
/**
 * Spec B3's runtime targets, measured on this machine (CP8):
 * - Lecturn sidecar cold start to ready, at most 6 s: `connect` on a fresh
 *   sidecar home with no user server to find.
 * - `mountEmbedView` to an interactive composer, at most 2.0 s, with the
 *   server already running (the median of fresh mounts in Embed Host).
 * - No frames while the embed view or Apps mode sits idle, from a CDP
 *   Performance trace of each page's renderer.
 *
 *   node scripts/bar/perf.ts --home <fresh temp dir> [--out <dir>] [--idle-ms 5000] [--samples 5] [--browser-path <chrome>]
 *
 * Needs `vp run --filter embed-host build` (it builds the server and the web
 * client too). Everything it starts lives under --home and is stopped before
 * it exits. Writes `perf.json` and one trace per idle scene (open them in
 * the DevTools Performance panel) to --out, `<home>/perf` by default; exits 1
 * when a target is missed.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";
import { type CDPSession, chromium, type Page } from "playwright-core";

import {
  type EmbedHostDirs,
  type HostGlobals,
  launchEmbedHost,
} from "../../examples/embed-host/e2e/harness.ts";
import { createEmbedThread } from "../../examples/embed-host/e2e/embedRpc.ts";
import { connect } from "../../packages/embed/src/node.ts";
import { AppRegistration } from "../../packages/contracts/src/index.ts";
import {
  assertIsolatedBaseDir,
  fetchBarShellSnapshot,
  issueBarReadToken,
  seedBarFixture,
  startBarServer,
} from "../seed-bar-fixture.ts";
import { BAR_APP_ID, barAppRegistration, barAppServerEnv } from "./app-fixture.ts";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const SERVER_ENTRY = NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs");
const BUILD_OUTPUTS = [
  SERVER_ENTRY,
  NodePath.join(REPO_ROOT, "apps/web/dist/index.html"),
  NodePath.join(REPO_ROOT, "examples/embed-host/dist/main.mjs"),
];

const encodeRegistration = Schema.encodeSync(AppRegistration);

/** Spec B3. */
export const PERF_TARGETS = {
  sidecarColdStartMs: 6_000,
  mountToInteractiveMs: 2_000,
  idleFrames: 0,
} as const;

/** Lets layout, fonts and the last network replies finish before an idle window starts. */
const SETTLE_MS = 2_000;
const COMPOSER_TIMEOUT_MS = 30_000;
const POLL_MS = 16;

/** What DevTools' Performance panel records, without the CPU profiler. */
export const TRACE_CATEGORIES = [
  "-*",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "toplevel",
  "benchmark",
  "cc",
  "blink.user_timing",
] as const;

/**
 * Each of these marks a frame the renderer scheduled: main-thread frame
 * work, an animation frame callback, a paint, a compositor frame. A
 * renderer with nothing to show emits none.
 */
export const FRAME_EVENT_NAMES = [
  "BeginMainThreadFrame",
  "FireAnimationFrame",
  "Paint",
  "Commit",
  "DrawFrame",
  "PipelineReporter",
] as const;

export interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly pid: number;
  readonly ts?: number;
  readonly args?: { readonly data?: unknown };
}

/** End halves of duration and async events: counting them would count each frame twice. */
const END_PHASES = new Set(["E", "e"]);

export function countFrameEvents(
  events: ReadonlyArray<TraceEvent>,
  pids: ReadonlySet<number>,
): { readonly total: number; readonly byName: Readonly<Record<string, number>> } {
  const names = new Set<string>(FRAME_EVENT_NAMES);
  const byName: Record<string, number> = {};
  let total = 0;
  for (const event of events) {
    if (!pids.has(event.pid) || !names.has(event.name) || END_PHASES.has(event.ph)) continue;
    byName[event.name] = (byName[event.name] ?? 0) + 1;
    total += 1;
  }
  return { total, byName };
}

interface TraceFrameData {
  readonly url?: unknown;
  readonly processId?: unknown;
}

/** The renderer processes the trace says hold a frame whose URL matches. */
export function rendererPidsForUrl(
  events: ReadonlyArray<TraceEvent>,
  matches: (url: string) => boolean,
): ReadonlySet<number> {
  const pids = new Set<number>();
  const consider = (frame: TraceFrameData | undefined) => {
    if (typeof frame?.url !== "string" || typeof frame.processId !== "number") return;
    if (matches(frame.url)) pids.add(frame.processId);
  };
  for (const event of events) {
    const data = event.args?.data as
      | (TraceFrameData & { readonly frames?: ReadonlyArray<TraceFrameData> })
      | undefined;
    if (event.name === "TracingStartedInBrowser")
      for (const frame of data?.frames ?? []) consider(frame);
    else if (event.name === "FrameCommittedInBrowser") consider(data);
  }
  return pids;
}

export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface IdleSceneResult {
  readonly scene: string;
  readonly idleMs: number;
  readonly pids: ReadonlyArray<number>;
  readonly frames: number;
  readonly framesByName: Readonly<Record<string, number>>;
  readonly trace: string;
}

export interface PerfResult {
  readonly measuredAt: string;
  readonly targets: typeof PERF_TARGETS;
  readonly sidecarColdStartMs: number;
  readonly mount: {
    /** Composer interactive, from the `mountEmbedView` call, per measured mount. */
    readonly samplesMs: ReadonlyArray<number>;
    /** The guest's `lecturn/ready`, from the same call; null when it never came. */
    readonly readyMs: ReadonlyArray<number | null>;
    readonly medianMs: number;
    readonly maxMs: number;
  };
  readonly idle: ReadonlyArray<IdleSceneResult>;
  /** Threads the Apps mode fixture still showed as working while its trace ran. */
  readonly appsRunningThreads: number;
}

export function perfFailures(
  result: Omit<PerfResult, "measuredAt" | "targets">,
): ReadonlyArray<string> {
  const failures: Array<string> = [];
  if (!(result.sidecarColdStartMs <= PERF_TARGETS.sidecarColdStartMs)) {
    failures.push(
      `sidecar cold start took ${Math.round(result.sidecarColdStartMs)} ms (target ${PERF_TARGETS.sidecarColdStartMs} ms)`,
    );
  }
  if (!(result.mount.medianMs <= PERF_TARGETS.mountToInteractiveMs)) {
    failures.push(
      `mountEmbedView to composer interactive took ${Math.round(result.mount.medianMs)} ms at the median (target ${PERF_TARGETS.mountToInteractiveMs} ms)`,
    );
  }
  for (const scene of result.idle) {
    if (scene.pids.length === 0)
      failures.push(`${scene.scene}: the trace names no renderer for the page`);
    else if (scene.frames > PERF_TARGETS.idleFrames) {
      failures.push(
        `${scene.scene}: ${scene.frames} frame events while idle ${JSON.stringify(scene.framesByName)}`,
      );
    }
  }
  if (result.appsRunningThreads > 0) {
    failures.push(`Apps mode was not idle: ${result.appsRunningThreads} threads still working`);
  }
  return failures;
}

export function parsePerfArgs(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      home: { type: "string" },
      out: { type: "string" },
      "idle-ms": { type: "string", default: "5000" },
      samples: { type: "string", default: "5" },
      "browser-path": { type: "string" },
    },
  });
  if (values.home === undefined) {
    throw new Error(
      "Usage: node scripts/bar/perf.ts --home <fresh temp dir> [--out <dir>] [--idle-ms 5000] [--samples 5] [--browser-path <chrome>]",
    );
  }
  const idleMs = Number(values["idle-ms"]);
  const samples = Number(values.samples);
  if (!Number.isInteger(idleMs) || idleMs < 1_000)
    throw new Error("--idle-ms takes whole milliseconds, at least 1000.");
  if (!Number.isInteger(samples) || samples < 1)
    throw new Error("--samples takes a positive whole number.");
  const home = NodePath.resolve(values.home);
  return {
    home,
    out: NodePath.resolve(values.out ?? NodePath.join(home, "perf")),
    idleMs,
    samples,
    browserPath: values["browser-path"],
  } as const;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freshDir(path: string): Promise<string> {
  if (NodeFS.existsSync(path) && NodeFS.readdirSync(path).length > 0) {
    throw new Error(`${path} is not empty; give perf.ts a fresh --home.`);
  }
  await NodeFSP.mkdir(path, { recursive: true });
  // The server echoes workspace roots verbatim, and macOS hands out /var for /private/var.
  return NodeFSP.realpath(path);
}

async function measureSidecarColdStart(home: string): Promise<number> {
  const root = await freshDir(NodePath.join(home, "cold-sidecar"));
  const lecturnHome = NodePath.join(root, "no-user-server");
  await NodeFSP.mkdir(lecturnHome);
  const startedAt = performance.now();
  const connection = await connect({
    registration: encodeRegistration(barAppRegistration()),
    lecturnHome,
    sidecar: { serverEntry: SERVER_ENTRY, baseDir: NodePath.join(root, "sidecar") },
  });
  const elapsed = performance.now() - startedAt;
  try {
    if (connection.mode !== "sidecar")
      throw new Error(`connect chose ${connection.mode}, not the sidecar`);
  } finally {
    await connection.close();
  }
  return elapsed;
}

/** Records a trace while nothing happens on the page; `Tracing` is recorded browser-wide. */
async function traceIdle(cdp: CDPSession, idleMs: number): Promise<ReadonlyArray<TraceEvent>> {
  const events: Array<TraceEvent> = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    events.push(...(value as unknown as ReadonlyArray<TraceEvent>));
  });
  const complete = new Promise<void>((resolve) =>
    cdp.once("Tracing.tracingComplete", () => resolve()),
  );
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: [...TRACE_CATEGORIES],
      recordMode: "recordAsMuchAsPossible",
    },
  });
  await sleep(idleMs);
  await cdp.send("Tracing.end");
  await complete;
  return events;
}

/**
 * A focused text field's caret blinks, which repaints whatever the app
 * does; idle here means the app scheduling nothing of its own.
 */
const blurFocus = (page: Page) =>
  page.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");

async function idleScene(input: {
  readonly scene: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly idleMs: number;
  readonly out: string;
  readonly matchesUrl: (url: string) => boolean;
  readonly knownPids?: ReadonlyArray<number>;
}): Promise<IdleSceneResult> {
  await blurFocus(input.page);
  await sleep(SETTLE_MS);
  const events = await traceIdle(input.cdp, input.idleMs);
  const pids = new Set([
    ...rendererPidsForUrl(events, input.matchesUrl),
    ...(input.knownPids ?? []),
  ]);
  const trace = NodePath.join(input.out, `${input.scene}.trace.json`);
  await NodeFSP.writeFile(trace, JSON.stringify({ traceEvents: events }));
  const frames = countFrameEvents(events, pids);
  return {
    scene: input.scene,
    idleMs: input.idleMs,
    pids: [...pids],
    frames: frames.total,
    framesByName: frames.byName,
    trace,
  };
}

/** The guest's composer accepts typing: present, laid out, editable and not read-only. */
const COMPOSER_INTERACTIVE = `(() => {
  const editor = document.querySelector('[data-testid="composer-editor"]');
  if (!(editor instanceof HTMLElement) || !editor.isContentEditable) return false;
  if (editor.getAttribute("aria-readonly") === "true" || editor.closest("[inert]")) return false;
  const rect = editor.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
})()`;

async function measureEmbed(input: {
  readonly home: string;
  readonly out: string;
  readonly idleMs: number;
  readonly samples: number;
}): Promise<{ mount: PerfResult["mount"]; idle: IdleSceneResult }> {
  const root = await freshDir(NodePath.join(input.home, "embed-host"));
  const dirs: EmbedHostDirs = {
    root,
    lecturnHome: NodePath.join(root, "lecturn-home"),
    sidecarDir: NodePath.join(root, "sidecar"),
    userData: NodePath.join(root, "electron-user-data"),
    workspace: NodePath.join(root, "ws-a"),
    flashLog: NodePath.join(root, "flashes.json"),
    scripts: NodePath.join(root, "scripted-turns.json"),
  };
  for (const dir of [dirs.lecturnHome, dirs.sidecarDir, dirs.userData, dirs.workspace]) {
    await NodeFSP.mkdir(dir, { recursive: true });
  }
  const run = await launchEmbedHost({ dirs });
  try {
    // A fresh project has no thread, and the embed has no draft composer, so a project
    // mount shows a composer only once the project has a thread to open.
    const target = await run.app.evaluate(() =>
      (globalThis as HostGlobals).embedHost!.embedTarget(),
    );
    await createEmbedThread({
      origin: run.host.origin,
      embedToken: target.token,
      projectId: run.host.projectId,
      title: "Perf",
    });
    const guest = await run.guestPage("/embed/");
    await guest.waitForFunction(COMPOSER_INTERACTIVE, undefined, { timeout: COMPOSER_TIMEOUT_MS });

    // The pane's own mount warmed the server; the first timed mount warms nothing else.
    const timings: Array<{ interactiveMs: number; readyMs: number | null }> = [];
    for (let index = 0; index <= input.samples; index += 1) {
      const timing = await run.app.evaluate(
        async (_electron, { predicate, timeoutMs, pollMs }) => {
          const startedAt = performance.now();
          const view = (globalThis as HostGlobals).embedHost!.mountView();
          let readyAt: number | null = null;
          view.on("lecturn/ready", () => {
            readyAt ??= performance.now();
          });
          try {
            for (;;) {
              // Rejects while a navigation replaces the document; the next poll asks again.
              const interactive = await view.webContents
                .executeJavaScript(predicate)
                .catch(() => false);
              if (interactive === true) break;
              if (performance.now() - startedAt > timeoutMs) {
                throw new Error(`no interactive composer within ${timeoutMs} ms`);
              }
              await new Promise((resolve) => setTimeout(resolve, pollMs));
            }
            const interactiveMs = performance.now() - startedAt;
            return { interactiveMs, readyMs: readyAt === null ? null : readyAt - startedAt };
          } finally {
            view.destroy();
          }
        },
        { predicate: COMPOSER_INTERACTIVE, timeoutMs: COMPOSER_TIMEOUT_MS, pollMs: POLL_MS },
      );
      if (index > 0) timings.push(timing);
    }
    const samplesMs = timings.map((timing) => timing.interactiveMs);

    const guestPid = await run.app.evaluate(() =>
      (globalThis as HostGlobals).embedHost!.embed.webContents.getOSProcessId(),
    );
    const cdp = await run.app.context().newCDPSession(guest);
    const idle = await idleScene({
      scene: "embed-idle",
      page: guest,
      cdp,
      idleMs: input.idleMs,
      out: input.out,
      matchesUrl: (url) => new URL(url).pathname.startsWith("/embed/"),
      knownPids: [guestPid],
    });
    await cdp.detach();
    return {
      mount: {
        samplesMs,
        readyMs: timings.map((timing) => timing.readyMs),
        medianMs: median(samplesMs),
        maxMs: Math.max(...samplesMs),
      },
      idle,
    };
  } catch (error) {
    console.error(`--- embed-host output ---\n${run.output()}`);
    throw error;
  } finally {
    await run.close();
  }
}

/** `AppProjectService`'s running statuses, the ones an app rail draws as working. */
const RUNNING = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const APPS_SCENES = [
  { scene: "apps-list-idle", path: "/?sidebar=apps", ready: '[data-testid="sidebar-app-row"]' },
  {
    scene: "apps-app-selected-idle",
    path: `/apps/${encodeURIComponent(BAR_APP_ID)}`,
    ready: '[data-testid="sidebar-app-workspace"]',
  },
] as const;

async function measureAppsMode(input: {
  readonly home: string;
  readonly out: string;
  readonly idleMs: number;
  readonly browserPath: string | undefined;
}): Promise<{ idle: ReadonlyArray<IdleSceneResult>; runningThreads: number }> {
  const baseDir = await freshDir(NodePath.join(input.home, "apps-fixture"));
  const seeded = await seedBarFixture({ baseDir, app: true });
  // The fixture holds two turns open for the Working rows the mockups draw.
  // A restart should end them; `runningThreads` reports any it did not.
  await seeded.server?.stop();
  const server = await startBarServer({ baseDir, env: barAppServerEnv(baseDir) });
  try {
    if (server.pairingUrl === null)
      throw new Error("The restarted fixture server printed no pairing URL.");
    const snapshot = await fetchBarShellSnapshot(server.origin, await issueBarReadToken(baseDir));
    const runningThreads = snapshot.threads.filter((thread) => RUNNING.has(thread.status)).length;
    const browser = await chromium.launch(
      input.browserPath === undefined
        ? { channel: "chrome" }
        : { executablePath: input.browserPath },
    );
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
      });
      const page = await context.newPage();
      await page.goto(server.pairingUrl);
      await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
      const idle: Array<IdleSceneResult> = [];
      for (const scene of APPS_SCENES) {
        await page.goto(new URL(scene.path, server.origin).toString());
        await page.locator(scene.ready).first().waitFor({ state: "visible", timeout: 60_000 });
        const cdp = await context.newCDPSession(page);
        idle.push(
          await idleScene({
            scene: scene.scene,
            page,
            cdp,
            idleMs: input.idleMs,
            out: input.out,
            matchesUrl: (url) => url.startsWith(server.origin),
          }),
        );
        await cdp.detach();
      }
      return { idle, runningThreads };
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
}

async function main(): Promise<void> {
  const args = parsePerfArgs(NodeProcess.argv.slice(2));
  assertIsolatedBaseDir(args.home);
  const missing = BUILD_OUTPUTS.filter((path) => !NodeFS.existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(", ")}; run \`vp run --filter embed-host build\` first.`,
    );
  }
  await NodeFSP.mkdir(args.home, { recursive: true });
  await NodeFSP.mkdir(args.out, { recursive: true });

  // First, before anything else has run Lecturn's server code in this session.
  const sidecarColdStartMs = await measureSidecarColdStart(args.home);
  console.log(`sidecar cold start ${Math.round(sidecarColdStartMs)} ms`);
  const embed = await measureEmbed(args);
  console.log(
    `mountEmbedView to composer interactive: median ${Math.round(embed.mount.medianMs)} ms, max ${Math.round(embed.mount.maxMs)} ms`,
  );
  const apps = await measureAppsMode(args);
  const measured = {
    sidecarColdStartMs,
    mount: embed.mount,
    idle: [embed.idle, ...apps.idle],
    appsRunningThreads: apps.runningThreads,
  };
  for (const scene of measured.idle)
    console.log(`${scene.scene}: ${scene.frames} frame events in ${scene.idleMs} ms`);
  const failures = perfFailures(measured);
  const result: PerfResult = {
    measuredAt: new Date().toISOString(),
    targets: PERF_TARGETS,
    ...measured,
  };
  const file = NodePath.join(args.out, "perf.json");
  await NodeFSP.writeFile(
    file,
    `${JSON.stringify({ ...result, passed: failures.length === 0, failures }, null, 2)}\n`,
  );
  console.log(`wrote ${file}`);
  if (failures.length > 0) {
    console.error(`B3 not met:\n- ${failures.join("\n- ")}`);
    globalThis.process.exitCode = 1;
  } else console.log("B3 runtime targets met.");
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    NodeProcess.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    NodeProcess.exit(1);
  });
}
