// @effect-diagnostics nodeBuiltinImport:off -- Test harness driving a real Electron app; it runs no Effect runtime.
/**
 * The CP1 tracer: the sidecar starts, the workspace is ensured, the embed is
 * mounted with RocketWright's theme, and one scripted turn calls
 * `ex_counter_increment` through Lecturn's app toolkit. It asserts the tool
 * row in the embed, the counter server's call log and the
 * `lecturn/context` meta Lecturn sent with the call.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { CounterCall } from "../tools/counter-mcp.ts";
import { createEmbedThread } from "./embedRpc.ts";
import { type HostGlobals, launchEmbedHost, removeDirs } from "./harness.ts";
import type { E2eContext } from "./run.ts";

const TOOL = "ex_counter_increment";
const REPLY = "Counter incremented.";
const SCRIPT = [{ toolCall: { name: TOOL, arguments: { by: 1 } } }, { assistantText: REPLY }];
const MESSAGE = `Increment the counter once.\n\n\`\`\`scripted\n${JSON.stringify(SCRIPT)}\n\`\`\``;
const TURN_TIMEOUT_MS = 90_000;

export default async function tracer({ log, artifactsDir, keep }: E2eContext): Promise<void> {
  const run = await launchEmbedHost({ scripted: true });
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
      title: "Tracer",
    });
    log(`thread ${threadId}`);
    await run.app.evaluate(
      (_electron, id) => (globalThis as HostGlobals).embedHost!.openThread(id),
      threadId,
    );

    // A9's method: the guest WebContentsView is a page of the app's context.
    const guest = await run.guestPage(`/${threadId}`);
    log(`guest ${new URL(guest.url()).pathname}`);
    const editor = guest.locator('[data-testid="composer-editor"]');
    await editor.waitFor({ state: "visible", timeout: 60_000 });
    // Pasted, so the fence arrives as one block; typing it would trip the
    // editor's code-block input rules and send on Enter.
    await editor.evaluate((element, text) => {
      (element as HTMLElement).focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, MESSAGE);
    await guest.locator("button.lecturn-composer-send:enabled").click({ timeout: 15_000 });
    log("sent the scripted turn");

    const toolRow = guest.locator('[data-timeline-row-kind="work"]').first();
    await toolRow.waitFor({ state: "visible", timeout: TURN_TIMEOUT_MS });
    await guest.getByText(REPLY).first().waitFor({ state: "visible", timeout: TURN_TIMEOUT_MS });
    const rowText = (await toolRow.evaluate((element) => element.textContent ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    log(`tool row: ${rowText}`);
    NodeAssert.match(rowText, /counter/i, "the work row names the counter tool");

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
