// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off -- Test harness driving a real Electron app and server; it runs no Effect runtime of its own.
/**
 * Spec B2 steps 7 and 8, on whichever server the host is using (the sidecar
 * when `--steps 7,8` runs on its own):
 *
 *   7. Revoke the app as Settings does. Its credential and embed token are
 *      refused, its live lease is gone and its headless process stops, while
 *      its threads stay open, exportable and deletable from Lecturn and show as
 *      revoked. Pairing again with the approved command restores its project
 *      and threads.
 *   8. An app credential and an embed token are refused for a normal project,
 *      another app's project and an unlisted method, over RPC, the shell stream
 *      and MCP (the host app's thread calling Lecturn's tools). `/embed`, served
 *      from the built web app, refuses framing from a page on a port no app
 *      declared and allows the declared one. A changed headless command waits
 *      for a new approval.
 *
 * A second app ("Security Probe") pairs over the real pairing endpoint to be
 * "another app". Step 7 leaves the host without a credential (a sidecar host
 * only gets one back by restarting), so scenario.ts runs it last.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import {
  AppId,
  type AppRegistration,
  type AppStatus,
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS as O,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  WS_METHODS as W,
  WsRpcGroup,
} from "@lecturn/contracts";
import {
  APPS_WS_METHODS as A,
  AppsDecidePairingInput,
  AppsEnsureWorkspaceInput,
  AppsMintEmbedTokenInput,
} from "@lecturn/contracts/appsRpcCore";
import {
  APPS_PAIRING_REQUESTS_PATH,
  APPS_POLL_SECRET_HEADER,
  appsPairingRequestPath,
} from "@lecturn/contracts/appsHttp";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import type { Page } from "playwright-core";

import { iconDataUrl } from "../src/icon.ts";
import { ADMIN_SCOPES, issueAdminToken } from "./adminClient.ts";
import { createEmbedThread, ticketedSocketUrl } from "./embedRpc.ts";
import { type EmbedHostRun, type HostGlobals, until } from "./harness.ts";
import type { E2eContext } from "./run.ts";

const HOST_APP_ID = AppId.make("dev.example.embedhost");
const PROBE_APP_ID = AppId.make("dev.example.securityprobe");
// Settings reads app status (access:read) and changes it (access:write).
const SETTINGS_SCOPES = [...ADMIN_SCOPES, "access:read"];
const TURN_TIMEOUT_MS = 120_000;
const EMBED_TOKEN_TTL_SECONDS = 300;

const decodeDecidePairing = Schema.decodeSync(AppsDecidePairingInput);
const decodeEnsureWorkspace = Schema.decodeSync(AppsEnsureWorkspaceInput);
const decodeMintEmbedToken = Schema.decodeSync(AppsMintEmbedTokenInput);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** One call on its own socket, signed in with `token`; the exit says whether the server refused it. */
async function rpcExit<A, E>(
  origin: string,
  token: string,
  call: (client: WsClient) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, unknown>> {
  const url = await ticketedSocketUrl(origin, token);
  return Effect.runPromiseExit(
    openClient(url).pipe(Effect.flatMap(call), Effect.scoped, Effect.timeout(30_000)),
  );
}

async function rpc<A, E>(
  origin: string,
  token: string,
  label: string,
  call: (client: WsClient) => Effect.Effect<A, E>,
): Promise<A> {
  const exit = await rpcExit(origin, token, call);
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`${label} failed: ${Cause.pretty(exit.cause)}`);
}

// What the server answers when its authorization, not the transport, says no.
const REFUSALS: ReadonlySet<string> = new Set(["EnvironmentAuthorizationError", "AppsError"]);

function assertRefused(label: string, exit: Exit.Exit<unknown, unknown>) {
  NodeAssert.ok(Exit.isFailure(exit), `${label} was refused`);
  const error = Option.getOrUndefined(Exit.findErrorOption(exit)) as
    | { readonly _tag?: string }
    | undefined;
  NodeAssert.ok(
    error?._tag !== undefined && REFUSALS.has(error._tag),
    `${label} was refused by the server's authorization: ${Cause.pretty(exit.cause)}`,
  );
}

const newCommandId = () => CommandId.make(`embed-host-e2e:${NodeCrypto.randomUUID()}`);

const dispatch = (origin: string, token: string, command: OrchestrationV2Command) =>
  rpc(origin, token, command.type, (client) => client[O.dispatchCommand](command));

const projectionOf = (origin: string, token: string, threadId: ThreadId) =>
  rpc(origin, token, "getThreadProjection", (client) =>
    client[O.getThreadProjection]({ threadId }),
  ) as Promise<OrchestrationV2ThreadProjection>;

const shellSnapshot = (client: WsClient) =>
  client[O.subscribeShell]({}).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.runHead,
    Effect.map((item) =>
      Option.isSome(item) && item.value.kind === "snapshot" ? item.value.snapshot : null,
    ),
  );

const appStatus = async (origin: string, settings: string, appId: AppId) => {
  const apps = await rpc(origin, settings, "apps.list", (client) => client[A.appsList]({}));
  const app = apps.find((entry) => entry.appId === appId);
  NodeAssert.ok(app, `${appId} is registered`);
  return app;
};

const setRuntimeMode = (
  origin: string,
  token: string,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
) =>
  dispatch(origin, token, {
    type: "thread.runtime-mode.set",
    commandId: newCommandId(),
    threadId,
    runtimeMode,
  });

/**
 * Sends a turn whose script is in the message (the scripted provider prefers
 * it over the scripts file) and waits for its closing reply.
 */
async function runScriptedTurn(input: {
  readonly origin: string;
  readonly token: string;
  readonly threadId: ThreadId;
  readonly steps: ReadonlyArray<unknown>;
  readonly reply: string;
}): Promise<OrchestrationV2ThreadProjection> {
  const script = [...input.steps, { assistantText: input.reply }];
  await dispatch(input.origin, input.token, {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: newCommandId(),
    threadId: input.threadId,
    messageId: MessageId.make(`embed-host-e2e:${NodeCrypto.randomUUID()}`),
    text: `Security check.\n\`\`\`scripted\n${JSON.stringify(script)}\n\`\`\``,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });
  return until(`the reply "${input.reply}"`, TURN_TIMEOUT_MS, async () => {
    const projection = await projectionOf(input.origin, input.token, input.threadId);
    return projection.messages.some(
      (message) => message.role === "assistant" && message.text.includes(input.reply),
    )
      ? projection
      : undefined;
  });
}

async function httpStatus(origin: string, path: string, init: RequestInit = {}): Promise<number> {
  const response = await fetch(new URL(path, origin), { credentials: "omit", ...init });
  await response.body?.cancel();
  return response.status;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A WebSocket ticket is the first thing every client buys with its bearer. */
const ticketStatus = (origin: string, token: string) =>
  httpStatus(origin, "/api/auth/websocket-ticket", { method: "POST", headers: bearer(token) });

const mcpStatus = (origin: string, token: string) =>
  httpStatus(origin, "/mcp", {
    method: "POST",
    headers: {
      ...bearer(token),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "embed-host-e2e", version: "0.0.0" },
      },
    }),
  });

const isRefusedStatus = (status: number) => status === 401 || status === 403 || status === 404;

interface PairingRequest {
  readonly requestId: string;
  readonly pollSecret: string;
}

async function requestPairing(
  origin: string,
  registration: AppRegistration,
): Promise<PairingRequest> {
  const response = await fetch(new URL(APPS_PAIRING_REQUESTS_PATH, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
    credentials: "omit",
  });
  NodeAssert.ok(response.ok, `the pairing request was accepted (${response.status})`);
  return (await response.json()) as PairingRequest;
}

async function pollPairing(origin: string, request: PairingRequest) {
  const response = await fetch(new URL(appsPairingRequestPath(request.requestId), origin), {
    headers: { [APPS_POLL_SECRET_HEADER]: request.pollSecret },
    credentials: "omit",
  });
  NodeAssert.ok(response.ok, `the pairing poll was answered (${response.status})`);
  return (await response.json()) as {
    readonly state: string;
    readonly credential?: { readonly token: string };
  };
}

const decide = (origin: string, settings: string, requestId: string, decision: "grant" | "deny") =>
  rpc(origin, settings, `apps.decidePairing ${decision}`, (client) =>
    client[A.appsDecidePairing](decodeDecidePairing({ requestId, decision })),
  );

/** Pairs through the prompt, approved from Settings, and returns the app credential. */
async function pair(origin: string, settings: string, registration: AppRegistration) {
  const request = await requestPairing(origin, registration);
  const granted = await decide(origin, settings, request.requestId, "grant");
  NodeAssert.equal(granted.state, "granted", `${registration.name} is granted`);
  const poll = await pollPairing(origin, request);
  NodeAssert.ok(poll.credential, `${registration.name} received its credential`);
  return poll.credential.token;
}

const ensureWorkspace = (
  origin: string,
  credential: string,
  workspaceRoot: string,
  title: string,
) =>
  rpc(origin, credential, "apps.ensureWorkspace", (client) =>
    client[A.appsEnsureWorkspace](decodeEnsureWorkspace({ workspaceRoot, title })),
  );

const mintEmbedToken = (origin: string, credential: string, projectId: ProjectId) =>
  rpc(origin, credential, "apps.mintEmbedToken", (client) =>
    client[A.appsMintEmbedToken](
      decodeMintEmbedToken({
        projectId,
        ttlSeconds: EMBED_TOKEN_TTL_SECONDS,
      }),
    ),
  );

const probeRegistration = (embedOrigin: string, args: ReadonlyArray<string>): AppRegistration =>
  ({
    appId: PROBE_APP_ID,
    name: "Security Probe",
    iconDataUrl,
    toolPrefix: "probe",
    refPrefixes: ["probe:"],
    // Never started: the probe has no thread that calls a tool.
    headlessTools: { command: process.execPath, args: [...args], cwd: "{workspaceRoot}" },
    liveTools: false,
    gatedTools: [],
    embedOrigins: [embedOrigin],
  }) as AppRegistration;

/**
 * What the host asks with when it pairs again: the command and frame origins
 * the user approved, which Settings shows on its status.
 */
const registrationFromStatus = (status: AppStatus): AppRegistration =>
  ({
    appId: status.appId,
    name: status.name,
    iconDataUrl: status.iconDataUrl,
    toolPrefix: status.toolPrefix,
    refPrefixes: status.refPrefixes,
    ...(status.openUrlTemplate === null ? {} : { openUrlTemplate: status.openUrlTemplate }),
    ...(status.headlessTools === null ? {} : { headlessTools: status.headlessTools }),
    liveTools: true,
    gatedTools: status.gatedTools,
    embedOrigins: status.embedOrigins,
  }) as AppRegistration;

interface FramePage {
  addFrame(src: string): void;
}

const FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>embed-host framing probe</title></head>
<body><script>window.addFrame = (src) => {
  const frame = document.createElement("iframe");
  frame.src = src;
  frame.width = "600";
  frame.height = "400";
  document.body.append(frame);
};</script></body></html>`;

interface FramePageServer {
  readonly origin: string;
  close(): Promise<void>;
}

function startFramePage(): Promise<FramePageServer> {
  const server = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FRAME_PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The framing page server has no TCP address."));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Loads `pageUrl` in a hidden window of the host app, frames `src` in it, and reports what loaded. */
async function frameFrom(
  run: EmbedHostRun,
  pageUrl: string,
  src: string,
  log: E2eContext["log"],
): Promise<"framed" | "refused"> {
  const windowId = await run.app.evaluate(({ BrowserWindow }, url) => {
    const win = new BrowserWindow({ show: false, width: 800, height: 600 });
    void win.loadURL(url);
    return win.id;
  }, pageUrl);
  try {
    const page: Page = await run.guestPage(pageUrl);
    page.on("console", (message) => log(`  framing console: ${message.text()}`));
    await page.waitForFunction(
      () => typeof (window as unknown as FramePage).addFrame === "function",
    );
    await page.evaluate((url) => (window as unknown as FramePage).addFrame(url), src);
    return await until(`the framing of ${src} from ${pageUrl}`, 20_000, async () => {
      const child = page.frames().find((frame) => frame.parentFrame() === page.mainFrame());
      if (child === undefined) return undefined;
      const href = await child.evaluate(() => location.href).catch(() => undefined);
      if (href === undefined || href === "about:blank") return undefined;
      // A refused frame shows Chromium's error page instead of the server's document.
      return new URL(href).origin === new URL(src).origin ? "framed" : "refused";
    });
  } finally {
    await run.app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(),
      windowId,
    );
  }
}

const hostEmbedTarget = (run: EmbedHostRun) =>
  run.app.evaluate(() => (globalThis as HostGlobals).embedHost!.embedTarget());

async function headlessPids(run: EmbedHostRun): Promise<ReadonlyArray<number>> {
  const path = NodePath.join(run.dirs.workspace, ".embed-host", "counter-processes.json");
  if (!NodeFS.existsSync(path)) return [];
  return JSON.parse(await NodeFSP.readFile(path, "utf8")) as Array<number>;
}

/** Signal 0 only asks whether the pid is alive; nothing is sent to the process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const REVOKE_REPLY = "Counted once before the revoke.";

export async function step7(run: EmbedHostRun, log: E2eContext["log"]): Promise<void> {
  const { host, dirs } = run;
  const { origin } = host;
  const settings = await issueAdminToken(dirs.sidecarDir, SETTINGS_SCOPES);
  const projectId = ProjectId.make(host.projectId);

  // A thread with history and a running headless process, and one to delete later.
  const target = await hostEmbedTarget(run);
  const threadId = ThreadId.make(
    await createEmbedThread({
      origin,
      embedToken: target.token,
      projectId,
      title: "Before revoke",
    }),
  );
  const doomedId = ThreadId.make(
    await createEmbedThread({
      origin,
      embedToken: target.token,
      projectId,
      title: "Deleted while revoked",
    }),
  );
  await setRuntimeMode(origin, settings, threadId, "full-access");
  await runScriptedTurn({
    origin,
    token: settings,
    threadId,
    steps: [{ toolCall: { name: "ex_counter_increment", arguments: { by: 1 } } }],
    reply: REVOKE_REPLY,
  });
  const live = (await headlessPids(run)).filter(isAlive);
  NodeAssert.ok(live.length > 0, "the headless counter process is running");
  NodeAssert.notEqual(
    (await appStatus(origin, settings, HOST_APP_ID)).live,
    null,
    "the host holds a live lease",
  );
  log(`step 7: thread ${threadId}, headless pids ${live.join(", ")}`);

  const revoked = await rpc(origin, settings, "apps.revoke", (client) =>
    client[A.appsRevoke]({ appId: HOST_APP_ID }),
  );
  NodeAssert.equal(revoked.state, "revoked");
  NodeAssert.equal(revoked.live, null, "revoking clears the live lease");
  log("revoked Embed Host from Settings");

  // The credential and the embed token it minted are refused.
  NodeAssert.ok(
    isRefusedStatus(await ticketStatus(origin, target.token)),
    "the embed token is refused",
  );
  const minted = await Promise.race([
    hostEmbedTarget(run).then(
      () => "minted",
      () => "refused",
    ),
    sleep(15_000).then(() => "no answer"),
  ]);
  NodeAssert.notEqual(minted, "minted", "the host's credential can no longer mint embed tokens");
  log(`the host's own credential: ${minted}`);

  await until("the headless process to stop", 15_000, async () =>
    live.some(isAlive) ? undefined : true,
  );
  log("the headless process stopped");

  // Lecturn keeps the threads: shown as revoked, open, exportable and deletable.
  const embedContext = await rpc(origin, settings, "apps.subscribeEmbedContext", (client) =>
    client[A.appsSubscribeEmbedContext]({ projectId }).pipe(Stream.runHead),
  );
  NodeAssert.equal(
    Option.getOrUndefined(embedContext)?.state,
    "revoked",
    "the app's threads read the app as revoked",
  );
  const projection = await projectionOf(origin, settings, threadId);
  NodeAssert.ok(
    projection.messages.some(
      (message) => message.role === "assistant" && message.text.includes(REVOKE_REPLY),
    ),
    "the thread opens with its history",
  );
  NodeAssert.equal(
    await httpStatus(origin, `/api/orchestration/threads/${threadId}/transcript`, {
      headers: bearer(settings),
    }),
    200,
    "the thread exports",
  );
  await dispatch(origin, settings, {
    type: "thread.delete",
    commandId: newCommandId(),
    threadId: doomedId,
  });
  await until("the deleted thread to leave the shell", 15_000, async () => {
    const snapshot = await rpc(origin, settings, "subscribeShell", shellSnapshot);
    const ids = new Set(snapshot?.threads.map((thread) => thread.id));
    return ids.has(threadId) && !ids.has(doomedId) ? true : undefined;
  });
  log("revoked app's thread opened, exported; another deleted");

  // Pairing again with the approved command restores the app with its project and threads.
  const request = await requestPairing(origin, registrationFromStatus(revoked));
  const waiting = await appStatus(origin, settings, HOST_APP_ID);
  NodeAssert.equal(waiting.state, "revoked", "a revoked app stays revoked until the user approves");
  NodeAssert.equal(
    waiting.pendingRequest?.requestId,
    request.requestId,
    "Settings shows the re-pair request",
  );
  const restored = await decide(origin, settings, request.requestId, "grant");
  NodeAssert.equal(restored.state, "granted");
  const poll = await pollPairing(origin, request);
  NodeAssert.ok(poll.credential, "the re-paired app received a new credential");
  const credential = poll.credential.token;
  const again = await ensureWorkspace(origin, credential, host.workspaceRoot, "ws-a");
  NodeAssert.equal(again.projectId, projectId, "the app finds its project again");
  const threads = await rpc(origin, credential, "apps.listThreads", (client) =>
    client[A.appsListThreads]({ projectId }),
  );
  NodeAssert.ok(
    threads.some((thread) => thread.threadId === threadId),
    "the app sees its thread again",
  );
  const fresh = await mintEmbedToken(origin, credential, projectId);
  NodeAssert.equal(await ticketStatus(origin, fresh.token), 200, "a new embed token works");
  log("re-paired: project, threads and embed tokens restored");
}

const PROBE_REPLY = "Security probe done.";

export async function step8(run: EmbedHostRun, log: E2eContext["log"]): Promise<void> {
  const { host, dirs } = run;
  const { origin } = host;
  const settings = await issueAdminToken(dirs.sidecarDir, SETTINGS_SCOPES);
  const hostProject = ProjectId.make(host.projectId);
  const allowedPage = await startFramePage();
  const refusedPage = await startFramePage();
  try {
    // The cast: a normal project, another app's project, and the host's own.
    const normalRoot = NodePath.join(dirs.root, "ws-normal");
    const normalProject = ProjectId.make(NodeCrypto.randomUUID());
    await rpc(origin, settings, "projects.mutate", (client) =>
      client[W.projectsMutate]({
        type: "project.create",
        commandId: newCommandId(),
        projectId: normalProject,
        title: "Normal",
        workspaceRoot: normalRoot,
        createWorkspaceRootIfMissing: true,
      }),
    );
    const normalThread = ThreadId.make(NodeCrypto.randomUUID());
    await dispatch(origin, settings, {
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: newCommandId(),
      threadId: normalThread,
      projectId: normalProject,
      title: "Normal thread",
      modelSelection: { instanceId: ProviderInstanceId.make("scripted"), model: "scripted" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    const probeArgs = ["--probe", "v1"];
    const probeCredential = await pair(
      origin,
      settings,
      probeRegistration(allowedPage.origin, probeArgs),
    );
    const probeRoot = NodePath.join(dirs.root, "ws-probe");
    await NodeFSP.mkdir(probeRoot, { recursive: true });
    const probeProject = (await ensureWorkspace(origin, probeCredential, probeRoot, "ws-probe"))
      .projectId;
    const probeEmbed = await mintEmbedToken(origin, probeCredential, probeProject);
    const probeThread = ThreadId.make(
      await createEmbedThread({
        origin,
        embedToken: probeEmbed.token,
        projectId: probeProject,
        title: "Probe thread",
      }),
    );
    const hostEmbed = await hostEmbedTarget(run);
    const hostThread = ThreadId.make(
      await createEmbedThread({
        origin,
        embedToken: hostEmbed.token,
        projectId: hostProject,
        title: "Security",
      }),
    );
    log(
      `step 8: normal ${normalProject}, probe app ${probeProject}, host ${hostProject} (thread ${hostThread})`,
    );

    // RPC: the probe's app credential and the host's embed token, against what is not theirs.
    const appRefusals: ReadonlyArray<
      readonly [string, (client: WsClient) => Effect.Effect<unknown, unknown>]
    > = [
      [
        "listThreads of a normal project",
        (c) => c[A.appsListThreads]({ projectId: normalProject }),
      ],
      [
        "listThreads of another app's project",
        (c) => c[A.appsListThreads]({ projectId: hostProject }),
      ],
      [
        "mintEmbedToken for another app's project",
        (c) =>
          c[A.appsMintEmbedToken](decodeMintEmbedToken({ projectId: hostProject, ttlSeconds: 60 })),
      ],
      [
        "setThreadAppData on a normal thread",
        (c) => c[A.appsSetThreadAppData]({ threadId: normalThread, appData: "x" }),
      ],
      // Unlisted: an app credential reads no thread at all, not even its own.
      [
        "getThreadProjection of its own thread",
        (c) => c[O.getThreadProjection]({ threadId: probeThread }),
      ],
      ["apps.list", (c) => c[A.appsList]({})],
    ];
    for (const [label, call] of appRefusals) {
      assertRefused(`app credential: ${label}`, await rpcExit(origin, probeCredential, call));
    }
    const embedRefusals: ReadonlyArray<
      readonly [string, (client: WsClient) => Effect.Effect<unknown, unknown>]
    > = [
      [
        "getThreadProjection of a normal thread",
        (c) => c[O.getThreadProjection]({ threadId: normalThread }),
      ],
      [
        "getThreadProjection of another app's thread",
        (c) => c[O.getThreadProjection]({ threadId: probeThread }),
      ],
      [
        "createEmbedThread in a normal project",
        (c) => c[A.appsCreateEmbedThread]({ projectId: normalProject }),
      ],
      [
        "createEmbedThread in another app's project",
        (c) => c[A.appsCreateEmbedThread]({ projectId: probeProject }),
      ],
      [
        "a message to another app's thread",
        (c) =>
          c[O.dispatchCommand]({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: newCommandId(),
            threadId: probeThread,
            messageId: MessageId.make(`embed-host-e2e:${NodeCrypto.randomUUID()}`),
            text: "hello",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          }),
      ],
      [
        "searchEntries in a normal project's folder",
        (c) => c[W.projectsSearchEntries]({ cwd: normalRoot, query: "readme", limit: 10 }),
      ],
      // Unlisted, though its scope (orchestration:operate) is one the token holds.
      [
        "projects.mutate",
        (c) =>
          c[W.projectsMutate]({
            type: "project.create",
            commandId: newCommandId(),
            projectId: ProjectId.make(NodeCrypto.randomUUID()),
            title: "Smuggled",
            workspaceRoot: dirs.root,
          }),
      ],
      ["apps.list", (c) => c[A.appsList]({})],
    ];
    for (const [label, call] of embedRefusals) {
      assertRefused(`embed token: ${label}`, await rpcExit(origin, hostEmbed.token, call));
    }
    log(
      `RPC: ${appRefusals.length} app-credential and ${embedRefusals.length} embed-token calls refused`,
    );

    // Shell stream: the embed sees only its own project; the app credential gets no stream.
    const embedShell = await rpc(origin, hostEmbed.token, "embed subscribeShell", shellSnapshot);
    NodeAssert.ok(embedShell, "the embed token gets a shell snapshot");
    NodeAssert.deepEqual(
      [...new Set(embedShell.projects.map((project) => project.id))],
      [hostProject],
      "the embed's shell holds its own project only",
    );
    const leaked = [...embedShell.threads, ...embedShell.archivedThreads].filter(
      (thread) => thread.projectId !== hostProject,
    );
    NodeAssert.deepEqual(
      leaked.map((thread) => thread.id),
      [],
      "no other project's threads reach the embed",
    );
    assertRefused(
      "app credential: subscribeShell",
      await rpcExit(origin, probeCredential, shellSnapshot),
    );
    NodeAssert.ok(
      isRefusedStatus(
        await httpStatus(origin, `/api/orchestration/threads/${normalThread}`, {
          headers: bearer(hostEmbed.token),
        }),
      ),
      "embed token: a normal thread over HTTP",
    );
    NodeAssert.ok(
      isRefusedStatus(
        await httpStatus(origin, "/api/orchestration/shell", { headers: bearer(probeCredential) }),
      ),
      "app credential: the shell over HTTP",
    );
    log("shell stream filtered for the embed and refused to the app credential");

    // MCP: neither credential signs in to /mcp, and the app's own thread reaches only its project.
    for (const [label, token] of [
      ["app credential", probeCredential],
      ["embed token", hostEmbed.token],
    ] as const) {
      NodeAssert.ok(isRefusedStatus(await mcpStatus(origin, token)), `${label}: /mcp is refused`);
    }
    await setRuntimeMode(origin, settings, hostThread, "full-access");
    const mcpCalls: ReadonlyArray<{
      readonly name: string;
      readonly arguments: Record<string, unknown>;
      readonly allowed: boolean;
    }> = [
      { name: "lecturn_thread_read", arguments: { threadId: normalThread }, allowed: false },
      { name: "lecturn_thread_read", arguments: { threadId: probeThread }, allowed: false },
      { name: "lecturn_project_read", arguments: { projectId: normalProject }, allowed: false },
      { name: "list_thread_pull_requests", arguments: { threadId: normalThread }, allowed: false },
      {
        name: "lecturn_project_delete",
        arguments: { projectId: normalProject, force: true },
        allowed: false,
      },
      { name: "lecturn_project_list", arguments: {}, allowed: true },
      { name: "lecturn_thread_read", arguments: { threadId: hostThread }, allowed: true },
    ];
    const afterTurn = await runScriptedTurn({
      origin,
      token: settings,
      threadId: hostThread,
      steps: mcpCalls.map((call) => ({ toolCall: { name: call.name, arguments: call.arguments } })),
      reply: PROBE_REPLY,
    });
    const toolItems = afterTurn.turnItems.filter((item) => item.type === "dynamic_tool");
    for (const call of mcpCalls) {
      const item = toolItems.find(
        (candidate) =>
          candidate.type === "dynamic_tool" &&
          candidate.toolName === `lecturn.${call.name}` &&
          JSON.stringify(candidate.input) === JSON.stringify(call.arguments),
      );
      NodeAssert.ok(item && item.type === "dynamic_tool", `MCP ${call.name} ran`);
      NodeAssert.equal(
        item.status,
        call.allowed ? "completed" : "failed",
        `MCP ${call.name} ${JSON.stringify(call.arguments)} was ${call.allowed ? "served" : "refused"}`,
      );
      // Outputs may be left out of the projection; when present, the list is the app's own.
      if (call.name === "lecturn_project_list" && item.output !== undefined) {
        const output = JSON.stringify(item.output);
        NodeAssert.ok(output.includes(hostProject), "the app's thread lists its own project");
        for (const other of [normalProject, probeProject]) {
          NodeAssert.ok(!output.includes(other), `the app's thread does not list ${other}`);
        }
      }
    }
    const normalAfter = await rpc(origin, settings, "subscribeShell", shellSnapshot);
    NodeAssert.ok(
      normalAfter?.projects.some((project) => project.id === normalProject),
      "the normal project survived the app thread's delete attempt",
    );
    log(`MCP: ${mcpCalls.filter((call) => !call.allowed).length} cross-project calls refused`);

    // Framing: the built web app's /embed sends frame-ancestors; only the declared port may frame.
    const embedUrl = `${origin}/embed/${host.environmentId}/${probeProject}`;
    const embedResponse = await fetch(embedUrl, { credentials: "omit" });
    await embedResponse.body?.cancel();
    const policy = embedResponse.headers.get("content-security-policy") ?? "";
    log(`/embed Content-Security-Policy: ${policy}`);
    NodeAssert.match(policy, /frame-ancestors/, "/embed declares frame-ancestors");
    NodeAssert.ok(policy.includes(allowedPage.origin), "the probe's declared origin may frame");
    NodeAssert.ok(!policy.includes(refusedPage.origin), "an undeclared port is not listed");
    NodeAssert.equal(
      await frameFrom(run, `${allowedPage.origin}/frame`, embedUrl, log),
      "framed",
      "a page on the declared port frames /embed",
    );
    NodeAssert.equal(
      await frameFrom(run, `${refusedPage.origin}/frame`, embedUrl, log),
      "refused",
      "a page on an undeclared port is refused framing",
    );
    log(`framing: ${allowedPage.origin} framed, ${refusedPage.origin} refused`);

    // A changed headless command is not what the user approved: it waits for a new approval.
    const changed = await requestPairing(
      origin,
      probeRegistration(allowedPage.origin, [...probeArgs, "--changed"]),
    );
    const pending = await appStatus(origin, settings, PROBE_APP_ID);
    NodeAssert.equal(pending.state, "pairing-requested", "the grant is suspended");
    NodeAssert.deepEqual(
      pending.pendingRequest?.registration.headlessTools?.args,
      [...probeArgs, "--changed"],
      "Settings shows the changed command",
    );
    NodeAssert.deepEqual(pending.headlessTools?.args, probeArgs, "the approved command is kept");
    NodeAssert.equal((await pollPairing(origin, changed)).state, "pairing-requested");
    const denied = await decide(origin, settings, changed.requestId, "deny");
    NodeAssert.equal(denied.state, "denied");
    NodeAssert.ok(
      isRefusedStatus(await ticketStatus(origin, probeCredential)),
      "denying the change retires the old credential",
    );
    log("a changed headless command waited for approval and was denied");
  } finally {
    await Promise.all([allowedPage.close(), refusedPage.close()]);
  }
}
