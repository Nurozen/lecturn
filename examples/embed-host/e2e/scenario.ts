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
 *   3-5, ledger. A user server starts while the host runs; the host switches
 *      to it live, is closed and reopened, and its copy ledger is checked
 *      across fallbacks (attach.ts).
 *   7. Revoke and re-pair (security.ts).
 *   8. The trust boundary: refusals over RPC, the shell stream and MCP,
 *      framing, and re-approval of a changed command (security.ts).
 *
 * Step 8 runs before step 3, on the sidecar. Step 7 runs last, on whichever
 * server the host ends on: it leaves the host without a credential.
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
import { type AttachFlow, attachFlow, type SourceThread } from "./attach.ts";
import { createEmbedThread } from "./embedRpc.ts";
import { embedPage } from "./embedPage.ts";
import { step7, step8 } from "./security.ts";
import {
  type EmbedHostGlobal,
  type EmbedHostRun,
  launchEmbedHost,
  readJsonArray,
  removeDirs,
  until,
} from "./harness.ts";
import type { E2eContext, ScenarioStep } from "./run.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const SCRIPTS_FILE = NodePath.join(here, "scripts", "b2-steps-1-2.scripted.json");
export const AUTOMATED_STEPS: ReadonlyArray<ScenarioStep> = [1, 2, 3, 4, 5, "ledger", 7, 8];
// Each later attach step continues from the state the one before it leaves.
const REQUIRES: ReadonlyArray<readonly [ScenarioStep, ScenarioStep]> = [
  [4, 3],
  [5, 4],
  ["ledger", 3],
];

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
async function step2(run: EmbedHostRun, log: E2eContext["log"]): Promise<SourceThread> {
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
  await page.waitForApproval("Flash window", TURN_TIMEOUT_MS);
  // The card is up, so both counter calls have run and the host has not been asked yet.
  const countedBeforeApproval = await readJsonArray<CounterCall>(countersPath);
  NodeAssert.equal(countedBeforeApproval.length, 2, "both counter calls ran before the approval");
  NodeAssert.deepEqual(
    await readJsonArray<FlashRecord>(host.flashLogPath),
    [],
    "no flash reached the host before it was approved",
  );
  await page.approve("Flash window", TURN_TIMEOUT_MS);
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
  return { threadId, cards };
}

const SEED_REPLY = "Counted once on the sidecar.";

/** Without step 2, step 3 copies a thread with one counter card made here. */
async function seedSourceThread(run: EmbedHostRun, log: E2eContext["log"]): Promise<SourceThread> {
  const { host, dirs } = run;
  const target = await run.app.evaluate(() =>
    (globalThis as ScenarioGlobals).embedHost!.embedTarget(),
  );
  const threadId = await createEmbedThread({
    origin: host.origin,
    embedToken: target.token,
    projectId: host.projectId,
    title: THREAD_TITLE,
  });
  await run.app.evaluate(
    (_electron, id) => (globalThis as ScenarioGlobals).embedHost!.openThread(id),
    threadId,
  );
  const page = embedPage(await run.guestPage(`/${threadId}`));
  await page.send(
    `Count once.\n\`\`\`scripted\n${JSON.stringify([
      { toolCall: { name: "ex_counter_increment", arguments: { by: 1 } } },
      { assistantText: SEED_REPLY },
    ])}\n\`\`\``,
  );
  const [card] = await page.loadedCards(1, CARD_TIMEOUT_MS);
  // Copied mid-turn, the thread would miss its reply until a later re-copy.
  await until("the seed turn to finish", TURN_TIMEOUT_MS, async () => {
    const threads = await run.app.evaluate(() =>
      (globalThis as ScenarioGlobals).embedHost!.listThreads(),
    );
    return threads.find((thread) => thread.threadId === threadId)?.state === "idle"
      ? true
      : undefined;
  });
  const counted = await readJsonArray<CounterCall>(
    NodePath.join(dirs.workspace, ".embed-host", "counter-calls.json"),
  );
  NodeAssert.deepEqual(card, { state: "saved", count: String(counted.at(-1)?.value) });
  log(`seeded sidecar thread ${threadId} with one counter card`);
  return { threadId, cards: [card!] };
}

export default async function scenario({
  log,
  artifactsDir,
  keep,
  steps = AUTOMATED_STEPS,
}: E2eContext): Promise<void> {
  const unknown = steps.filter((step) => !AUTOMATED_STEPS.includes(step));
  if (unknown.length > 0) {
    throw new Error(
      `B2 step ${unknown.join(", ")} is not automated; automated steps: ${AUTOMATED_STEPS.join(", ")}`,
    );
  }
  const missing = REQUIRES.filter(
    ([step, needs]) => steps.includes(step) && !steps.includes(needs),
  );
  if (missing.length > 0) {
    throw new Error(
      missing.map(([step, needs]) => `step ${step} continues from step ${needs}`).join("; "),
    );
  }
  const scripts = JSON.parse(await NodeFSP.readFile(SCRIPTS_FILE, "utf8")) as Record<
    number,
    ReadonlyArray<unknown>
  >;
  const first = await launchEmbedHost({ scripted: true, scripts });
  const { dirs } = first;
  // Steps 4 and 5 close and reopen the host, so from step 3 on the flow owns it.
  let attach: AttachFlow | null = null;
  const currentRun = () => (attach === null ? first : attach.run);
  try {
    await step1(first, log);
    const copied = steps.includes(2) ? await step2(first, log) : null;
    if (steps.includes(8)) await step8(first, log);
    if (steps.includes(3)) {
      attach = attachFlow({
        run: first,
        log,
        reopen: () => launchEmbedHost({ scripted: true, scripts, dirs }),
        artifactsDir,
      });
      await attach.step3(copied ?? (await seedSourceThread(first, log)));
      if (steps.includes(4)) await attach.step4();
      if (steps.includes(5)) await attach.step5();
      if (steps.includes("ledger")) await attach.ledger();
    }
    if (steps.includes(7)) {
      const host = attach === null ? first : await attach.ensureHost();
      await host.refreshHost();
      await step7(host, log);
    }
  } catch (error) {
    const host = currentRun();
    if (host !== null) log(`--- embed-host output ---\n${host.output()}`);
    if (attach !== null) log(`--- user server output ---\n${attach.output()}`);
    throw error;
  } finally {
    await currentRun()?.close();
    await attach?.close();
    if (keep) log(`kept ${dirs.root}`);
    else await removeDirs(dirs);
  }
}
