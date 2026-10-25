#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Host-side browser capture tooling writing PNG and JSON files.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { chromium, type Page } from "playwright-core";

import { BAR_FIXTURE_NOW } from "../seed-bar-fixture.ts";
import {
  CHECKLIST_NAMES,
  type ChecklistName,
  loadChecklist,
  playwrightProbeRoot,
  probeScene,
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
export type BarWebSceneName = keyof typeof BAR_WEB_SCENES;

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
    },
  });
  const pairingUrl = values["pairing-url"];
  const out = values.out;
  if (pairingUrl === undefined || out === undefined) {
    throw new Error(
      `Usage: node scripts/bar/capture-web.ts --pairing-url <url> --out <dir> [--scene <name>]... [--param name=value]... [--base-dir <dir>] [--clock <iso>] [--checklist ${CHECKLIST_NAMES.join("|")}] [--browser-path <chrome>] [--appearance dark|light]\nScenes: ${Object.keys(BAR_WEB_SCENES).join(", ")}`,
    );
  }
  const scenes = (values.scene ?? Object.keys(BAR_WEB_SCENES)).map((name) => {
    if (!Object.hasOwn(BAR_WEB_SCENES, name)) throw new Error(`Unknown scene '${name}'.`);
    return name as BarWebSceneName;
  });
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
  } as const;
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

export async function captureScene(input: {
  readonly page: Page;
  readonly origin: string;
  readonly name: BarWebSceneName;
  readonly params: Readonly<Record<string, string>>;
  readonly out: string;
  readonly checklist?: ChecklistName;
}): Promise<void> {
  const scene: BarWebScene = BAR_WEB_SCENES[input.name];
  await input.page.goto(new URL(resolveScenePath(scene, input.params), input.origin).toString());
  await settle(input.page, scene);
  const base = NodePath.join(input.out, input.name);
  await input.page.screenshot({ path: `${base}.png`, animations: "disabled", caret: "hide" });
  if (input.checklist !== undefined) {
    const checklist = await loadChecklist(input.checklist);
    if (checklist.scenes.includes(input.name)) {
      const results = await probeScene(checklist, input.name, playwrightProbeRoot(input.page));
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
}

async function main(): Promise<void> {
  const args = parseCaptureWebArgs(NodeProcess.argv.slice(2));
  const params = { ...args.params };
  if (params.environmentId === undefined && args.baseDir !== undefined) {
    params.environmentId = (
      await NodeFSP.readFile(NodePath.join(args.baseDir, "userdata", "environment-id"), "utf8")
    ).trim();
  }
  await NodeFSP.mkdir(args.out, { recursive: true });
  const browser = await chromium.launch(
    args.browserPath === undefined ? { channel: "chrome" } : { executablePath: args.browserPath },
  );
  try {
    const context = await browser.newContext({
      viewport: BAR_VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: args.appearance,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(args.clock);
    await page.goto(args.pairingUrl);
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
    for (const name of args.scenes) {
      await captureScene({
        page,
        origin: args.origin,
        name,
        params,
        out: args.out,
        ...(args.checklist === undefined ? {} : { checklist: args.checklist }),
      });
      NodeProcess.stdout.write(`captured ${name}\n`);
    }
  } finally {
    await browser.close();
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
