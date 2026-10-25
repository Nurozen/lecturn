// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Test harness driving a real Electron app and servers; it runs no Effect runtime of its own.
/**
 * Spec B2 steps 3-5 and the copy ledger (D33, D36), from a host that step 1
 * left on its sidecar:
 *
 *   3. A user server starts (temp home) with the host running; approving the
 *      pairing from an admin client switches the host live. The `mode` event
 *      carries the maps, the embed view stays mounted and reloads at the copy
 *      of its open thread, and the live lease moves to the user server. A
 *      Lecturn web client finds the copy under Apps > Embed Host > ws-a, not
 *      in Projects mode, marked "Copied from Embed Host", with its cards.
 *   4. The host closes. From the web client a turn's headless call runs, the
 *      closed banner shows, and `ex_window_flash` answers that the app is
 *      closed without reaching it.
 *   5. The host reopens; a Supervised flash is approved in the web client,
 *      then a Full-access flash runs with no approval card.
 *   ledger. The user server stops: the host falls back to its sidecar, where
 *      the copied thread is read-only with "Continued in Lecturn". Only a new
 *      sidecar thread is copied on restart. A turn held open across a copy
 *      completes on the sidecar after it and is re-copied exactly once; a
 *      later subtitle write alone re-copies nothing.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { MessageId, ThreadId } from "@lecturn/contracts";
import type { ConnectedAppThreadSummary } from "@lecturn/contracts/apps";
import { APPS_WS_METHODS as A } from "@lecturn/contracts/appsRpcCore";
import type { EmbedBridge } from "@lecturn/embed/electron";
import type { ConnectionMode, ConnectionModeEvent } from "@lecturn/embed/node";
import type { Locator, Page } from "playwright-core";

import type { FlashRecord } from "../src/liveMcp.ts";
import type { CounterCall } from "../tools/counter-mcp.ts";
import { issueAdminToken } from "./adminClient.ts";
import { createEmbedThread } from "./embedRpc.ts";
import { type CounterCard, embedPage } from "./embedPage.ts";
import { type EmbedHostGlobal, type EmbedHostRun, readJsonArray, until } from "./harness.ts";
import type { E2eContext } from "./run.ts";
import {
  appStatus,
  decide,
  dispatch,
  HOST_APP_ID,
  newCommandId,
  projectionOf,
  rpc,
  SETTINGS_SCOPES,
  setRuntimeMode,
} from "./security.ts";
import { userServer } from "./userServer.ts";
import { openWebClient, type WebClient } from "./webClient.ts";

const TURN_TIMEOUT_MS = 120_000;
const CARD_TIMEOUT_MS = 30_000;
// One watch beat finds the server, one more polls the grant, then the copy runs.
const SWITCH_TIMEOUT_MS = 60_000;
// Two missed probes, then a fresh sidecar has to start.
const FALLBACK_TIMEOUT_MS = 90_000;
const UI_TIMEOUT_MS = 30_000;

const APP_NAME = "Embed Host";
const WORKSPACE_TITLE = "ws-a";
const CLOSED_BANNER = `${APP_NAME} closed: live tools unavailable`;
const CLOSED_ERROR = `${APP_NAME} is closed; open it to use ex_window_flash.`;
const CLOSED_REPLY = "Counted once more; the window could not flash while the host was closed.";
const SUPERVISED_REPLY = "Flashed the window from Lecturn in Supervised.";
const FULL_ACCESS_REPLY = "Flashed the window from Lecturn in Full access.";
const NEW_THREAD_REPLY = "Written on the sidecar after the fallback.";
const HELD_REPLY = "The held turn finished on the sidecar.";
const SUBTITLES = ["Released", "Released again"] as const;

/** The sidecar thread step 3 copies, with the counter cards its copy must render. */
export interface SourceThread {
  readonly threadId: string;
  readonly cards: ReadonlyArray<CounterCard>;
}

interface AttachGlobals {
  readonly embedHost?: EmbedHostGlobal & { readonly embed: EmbedBridge };
}

interface Copied {
  readonly sidecarEnvironmentId: string;
  readonly sourceThreadId: string;
  readonly copyThreadId: string;
  readonly title: string;
  readonly userEnvironmentId: string;
  readonly userProjectId: string;
}

/** What a re-import would change on a copy; `updatedAt` also moves on visits, so it is left out. */
const copyMark = (thread: ConnectedAppThreadSummary) => ({
  threadId: thread.threadId,
  copiedAt: thread.copiedFrom?.copiedAt,
  sourceHistoryRevision: thread.copiedFrom?.sourceHistoryRevision,
  historyRevision: thread.historyRevision,
});

const scriptedMessage = (lead: string, steps: ReadonlyArray<unknown>) =>
  `${lead}\n\`\`\`scripted\n${JSON.stringify(steps)}\n\`\`\``;

const decodedPath = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return "";
  }
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function readJson<T>(path: string): Promise<T | null> {
  const text = await NodeFSP.readFile(path, "utf8").catch(() => null);
  return text === null ? null : (JSON.parse(text) as T);
}

const modeEvents = (run: EmbedHostRun): Promise<ReadonlyArray<ConnectionModeEvent>> =>
  run.app.evaluate(() => [...(globalThis as AttachGlobals).embedHost!.modeEvents]);

/** The first `mode` event at or after index `from` that switched to `mode`. */
const waitForMode = (
  run: EmbedHostRun,
  from: number,
  mode: ConnectionMode,
  timeoutMs: number,
): Promise<ConnectionModeEvent> =>
  until(`a mode event to ${mode}`, timeoutMs, async () =>
    (await modeEvents(run)).slice(from).find((event) => event.mode === mode),
  );

const viewState = (run: EmbedHostRun) =>
  run.app.evaluate(() => {
    const host = (globalThis as AttachGlobals).embedHost!;
    return {
      webContentsId: host.embed.webContents.id,
      generation: host.embed.generation,
      modeEventCount: host.modeEvents.length,
    };
  });

const hostThreads = (run: EmbedHostRun): Promise<ReadonlyArray<ConnectedAppThreadSummary>> =>
  run.app.evaluate(() => (globalThis as AttachGlobals).embedHost!.listThreads());

async function hostThread(run: EmbedHostRun, threadId: string) {
  const thread = (await hostThreads(run)).find((candidate) => candidate.threadId === threadId);
  NodeAssert.ok(thread, `the host lists thread ${threadId}`);
  return thread;
}

const openInEmbed = (run: EmbedHostRun, threadId: string) =>
  run.app.evaluate(
    (_electron, id) => (globalThis as AttachGlobals).embedHost!.openThread(id),
    threadId,
  );

async function setSubtitle(run: EmbedHostRun, threadId: string, subtitle: string) {
  await run.app.evaluate(
    (_electron, [id, text]) =>
      (globalThis as AttachGlobals).embedHost!.setThreadAppData(id, null, text),
    [threadId, subtitle] as const,
  );
  return until(`the subtitle "${subtitle}"`, UI_TIMEOUT_MS, async () => {
    const thread = await hostThread(run, threadId);
    return thread.subtitle === subtitle ? thread : undefined;
  });
}

const portOf = (url: string) => {
  try {
    return new URL(url).port;
  } catch {
    return "";
  }
};

/**
 * The embed guest once it shows `threadId` from the server at `origin`; a
 * retarget keeps the same page. Matched by port: the server may name its own
 * loopback host differently from the runtime record.
 */
const guestAt = (run: EmbedHostRun, origin: string, threadId: string): Promise<Page> =>
  until(`the embed guest at ${threadId} on ${origin}`, SWITCH_TIMEOUT_MS, async () =>
    run.app
      .context()
      .pages()
      .find((page) => {
        const url = page.url();
        const path = decodedPath(url);
        return (
          portOf(url) === portOf(origin) &&
          path.startsWith("/embed/") &&
          path.endsWith(`/${threadId}`)
        );
      }),
  );

/** Copies on the user server of threads from the sidecar environment, by source thread. */
function copiesOf(
  threads: ReadonlyArray<ConnectedAppThreadSummary>,
  sidecarEnvironmentId: string,
): Map<string, ReadonlyArray<ConnectedAppThreadSummary>> {
  const copies = new Map<string, Array<ConnectedAppThreadSummary>>();
  for (const thread of threads) {
    const origin = thread.copiedFrom;
    if (origin === undefined || origin.sourceEnvironmentId !== sidecarEnvironmentId) continue;
    copies.set(origin.sourceThreadId, [...(copies.get(origin.sourceThreadId) ?? []), thread]);
  }
  return copies;
}

function onlyCopy(
  copies: ReadonlyMap<string, ReadonlyArray<ConnectedAppThreadSummary>>,
  sourceThreadId: string,
): ConnectedAppThreadSummary {
  const found = copies.get(sourceThreadId) ?? [];
  NodeAssert.equal(found.length, 1, `exactly one copy of ${sourceThreadId}`);
  return found[0]!;
}

function assertCopiesUnchanged(
  before: ReadonlyMap<string, ReadonlyArray<ConnectedAppThreadSummary>>,
  after: ReadonlyMap<string, ReadonlyArray<ConnectedAppThreadSummary>>,
  label: string,
) {
  for (const [source, copies] of before) {
    NodeAssert.deepEqual(
      (after.get(source) ?? []).map(copyMark),
      copies.map(copyMark),
      `${label}: the copy of ${source} is unchanged`,
    );
  }
}

async function assistantReplied(
  origin: string,
  token: string,
  threadId: string,
  text: string,
  timeoutMs = TURN_TIMEOUT_MS,
) {
  return until(`the reply "${text}"`, timeoutMs, async () => {
    const projection = await projectionOf(origin, token, ThreadId.make(threadId));
    return projection.messages.some(
      (message) => message.role === "assistant" && message.text.includes(text),
    )
      ? projection
      : undefined;
  });
}

/** A turn sent over RPC, as the composer would send it; the script travels in the message. */
const sendScripted = (
  origin: string,
  token: string,
  threadId: string,
  lead: string,
  steps: ReadonlyArray<unknown>,
) =>
  dispatch(origin, token, {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: newCommandId(),
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(`embed-host-e2e:${NodeCrypto.randomUUID()}`),
    text: scriptedMessage(lead, steps),
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });

function assertCallContext(
  meta: unknown,
  expected: {
    readonly projectId: string;
    readonly threadId: string;
    readonly workspaceRoot: string;
  },
  label: string,
) {
  const context = (meta as Record<string, Record<string, unknown>> | null | undefined)?.[
    "lecturn/context"
  ];
  NodeAssert.ok(context, `${label} carried lecturn/context meta`);
  NodeAssert.equal(context.projectId, expected.projectId, `${label}: projectId`);
  NodeAssert.equal(context.threadId, expected.threadId, `${label}: threadId`);
  NodeAssert.equal(context.workspaceRoot, expected.workspaceRoot, `${label}: workspaceRoot`);
}

async function setSidebarMode(page: Page, label: "Apps" | "Projects") {
  const group = page.locator('[aria-label="Sidebar mode"]');
  await group.getByText(label, { exact: true }).click({ timeout: UI_TIMEOUT_MS });
  await group
    .locator(':is([aria-pressed="true"], [data-pressed])', { hasText: label })
    .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
}

/**
 * A copy lands settled, and Apps mode folds Settled by default. Found by id:
 * the title can be the first message, scripted block and all.
 */
async function appThreadRow(workspace: Locator, threadId: string): Promise<Locator> {
  const row = workspace.locator(`[data-thread-item$="${threadId}"] [data-testid="app-thread-row"]`);
  const settled = workspace.locator('button[aria-label^="Settled threads in"]');
  if (
    !(await row.isVisible()) &&
    (await settled.count()) > 0 &&
    (await settled.getAttribute("aria-expanded")) === "false"
  ) {
    await settled.click();
  }
  await row.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  return row;
}

export interface AttachFlow {
  /** The open host; null after step 4 closed it and before step 5 reopens it. */
  readonly run: EmbedHostRun | null;
  /** Reopens the host when step 4 left it closed. */
  ensureHost(): Promise<EmbedHostRun>;
  step3(source: SourceThread): Promise<void>;
  step4(): Promise<void>;
  step5(): Promise<void>;
  ledger(): Promise<void>;
  /** Stops the web client and the user server; the host is the caller's. */
  close(): Promise<void>;
  readonly output: () => string;
}

export function attachFlow(input: {
  readonly run: EmbedHostRun;
  readonly log: E2eContext["log"];
  /** Launches the host again on the same directories. */
  readonly reopen: () => Promise<EmbedHostRun>;
  /** Where the CP4 captures go; none are taken without it. */
  readonly artifactsDir?: string | undefined;
}): AttachFlow {
  const { log, artifactsDir } = input;
  const capture = async (page: Page, name: string) => {
    if (artifactsDir === undefined) return;
    const menus = page.locator('[role="menu"]').filter({ visible: true });
    if ((await menus.count()) > 0) {
      log(`closing an open menu before ${name}: ${await menus.first().innerText()}`);
      await page.keyboard.press("Escape");
      await menus.first().waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });
    }
    const path = NodePath.join(artifactsDir, name);
    await page.screenshot({ path });
    log(`captured ${path}`);
  };
  const dirs = input.run.dirs;
  const server = userServer(dirs, log);
  const countersPath = NodePath.join(dirs.workspace, ".embed-host", "counter-calls.json");
  const sidecarRuntimePath = NodePath.join(dirs.sidecarDir, "userdata", "server-runtime.json");
  const ledgerPath = NodePath.join(dirs.sidecarDir, "embed-attach.json");
  let run: EmbedHostRun | null = input.run;
  let web: WebClient | null = null;
  let copied: Copied | null = null;
  let userToken: string | null = null;
  let sidecarToken: string | null = null;

  const liveRun = () => {
    NodeAssert.ok(run, "the host is open");
    return run;
  };
  const requireCopied = () => {
    NodeAssert.ok(copied, "step 3 copied a thread");
    return copied;
  };
  const requireWeb = () => {
    NodeAssert.ok(web, "step 3 opened a Lecturn web client");
    return web;
  };
  // Sessions live in each server's database, so one token serves every restart.
  const userSettings = async () =>
    (userToken ??= await issueAdminToken(dirs.lecturnHome, SETTINGS_SCOPES));
  const sidecarSettings = async () =>
    (sidecarToken ??= await issueAdminToken(dirs.sidecarDir, SETTINGS_SCOPES));

  const ensureHost = async () => {
    run ??= await input.reopen();
    await run.refreshHost();
    return run;
  };

  /** Stops the user server and waits for the host to serve from its sidecar again. */
  const fallBack = async (host: EmbedHostRun) => {
    const from = (await modeEvents(host)).length;
    await server.stop();
    const event = await waitForMode(host, from, "sidecar", FALLBACK_TIMEOUT_MS);
    const snapshot = await host.refreshHost();
    NodeAssert.equal(snapshot.mode, "sidecar");
    log(`fell back to the sidecar ${snapshot.origin}`);
    return { event, origin: snapshot.origin, projectId: snapshot.projectId };
  };

  /** Starts the user server again; the stored credential attaches without a prompt. */
  const reattach = async (host: EmbedHostRun) => {
    const from = (await modeEvents(host)).length;
    const user = await server.start();
    const event = await waitForMode(host, from, "user-server", SWITCH_TIMEOUT_MS);
    NodeAssert.equal(event.environmentId, user.environmentId, "the same user environment");
    await host.refreshHost();
    log(`attached to the user server again`);
    return { event, user };
  };

  const step3 = async (source: SourceThread) => {
    const host = liveRun();
    const sidecar = await host.refreshHost();
    NodeAssert.equal(sidecar.mode, "sidecar", "the host starts step 3 on its sidecar");
    await openInEmbed(host, source.threadId);
    await guestAt(host, sidecar.origin, source.threadId);
    const before = await viewState(host);

    // D36: no host restart; the helper finds the new server on its own.
    const user = await server.start();
    const token = await userSettings();
    const request = await until("the host's pairing request", SWITCH_TIMEOUT_MS, async () => {
      const apps = await rpc(user.origin, token, "apps.list", (client) => client[A.appsList]({}));
      return apps.find((app) => app.appId === HOST_APP_ID)?.pendingRequest ?? undefined;
    });
    const waiting = await host.refreshHost();
    NodeAssert.equal(
      waiting.mode,
      "sidecar",
      "the host serves from its sidecar while pairing waits",
    );
    NodeAssert.equal(
      await host.app.evaluate(() => (globalThis as AttachGlobals).embedHost!.pairing),
      "pending",
      "the host reports pairing pending",
    );
    log(`step 3: pairing request ${request.requestId} on ${user.origin}`);

    const granted = await decide(user.origin, token, request.requestId, "grant");
    NodeAssert.equal(granted.state, "granted");
    const event = await waitForMode(host, before.modeEventCount, "user-server", SWITCH_TIMEOUT_MS);
    log(`mode event ${JSON.stringify(event)}`);
    NodeAssert.equal(
      event.environmentId,
      user.environmentId,
      "the mode event names the user server",
    );
    const userProjectId = event.projectIdsByWorkspaceRoot[dirs.workspace];
    NodeAssert.ok(userProjectId, "the mode event maps ws-a to its user-server project");
    const copyThreadId = event.threadIdMap[source.threadId];
    NodeAssert.ok(copyThreadId, "the mode event maps the open thread to its copy");

    const after = await viewState(host);
    NodeAssert.equal(after.webContentsId, before.webContentsId, "the embed view stayed mounted");
    NodeAssert.ok(after.generation > before.generation, "the retarget bumped the generation");
    await guestAt(host, user.origin, copyThreadId);
    const switched = await host.refreshHost();
    NodeAssert.equal(switched.mode, "user-server");
    NodeAssert.equal(switched.origin, user.origin);
    NodeAssert.equal(switched.projectId, userProjectId);
    NodeAssert.notEqual(
      (await appStatus(user.origin, token, HOST_APP_ID)).live,
      null,
      "the live lease is on the user server",
    );
    const copy = await hostThread(host, copyThreadId);
    NodeAssert.equal(copy.copiedFrom?.sourceThreadId, source.threadId);
    NodeAssert.equal(copy.copiedFrom?.sourceEnvironmentId, sidecar.environmentId);
    log(`switched live: copy ${copyThreadId} in project ${userProjectId}`);

    web = await openWebClient({ root: dirs.root, baseDir: dirs.lecturnHome });
    const page = web.page;
    // Apps mode first: once the copy shows there, the shell has loaded, so its
    // absence from Projects mode below means something.
    await setSidebarMode(page, "Apps");
    await page.locator(`[aria-label="Show only ${APP_NAME}"]`).click({ timeout: UI_TIMEOUT_MS });
    const workspace = page.locator('[data-testid="sidebar-app-workspace"]', {
      hasText: WORKSPACE_TITLE,
    });
    await workspace.first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    const row = await appThreadRow(workspace.first(), copyThreadId);
    await row.click();
    await until("the copied thread to open", UI_TIMEOUT_MS, async () =>
      decodedPath(page.url()).endsWith(`/${copyThreadId}`) ? true : undefined,
    );
    await page
      .locator(`[aria-label="Copied from ${APP_NAME}"]`)
      .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    const cards = await embedPage(page).loadedCards(source.cards.length, CARD_TIMEOUT_MS);
    log(`copied cards ${JSON.stringify(cards)}`);
    NodeAssert.deepEqual(cards, source.cards, "the copied cards render with their results");
    await capture(page, "cp4-copied-thread-apps.png");

    await setSidebarMode(page, "Projects");
    const listedInProjects = await page.evaluate(
      (id) =>
        [...document.querySelectorAll("[data-thread-item]")].some((element) =>
          (element.getAttribute("data-thread-item") ?? "").endsWith(id),
        ),
      copyThreadId,
    );
    NodeAssert.equal(listedInProjects, false, "Projects mode does not list the copy");
    NodeAssert.equal(
      await page
        .locator('[data-slot="sidebar"]')
        .getByText(WORKSPACE_TITLE, { exact: true })
        .count(),
      0,
      "Projects mode does not list the app's workspace",
    );
    await setSidebarMode(page, "Apps");
    log("web client: the copy is under Apps > Embed Host > ws-a and not in Projects mode");

    copied = {
      sidecarEnvironmentId: sidecar.environmentId,
      sourceThreadId: source.threadId,
      copyThreadId,
      title: copy.title,
      userEnvironmentId: user.environmentId,
      userProjectId,
    };
  };

  const step4 = async () => {
    const copy = requireCopied();
    const page = requireWeb().page;
    const user = server.current;
    const token = await userSettings();
    // Full access, so the error below can only come from the lease check, never an approval.
    await setRuntimeMode(user.origin, token, ThreadId.make(copy.copyThreadId), "full-access");

    await liveRun().close();
    run = null;
    await until("the host's live lease to clear", UI_TIMEOUT_MS, async () =>
      (await appStatus(user.origin, token, HOST_APP_ID)).live === null ? true : undefined,
    );
    log("step 4: closed the host");

    const lecturn = embedPage(page);
    await page
      .getByText(CLOSED_BANNER)
      .first()
      .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    // The copy landed settled, which shows Unsettle in place of the composer.
    await page.getByRole("button", { name: "Unsettle thread" }).click({ timeout: UI_TIMEOUT_MS });
    await lecturn.waitForRuntimeMode("Full access");
    const countsBefore = (await readJsonArray<CounterCall>(countersPath)).length;
    const flashesBefore = await readJsonArray<FlashRecord>(dirs.flashLog);
    await lecturn.send(
      scriptedMessage("Count once more, then flash the window.", [
        { toolCall: { name: "ex_counter_increment", arguments: { by: 1 } } },
        {
          // One try that must return the closed error: any other answer fails the turn.
          poll: {
            toolCall: { name: "ex_window_flash", arguments: { color: "red" } },
            until: { path: "content.0.text", equals: CLOSED_ERROR },
            maxTries: 1,
            intervalMs: 0,
          },
        },
        { assistantText: CLOSED_REPLY },
      ]),
    );
    await assistantReplied(user.origin, token, copy.copyThreadId, CLOSED_REPLY);

    const counts = await readJsonArray<CounterCall>(countersPath);
    NodeAssert.equal(counts.length, countsBefore + 1, "the headless counter ran once");
    assertCallContext(
      counts.at(-1)!._meta,
      {
        projectId: copy.userProjectId,
        threadId: copy.copyThreadId,
        workspaceRoot: dirs.workspace,
      },
      "the headless call",
    );
    NodeAssert.deepEqual(
      await readJsonArray<FlashRecord>(dirs.flashLog),
      flashesBefore,
      "the closed host was never asked to flash",
    );
    log(`step 4: headless call ran; ex_window_flash answered "${CLOSED_ERROR}"`);
  };

  const step5 = async () => {
    const copy = requireCopied();
    const page = requireWeb().page;
    const user = server.current;
    const token = await userSettings();
    NodeAssert.equal(run, null, "step 4 closed the host");

    const host = await ensureHost();
    NodeAssert.equal(
      host.host.mode,
      "user-server",
      "the reopened host attaches to the user server",
    );
    NodeAssert.equal(host.host.environmentId, user.environmentId);
    NodeAssert.equal(host.host.projectId, copy.userProjectId);
    await until("the reopened host's live lease", UI_TIMEOUT_MS, async () =>
      (await appStatus(user.origin, token, HOST_APP_ID)).live === null ? undefined : true,
    );
    await page
      .getByText(CLOSED_BANNER)
      .first()
      .waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });
    log("step 5: reopened the host on the user server");

    const lecturn = embedPage(page);
    const context = {
      projectId: copy.userProjectId,
      threadId: copy.copyThreadId,
      workspaceRoot: dirs.workspace,
    };
    const threadId = ThreadId.make(copy.copyThreadId);
    const flashesBefore = (await readJsonArray<FlashRecord>(dirs.flashLog)).length;

    await setRuntimeMode(user.origin, token, threadId, "approval-required");
    await lecturn.waitForRuntimeMode("Supervised");
    await lecturn.send(
      scriptedMessage("Flash the window from Lecturn.", [
        { expectApproval: true },
        { toolCall: { name: "ex_window_flash", arguments: { color: "gold" } } },
        { assistantText: SUPERVISED_REPLY },
      ]),
    );
    await lecturn.approve("ex_window_flash", TURN_TIMEOUT_MS);
    log("approved ex_window_flash in the web client");
    await assistantReplied(user.origin, token, copy.copyThreadId, SUPERVISED_REPLY);
    const supervised = await until("the Supervised flash", UI_TIMEOUT_MS, async () => {
      const flashes = await readJsonArray<FlashRecord>(dirs.flashLog);
      return flashes.length === flashesBefore + 1 ? flashes.at(-1) : undefined;
    });
    NodeAssert.equal(supervised.color, "gold");
    assertCallContext({ "lecturn/context": supervised.context }, context, "the Supervised flash");
    const approval = supervised.approval as {
      readonly approved?: unknown;
      readonly requestId?: unknown;
    };
    NodeAssert.equal(approval.approved, true);
    NodeAssert.equal(typeof approval.requestId, "string", "the approved flash names its request");

    await setRuntimeMode(user.origin, token, threadId, "full-access");
    await lecturn.waitForRuntimeMode("Full access");
    const seenApprovals = await lecturn.watchApprovalCards();
    await lecturn.send(
      scriptedMessage("Flash the window again.", [
        { expectApproval: true },
        { toolCall: { name: "ex_window_flash", arguments: { color: "teal" } } },
        { assistantText: FULL_ACCESS_REPLY },
      ]),
    );
    await assistantReplied(user.origin, token, copy.copyThreadId, FULL_ACCESS_REPLY);
    const full = await until("the Full-access flash", UI_TIMEOUT_MS, async () => {
      const flashes = await readJsonArray<FlashRecord>(dirs.flashLog);
      return flashes.length === flashesBefore + 2 ? flashes.at(-1) : undefined;
    });
    NodeAssert.equal(full.color, "teal");
    assertCallContext({ "lecturn/context": full.context }, context, "the Full-access flash");
    NodeAssert.deepEqual(full.approval, { approved: true }, "approved in advance, with no request");
    NodeAssert.deepEqual(await seenApprovals(), [], "no approval card in Full access");
    log("step 5: Supervised flash approved in Lecturn; Full-access flash ran with no card");
  };

  const ledger = async () => {
    const copy = requireCopied();
    const host = await ensureHost();
    NodeAssert.equal(host.host.mode, "user-server", "the ledger step starts on the user server");
    await openInEmbed(host, copy.copyThreadId);
    await guestAt(host, server.current.origin, copy.copyThreadId);
    const { sidecarEnvironmentId } = copy;
    const copies0 = copiesOf(await hostThreads(host), sidecarEnvironmentId);

    // Fallback: the copied thread is read-only on the sidecar and points at its copy.
    const fallback1 = await fallBack(host);
    NodeAssert.equal(
      fallback1.event.threadIdMap[copy.copyThreadId],
      copy.sourceThreadId,
      "the mode event maps the copy back to its sidecar thread",
    );
    NodeAssert.equal(fallback1.event.environmentId, sidecarEnvironmentId, "the same sidecar");
    const guest = await guestAt(host, fallback1.origin, copy.sourceThreadId);
    await guest
      .locator('[data-embed-continued="true"]')
      .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
    await guest
      .getByText("Continued in Lecturn")
      .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    const link = await guest
      .getByRole("link", { name: "Open in Lecturn" })
      .getAttribute("href", { timeout: UI_TIMEOUT_MS });
    NodeAssert.equal(
      link === null ? null : decodeURIComponent(link),
      `lecturn://apps/${HOST_APP_ID}/threads/${copy.userEnvironmentId}/${copy.copyThreadId}`,
      "the notice links to the copy",
    );
    // The composer stays mounted under the notice; embed.css hides it (D33).
    NodeAssert.equal(
      await guest.locator('[data-testid="composer-editor"]').filter({ visible: true }).count(),
      0,
      "the copied thread has no composer on the sidecar",
    );
    // Read back in full: the copied history's card, not just the notice.
    await embedPage(guest).loadedCards(1, CARD_TIMEOUT_MS);
    await capture(guest, "cp4-continued-in-lecturn.png");
    log("ledger: the copied thread is read-only on the sidecar with its link");

    // A new sidecar thread: the next attach copies it and nothing else.
    const sidecarAdmin = await sidecarSettings();
    const embedToken = async () =>
      (await host.app.evaluate(() => (globalThis as AttachGlobals).embedHost!.embedTarget())).token;
    const newThreadId = await createEmbedThread({
      origin: fallback1.origin,
      embedToken: await embedToken(),
      projectId: fallback1.projectId,
      title: "After fallback",
    });
    await sendScripted(fallback1.origin, sidecarAdmin, newThreadId, "Write on the sidecar.", [
      { assistantText: NEW_THREAD_REPLY },
    ]);
    await assistantReplied(fallback1.origin, sidecarAdmin, newThreadId, NEW_THREAD_REPLY);

    const attach1 = await reattach(host);
    const copies1 = copiesOf(await hostThreads(host), sidecarEnvironmentId);
    const newCopy = onlyCopy(copies1, newThreadId);
    NodeAssert.equal(attach1.event.threadIdMap[newThreadId], newCopy.threadId);
    NodeAssert.deepEqual(
      [...copies1.keys()].sort(),
      [...copies0.keys(), newThreadId].sort(),
      "the attach copied only the new thread",
    );
    assertCopiesUnchanged(copies0, copies1, "the attach after the fallback");
    log(`ledger: only the new thread was copied (${newCopy.threadId})`);

    // Re-copy (decisions 13 and 19): a turn held open across a copy.
    const fallback2 = await fallBack(host);
    const heldId = await createEmbedThread({
      origin: fallback2.origin,
      embedToken: await embedToken(),
      projectId: fallback2.projectId,
      title: "Held turn",
    });
    const releasePath = NodePath.join(dirs.root, "release");
    await sendScripted(fallback2.origin, sidecarAdmin, heldId, "Wait for the release file.", [
      { hold: { until: releasePath } },
      { assistantText: HELD_REPLY },
    ]);
    await until("the held turn to run", TURN_TIMEOUT_MS, async () =>
      (await hostThread(host, heldId)).state === "running" ? true : undefined,
    );
    const sidecarPid = (await readJson<{ readonly pid: number }>(sidecarRuntimePath))?.pid;
    NodeAssert.ok(sidecarPid !== undefined, "the sidecar recorded its pid");

    const attach2 = await reattach(host);
    const copies2 = copiesOf(await hostThreads(host), sidecarEnvironmentId);
    assertCopiesUnchanged(copies1, copies2, "the mid-turn attach");
    const midCopy = onlyCopy(copies2, heldId);
    NodeAssert.equal(attach2.event.threadIdMap[heldId], midCopy.threadId);
    const midRevision = midCopy.copiedFrom!.sourceHistoryRevision;
    const userToken = await userSettings();
    const midProjection = await projectionOf(
      attach2.user.origin,
      userToken,
      ThreadId.make(midCopy.threadId),
    );
    NodeAssert.ok(
      // The user's message names the reply in its script, so only replies count.
      !midProjection.messages.some(
        (message) => message.role === "assistant" && message.text.includes(HELD_REPLY),
      ),
      "the copy was taken before the held turn finished",
    );
    // D33: the sidecar, lease included, stays up while its turn runs.
    NodeAssert.ok(isAlive(sidecarPid), "the sidecar keeps running the held turn");
    NodeAssert.notEqual(
      (await appStatus(fallback2.origin, await sidecarSettings(), HOST_APP_ID)).live,
      null,
      "the sidecar keeps its live lease while it drains",
    );
    log(`ledger: copied ${heldId} mid-turn at revision ${midRevision}`);

    await NodeFSP.writeFile(releasePath, "");
    await until("the sidecar to drain once the held turn ends", TURN_TIMEOUT_MS, async () =>
      isAlive(sidecarPid) ? undefined : true,
    );
    const ledgerAfterDrain = await readJson<{ readonly pendingCopy: boolean }>(ledgerPath);
    NodeAssert.equal(
      ledgerAfterDrain?.pendingCopy,
      true,
      "the ledger keeps a copy due for history the user server lacks",
    );
    log("ledger: released; the sidecar drained with a copy due");

    // The turn completed normally on the sidecar, after the copy.
    const fallback3 = await fallBack(host);
    const heldProjection = await projectionOf(
      fallback3.origin,
      sidecarAdmin,
      ThreadId.make(heldId),
    );
    NodeAssert.ok(
      heldProjection.messages.some(
        (message) => message.role === "assistant" && message.text.includes(HELD_REPLY),
      ),
      "the held turn's final message is persisted on the sidecar",
    );
    const lastRun = [...heldProjection.runs].sort((a, b) => a.ordinal - b.ordinal).at(-1);
    NodeAssert.equal(lastRun?.status, "completed", "the held turn completed normally");
    const released = await hostThread(host, heldId);
    NodeAssert.ok(
      released.historyRevision > midRevision,
      `history moved past the copy (${released.historyRevision} > ${midRevision})`,
    );
    const subtitled = await setSubtitle(host, heldId, SUBTITLES[0]);
    NodeAssert.equal(
      subtitled.historyRevision,
      released.historyRevision,
      "a subtitle is not history",
    );

    await reattach(host);
    const copies3 = copiesOf(await hostThreads(host), sidecarEnvironmentId);
    const recopy = onlyCopy(copies3, heldId);
    NodeAssert.equal(
      recopy.threadId,
      midCopy.threadId,
      "the history-only copy is replaced in place",
    );
    NodeAssert.equal(
      recopy.copiedFrom?.sourceHistoryRevision,
      released.historyRevision,
      "the re-copy records the new revision",
    );
    for (const source of [copy.sourceThreadId, newThreadId]) {
      NodeAssert.deepEqual(
        (copies3.get(source) ?? []).map(copyMark),
        (copies2.get(source) ?? []).map(copyMark),
        `the copy of ${source} is unchanged by the re-copy`,
      );
    }
    await assistantReplied(
      server.current.origin,
      userToken,
      recopy.threadId,
      HELD_REPLY,
      UI_TIMEOUT_MS,
    );
    log(`ledger: re-copied ${heldId} once at revision ${released.historyRevision}`);

    // A subtitle write alone moves `updatedAt` but copies nothing.
    await fallBack(host);
    const beforeSubtitle = await hostThread(host, heldId);
    const resubtitled = await setSubtitle(host, heldId, SUBTITLES[1]);
    NodeAssert.ok(
      Date.parse(resubtitled.updatedAt) > Date.parse(beforeSubtitle.updatedAt),
      "the subtitle write moved updatedAt",
    );
    NodeAssert.equal(resubtitled.historyRevision, released.historyRevision);

    await reattach(host);
    const copies4 = copiesOf(await hostThreads(host), sidecarEnvironmentId);
    assertCopiesUnchanged(copies3, copies4, "the attach after a subtitle write");
    NodeAssert.equal(
      onlyCopy(copies4, heldId).subtitle,
      SUBTITLES[0],
      "the copy keeps the subtitle it was copied with",
    );
    await until("the ledger to settle once nothing is due", TURN_TIMEOUT_MS, async () =>
      (await readJson<{ readonly pendingCopy: boolean }>(ledgerPath))?.pendingCopy === false
        ? true
        : undefined,
    );
    log("ledger: the subtitle write re-copied nothing; the ledger settled");
  };

  return {
    get run() {
      return run;
    },
    ensureHost,
    step3,
    step4,
    step5,
    ledger,
    close: async () => {
      await web?.close();
      web = null;
      await server.stop();
    },
    output: () => server.output(),
  };
}
