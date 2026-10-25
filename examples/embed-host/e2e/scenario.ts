// @effect-diagnostics nodeBuiltinImport:off -- Test harness driving a real Electron app; it runs no Effect runtime.
/**
 * The gold scenario (spec B2), automated with the scripted provider so every
 * tool call is exact and goes through Lecturn's real app toolkit. Steps are
 * B2's numbers; `vp run --filter embed-host e2e -- --steps 1,2` runs a subset.
 *
 *   1. No user server: the host starts the sidecar, registers, ensures `ws-a`
 *      and mounts the embed view.
 *   2. A Supervised turn makes two `ex_counter_increment` calls and a gated
 *      `ex_window_flash`, approved in the embed; both counter cards render,
 *      the host records the flash, `lecturn/turn.state` goes idle → running →
 *      awaiting-approval → running → idle, and every call carries the right
 *      `lecturn/context`. Then the same flash in Full access and in Auto runs
 *      with no approval card.
 *   7. Revoke and re-pair (security.ts).
 *   8. The trust boundary: refusals over RPC, the shell stream and MCP,
 *      framing, and re-approval of a changed command (security.ts).
 *
 * Step 7 runs after step 8: it leaves the host without a credential.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { EmbedBridge } from "@lecturn/embed/electron";

import type { FlashRecord } from "../src/liveMcp.ts";
import type { CounterCall } from "../tools/counter-mcp.ts";
import { adminClient, issueAdminToken } from "./adminClient.ts";
import { createEmbedThread } from "./embedRpc.ts";
import { embedPage } from "./embedPage.ts";
import { step7, step8 } from "./security.ts";
import {
  type EmbedHostGlobal,
  type EmbedHostRun,
  launchEmbedHost,
  removeDirs,
  until,
} from "./harness.ts";
import type { E2eContext } from "./run.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const SCRIPTS_FILE = NodePath.join(here, "scripts", "b2-steps-1-2.scripted.json");
export const AUTOMATED_STEPS: ReadonlyArray<number> = [1, 2, 7, 8];

const TURN_TIMEOUT_MS = 120_000;
const CARD_TIMEOUT_MS = 30_000;
const THREAD_TITLE = "Scenario";

/** One turn per scripts-file entry, keyed by the same turn index. */
const SUPERVISED_TURN = {
  message: "Count to two, then flash the window",
  reply: "Counted to two and flashed the window.",
};
const UNPROMPTED_TURNS = [
  {
    mode: "full-access",
    label: "Full access",
    message: "Flash the window again",
    reply: "Flashed the window in Full access.",
    color: "teal",
  },
  {
    mode: "auto",
    label: "Auto",
    message: "And once more",
    reply: "Flashed the window in Auto.",
    color: "plum",
  },
] as const;

interface TurnStateEvent {
  readonly threadId: string;
  readonly state: string;
}

/** What this scenario adds to main.ts's globals, for `app.evaluate` callbacks. */
interface ScenarioGlobals {
  readonly embedHost?: EmbedHostGlobal & { readonly embed: EmbedBridge };
  scenarioTurnStates?: Array<TurnStateEvent>;
}

const collapse = (states: ReadonlyArray<string>) =>
  states.filter((state, index) => index === 0 || states[index - 1] !== state);

async function readJsonArray<T>(path: string): Promise<Array<T>> {
  if (!NodeFS.existsSync(path)) return [];
  return JSON.parse(await NodeFSP.readFile(path, "utf8")) as Array<T>;
}

function assertContext(
  run: EmbedHostRun,
  threadId: string,
  label: string,
  meta: Record<string, unknown> | null | undefined,
) {
  NodeAssert.ok(meta, `${label} carried lecturn/context meta`);
  NodeAssert.equal(meta.projectId, run.host.projectId, `${label}: projectId`);
  NodeAssert.equal(meta.threadId, threadId, `${label}: threadId`);
  NodeAssert.equal(meta.workspaceRoot, run.dirs.workspace, `${label}: workspaceRoot`);
  NodeAssert.ok(
    meta.turnId === null || typeof meta.turnId === "string",
    `${label}: turnId is a string or null`,
  );
}

/** Step 1: the host is on its own sidecar, the workspace is ensured and the embed is mounted. */
async function step1(run: EmbedHostRun, log: E2eContext["log"]) {
  const { host, dirs } = run;
  const userServer = NodePath.join(dirs.lecturnHome, "userdata", "server-runtime.json");
  NodeAssert.ok(!NodeFS.existsSync(userServer), "no user server is running");
  const sidecar = JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(dirs.sidecarDir, "userdata", "server-runtime.json"),
      "utf8",
    ),
  ) as { readonly origin?: string; readonly port?: number };
  NodeAssert.equal(
    new URL(host.origin).port,
    String(sidecar.port),
    "the host talks to the sidecar it started",
  );
  NodeAssert.equal(host.workspaceRoot, dirs.workspace, "ws-a is the ensured workspace");
  NodeAssert.ok(host.projectId.length > 0, "ensureWorkspace returned a project");
  const guest = await run.guestPage(`/embed/${host.environmentId}/${host.projectId}`, 60_000);
  log(
    `step 1: sidecar ${host.origin}, project ${host.projectId}, embed ${new URL(guest.url()).pathname}`,
  );
}

/** Step 2: the Supervised turn, then the same gated flash in Full access and in Auto. */
async function step2(run: EmbedHostRun, log: E2eContext["log"]) {
  const { host, dirs } = run;
  const countersPath = NodePath.join(dirs.workspace, ".embed-host", "counter-calls.json");

  await run.app.evaluate(() => {
    const globals = globalThis as ScenarioGlobals;
    const states: Array<TurnStateEvent> = [];
    globals.scenarioTurnStates = states;
    globals.embedHost!.embed.on("lecturn/turn.state", (event) => {
      states.push({ threadId: event.threadId, state: event.state });
    });
  });
  const turnStates = async (threadId: string) =>
    (await run.app.evaluate(() => [...((globalThis as ScenarioGlobals).scenarioTurnStates ?? [])]))
      .filter((event) => event.threadId === threadId)
      .map((event) => event.state);

  const target = await run.app.evaluate(() =>
    (globalThis as ScenarioGlobals).embedHost!.embedTarget(),
  );
  const threadId = await createEmbedThread({
    origin: host.origin,
    embedToken: target.token,
    projectId: host.projectId,
    title: THREAD_TITLE,
  });
  const admin = adminClient({ origin: host.origin, token: await issueAdminToken(dirs.sidecarDir) });
  await admin.setRuntimeMode(threadId, "approval-required");
  log(`step 2: thread ${threadId} in Supervised`);

  await run.app.evaluate(
    (_electron, id) => (globalThis as ScenarioGlobals).embedHost!.openThread(id),
    threadId,
  );
  const page = embedPage(await run.guestPage(`/${threadId}`));
  await page.waitForRuntimeMode("Supervised");

  await page.send(SUPERVISED_TURN.message);
  await page.waitForApproval("ex_window_flash", TURN_TIMEOUT_MS);
  // The card is up, so both counter calls have run and the host has not been asked yet.
  const countedBeforeApproval = await readJsonArray<CounterCall>(countersPath);
  NodeAssert.equal(countedBeforeApproval.length, 2, "both counter calls ran before the approval");
  NodeAssert.deepEqual(
    await readJsonArray<FlashRecord>(host.flashLogPath),
    [],
    "no flash reached the host before it was approved",
  );
  await page.approve("ex_window_flash", TURN_TIMEOUT_MS);
  log("approved ex_window_flash in the embed");
  await page.waitForReply(SUPERVISED_TURN.reply, TURN_TIMEOUT_MS);

  const cards = await page.loadedCards(2, CARD_TIMEOUT_MS);
  log(`counter cards ${JSON.stringify(cards)}`);
  NodeAssert.deepEqual(
    cards,
    [
      { state: "saved", count: "1" },
      { state: "saved", count: "2" },
    ],
    `two counter cards with their own results; work rows: ${JSON.stringify(await page.workRowTexts())}`,
  );

  const counters = await readJsonArray<CounterCall>(countersPath);
  NodeAssert.deepEqual(
    counters.map((call) => call.value),
    [1, 2],
  );
  counters.forEach((call, index) =>
    assertContext(
      run,
      threadId,
      `counter call ${index + 1}`,
      (call._meta as Record<string, Record<string, unknown>> | null)?.["lecturn/context"],
    ),
  );

  const [flash, ...extraFlashes] = await readJsonArray<FlashRecord>(host.flashLogPath);
  NodeAssert.ok(flash, "the host recorded the flash");
  NodeAssert.equal(extraFlashes.length, 0, "exactly one flash");
  assertContext(run, threadId, "the flash", flash.context as Record<string, unknown> | null);
  const approval = flash.approval as { readonly approved?: unknown; readonly requestId?: unknown };
  NodeAssert.equal(approval.approved, true);
  NodeAssert.equal(typeof approval.requestId, "string", "the approved flash names its request");

  const supervisedStates = await until("the Supervised turn to settle", 15_000, async () => {
    const states = collapse(await turnStates(threadId));
    return states.at(-1) === "idle" && states.length > 1 ? states : undefined;
  });
  log(`turn.state ${supervisedStates.join(" -> ")}`);
  NodeAssert.deepEqual(supervisedStates, [
    "idle",
    "running",
    "awaiting-approval",
    "running",
    "idle",
  ]);

  for (const [index, turn] of UNPROMPTED_TURNS.entries()) {
    await admin.setRuntimeMode(threadId, turn.mode);
    await page.waitForRuntimeMode(turn.label);
    const before = (await turnStates(threadId)).length;
    const seenApprovals = await page.watchApprovalCards();
    await page.send(turn.message);
    await page.waitForReply(turn.reply, TURN_TIMEOUT_MS);

    const flashes = await until(`the ${turn.label} flash`, 15_000, async () => {
      const recorded = await readJsonArray<FlashRecord>(host.flashLogPath);
      return recorded.length === index + 2 ? recorded : undefined;
    });
    const recorded = flashes.at(-1)!;
    NodeAssert.equal(recorded.color, turn.color);
    assertContext(
      run,
      threadId,
      `the ${turn.label} flash`,
      recorded.context as Record<string, unknown> | null,
    );
    // Approved in advance: no request was raised, so there is no id to send.
    NodeAssert.deepEqual(recorded.approval, { approved: true });

    const states = await until(`the ${turn.label} turn to settle`, 15_000, async () => {
      const after = collapse((await turnStates(threadId)).slice(before));
      return after.at(-1) === "idle" ? after : undefined;
    });
    log(`${turn.label}: turn.state ${states.join(" -> ")}`);
    NodeAssert.deepEqual(states, ["running", "idle"], `no approval wait in ${turn.label}`);
    NodeAssert.deepEqual(await seenApprovals(), [], `no approval card in ${turn.label}`);
  }

  const projection = await admin.threadProjection(threadId);
  const appRequests = projection.runtimeRequests.filter(
    (request) => request.connectedAppTool !== undefined,
  );
  NodeAssert.deepEqual(
    appRequests.map((request) => [request.connectedAppTool?.toolName, request.status]),
    [["ex_window_flash", "resolved"]],
    "the Supervised flash raised the thread's only app approval",
  );
}

export default async function scenario({
  log,
  keep,
  steps = AUTOMATED_STEPS,
}: E2eContext): Promise<void> {
  const unknown = steps.filter((step) => !AUTOMATED_STEPS.includes(step));
  if (unknown.length > 0) {
    throw new Error(
      `B2 step ${unknown.join(", ")} is not automated; automated steps: ${AUTOMATED_STEPS.join(", ")}`,
    );
  }
  const scripts = JSON.parse(await NodeFSP.readFile(SCRIPTS_FILE, "utf8")) as Record<
    number,
    ReadonlyArray<unknown>
  >;
  const run = await launchEmbedHost({ scripted: true, scripts });
  try {
    // Every later step runs on the host step 1 starts.
    await step1(run, log);
    if (steps.includes(2)) await step2(run, log);
    if (steps.includes(8)) await step8(run, log);
    if (steps.includes(7)) await step7(run, log);
  } catch (error) {
    log(`--- embed-host output ---\n${run.output()}`);
    throw error;
  } finally {
    await run.close();
    if (keep) log(`kept ${run.dirs.root}`);
    else await removeDirs(run.dirs);
  }
}
