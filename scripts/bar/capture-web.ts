#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side browser capture tooling writing PNG and JSON files.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  type Page,
} from "playwright-core";

import {
  BAR_FIXTURE_NOW,
  barGitStateProblems,
  fetchBarShellSnapshot,
  issueBarReadToken,
} from "../seed-bar-fixture.ts";
import {
  type BarAppManifest,
  barAppLiveStateProblems,
  barAppSceneParams,
  readBarAppManifest,
} from "./app-fixture.ts";
import { BAR_APP_SCENE_NAMES, type BarAppSceneName, barAppStagingChecks } from "./app-scenes.ts";
import {
  CHECKLIST_NAMES,
  type ChecklistName,
  loadChecklist,
  playwrightProbeRoot,
  probeScene,
  type StagingCheck,
  stagingProblems,
} from "./probe-dom.ts";

export const BAR_VIEWPORT = { width: 1440, height: 900 } as const;

const CAPTURE_ONLY_CSS = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "capture-only.css",
);

/** Live timestamps and spinners differ between runs even with a frozen page clock. */
export const DEFAULT_MASKS = ["time", '[role="status"]', '[aria-busy="true"]'] as const;

export interface BarWebScene {
  readonly description: string;
  /** Route path; `{name}` segments come from `--param name=value`. */
  readonly path: string;
  /** The scene is ready once each of these selectors is visible. */
  readonly readySelectors: ReadonlyArray<string>;
  readonly masks?: ReadonlyArray<string>;
  /**
   * `staged`: the app fixture's staging time, so its live threads read as
   * recent. Projects mode keeps the fixture clock its baseline was drawn at.
   */
  readonly clock?: "fixture" | "staged";
  /** The checklist scene whose rows this capture is probed against, when named differently. */
  readonly checklistScene?: string;
}

/** Later checkpoints add their scenes here; names match the checklist `scenes`. */
export const BAR_WEB_SCENES = {
  "projects-sidebar": {
    description: "Projects sidebar with the seeded workspaces and their threads",
    path: "/",
    readySelectors: ['[data-slot="sidebar"]'],
  },
  "thread-approval": {
    description: "A thread with a live pending approval from the mock Copilot agent",
    path: "/{environmentId}/{threadId}",
    // The approval card mounts before the timeline reveals its rows.
    readySelectors: ["[data-approval-detail]", "[data-timeline-ready] [data-timeline-row-id]"],
  },
  "settings-connections": {
    description: "Settings > Connections",
    path: "/settings/connections",
    readySelectors: ['[data-slot="settings-section-card"]'],
  },
} satisfies Record<string, BarWebScene>;

const APP_THREAD_READY = [
  "[data-timeline-ready] [data-timeline-row-id]",
  '[data-testid="mcp-app-card"]',
];
// Apps mode is entered through the app deep-link query (`appLinkPath`), never through saved UI
// state. `app=` scopes the sidebar to that app (its header in place of the app row); the
// desktop mockup draws the All apps scope, so its scene leaves the app out.
const APP_THREAD_PATH = (threadParam: string, scope: "app" | "all" = "app") =>
  `/{environmentId}/{${threadParam}}?sidebar=apps${scope === "app" ? "&app={appId}" : ""}`;

/** The CP3 after-captures (A38); every one but Projects mode needs `seed-bar-fixture.ts --app`. */
export const BAR_APP_WEB_SCENES = {
  "projects-mode": {
    description:
      "Projects mode beside the app fixture, for the masked diff against projects-sidebar",
    path: "/",
    readySelectors: ['[data-slot="sidebar"]'],
  },
  // The Apps scenes open the app's latest thread, so the main pane is an app thread like the
  // sidebar beside it rather than the Projects-mode draft the index shows.
  "apps-list": {
    description:
      "Apps mode with All apps: the closed Embed Host row, the waiting app's Approve and Deny row, Embed Host's latest thread",
    path: APP_THREAD_PATH("latestThreadId", "all"),
    readySelectors: [
      '[data-testid="sidebar-app-row"]',
      "[data-timeline-ready] [data-timeline-row-id]",
    ],
    clock: "staged",
  },
  "apps-app-selected": {
    description:
      "Apps mode with Embed Host selected: its workspaces and sections, its latest thread",
    path: APP_THREAD_PATH("latestThreadId"),
    readySelectors: [
      '[data-testid="sidebar-app-workspace"]',
      "[data-timeline-ready] [data-timeline-row-id]",
    ],
    clock: "staged",
  },
  "apps-desktop-mockup-scene": {
    description:
      "The desktop mockup as drawn: pinned app thread in Full access, closed banner, two tool rows, wide card",
    path: APP_THREAD_PATH("mockupThreadId", "all"),
    readySelectors: APP_THREAD_READY,
    clock: "staged",
  },
  "app-thread-supervised": {
    description: "An app thread in Supervised: closed banner, a card and the pending approval card",
    path: APP_THREAD_PATH("supervisedThreadId"),
    readySelectors: [...APP_THREAD_READY, '[data-testid="app-approval-card"]'],
    clock: "staged",
    checklistScene: "apps-app-thread",
  },
  "app-thread-full-access": {
    description: "The same gated call in Full access: a card and no approval card",
    path: APP_THREAD_PATH("fullAccessThreadId"),
    readySelectors: APP_THREAD_READY,
    clock: "staged",
  },
  "settings-connected-apps": {
    description: "Settings > Connected apps with the granted Embed Host",
    path: "/settings/apps",
    readySelectors: ['[data-slot="settings-section-card"]'],
    clock: "staged",
  },
} satisfies Record<BarAppSceneName, BarWebScene>;

const ALL_SCENES: Readonly<Record<string, BarWebScene>> = {
  ...BAR_WEB_SCENES,
  ...BAR_APP_WEB_SCENES,
};
export type BarWebSceneName = keyof typeof BAR_WEB_SCENES | BarAppSceneName;

const isAppScene = (name: BarWebSceneName): name is BarAppSceneName =>
  (BAR_APP_SCENE_NAMES as ReadonlyArray<string>).includes(name);

export function resolveScenePath(
  scene: BarWebScene,
  params: Readonly<Record<string, string>>,
): string {
  return scene.path.replace(/\{([a-zA-Z]+)\}/gu, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      throw new Error(`Scene path ${scene.path} needs --param ${name}=<value>.`);
    }
    return encodeURIComponent(value);
  });
}

export function parseCaptureWebArgs(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      "pairing-url": { type: "string" },
      origin: { type: "string" },
      scene: { type: "string", multiple: true },
      param: { type: "string", multiple: true },
      "base-dir": { type: "string" },
      out: { type: "string" },
      clock: { type: "string" },
      checklist: { type: "string" },
      "browser-path": { type: "string" },
      appearance: { type: "string" },
      after: { type: "boolean", default: false },
    },
  });
  const pairingUrl = values["pairing-url"];
  const out = values.out;
  if (pairingUrl === undefined || out === undefined) {
    throw new Error(
      `Usage: node scripts/bar/capture-web.ts --pairing-url <url> --out <dir> [--after] [--scene <name>]... [--param name=value]... [--base-dir <dir>] [--clock <iso>] [--checklist ${CHECKLIST_NAMES.join("|")}] [--browser-path <chrome>] [--appearance dark|light]\nScenes: ${Object.keys(ALL_SCENES).join(", ")}\n--after captures the app-fixture scenes (default with --after: ${BAR_APP_SCENE_NAMES.join(", ")}).`,
    );
  }
  const after = values.after === true;
  const scenes = (
    values.scene ?? (after ? [...BAR_APP_SCENE_NAMES] : Object.keys(BAR_WEB_SCENES))
  ).map((name) => {
    if (!Object.hasOwn(ALL_SCENES, name)) throw new Error(`Unknown scene '${name}'.`);
    return name as BarWebSceneName;
  });
  if (after && values["base-dir"] === undefined) {
    throw new Error("--after reads the app fixture's manifest, so it needs --base-dir.");
  }
  const params: Record<string, string> = {};
  for (const entry of values.param ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`--param expects name=value, got '${entry}'.`);
    params[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  const checklist = values.checklist;
  if (checklist !== undefined && !CHECKLIST_NAMES.some((name) => name === checklist)) {
    throw new Error(`Unknown checklist '${checklist}'.`);
  }
  const appearance = values.appearance ?? "dark";
  if (appearance !== "dark" && appearance !== "light") {
    throw new Error(`--appearance expects dark or light, got '${appearance}'.`);
  }
  return {
    pairingUrl,
    origin: values.origin ?? new URL(pairingUrl).origin,
    scenes,
    params,
    baseDir: values["base-dir"],
    out,
    clock: values.clock ?? BAR_FIXTURE_NOW,
    checklist: checklist as ChecklistName | undefined,
    browserPath: values["browser-path"],
    appearance,
    after,
  } as const;
}

const STAGING_TIMEOUT_MS = 30_000;

/** Polls the staging checks while cards load and live rows settle; the last failures if they never pass. */
async function awaitStaging(
  page: Page,
  checks: ReadonlyArray<StagingCheck>,
): Promise<ReadonlyArray<string>> {
  const deadline = Date.now() + STAGING_TIMEOUT_MS;
  for (;;) {
    const problems = await stagingProblems(checks, playwrightProbeRoot(page));
    if (problems.length === 0 || Date.now() > deadline) return problems;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const PAIRING_PROMPT = '[data-testid="app-pairing-prompt"]';
const PAIRING_PROMPT_WAIT_MS = 15_000;

/**
 * The seeded pairing request prompts every admin client in a dialog over the
 * page. Closing it hides it in this page only, as a user dismisses it; the
 * request stays pending, so the Apps list still shows its row.
 */
async function dismissPairingPrompt(page: Page): Promise<void> {
  const prompt = page.locator(PAIRING_PROMPT);
  const shown = await prompt.waitFor({ state: "visible", timeout: PAIRING_PROMPT_WAIT_MS }).then(
    () => true,
    () => false,
  );
  if (!shown) return;
  await page.keyboard.press("Escape");
  await prompt.waitFor({ state: "hidden", timeout: 10_000 });
}

async function settle(page: Page, scene: BarWebScene): Promise<void> {
  for (const selector of scene.readySelectors) {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 60_000 });
  }
  await page.evaluate(() =>
    (
      globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }
    ).document.fonts.ready.then(() => undefined),
  );
}

/** False when the scene did not show its staged states, in which case nothing is written but the reasons. */
export async function captureScene(input: {
  readonly page: Page;
  readonly origin: string;
  readonly name: BarWebSceneName;
  readonly params: Readonly<Record<string, string>>;
  readonly out: string;
  readonly checklist?: ChecklistName;
  readonly staging?: ReadonlyArray<StagingCheck>;
  readonly pairingPending?: boolean;
}): Promise<boolean> {
  const scene = ALL_SCENES[input.name]!;
  await input.page.goto(new URL(resolveScenePath(scene, input.params), input.origin).toString());
  if (input.pairingPending === true) await dismissPairingPrompt(input.page);
  await settle(input.page, scene);
  const base = NodePath.join(input.out, input.name);
  if (input.staging !== undefined && input.staging.length > 0) {
    const problems = await awaitStaging(input.page, input.staging);
    if (problems.length > 0) {
      // A capture left from an earlier run must not pass for this one.
      for (const suffix of [".png", ".masked.png", ".probe.json"]) {
        await NodeFSP.rm(`${base}${suffix}`, { force: true });
      }
      await NodeFSP.writeFile(`${base}.staging.json`, `${JSON.stringify(problems, null, 2)}\n`);
      return false;
    }
    await NodeFSP.rm(`${base}.staging.json`, { force: true });
  }
  await input.page.screenshot({ path: `${base}.png`, animations: "disabled", caret: "hide" });
  if (input.checklist !== undefined) {
    const checklist = await loadChecklist(input.checklist);
    const checklistScene = scene.checklistScene ?? input.name;
    if (checklist.scenes.includes(checklistScene)) {
      const results = await probeScene(checklist, checklistScene, playwrightProbeRoot(input.page));
      await NodeFSP.writeFile(`${base}.probe.json`, `${JSON.stringify(results, null, 2)}\n`);
    }
  }
  const style = await input.page.addStyleTag({ path: CAPTURE_ONLY_CSS });
  await input.page.screenshot({
    path: `${base}.masked.png`,
    animations: "disabled",
    caret: "hide",
    mask: [...DEFAULT_MASKS, ...(scene.masks ?? [])].map((selector) =>
      input.page.locator(selector),
    ),
  });
  await style.evaluate((node) => (node as unknown as { remove(): void }).remove());
  return true;
}

/** Everything the live app states need before the first capture: unexpired and still staged. */
export function barAppPreflightProblems(input: {
  readonly manifest: BarAppManifest;
  readonly liveProblems: ReadonlyArray<string>;
  readonly gitProblems?: ReadonlyArray<string>;
  readonly now: number;
}): ReadonlyArray<string> {
  const { manifest } = input;
  const windows = [
    { label: "staged approval", expiresAt: manifest.approvalExpiresAt },
    {
      label: `${manifest.pendingPairing.appName} pairing request`,
      expiresAt: manifest.pendingPairing.expiresAt,
    },
  ];
  const expired = windows.flatMap(({ label, expiresAt }) =>
    input.now >= Date.parse(expiresAt)
      ? [`the ${label} expired at ${expiresAt}; seed a fresh base dir with --app`]
      : [],
  );
  return [...expired, ...input.liveProblems, ...(input.gitProblems ?? [])];
}

/**
 * One context per scene, signed in with the paired cookies only: the sidebar
 * mode and scope persist in local storage, and one scene must not set them
 * for the next.
 */
async function sceneContext(
  browser: Browser,
  options: BrowserContextOptions,
  cookies: Awaited<ReturnType<BrowserContext["cookies"]>>,
) {
  return browser.newContext({ ...options, storageState: { cookies, origins: [] } });
}

async function main(): Promise<void> {
  const args = parseCaptureWebArgs(NodeProcess.argv.slice(2));
  const params = { ...args.params };
  if (params.environmentId === undefined && args.baseDir !== undefined) {
    params.environmentId = (
      await NodeFSP.readFile(NodePath.join(args.baseDir, "userdata", "environment-id"), "utf8")
    ).trim();
  }
  // Projects mode too: its baseline row is the staged Copilot approval, and the pairing prompt
  // covers it until dismissed.
  const needsApp = args.scenes.some(isAppScene);
  let manifest: BarAppManifest | null = null;
  if (args.after || needsApp) {
    if (args.baseDir === undefined) throw new Error("App scenes need --base-dir.");
    manifest = await readBarAppManifest(args.baseDir);
    for (const [name, value] of Object.entries(barAppSceneParams(manifest))) {
      params[name] ??= value;
    }
    const snapshot = await fetchBarShellSnapshot(
      args.origin,
      await issueBarReadToken(args.baseDir),
    );
    const problems = barAppPreflightProblems({
      manifest,
      liveProblems: barAppLiveStateProblems(snapshot, manifest),
      gitProblems: await barGitStateProblems(args.baseDir),
      now: Date.now(),
    });
    if (problems.length > 0) {
      throw new Error(
        `The app fixture's live states are not as staged:\n- ${problems.join("\n- ")}`,
      );
    }
  }
  await NodeFSP.mkdir(args.out, { recursive: true });
  const browser = await chromium.launch(
    args.browserPath === undefined ? { channel: "chrome" } : { executablePath: args.browserPath },
  );
  const contextOptions: BrowserContextOptions = {
    viewport: BAR_VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: args.appearance,
    reducedMotion: "reduce",
  };
  const discarded: Array<string> = [];
  try {
    const pairing = await browser.newContext(contextOptions);
    const pairingPage = await pairing.newPage();
    await pairingPage.goto(args.pairingUrl);
    await pairingPage.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
    const cookies = await pairing.cookies();
    await pairing.close();
    for (const name of args.scenes) {
      const scene = ALL_SCENES[name]!;
      const context = await sceneContext(browser, contextOptions, cookies);
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(
          scene.clock === "staged" && manifest !== null ? manifest.stagedAt : args.clock,
        );
        const captured = await captureScene({
          page,
          origin: args.origin,
          name,
          params,
          out: args.out,
          ...(args.checklist === undefined ? {} : { checklist: args.checklist }),
          ...(manifest !== null && isAppScene(name)
            ? { staging: barAppStagingChecks(name, manifest) }
            : {}),
          pairingPending: manifest !== null,
        });
        if (captured) NodeProcess.stdout.write(`captured ${name}\n`);
        else {
          discarded.push(name);
          NodeProcess.stdout.write(`discarded ${name}: see ${name}.staging.json\n`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (discarded.length > 0) {
    throw new Error(
      `Staging checks failed, so these scenes were not captured: ${discarded.join(", ")}`,
    );
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    NodeProcess.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    NodeProcess.exit(1);
  });
}
