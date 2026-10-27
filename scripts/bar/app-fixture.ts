// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off preferSchemaOverJson:off - Host-side fixture tooling driving a running server over HTTP and WebSocket.
/**
 * The connected-app half of the Bar fixture (A38): the Embed Host app paired
 * into a running fixture server, its exported history imported, and the live
 * states the mockups draw staged with the scripted provider, because imported
 * history is always settled and never running or waiting on approval.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { PNG } from "pngjs";

import {
  APPS_PAIRING_REQUESTS_PATH,
  APPS_POLL_SECRET_HEADER,
  APPS_WS_METHODS as A,
  AppLiveLeaseInput,
  AppRegistration,
  AppsDecidePairingInput,
  AppsEnsureWorkspaceInput,
  AppsSetThreadAppDataInput,
  AuthWebSocketTicketResult,
  CommandId,
  ConnectedAppThreadBundleV1,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS as O,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  WsRpcGroup,
  appsPairingRequestPath,
} from "../../packages/contracts/src/index.ts";
import { MCP_APP_OUTPUT_KEY } from "../../packages/shared/src/mcpApp.ts";
import { iconDataUrl } from "../../examples/embed-host/src/icon.ts";
import { LIVE_GATED_TOOLS, startLiveMcp } from "../../examples/embed-host/src/liveMcp.ts";

const decodeRegistration = Schema.decodeSync(AppRegistration);
const decodeDecidePairing = Schema.decodeSync(AppsDecidePairingInput);
const decodeLiveLease = Schema.decodeSync(AppLiveLeaseInput);
const decodeEnsureWorkspace = Schema.decodeSync(AppsEnsureWorkspaceInput);
const decodeSetThreadAppData = Schema.decodeSync(AppsSetThreadAppDataInput);
const decodeBundle = Schema.decodeUnknownSync(ConnectedAppThreadBundleV1);
const encodeRegistration = Schema.encodeSync(AppRegistration);

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
export const BAR_APP_BUNDLE_PATH = NodePath.join(
  REPO_ROOT,
  "apps/server/src/apps/fixtures/embed-host.bundle.json",
);
const COUNTER_MCP_PATH = NodePath.join(REPO_ROOT, "examples/embed-host/tools/counter-mcp.ts");
const MOCK_COPILOT_PATH = NodePath.join(REPO_ROOT, "scripts/bar/mock-copilot.sh");

export const BAR_APP_ID = "dev.example.embedhost";
export const BAR_APP_MANIFEST_FILE = "bar-app-fixture.json";
export const BAR_APP_SCRIPTS_FILE = "bar-app-scripts.json";
export const BAR_APP_MODEL = { instanceId: "scripted", model: "scripted" } as const;
/** `AppToolApprovalService.APPROVAL_TTL`: an unanswered approval card closes after this. */
export const BAR_APP_APPROVAL_TTL_MS = 10 * 60 * 1000;

const TURN_TIMEOUT_MS = 120_000;
const LEASE_TTL_SECONDS = 60;
const LEASE_HEARTBEAT_MS = 20_000;

/**
 * Enables the scripted provider, and the mock Copilot the CP0 approval thread
 * ran on, without changing the default model the baseline drew.
 */
export const BAR_APP_SETTINGS = {
  providerInstances: {
    scripted: { driver: "scripted", enabled: true },
    githubCopilot: {
      driver: "githubCopilot",
      enabled: true,
      config: { enabled: true, binaryPath: MOCK_COPILOT_PATH },
    },
  },
  // The mock's version trails the latest CLI, and the update toast would cover the captures.
  enableProviderUpdateChecks: false,
} as const;

export function barAppServerEnv(baseDir: string): Readonly<Record<string, string>> {
  return {
    LECTURN_TEST_PROVIDERS: "1",
    LECTURN_SCRIPTED_PROVIDER_SCRIPTS: NodePath.join(baseDir, BAR_APP_SCRIPTS_FILE),
    // mock-copilot.sh runs the ACP mock on this Node, not whichever `node` PATH finds.
    LECTURN_BAR_NODE: NodeProcess.execPath,
  };
}

/**
 * The live approval thread CP0 drew in hopper-38mm (A11 staged it by hand on
 * the mock Copilot): Supervised, one tool call, its permission left pending.
 */
export const BAR_PROJECTS_APPROVAL_THREAD = {
  threadId: "bar-run-38mm-approval",
  title: "Run 38 mm Hopper Flight Simulation",
  user: "Run the baseline flight simulation for the 38 mm hopper.",
  model: { instanceId: "githubCopilot", model: "auto" },
} as const;

export const BAR_PENDING_APP_ID = "dev.example.sketchpad";

/** A 32 px amber disc, so the waiting app does not borrow Embed Host's icon. */
function discIconDataUrl(): string {
  const size = 32;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 <= 14 ** 2;
      png.data[offset] = 0xe0;
      png.data[offset + 1] = 0xa0;
      png.data[offset + 2] = 0x40;
      png.data[offset + 3] = inside ? 0xff : 0;
    }
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

/**
 * A second app left waiting on its pairing request, for the Apps list's
 * Approve and Deny row. Its name sorts after Embed Host's, so the staged
 * app keeps the first row the mockup draws.
 */
export function barPendingAppRegistration(): AppRegistration {
  return decodeRegistration({
    appId: BAR_PENDING_APP_ID,
    name: "Sketch Pad",
    iconDataUrl: discIconDataUrl(),
    toolPrefix: "sk",
    refPrefixes: ["sk:"],
    liveTools: true,
    gatedTools: [],
  });
}

/** Embed Host's own registration (examples/embed-host/src/main.ts), run on this Node. */
export function barAppRegistration(nodePath: string = NodeProcess.execPath): AppRegistration {
  return decodeRegistration({
    appId: BAR_APP_ID,
    name: "Embed Host",
    iconDataUrl,
    toolPrefix: "ex",
    openUrlTemplate: "embedhost://open?workspace={workspaceRoot}&thread={threadId}",
    refPrefixes: ["ex:"],
    headlessTools: {
      command: nodePath,
      args: [COUNTER_MCP_PATH, "--root", "{workspaceRoot}"],
      listArgs: [COUNTER_MCP_PATH, "--list-tools"],
      cwd: "{workspaceRoot}",
    },
    liveTools: true,
    gatedTools: LIVE_GATED_TOOLS,
    instructions: "You can read and increment a counter and flash the host window.",
  });
}

export type BarAppWorkspaceKey = "ws-a" | "ws-b";
export const BAR_APP_WORKSPACE_KEYS: ReadonlyArray<BarAppWorkspaceKey> = ["ws-a", "ws-b"];

export function barAppWorkspaceRoot(baseDir: string, key: BarAppWorkspaceKey): string {
  return NodePath.join(baseDir, "app-workspaces", key);
}

/** Imported threads the pin command pins, by workspace: one pinned row per workspace, as drawn. */
export const BAR_APP_PINNED_IMPORTS: Readonly<Partial<Record<BarAppWorkspaceKey, string>>> = {
  "ws-b": "eff74899-f5d0-4156-93d7-f8fedf1fa69b",
};

interface RawBundleThread {
  readonly sourceThreadId: string;
  readonly pinned: boolean;
  readonly messages: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly turnItems: ReadonlyArray<Readonly<Record<string, unknown>>>;
}
interface RawBundleProject {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly threads: ReadonlyArray<RawBundleThread>;
}
interface RawBundle {
  readonly appId: string;
  readonly exportedAt: string;
  readonly projects: ReadonlyArray<RawBundleProject>;
}

/** How long before the seeding clock the imported history reads as exported, when moved. */
export const BAR_APP_HISTORY_AGE_MS = 60 * 60 * 1000;

const THREAD_TIMES = ["createdAt", "updatedAt"] as const;
const ITEM_TIMES = ["createdAt", "updatedAt", "startedAt", "completedAt"] as const;

function shiftTimes<T extends object>(record: T, keys: ReadonlyArray<string>, offsetMs: number): T {
  const shifted: Record<string, unknown> = { ...(record as Readonly<Record<string, unknown>>) };
  for (const key of keys) {
    const value = shifted[key];
    if (typeof value === "string") {
      shifted[key] = new Date(Date.parse(value) + offsetMs).toISOString();
    }
  }
  return shifted as T;
}

/**
 * The checked-in bundle, retargeted at this app and base dir. Every thread
 * arrives unpinned (so settled): the pins are made with the pin command, as a
 * user makes them, so `thread.pinned` is in the event log. With `relativeTo`,
 * every time moves so the export lands `BAR_APP_HISTORY_AGE_MS` before it.
 */
export function barAppBundle(
  raw: unknown,
  baseDir: string,
  relativeTo?: number,
): ConnectedAppThreadBundleV1 {
  const bundle = raw as RawBundle;
  if (bundle.projects.length !== BAR_APP_WORKSPACE_KEYS.length) {
    throw new Error(`The app bundle has ${bundle.projects.length} workspaces, expected 2.`);
  }
  const offsetMs =
    relativeTo === undefined
      ? 0
      : relativeTo - BAR_APP_HISTORY_AGE_MS - Date.parse(bundle.exportedAt);
  return decodeBundle({
    ...shiftTimes(bundle, ["exportedAt"], offsetMs),
    appId: BAR_APP_ID,
    projects: bundle.projects.map((project, index) => ({
      ...project,
      title: BAR_APP_WORKSPACE_KEYS[index],
      workspaceRoot: barAppWorkspaceRoot(baseDir, BAR_APP_WORKSPACE_KEYS[index]!),
      threads: project.threads.map((thread) => ({
        ...shiftTimes(thread, THREAD_TIMES, offsetMs),
        pinned: false,
        messages: thread.messages.map((message) => shiftTimes(message, ITEM_TIMES, offsetMs)),
        turnItems: thread.turnItems.map((item) => shiftTimes(item, ITEM_TIMES, offsetMs)),
      })),
    })),
  });
}

export type BarAppScriptStep =
  | { readonly toolCall: { readonly name: string; readonly arguments?: object } }
  | { readonly assistantText: string }
  | { readonly expectApproval: true }
  | { readonly hold: true };

export interface BarAppStagedThread {
  readonly key: "mockup" | "supervised" | "fullAccess" | "workingA" | "workingB";
  readonly workspace: BarAppWorkspaceKey;
  readonly title: string;
  readonly runtimeMode: RuntimeMode;
  readonly user: string;
  readonly script: ReadonlyArray<BarAppScriptStep>;
  readonly subtitle: string;
  /** What the turn is left doing when staging moves on. */
  readonly settles: "reply" | "approval" | "hold";
  readonly pinned: boolean;
  /** Live tools are leased only while these run, so the app reads Closed afterwards. */
  readonly needsLiveHost: boolean;
}

const MOCKUP_REPLY = "The counter read 0 and is now 1. Reopen Embed Host to run live tools.";

/** In staging order: the live-host threads run first, then the lease is cleared. */
export const BAR_APP_STAGED_THREADS: ReadonlyArray<BarAppStagedThread> = [
  {
    key: "supervised",
    workspace: "ws-a",
    title: "Flash on count",
    runtimeMode: "approval-required",
    user: "Count once more, then flash the window.",
    script: [
      { toolCall: { name: "ex_counter_increment", arguments: { by: 1 } } },
      { expectApproval: true },
      { toolCall: { name: "ex_window_flash", arguments: { color: "gold" } } },
      { assistantText: "Counted and flashed the window." },
    ],
    subtitle: "Waiting on a flash",
    settles: "approval",
    pinned: false,
    needsLiveHost: true,
  },
  {
    key: "fullAccess",
    workspace: "ws-a",
    title: "Flash in Full access",
    runtimeMode: "full-access",
    user: "Count once more, then flash the window.",
    script: [
      { toolCall: { name: "ex_counter_increment", arguments: { by: 1 } } },
      { toolCall: { name: "ex_window_flash", arguments: { color: "gold" } } },
      { assistantText: "Counted and flashed the window without asking, in Full access." },
    ],
    subtitle: "Flashed gold",
    settles: "reply",
    pinned: false,
    needsLiveHost: true,
  },
  {
    key: "mockup",
    workspace: "ws-a",
    title: "Counter baseline",
    runtimeMode: "full-access",
    user: "Read the counter and add one.",
    script: [
      { toolCall: { name: "ex_counter_read", arguments: {} } },
      { toolCall: { name: "ex_counter_increment", arguments: { by: 1 } } },
      { assistantText: MOCKUP_REPLY },
    ],
    subtitle: "Counter at 1",
    settles: "reply",
    pinned: true,
    needsLiveHost: false,
  },
  {
    key: "workingA",
    workspace: "ws-b",
    title: "Long count",
    runtimeMode: "full-access",
    user: "Keep counting until I stop you.",
    script: [{ toolCall: { name: "ex_counter_read", arguments: {} } }, { hold: true }],
    subtitle: "Counting",
    settles: "hold",
    pinned: false,
    needsLiveHost: false,
  },
  {
    key: "workingB",
    workspace: "ws-b",
    title: "Watch the counter",
    runtimeMode: "full-access",
    user: "Watch the counter and tell me when it changes.",
    script: [{ toolCall: { name: "ex_counter_read", arguments: {} } }, { hold: true }],
    subtitle: "Watching",
    settles: "hold",
    pinned: false,
    needsLiveHost: false,
  },
];

export interface BarAppSectionCounts {
  readonly pinned: number;
  readonly active: number;
  readonly settled: number;
}

/** Where every imported and staged thread lands in the sidebar tree, per workspace. */
export function expectedBarAppSections(
  bundle: Pick<ConnectedAppThreadBundleV1, "projects">,
  staged: ReadonlyArray<BarAppStagedThread> = BAR_APP_STAGED_THREADS,
): Readonly<Record<BarAppWorkspaceKey, BarAppSectionCounts>> {
  const counts = (key: BarAppWorkspaceKey, index: number): BarAppSectionCounts => {
    const imported = bundle.projects[index]?.threads.length ?? 0;
    const pinnedImports = BAR_APP_PINNED_IMPORTS[key] === undefined ? 0 : 1;
    const mine = staged.filter((thread) => thread.workspace === key);
    return {
      pinned: pinnedImports + mine.filter((thread) => thread.pinned).length,
      active: mine.filter((thread) => !thread.pinned).length,
      settled: imported - pinnedImports,
    };
  };
  return { "ws-a": counts("ws-a", 0), "ws-b": counts("ws-b", 1) };
}

export interface BarAppManifest {
  readonly version: 1;
  readonly appId: string;
  readonly appName: string;
  readonly environmentId: string;
  /** Captures of app scenes freeze the page clock here, just after staging. */
  readonly stagedAt: string;
  readonly approvalExpiresAt: string;
  /** The second app's request, left unanswered; it expires like the approval. */
  readonly pendingPairing: {
    readonly appId: string;
    readonly appName: string;
    readonly requestId: string;
    readonly expiresAt: string;
  };
  readonly workspaces: ReadonlyArray<{
    readonly key: BarAppWorkspaceKey;
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly expected: BarAppSectionCounts;
  }>;
  readonly threads: Readonly<Record<BarAppStagedThread["key"], string>>;
  /** The app thread updated last, which the Apps list scenes open. */
  readonly latestThreadId: string;
  readonly pinnedImportThreadIds: ReadonlyArray<string>;
  /** The mock Copilot thread in hopper-38mm, waiting on its approval. */
  readonly projectsApprovalThreadId: string;
}

export function barAppManifestPath(baseDir: string): string {
  return NodePath.join(baseDir, BAR_APP_MANIFEST_FILE);
}

export async function readBarAppManifest(baseDir: string): Promise<BarAppManifest> {
  const path = barAppManifestPath(baseDir);
  const text = await NodeFSP.readFile(path, "utf8").catch(() => {
    throw new Error(`${path} is missing; seed with \`seed-bar-fixture.ts --app\` first.`);
  });
  return JSON.parse(text) as BarAppManifest;
}

type ShellForCheck = {
  readonly threads: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
    readonly status: string;
    readonly pinnedAt?: unknown;
    readonly settledOverride?: string | null;
    readonly pendingRuntimeRequest: unknown;
    readonly archivedAt?: unknown;
    readonly deletedAt?: unknown;
  }>;
};

/** The server's `RUNNING_STATUSES` (AppProjectService.ts): what an app rail shows as working. */
const RUNNING = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Every way the server's shell has drifted from the staged live states: a
 * released hold, an expired or answered approval, a lost pin.
 */
export function barAppLiveStateProblems(
  snapshot: ShellForCheck,
  manifest: BarAppManifest,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const threadsOf = (projectId: string) =>
    snapshot.threads.filter(
      (thread) =>
        String(thread.projectId) === projectId &&
        thread.archivedAt == null &&
        thread.deletedAt == null,
    );
  const all = manifest.workspaces.flatMap((workspace) => threadsOf(workspace.projectId));
  const working = all.filter(
    (thread) => thread.pendingRuntimeRequest == null && RUNNING.has(thread.status),
  );
  const expectedWorking = [manifest.threads.workingA, manifest.threads.workingB];
  if (working.length !== expectedWorking.length) {
    problems.push(`${working.length} app threads are working, expected ${expectedWorking.length}`);
  }
  for (const id of expectedWorking) {
    if (!working.some((thread) => String(thread.id) === id)) problems.push(`${id} is not working`);
  }
  const pending = all.filter((thread) => thread.pendingRuntimeRequest != null);
  if (pending.length !== 1 || String(pending[0]?.id) !== manifest.threads.supervised) {
    problems.push(
      `pending approvals on ${JSON.stringify(pending.map((thread) => thread.id))}, expected only ${manifest.threads.supervised}`,
    );
  }
  for (const workspace of manifest.workspaces) {
    const threads = threadsOf(workspace.projectId);
    const pinned = threads.filter((thread) => thread.pinnedAt != null);
    const settled = threads.filter(
      (thread) => thread.pinnedAt == null && thread.settledOverride === "settled",
    );
    const active = threads.length - pinned.length - settled.length;
    const actual = { pinned: pinned.length, active, settled: settled.length };
    for (const section of ["pinned", "active", "settled"] as const) {
      if (actual[section] !== workspace.expected[section]) {
        problems.push(
          `${workspace.key} has ${actual[section]} ${section} threads, expected ${workspace.expected[section]}`,
        );
      }
    }
  }
  const pinnedIds = new Set(
    all.filter((thread) => thread.pinnedAt != null).map((thread) => String(thread.id)),
  );
  for (const id of [manifest.threads.mockup, ...manifest.pinnedImportThreadIds]) {
    if (!pinnedIds.has(id)) problems.push(`${id} is not pinned`);
  }
  const projectsApproval = snapshot.threads.find(
    (thread) => String(thread.id) === manifest.projectsApprovalThreadId,
  );
  if (projectsApproval?.pendingRuntimeRequest == null) {
    problems.push(`${manifest.projectsApprovalThreadId} is not waiting on its approval`);
  }
  return problems;
}

/** The route parameters the after-capture scenes name. */
export function barAppSceneParams(manifest: BarAppManifest): Readonly<Record<string, string>> {
  return {
    environmentId: manifest.environmentId,
    appId: manifest.appId,
    mockupThreadId: manifest.threads.mockup,
    supervisedThreadId: manifest.threads.supervised,
    fullAccessThreadId: manifest.threads.fullAccess,
    latestThreadId: manifest.latestThreadId,
  };
}

const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult));

async function ticketedSocketUrl(origin: string, bearer: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/websocket-ticket", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!response.ok) throw new Error(`websocket-ticket answered ${response.status}`);
  const { ticket } = decodeTicket(await response.json());
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

const openClient = (url: string) => {
  const protocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket()).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
      ),
    ),
  );
  // Built into the caller's scope: `Effect.provide` would close the socket at once.
  return Layer.build(protocol).pipe(
    Effect.flatMap((context) => RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(context))),
  );
};
type WsClient = Effect.Success<ReturnType<typeof openClient>>;

/** One call on its own socket: each is short, and none is left open when staging fails. */
async function rpc<A, E>(
  origin: string,
  token: string,
  label: string,
  call: (client: WsClient) => Effect.Effect<A, E>,
): Promise<A> {
  const url = await ticketedSocketUrl(origin, token);
  const exit = await Effect.runPromiseExit(
    openClient(url).pipe(Effect.flatMap(call), Effect.scoped, Effect.timeout(60_000)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`${label} failed: ${Cause.pretty(exit.cause)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  label: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`);
}

const newCommandId = () => CommandId.make(`bar-app:${NodeCrypto.randomUUID()}`);

/** The app's own first step, from this loopback client as a local app makes it. */
async function requestPairing(
  origin: string,
  registration: AppRegistration,
): Promise<{ requestId: string; pollSecret: string; expiresAt: string }> {
  const requested = await fetch(new URL(APPS_PAIRING_REQUESTS_PATH, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encodeRegistration(registration)),
  });
  if (!requested.ok) {
    throw new Error(
      `The pairing request was refused: ${requested.status} ${await requested.text()}`,
    );
  }
  return (await requested.json()) as { requestId: string; pollSecret: string; expiresAt: string };
}

async function pairBarApp(input: {
  readonly origin: string;
  readonly admin: string;
  readonly registration: AppRegistration;
}): Promise<string> {
  const request = await requestPairing(input.origin, input.registration);
  const status = await rpc(input.origin, input.admin, "apps.decidePairing", (client) =>
    client[A.appsDecidePairing](
      decodeDecidePairing({
        requestId: request.requestId,
        decision: "grant",
      }),
    ),
  );
  if (status.state !== "granted") throw new Error(`The app is ${status.state}, not granted.`);
  const polled = await fetch(new URL(appsPairingRequestPath(request.requestId), input.origin), {
    headers: { [APPS_POLL_SECRET_HEADER]: request.pollSecret },
  });
  const poll = (await polled.json()) as { credential?: { token: string } };
  if (poll.credential === undefined) throw new Error("The granted pairing returned no credential.");
  return poll.credential.token;
}

/** Where the example host's live MCP records each flash it was asked for. */
export const barAppFlashLogPath = (baseDir: string) =>
  NodePath.join(baseDir, "bar-app-flashes.json");

/**
 * Embed Host's live tools, leased until `close`: the app reads Running, and a
 * gated flash that is approved reaches the host (A43, B2.6).
 */
export const leaseBarAppLiveTools = (origin: string, credential: string, baseDir: string) =>
  leaseLiveTools(origin, credential, barAppFlashLogPath(baseDir));

/** Keeps the live lease alive while live-tool threads run; Lecturn drops it after its TTL. */
async function leaseLiveTools(origin: string, credential: string, flashLogPath: string) {
  const live = await startLiveMcp({ flashLogPath });
  const lease = decodeLiveLease({
    url: live.url,
    bearer: live.bearer,
    ttlSeconds: LEASE_TTL_SECONDS,
  });
  const renew = () =>
    rpc(origin, credential, "apps.setLiveLease", (client) => client[A.appsSetLiveLease](lease));
  await renew();
  let failure: unknown = null;
  const heartbeat = setInterval(() => {
    renew().catch((error: unknown) => {
      failure = error;
    });
  }, LEASE_HEARTBEAT_MS);
  return {
    close: async () => {
      clearInterval(heartbeat);
      await rpc(origin, credential, "apps.clearLiveLease", (client) =>
        client[A.appsClearLiveLease]({}),
      );
      await live.close();
      if (failure !== null) throw failure;
    },
  };
}

/** Every app the server knows, with its pairing state and live lease. */
export const listBarApps = (origin: string, token: string) =>
  rpc(origin, token, "apps.list", (client) => client[A.appsList]({}));

const dispatch = (origin: string, token: string, command: OrchestrationV2Command) =>
  rpc(origin, token, command.type, (client) => client[O.dispatchCommand](command));

const projectionOf = (origin: string, token: string, threadId: ThreadId) =>
  rpc(origin, token, "getThreadProjection", (client) =>
    client[O.getThreadProjection]({ threadId }),
  ) as Promise<OrchestrationV2ThreadProjection>;

const ENDED_EARLY = new Set(["interrupted", "failed", "cancelled", "rolled_back"]);

const toolItems = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems.flatMap((item) => (item.type === "dynamic_tool" ? [item] : []));

/** A card renders from its captured HTML attachment, never from a live app. */
function cardAttachmentProblems(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<string> {
  const increments = toolItems(projection).filter((item) =>
    (item.toolName ?? "").endsWith("ex_counter_increment"),
  );
  if (increments.length === 0) return ["no ex_counter_increment tool row"];
  return increments.flatMap((item) => {
    const output = item.output as Record<string, unknown> | null | undefined;
    const card = output?.[MCP_APP_OUTPUT_KEY] as { attachmentId?: unknown } | undefined;
    return typeof card?.attachmentId === "string"
      ? []
      : [`tool row ${item.id} has no card attachment`];
  });
}

/** Waits for what each staged turn is left doing: a reply, a pending approval or a hold. */
async function awaitStagedTurn(input: {
  readonly origin: string;
  readonly admin: string;
  readonly threadId: ThreadId;
  readonly thread: BarAppStagedThread;
}): Promise<OrchestrationV2ThreadProjection> {
  const { thread } = input;
  const reply = thread.script.flatMap((step) =>
    "assistantText" in step ? [step.assistantText] : [],
  );
  const expectedTools = thread.script.filter((step) => "toolCall" in step).length;
  return until(`${thread.key} to ${thread.settles}`, TURN_TIMEOUT_MS, async () => {
    const projection = await projectionOf(input.origin, input.admin, input.threadId);
    const ended = projection.runs.find((run) => ENDED_EARLY.has(run.status));
    if (ended !== undefined) throw new Error(`The ${thread.key} turn ended ${ended.status}.`);
    const tools = toolItems(projection);
    switch (thread.settles) {
      case "reply":
        return projection.messages.some(
          (message) => message.role === "assistant" && message.text === reply.at(-1),
        ) &&
          tools.length === expectedTools &&
          tools.every((item) => item.status === "completed") &&
          projection.runs.every((run) => run.status === "completed")
          ? projection
          : undefined;
      case "approval":
        return projection.runtimeRequests.some(
          (request) => request.status === "pending" && request.connectedAppTool !== undefined,
        )
          ? projection
          : undefined;
      case "hold":
        return tools.length === expectedTools &&
          tools.every((item) => item.status === "completed") &&
          projection.runs.some((run) => RUNNING.has(run.status))
          ? projection
          : undefined;
    }
  });
}

async function stageProjectsApproval(input: {
  readonly origin: string;
  readonly admin: string;
  readonly projectId: ProjectId;
}): Promise<ThreadId> {
  const staged = BAR_PROJECTS_APPROVAL_THREAD;
  const threadId = ThreadId.make(staged.threadId);
  await dispatch(input.origin, input.admin, {
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: newCommandId(),
    threadId,
    projectId: input.projectId,
    title: staged.title,
    modelSelection: {
      instanceId: ProviderInstanceId.make(staged.model.instanceId),
      model: staged.model.model,
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  await dispatch(input.origin, input.admin, {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: newCommandId(),
    threadId,
    messageId: MessageId.make(`bar-app-${NodeCrypto.randomUUID()}`),
    text: staged.user,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });
  await until("the mock Copilot approval", TURN_TIMEOUT_MS, async () => {
    const projection = await projectionOf(input.origin, input.admin, threadId);
    const ended = projection.runs.find((run) => ENDED_EARLY.has(run.status));
    if (ended !== undefined) throw new Error(`The Copilot approval turn ended ${ended.status}.`);
    return projection.runtimeRequests.some((request) => request.status === "pending")
      ? projection
      : undefined;
  });
  return threadId;
}

export interface StageBarAppFixtureInput {
  readonly baseDir: string;
  readonly origin: string;
  /** hopper-38mm, where the Projects-mode approval thread is staged. */
  readonly projectsApprovalProjectId: ProjectId;
  readonly issueToken: (scopes: ReadonlyArray<string>, label: string) => Promise<string>;
  readonly fetchShell: () => Promise<ShellForCheck>;
  /** Moves the imported history's times relative to this clock (see `barAppBundle`). */
  readonly historyRelativeTo?: number;
}

export interface BarAppStaging {
  readonly manifest: BarAppManifest;
  /** The paired app's own credential, which a later live lease needs. */
  readonly credential: string;
}

/**
 * Pairs the app, imports its history and stages every live state, in an order
 * that leaves the app closed: the gated call is raised while the host's live
 * tools are leased, and the approval it waits on outlives the lease.
 */
export async function stageBarAppFixture(input: StageBarAppFixtureInput): Promise<BarAppStaging> {
  const { baseDir, origin } = input;
  const admin = await input.issueToken(
    ["access:read", "access:write", "orchestration:read", "orchestration:operate"],
    "bar-app-fixture",
  );
  for (const key of BAR_APP_WORKSPACE_KEYS) {
    await NodeFSP.mkdir(barAppWorkspaceRoot(baseDir, key), { recursive: true });
  }
  const projectsApprovalThreadId = await stageProjectsApproval({
    origin,
    admin,
    projectId: input.projectsApprovalProjectId,
  });
  const registration = barAppRegistration();
  const credential = await pairBarApp({ origin, admin, registration });

  const bundle = barAppBundle(
    JSON.parse(await NodeFSP.readFile(BAR_APP_BUNDLE_PATH, "utf8")),
    baseDir,
    input.historyRelativeTo,
  );
  const imported = await rpc(origin, credential, "apps.importThreads", (client) =>
    client[A.appsImportThreads]({ bundle }),
  );
  const total = bundle.projects.reduce((sum, project) => sum + project.threads.length, 0);
  if (imported.imported !== total) {
    throw new Error(`Imported ${imported.imported} of ${total} bundle threads.`);
  }
  const projectIds = {} as Record<BarAppWorkspaceKey, ProjectId>;
  for (const key of BAR_APP_WORKSPACE_KEYS) {
    const { projectId } = await rpc(origin, credential, "apps.ensureWorkspace", (client) =>
      client[A.appsEnsureWorkspace](
        decodeEnsureWorkspace({
          workspaceRoot: barAppWorkspaceRoot(baseDir, key),
          title: key,
        }),
      ),
    );
    projectIds[key] = projectId;
  }

  const scriptsPath = barAppServerEnv(baseDir).LECTURN_SCRIPTED_PROVIDER_SCRIPTS!;
  const threadIds = {} as Record<BarAppStagedThread["key"], ThreadId>;
  let lease: Awaited<ReturnType<typeof leaseLiveTools>> | null = await leaseBarAppLiveTools(
    origin,
    credential,
    baseDir,
  );
  let approvalRaisedAt: number | null = null;
  try {
    for (const thread of BAR_APP_STAGED_THREADS) {
      if (!thread.needsLiveHost && lease !== null) {
        await lease.close();
        lease = null;
      }
      const threadId = ThreadId.make(`bar-app-${thread.key}-${NodeCrypto.randomUUID()}`);
      threadIds[thread.key] = threadId;
      await dispatch(origin, admin, {
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: newCommandId(),
        threadId,
        projectId: projectIds[thread.workspace],
        title: thread.title,
        modelSelection: {
          instanceId: ProviderInstanceId.make(BAR_APP_MODEL.instanceId),
          model: BAR_APP_MODEL.model,
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      // Every staged turn is its thread's first, so the scripts file holds one
      // entry, rewritten per thread; the previous turn has already read its own.
      await NodeFSP.writeFile(scriptsPath, `${JSON.stringify({ "1": thread.script })}\n`);
      await dispatch(origin, admin, {
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: newCommandId(),
        threadId,
        messageId: MessageId.make(`bar-app-${NodeCrypto.randomUUID()}`),
        text: thread.user,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const projection = await awaitStagedTurn({ origin, admin, threadId, thread });
      if (thread.settles === "approval") approvalRaisedAt = Date.now();
      if (
        thread.script.some(
          (step) => "toolCall" in step && step.toolCall.name === "ex_counter_increment",
        )
      ) {
        const problems = cardAttachmentProblems(projection);
        if (problems.length > 0) throw new Error(`${thread.key}: ${problems.join("; ")}`);
      }
    }
  } finally {
    await lease?.close();
  }

  const listed = await Promise.all(
    BAR_APP_WORKSPACE_KEYS.map((key) =>
      rpc(origin, credential, "apps.listThreads", (client) =>
        client[A.appsListThreads]({ projectId: projectIds[key] }),
      ),
    ),
  );
  const pinnedImportThreadIds = BAR_APP_WORKSPACE_KEYS.flatMap((key, index) => {
    const source = BAR_APP_PINNED_IMPORTS[key];
    if (source === undefined) return [];
    const copy = listed[index]!.find((summary) => summary.copiedFrom?.sourceThreadId === source);
    if (copy === undefined) throw new Error(`The imported copy of ${source} is missing.`);
    return [copy.threadId];
  });
  const toPin = [
    ...BAR_APP_STAGED_THREADS.filter((thread) => thread.pinned).map(
      (thread) => threadIds[thread.key],
    ),
    ...pinnedImportThreadIds,
  ];
  for (const threadId of toPin) {
    await dispatch(origin, admin, { type: "thread.pin", commandId: newCommandId(), threadId });
  }
  for (const thread of BAR_APP_STAGED_THREADS) {
    await rpc(origin, credential, "apps.setThreadAppData", (client) =>
      client[A.appsSetThreadAppData](
        decodeSetThreadAppData({
          threadId: threadIds[thread.key],
          appData: JSON.stringify({ fixture: thread.key }),
          subtitle: thread.subtitle,
        }),
      ),
    );
  }

  // Last, so nothing staged after it answers or replaces the request.
  const pendingRegistration = barPendingAppRegistration();
  const pendingRequest = await requestPairing(origin, pendingRegistration);

  const apps = await rpc(origin, admin, "apps.list", (client) => client[A.appsList]({}));
  const app = apps.find((entry) => entry.appId === BAR_APP_ID);
  if (app?.state !== "granted" || app.live !== null) {
    throw new Error(
      `The app should be granted and closed, but is ${JSON.stringify(app?.state)} with lease ${JSON.stringify(app?.live)}.`,
    );
  }
  const pending = apps.find((entry) => entry.appId === BAR_PENDING_APP_ID);
  if (
    pending?.state !== "pairing-requested" ||
    pending.pendingRequest?.requestId !== pendingRequest.requestId
  ) {
    throw new Error(
      `${BAR_PENDING_APP_ID} should be waiting on request ${pendingRequest.requestId}, but is ${JSON.stringify(pending?.state)} with ${JSON.stringify(pending?.pendingRequest?.requestId)}.`,
    );
  }

  const sections = expectedBarAppSections(bundle);
  const environmentId = (
    await NodeFSP.readFile(NodePath.join(baseDir, "userdata", "environment-id"), "utf8")
  ).trim();
  const snapshot = await input.fetchShell();
  const manifest: BarAppManifest = {
    version: 1,
    appId: BAR_APP_ID,
    appName: registration.name,
    environmentId,
    stagedAt: new Date().toISOString(),
    approvalExpiresAt: new Date(
      (approvalRaisedAt ?? Date.now()) + BAR_APP_APPROVAL_TTL_MS,
    ).toISOString(),
    pendingPairing: {
      appId: BAR_PENDING_APP_ID,
      appName: pendingRegistration.name,
      requestId: pendingRequest.requestId,
      expiresAt: pendingRequest.expiresAt,
    },
    workspaces: BAR_APP_WORKSPACE_KEYS.map((key) => ({
      key,
      projectId: projectIds[key],
      workspaceRoot: barAppWorkspaceRoot(baseDir, key),
      expected: sections[key],
    })),
    threads: threadIds,
    // Subtitles are written in staging order, so the last staged thread is updated last; named
    // by key, since those writes land within a millisecond of each other.
    latestThreadId: threadIds[BAR_APP_STAGED_THREADS.at(-1)!.key],
    pinnedImportThreadIds,
    projectsApprovalThreadId,
  };
  const problems = barAppLiveStateProblems(snapshot, manifest);
  if (problems.length > 0) {
    throw new Error(`The staged app fixture drifted:\n- ${problems.join("\n- ")}`);
  }
  await NodeFSP.writeFile(barAppManifestPath(baseDir), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, credential };
}
