// @effect-diagnostics nodeBuiltinImport:off -- Test harness driving a real Electron app; it runs no Effect runtime.
/**
 * The CP1 tracer: the sidecar starts, the workspace is ensured, the embed is
 * mounted with RocketWright's theme under the host's own pane header, and
 * one scripted turn calls `ex_counter_increment` through Lecturn's app
 * toolkit. It asserts the header, the user's plain message, the tool's card
 * row with its card loaded and showing the result, the counter server's call
 * log and the `lecturn/context` meta Lecturn sent with the call.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { Page } from "playwright-core";

import type { CounterCall } from "../tools/counter-mcp.ts";
import { createEmbedThread } from "./embedRpc.ts";
import { type HostGlobals, launchEmbedHost, removeDirs, until } from "./harness.ts";
import type { E2eContext } from "./run.ts";

const TOOL = "ex_counter_increment";
const MESSAGE = "Increment the counter";
const REPLY = "Counter incremented.";
const THREAD_TITLE = "Tracer";
// From the scripts file, keyed by turn index, so the message stays what a user types.
const SCRIPTS = {
  1: [{ toolCall: { name: TOOL, arguments: { by: 1 } } }, { assistantText: REPLY }],
};
const TURN_TIMEOUT_MS = 90_000;
const CARD_TIMEOUT_MS = 30_000;

/** The header the host draws above the pane, and the embed view laid exactly over the pane below it. */
async function assertPaneHeader(run: Awaited<ReturnType<typeof launchEmbedHost>>, title: string) {
  const host = await run.hostPage();
  await host
    .locator("#pane-title", { hasText: title })
    .waitFor({ state: "visible", timeout: 30_000 });
  const layout = await host.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const header = rect(".pane-header");
    const pane = rect("#pane");
    return {
      headerBottom: Math.round(header.bottom),
      pane: {
        x: Math.round(pane.left),
        y: Math.round(pane.top),
        width: Math.round(pane.width),
        height: Math.round(pane.height),
      },
      controls: ["#pane-menu-button", "#pane-open"].filter((s) => document.querySelector(s)),
    };
  });
  NodeAssert.deepEqual(layout.controls, ["#pane-menu-button", "#pane-open"]);
  NodeAssert.ok(layout.headerBottom > 0, "the pane header has height");
  NodeAssert.equal(layout.pane.y, layout.headerBottom, "the pane starts under the header");
  const view = await until("the embed view to cover the pane", 10_000, async () => {
    const views = await run.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) => child.getBounds()),
    );
    return views.find((bounds) => JSON.stringify(bounds) === JSON.stringify(layout.pane));
  });
  return { headerBottom: layout.headerBottom, view };
}

/** Fails as soon as the card row shows its load error; resolves once the card shows the result. */
async function assertCardLoaded(guest: Page) {
  const row = guest.locator('[data-timeline-row-kind="mcp-app"]');
  const rows = await row.count();
  const workRows = await guest.locator('[data-timeline-row-kind="work"]').allTextContents();
  NodeAssert.equal(
    rows,
    1,
    `one card row for ${TOOL} (it declares _meta.ui.resourceUri); work rows: ${JSON.stringify(workRows)}`,
  );
  const unable = row.getByText(/Unable to load/);
  const card = row.frameLocator("iframe").locator(".card");
  return until("the counter card to load", CARD_TIMEOUT_MS, async () => {
    if ((await unable.count()) > 0) {
      throw new Error(`The counter card failed: ${(await unable.first().textContent())?.trim()}`);
    }
    if ((await card.count()) === 0) return undefined;
    const state = await card.getAttribute("data-state");
    if (state === "pending") return undefined;
    return { state, count: (await card.locator("#count").textContent())?.trim() };
  });
}

export default async function tracer({ log, artifactsDir, keep }: E2eContext): Promise<void> {
  const run = await launchEmbedHost({ scripted: true, scripts: SCRIPTS });
  try {
    const { host, dirs } = run;
    log(`sidecar ${host.origin} (environment ${host.environmentId})`);
    log(`workspace ${host.workspaceRoot} -> project ${host.projectId}`);
    NodeAssert.equal(host.workspaceRoot, dirs.workspace);

    const target = await run.app.evaluate(() =>
      (globalThis as HostGlobals).embedHost!.embedTarget(),
    );
    const threadId = await createEmbedThread({
      origin: host.origin,
      embedToken: target.token,
      projectId: host.projectId,
      title: THREAD_TITLE,
    });
    log(`thread ${threadId}`);
    await run.app.evaluate(
      (_electron, id) => (globalThis as HostGlobals).embedHost!.openThread(id),
      threadId,
    );

    // A9's method: the guest WebContentsView is a page of the app's context.
    const guest = await run.guestPage(`/${threadId}`);
    log(`guest ${new URL(guest.url()).pathname}`);
    const header = await assertPaneHeader(run, THREAD_TITLE);
    log(
      `pane header "${THREAD_TITLE}" (${header.headerBottom} px); embed view ${JSON.stringify(header.view)}`,
    );

    const editor = guest.locator('[data-testid="composer-editor"]');
    await editor.waitFor({ state: "visible", timeout: 60_000 });
    await editor.evaluate((element, text) => {
      (element as HTMLElement).focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, MESSAGE);
    await guest.locator("button.lecturn-composer-send:enabled").click({ timeout: 15_000 });
    log("sent the turn");

    await guest.getByText(REPLY).first().waitFor({ state: "visible", timeout: TURN_TIMEOUT_MS });
    const userText = (
      await guest.locator('[data-message-role="user"]').first().textContent({ timeout: 5_000 })
    )
      ?.replace(/\s+/g, " ")
      .trim();
    log(`user message: ${userText}`);
    NodeAssert.ok(userText?.includes(MESSAGE), "the user bubble shows the typed message");
    NodeAssert.doesNotMatch(userText ?? "", /scripted|toolCall/, "no script in the user bubble");

    const card = await assertCardLoaded(guest);
    log(`card row (mcp-app): state ${card.state}, count ${card.count}`);
    NodeAssert.equal(card.state, "saved", "the card received a successful tool result");
    NodeAssert.equal(card.count, "1", "the card shows the counter's new value");

    const callsPath = NodePath.join(dirs.workspace, ".embed-host", "counter-calls.json");
    const calls = JSON.parse(await NodeFSP.readFile(callsPath, "utf8")) as Array<CounterCall>;
    NodeAssert.equal(calls.length, 1, "exactly one counter call reached the headless server");
    const [call] = calls;
    NodeAssert.equal(call!.value, 1);
    const meta = call!._meta as Record<string, unknown> | null;
    const context = meta?.["lecturn/context"] as Record<string, unknown> | undefined;
    log(`lecturn/context ${JSON.stringify(context)}`);
    NodeAssert.ok(context, "the call carried lecturn/context meta");
    NodeAssert.equal(context.projectId, host.projectId);
    NodeAssert.equal(context.threadId, threadId);
    NodeAssert.equal(context.workspaceRoot, dirs.workspace);
    NodeAssert.ok(
      context.turnId === null || typeof context.turnId === "string",
      "turnId is a string or null",
    );

    if (artifactsDir !== undefined) {
      const file = NodePath.join(artifactsDir, "embed-host-embed.png");
      await run.app.evaluate(
        (_electron, path) => (globalThis as HostGlobals).embedHost!.capture(path),
        file,
      );
      log(`captured ${file}`);
    }
  } catch (error) {
    log(`--- embed-host output ---\n${run.output()}`);
    throw error;
  } finally {
    await run.close();
    if (keep) log(`kept ${run.dirs.root}`);
    else await removeDirs(run.dirs);
  }
}
