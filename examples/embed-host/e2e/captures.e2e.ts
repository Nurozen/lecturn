// @effect-diagnostics nodeBuiltinImport:off -- Test harness driving a real Electron app; it runs no Effect runtime.
/**
 * The CP2 embed captures (scripts/bar/checklists/embed.json), staged on the
 * real host with the scripted provider and the app's own gate (so approval
 * cards carry the app's reason). Each scene is probed before it is captured;
 * a scene with a missing row is not written and fails the run.
 *
 * - Switcher on, 960 px pane: `embed-host-approval`, `embed-host-timeline`,
 *   `embed-host-full-access`, each with a chip the host's Mention button put
 *   in the composer.
 * - Switcher on, 440 px pane (the mockup's pane width, where the card takes
 *   its narrow form): `embed-host-card`.
 * - Switcher off, 440 px pane: `embed-host-mockup-scene`, composed as the
 *   mockup's right pane (user message, a cardless app tool row, a card tool
 *   row with its card, assistant text, the pending gated approval, the
 *   composer with one chip). The pane is grown until the whole turn shows
 *   without scrolling, and the run fails if any part is still cut off.
 *
 * With EMBED_HOST_E2E_ARTIFACTS set, the composites, `captures-scenes.json`
 * (window and pane size and probe results per scene) and
 * `theme-probe-mockup-scene.json` are written there.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { EmbedBridge } from "@lecturn/embed/electron";
import type { Page } from "playwright-core";

import { compositeGuest, type GuestBounds } from "../../../scripts/bar/electron-guest-capture.ts";
import {
  type Checklist,
  loadChecklist,
  playwrightProbeRoot,
  probeScene,
  type RowResult,
} from "../../../scripts/bar/probe-dom.ts";
import { probeGuestTheme, type SentEmbedTheme } from "../../../scripts/bar/theme-probe.ts";
import { embedHostDir } from "../scripts/electronLauncher.ts";
import { adminClient, issueAdminToken } from "./adminClient.ts";
import { createEmbedThread } from "./embedRpc.ts";
import { embedPage } from "./embedPage.ts";
import {
  type EmbedHostGlobal,
  type EmbedHostRun,
  launchEmbedHost,
  removeDirs,
  until,
} from "./harness.ts";
import type { E2eContext } from "./run.ts";

type Png = Parameters<typeof compositeGuest>[0];
// pngjs is a dependency of the repo's scripts package, which owns the capture tooling.
const { PNG } = NodeModule.createRequire(
  NodePath.resolve(embedHostDir, "../../scripts/bar/electron-guest-capture.ts"),
)("pngjs") as {
  readonly PNG: { readonly sync: { read(buffer: Buffer): Png; write(image: Png): Buffer } };
};

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const scriptsFile = (name: string) => NodePath.join(here, "scripts", `${name}.scripted.json`);

const TURN_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** main.ts's window: a 320 px host sidebar, then the pane. */
const WIDE_WINDOW = { width: 1280, height: 820 } as const;
/** The embed mockup's pane is about 440 px wide beside the same sidebar. */
const MOCKUP_WINDOW = { width: 760, height: 820 } as const;
const MOCKUP_PANE_WIDTH = 440;
/** Runs the app's own gate, the path that carries a reason for the approval card. */
const APP_GATE_ENV = { EMBED_HOST_APP_GATE: "1" } as const;

interface CaptureGlobals {
  readonly embedHost?: EmbedHostGlobal & { readonly embed: EmbedBridge };
}

interface SceneRecord {
  readonly scene: string;
  readonly switcher: boolean;
  readonly window: { readonly width: number; readonly height: number };
  readonly pane: GuestBounds;
  /** Null when the scene failed a probe or a fit check and was not written. */
  readonly file: string | null;
  readonly probes: ReadonlyArray<RowResult>;
  readonly problems: ReadonlyArray<string>;
}

interface Stage {
  readonly run: EmbedHostRun;
  readonly guest: Page;
  readonly switcher: boolean;
}

function paneBounds(run: EmbedHostRun): Promise<GuestBounds> {
  return run.app.evaluate(({ BrowserWindow }) => {
    const embed = (globalThis as CaptureGlobals).embedHost!.embed;
    const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(
      (child) => "webContents" in child && child.webContents === embed.webContents,
    );
    if (view === undefined) throw new Error("The embed view is not in the host window.");
    return view.getBounds();
  });
}

function windowSize(run: EmbedHostRun) {
  return run.app.evaluate(({ BrowserWindow }) => {
    const [width = 0, height = 0] = BrowserWindow.getAllWindows()[0]!.getContentSize();
    return { width, height };
  });
}

/** Resizes the window's content and waits for the pane to follow the renderer's next rect report. */
async function resizeWindow(run: EmbedHostRun, width: number, height: number) {
  const fitted = await run.app.evaluate(
    ({ BrowserWindow, screen }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const chrome = win.getSize()[1]! - win.getContentSize()[1]!;
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      // A window taller than the display's work area is clamped by macOS anyway.
      const contentHeight = Math.min(size.height, area.height - chrome);
      win.setPosition(area.x, area.y);
      win.setContentSize(size.width, contentHeight);
      return { width: size.width, height: contentHeight };
    },
    { width, height },
  );
  const pane = await until(
    `a ${fitted.width}x${fitted.height} window's pane`,
    UI_TIMEOUT_MS,
    async () => {
      const bounds = await paneBounds(run);
      return bounds.x + bounds.width === fitted.width && bounds.y + bounds.height === fitted.height
        ? bounds
        : undefined;
    },
  );
  return { window: fitted, pane };
}

/**
 * The timeline's own scroller under `[data-timeline-ready]`: its overflow, or
 * scrolled to the top (the turn's user message) when `toTop` is set.
 */
function timelineScroller(guest: Page, toTop: boolean) {
  return guest.evaluate((scrollToTop) => {
    const root = document.querySelector("[data-timeline-ready]");
    if (root === null) return null;
    const scroller = [root, ...root.querySelectorAll("*")].find(
      (element) =>
        /auto|scroll/.test(getComputedStyle(element).overflowY) && element.clientHeight > 0,
    );
    if (scroller === undefined) return null;
    if (scrollToTop) scroller.scrollTop = 0;
    return { overflow: scroller.scrollHeight - scroller.clientHeight, top: scroller.scrollTop };
  }, toTop);
}

/**
 * Grows the window until the timeline needs no scrolling. If the display
 * stops it first, the timeline is scrolled to the user message so the
 * mockup's top is what shows; the fit check then names what is cut off.
 */
async function fitTimeline(stage: Stage, log: E2eContext["log"]) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = await timelineScroller(stage.guest, false);
    if (measured === null) throw new Error("The embed timeline has no scroller.");
    if (measured.overflow <= 1) return;
    const before = await windowSize(stage.run);
    const wanted = before.height + Math.ceil(measured.overflow) + 8;
    const { window } = await resizeWindow(stage.run, before.width, wanted);
    log(
      `fit: timeline overflows by ${measured.overflow} px; window ${before.height} -> ${window.height} px`,
    );
    if (window.height <= before.height) break;
    // The list re-measures its rows after the resize.
    await stage.guest.waitForTimeout(600);
  }
  const scrolled = await timelineScroller(stage.guest, true);
  log(
    `fit: the display limits the window; timeline scrolled to its top (${JSON.stringify(scrolled)})`,
  );
}

/** Parts of the mockup scene and how many of each it must show. */
const MOCKUP_TIMELINE_PARTS = [
  { name: "user message", selector: '[data-message-role="user"]', count: 1 },
  { name: "user avatar", selector: '[data-testid="embed-user-avatar"]', count: 1 },
  { name: "app tool row", selector: '[data-testid="app-tool-row"]', count: 2 },
  { name: "card", selector: '[data-testid="mcp-app-card"]', count: 1 },
  { name: "assistant text", selector: '[data-message-role="assistant"]', count: 1 },
] as const;
const MOCKUP_COMPOSER_PARTS = [
  { name: "approval card", selector: '[data-testid="app-approval-card"]', count: 1 },
  { name: "chip", selector: '[data-testid="app-ref-chip"]', count: 1 },
  { name: "composer", selector: '[data-slot="composer-shell"]', count: 1 },
  { name: "composer footer", selector: '[data-testid="embed-composer-footer"]', count: 1 },
] as const;

/**
 * Every mockup part is drawn whole: timeline parts between the timeline's top
 * and the composer stack (the approval card sits on top of it), composer parts
 * inside the pane.
 */
function mockupFitProblems(guest: Page): Promise<ReadonlyArray<string>> {
  return guest.evaluate(
    ({ timeline, composer }) => {
      const rects = (selector: string) =>
        [...document.querySelectorAll(selector)]
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0);
      const problems: Array<string> = [];
      const viewport = document.querySelector("[data-timeline-ready]")?.getBoundingClientRect();
      const stackTop = Math.min(
        ...rects('[data-testid="app-approval-card"]').map((rect) => rect.top),
        ...rects('[data-slot="composer-shell"]').map((rect) => rect.top),
      );
      const check = (
        parts: ReadonlyArray<{ name: string; selector: string; count: number }>,
        top: number,
        bottom: number,
      ) => {
        for (const part of parts) {
          const found = rects(part.selector);
          if (found.length !== part.count) {
            problems.push(`${part.name}: ${found.length} shown, the mockup has ${part.count}`);
          }
          for (const rect of found) {
            if (rect.top < top - 0.5 || rect.bottom > bottom + 0.5) {
              problems.push(
                `${part.name} is cut off (${Math.round(rect.top)}..${Math.round(rect.bottom)} outside ${Math.round(top)}..${Math.round(bottom)})`,
              );
            }
          }
        }
      };
      check(timeline, viewport?.top ?? 0, stackTop);
      check(composer, 0, window.innerHeight);
      return problems;
    },
    { timeline: MOCKUP_TIMELINE_PARTS, composer: MOCKUP_COMPOSER_PARTS },
  );
}

/** Clicks a host sidebar item's Mention button and waits for its chip in the embed composer. */
async function mentionFromHost(stage: Stage, itemName: string) {
  const host = await stage.run.hostPage();
  const chips = stage.guest.locator('[data-testid="app-ref-chip"]');
  const before = await chips.count();
  await host
    .locator("#items li", { hasText: itemName })
    .getByRole("button", { name: "Mention" })
    .click({ timeout: UI_TIMEOUT_MS });
  await until(`the ${itemName} chip`, UI_TIMEOUT_MS, async () =>
    (await chips.count()) > before ? true : undefined,
  );
}

async function settle(guest: Page) {
  await guest.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  // Fonts, the card iframe's layout and the list's row measurements land after the DOM does.
  await guest.waitForTimeout(800);
}

async function captureComposite(stage: Stage, file: string) {
  const windowImage = PNG.sync.read(
    await (await stage.run.hostPage()).screenshot({ scale: "css" }),
  );
  const guestFile = NodePath.join(stage.run.dirs.root, `${NodePath.basename(file)}.guest.png`);
  await stage.run.app.evaluate(
    (_electron, path) => (globalThis as CaptureGlobals).embedHost!.capture(path),
    guestFile,
  );
  const guestImage = PNG.sync.read(await NodeFSP.readFile(guestFile));
  await NodeFSP.rm(guestFile, { force: true });
  // Bounds are read after the guest capture so a resize while it ran is caught.
  await NodeFSP.writeFile(
    file,
    PNG.sync.write(compositeGuest(windowImage, guestImage, await paneBounds(stage.run))),
  );
  return guestImage;
}

function sceneRunner(checklist: Checklist, outDir: string, log: E2eContext["log"]) {
  const records: Array<SceneRecord> = [];
  const scene = async (
    stage: Stage,
    name: string,
    extraChecks: () => Promise<ReadonlyArray<string>> = async () => [],
  ) => {
    await settle(stage.guest);
    const probes = (await probeScene(checklist, name, playwrightProbeRoot(stage.guest))).filter(
      (result) => result.status !== "not-in-scene",
    );
    const problems = [
      ...probes.flatMap((result) =>
        result.status === "missing" ? [`${result.id}: ${result.reason}`] : [],
      ),
      ...(await extraChecks()),
    ];
    const file = NodePath.join(outDir, `${name}.png`);
    const guestImage = problems.length === 0 ? await captureComposite(stage, file) : null;
    const record: SceneRecord = {
      scene: name,
      switcher: stage.switcher,
      window: await windowSize(stage.run),
      pane: await paneBounds(stage.run),
      file: guestImage === null ? null : file,
      probes,
      problems,
    };
    records.push(record);
    log(
      `${name}: window ${record.window.width}x${record.window.height}, pane ${record.pane.width}x${record.pane.height}; ${probes.map((result) => `${result.id}=${result.status}`).join(", ")}${problems.length > 0 ? `; NOT CAPTURED: ${problems.join("; ")}` : ""}`,
    );
    return guestImage;
  };
  return { scene, records };
}

async function openThread(run: EmbedHostRun, title: string, switcher: boolean) {
  const { host, dirs } = run;
  await run.guestPage(`/embed/${host.environmentId}/${host.projectId}`, 60_000);
  const target = await run.app.evaluate(() =>
    (globalThis as CaptureGlobals).embedHost!.embedTarget(),
  );
  const threadId = await createEmbedThread({
    origin: host.origin,
    embedToken: target.token,
    projectId: host.projectId,
    title,
  });
  const admin = adminClient({ origin: host.origin, token: await issueAdminToken(dirs.sidecarDir) });
  await admin.setRuntimeMode(threadId, "approval-required");
  await run.app.evaluate(
    (_electron, id) => (globalThis as CaptureGlobals).embedHost!.openThread(id),
    threadId,
  );
  if (!switcher) {
    // switcher:false is a mount option; reload the same thread the way mountEmbedView would load it.
    await run.guestPage(`/${threadId}`);
    await run.app.evaluate(async () => {
      const embedHost = (globalThis as CaptureGlobals).embedHost!;
      const { token } = await embedHost.embedTarget();
      const url = new URL(embedHost.embed.webContents.getURL());
      url.hash = new URLSearchParams({ embedToken: token, switcher: "0" }).toString();
      // The view strips its hash on load, so a hash-only loadURL would be a same-document
      // navigation the view never reads, and Electron rejects it as ERR_FAILED.
      await embedHost.embed.webContents.loadURL("about:blank");
      await embedHost.embed.webContents.loadURL(url.toString());
    });
  }
  const guest = await run.guestPage(`/${threadId}`);
  await guest.waitForLoadState("load");
  await embedPage(guest).waitForRuntimeMode("Supervised");
  return { guest, threadId, admin };
}

async function withHost(
  scripts: string,
  log: E2eContext["log"],
  keep: boolean,
  body: (run: EmbedHostRun) => Promise<void>,
) {
  const run = await launchEmbedHost({
    scripted: true,
    scripts: JSON.parse(await NodeFSP.readFile(scriptsFile(scripts), "utf8")) as Record<
      number,
      ReadonlyArray<unknown>
    >,
    env: APP_GATE_ENV,
  });
  try {
    await body(run);
  } catch (error) {
    log(`--- embed-host output ---\n${run.output()}`);
    throw error;
  } finally {
    await run.close();
    if (keep) log(`kept ${run.dirs.root}`);
    else await removeDirs(run.dirs);
  }
}

async function switcherScenes(run: EmbedHostRun, runner: ReturnType<typeof sceneRunner>) {
  await resizeWindow(run, WIDE_WINDOW.width, WIDE_WINDOW.height);
  const { guest, threadId, admin } = await openThread(run, "Count to two", true);
  const stage = { run, guest, switcher: true };
  const page = embedPage(guest);

  await page.send("Count to two, then flash the window");
  await page.waitForApproval("ex_window_flash", TURN_TIMEOUT_MS);
  await page.loadedCards(2, TURN_TIMEOUT_MS);
  await mentionFromHost(stage, "Counter A");
  await runner.scene(stage, "embed-host-approval");

  await page.approve("ex_window_flash", UI_TIMEOUT_MS);
  await page.waitForReply("Counted to two and flashed the window.", TURN_TIMEOUT_MS);
  await runner.scene(stage, "embed-host-timeline");

  const { pane } = await resizeWindow(run, MOCKUP_WINDOW.width, MOCKUP_WINDOW.height);
  if (pane.width !== MOCKUP_PANE_WIDTH) {
    throw new Error(`The card scene's pane is ${pane.width} px, not ${MOCKUP_PANE_WIDTH} px.`);
  }
  const lastCard = guest.locator('[data-timeline-row-kind="mcp-app"]').last();
  await lastCard.evaluate((element) => element.scrollIntoView({ block: "center" }));
  // The card picks its form from its own width; a timeout is left for the probe to report.
  await lastCard
    .frameLocator("iframe")
    .locator('[data-card-layout="narrow"]')
    .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS })
    .catch(() => undefined);
  await runner.scene(stage, "embed-host-card");

  await resizeWindow(run, WIDE_WINDOW.width, WIDE_WINDOW.height);
  await admin.setRuntimeMode(threadId, "full-access");
  await page.waitForRuntimeMode("Full access");
  const seenApprovals = await page.watchApprovalCards();
  await page.send("Flash the window again");
  await page.waitForReply("Flashed the window in Full access.", TURN_TIMEOUT_MS);
  // The chip went out with the message; the scene shows one, as the others do.
  await mentionFromHost(stage, "Counter A");
  await runner.scene(stage, "embed-host-full-access", async () => {
    const seen = await seenApprovals();
    return seen.length === 0 ? [] : [`approval cards appeared in Full access: ${seen.join(", ")}`];
  });
}

async function mockupScene(
  run: EmbedHostRun,
  runner: ReturnType<typeof sceneRunner>,
  outDir: string,
  log: E2eContext["log"],
) {
  await resizeWindow(run, MOCKUP_WINDOW.width, MOCKUP_WINDOW.height);
  const { guest } = await openThread(run, "Counter review", false);
  const stage = { run, guest, switcher: false };
  const page = embedPage(guest);

  await page.send("Read the counter, then add one and flash the window.");
  await page.waitForApproval("ex_window_flash", TURN_TIMEOUT_MS);
  await page.loadedCards(1, TURN_TIMEOUT_MS);
  await page.waitForReply("The counter passes the check.", TURN_TIMEOUT_MS);
  await mentionFromHost(stage, "Counter A");
  await settle(guest);
  await fitTimeline(stage, log);

  const guestImage = await runner.scene(stage, "embed-host-mockup-scene", () =>
    mockupFitProblems(guest),
  );
  if (guestImage !== null) {
    // A point on the pane's bare background, beside the timeline's lane.
    const point = await guest.evaluate(() => {
      for (let y = Math.round(innerHeight * 0.15); y < innerHeight * 0.6; y += 7) {
        for (const x of [4, 8, innerWidth - 24]) {
          if (document.elementFromPoint(x, y)?.tagName === "MAIN") return { x, y };
        }
      }
      return { x: 4, y: Math.round(innerHeight * 0.4) };
    });
    const sentPath = NodePath.join(embedHostDir, "src", "rocketwright-theme.json");
    const sent = JSON.parse(await NodeFSP.readFile(sentPath, "utf8")) as SentEmbedTheme;
    const report = await probeGuestTheme({
      guest,
      sent,
      capture: guestImage,
      backgroundPoint: point,
    });
    const failed = report.checks.filter((check) => !check.passed);
    await NodeFSP.writeFile(
      NodePath.join(outDir, "theme-probe-mockup-scene.json"),
      `${JSON.stringify({ scene: "embed-host-mockup-scene", sentFile: NodePath.relative(embedHostDir, sentPath), backgroundPoint: point, ...report }, null, 2)}\n`,
    );
    log(
      `theme probe on the mockup scene: ${report.checks.length - failed.length}/${report.checks.length}${failed.map((check) => `; ${check.name} expected ${check.expected} got ${check.actual}`).join("")}`,
    );
  }

  await page.approve("ex_window_flash", UI_TIMEOUT_MS);
  await page.waitForReply("Flashed the window.", TURN_TIMEOUT_MS);
}

export default async function captures({ log, artifactsDir, keep }: E2eContext): Promise<void> {
  const checklist = await loadChecklist("embed");
  const outDir =
    artifactsDir ?? (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "embed-host-captures-")));
  const runner = sceneRunner(checklist, outDir, log);
  try {
    await withHost("captures-switcher", log, keep, (run) => switcherScenes(run, runner));
    await withHost("captures-mockup", log, keep, (run) => mockupScene(run, runner, outDir, log));
  } finally {
    await NodeFSP.writeFile(
      NodePath.join(outDir, "captures-scenes.json"),
      `${JSON.stringify({ checklist: "scripts/bar/checklists/embed.json", scenes: runner.records }, null, 2)}\n`,
    );
    if (artifactsDir === undefined) await NodeFSP.rm(outDir, { recursive: true, force: true });
  }
  const failed = runner.records.filter((record) => record.problems.length > 0);
  if (failed.length > 0) {
    throw new Error(
      `Scenes not captured:\n${failed.map((record) => `  ${record.scene}: ${record.problems.join("; ")}`).join("\n")}`,
    );
  }
  const missing = checklist.scenes.filter(
    (name) => !runner.records.some((record) => record.scene === name),
  );
  if (missing.length > 0) throw new Error(`Checklist scenes never staged: ${missing.join(", ")}`);
}
