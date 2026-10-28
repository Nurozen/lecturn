// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - A real loopback HTTP server stands in for the app's live endpoint.
/**
 * One app tool call through the whole stack a provider reaches: a real MCP
 * SDK client on `/mcp`, the interceptor, the toolkit with its real gate,
 * approval step and card envelope, then the real headless host over the
 * fixture app or the real live client over a loopback endpoint. Only the
 * registry, the calling thread's projection and the user's answer to an
 * approval are faked; AppToolApprovalService has its own tests.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  APP_TOOL_APPROVAL_META_KEY,
  APP_TOOL_APPROVAL_REQUIRED_META_KEY,
  APP_TOOL_CONTEXT_META_KEY,
  type AppLiveLeaseInput,
  type AppRegistration,
  type ConnectedAppToolApprovalInfo,
  EnvironmentId,
  NodeId,
  type OrchestrationV2AppThread,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import {
  MCP_APP_OUTPUT_KEY,
  type McpAppReference,
  readMcpAppToolOutcome,
} from "@lecturn/shared/mcpApp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as AppLeaseServiceLayer from "../../../apps/AppLeaseService.ts";
import * as AppRuntimeState from "../../../apps/AppRuntimeState.ts";
import * as HeadlessToolHostLayer from "../../../apps/HeadlessToolHost.ts";
import * as LiveToolClientLayer from "../../../apps/LiveToolClient.ts";
import {
  AppLeaseService,
  type AppToolApprovalOutcome,
  AppToolApprovalService,
} from "../../../apps/services.ts";
import {
  fixtureAppId as appId,
  fixtureProjectId as projectId,
  fixtureRegistration,
  makeFakeApps,
  makeWorkspace,
} from "../../../apps/testing/headlessAppFixture.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../../../orchestration-v2/RuntimePolicy.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as AppToolkitLayer from "./AppToolkit.ts";

const threadId = ThreadId.make("thread-app-integration");
const providerInstanceId = ProviderInstanceId.make("codex");
const turnId = ProviderTurnId.make("provider-turn-integration");
const FLASH_CARD_URI = "ui://ex/flash-card";
const FLASH_CARD_HTML = "<!doctype html><title>Flash</title><main>flash</main>";
const LIVE_BEARER = "live-bearer-integration";
const LIVE_SESSION = "live-session-1";
const CLOSED = "Counter is closed; open it to use ex_window_flash.";

const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 25, 12, 0, 0));
const baseThread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Counting",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

/** The app's live tools: a gated one with a card, and one the app decides to gate itself. */
const liveDefinitions = [
  new McpSchema.Tool({
    name: "window_flash",
    inputSchema: { type: "object", properties: { color: { type: "string" } } },
    _meta: { ui: { resourceUri: FLASH_CARD_URI, visibility: ["model", "app"] } },
  }),
  new McpSchema.Tool({ name: "save_snapshot", inputSchema: { type: "object" } }),
];

interface LiveCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly meta: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The host app's live endpoint, as examples/embed-host/src/liveMcp.ts answers:
 * a tool that needs approval says `lecturn/approval-required` until Lecturn
 * forwards it approved, so nothing runs unasked even if Lecturn forgot to gate.
 */
const liveAnswer = (call: LiveCall, calls: ReadonlyArray<LiveCall>) => {
  const approval = call.meta[APP_TOOL_APPROVAL_META_KEY];
  if (!isRecord(approval) || approval.approved !== true) {
    return {
      isError: true,
      content: [{ type: "text", text: `${call.name} needs approval.` }],
      _meta: { [APP_TOOL_APPROVAL_REQUIRED_META_KEY]: { reason: `${call.name} touches the app.` } },
    };
  }
  const ran = calls.filter((entry) => {
    const meta = entry.meta[APP_TOOL_APPROVAL_META_KEY];
    return entry.name === call.name && isRecord(meta) && meta.approved === true;
  }).length;
  return {
    content: [{ type: "text", text: `${call.name} ran` }],
    structuredContent: { ran, requestId: approval.requestId ?? null },
  };
};

const startLiveApp = Effect.acquireRelease(
  Effect.promise(async () => {
    const calls: Array<LiveCall> = [];
    const server = NodeHttp.createServer(async (req, res) => {
      const chunks: Array<Buffer> = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      if (req.headers.authorization !== `Bearer ${LIVE_BEARER}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      const message = JSON.parse(text) as {
        readonly id?: number;
        readonly method: string;
        readonly params?: Record<string, unknown>;
      };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const params = message.params ?? {};
      const result = (() => {
        switch (message.method) {
          case "initialize":
            return {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "live-integration", version: "1" },
            };
          case "tools/call": {
            const call: LiveCall = {
              name: String(params.name),
              arguments: isRecord(params.arguments) ? params.arguments : {},
              meta: isRecord(params._meta) ? params._meta : {},
            };
            calls.push(call);
            return liveAnswer(call, calls);
          }
          case "resources/read":
            return params.uri === FLASH_CARD_URI
              ? {
                  contents: [
                    {
                      uri: FLASH_CARD_URI,
                      mimeType: "text/html;profile=mcp-app",
                      text: FLASH_CARD_HTML,
                    },
                  ],
                }
              : undefined;
          default:
            return undefined;
        }
      })();
      const envelope =
        result === undefined
          ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No such method" } }
          : { jsonrpc: "2.0", id: message.id, result };
      const headers = message.method === "initialize" ? { "mcp-session-id": LIVE_SESSION } : {};
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(envelope));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as NodeNet.AddressInfo;
    return { server, calls, url: `http://127.0.0.1:${port}/mcp` };
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

/** The real runtime policy over a provider that supports every mode. */
const layerRuntimePolicy = (workspaceRoot: string) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () =>
          Effect.succeed({
            snapshot: { getSnapshot: Effect.succeed({} as ServerProvider) },
          } as ProviderInstance),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            projectId,
            title: "Counters",
            workspaceRoot,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-25T12:00:00.000Z",
            updatedAt: "2026-10-25T12:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
  );

/** The calling thread, in whatever mode the test last picked, with a running turn. */
const layerProjection = (runtimeMode: Ref.Ref<RuntimeMode>) =>
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThread: () =>
      Ref.get(runtimeMode).pipe(Effect.map((mode) => ({ ...baseThread, runtimeMode: mode }))),
    getRunningTurnContext: () =>
      Effect.succeed({
        run: undefined,
        providerThread: undefined,
        providerTurn: {
          id: turnId,
          providerThreadId: ProviderThreadId.make("provider-thread-integration"),
          nodeId: NodeId.make("node-integration"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: at,
          completedAt: null,
        },
      }),
  });

const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "A built-in Lecturn tool.",
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

const makeRegistry = McpSessionRegistry.__testing.make().pipe(
  Effect.provideService(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43126),
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  ),
  Effect.provideService(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-app-integration")),
      getDescriptor: Effect.die("unused"),
    }),
  ),
  Effect.provide(NodeServices.layer),
);

interface CallResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface Stack {
  readonly call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<CallResult, never, never>;
  readonly setMode: (mode: RuntimeMode) => Effect.Effect<void>;
  /** The user's answer to every approval from here on. */
  readonly answerApprovals: (outcome: AppToolApprovalOutcome) => Effect.Effect<void>;
  readonly approvals: ReadonlyArray<ConnectedAppToolApprovalInfo>;
  readonly liveCalls: ReadonlyArray<LiveCall>;
  readonly open: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly workspace: ReturnType<typeof makeWorkspace>;
  readonly attachmentsDir: string;
}

const withStack = <A, E>(body: (stack: Stack) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = makeWorkspace();
      yield* Effect.addFinalizer(() => Effect.sync(workspace.remove));
      const live = yield* startLiveApp;
      const runtimeMode = yield* Ref.make<RuntimeMode>("approval-required");
      const outcome = yield* Ref.make<AppToolApprovalOutcome>("approved");
      const approvals: Array<ConnectedAppToolApprovalInfo> = [];

      const registration: AppRegistration = {
        ...fixtureRegistration(workspace.logPath, { listArgs: true }),
        liveTools: true,
        // `gated_job` and `save_snapshot` are gated by the app's own answer.
        gatedTools: ["window_flash"],
      };
      const fake = yield* makeFakeApps({
        registration,
        workspaceRoot: workspace.workspaceRoot,
        cachedLive: liveDefinitions,
      });
      const apps = yield* Layer.build(
        AppToolkitLayer.layerWithRuntimePolicy.pipe(
          Layer.provideMerge(HeadlessToolHostLayer.layer),
          Layer.provideMerge(AppRuntimeState.layer),
          Layer.provideMerge(AppLeaseServiceLayer.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(workspace.workspaceRoot, {
              prefix: "lecturn-app-toolkit-integration-",
            }),
          ),
          Layer.provide(
            Layer.mergeAll(
              fake.layer,
              layerProjection(runtimeMode),
              layerRuntimePolicy(workspace.workspaceRoot),
              LiveToolClientLayer.layer,
              Layer.mock(AppToolApprovalService)({
                request: (_context, info) =>
                  Effect.gen(function* () {
                    approvals.push(info);
                    return {
                      outcome: yield* Ref.get(outcome),
                      requestId: RuntimeRequestId.make(`request-${approvals.length}`),
                    };
                  }),
              }),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
      );
      const registry = yield* makeRegistry;
      const { config } = yield* registry.issue({
        threadId,
        providerInstanceId,
        app: { appId, projectId },
      });
      const serverLayer = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          probe: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
        Layer.provide(Layer.succeedContext(apps)),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const { address } = yield* HttpServer.HttpServer;
      if (!NetAddress.isInetAddress(address)) return yield* Effect.die("no tcp address");
      const client = new Client({ name: "app-toolkit-integration", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
        { requestInit: { headers: { authorization: config.authorizationHeader } } },
      );
      yield* Effect.acquireRelease(
        // The SDK's own types disagree under exactOptionalPropertyTypes (its
        // optional callbacks lack `| undefined`); the object is the same.
        Effect.promise(() => client.connect(transport as Transport)),
        () => Effect.promise(() => client.close()),
      );

      const leases = Context.get(apps, AppLeaseService);
      const leaseInput = {
        url: live.url,
        bearer: LIVE_BEARER,
        ttlSeconds: 60,
      } as AppLiveLeaseInput;
      return yield* body({
        call: (name, args = {}) =>
          Effect.promise(
            () =>
              client.callTool({ name, arguments: args }) as Promise<unknown> as Promise<CallResult>,
          ),
        setMode: (mode) => Ref.set(runtimeMode, mode),
        answerApprovals: (next) => Ref.set(outcome, next),
        approvals,
        liveCalls: live.calls,
        open: leases.set(appId, leaseInput).pipe(Effect.orDie, Effect.asVoid),
        close: leases.clear(appId).pipe(Effect.orDie),
        workspace,
        attachmentsDir: Context.get(apps, ServerConfig.ServerConfig).attachmentsDir,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));

/** The card reference a client renders, after checking its captured document is on disk. */
const cardOf = (stack: Stack, result: CallResult) => {
  const reference = result.structuredContent?.[MCP_APP_OUTPUT_KEY] as McpAppReference | undefined;
  expect(reference, `a card envelope on ${JSON.stringify(result)}`).toBeDefined();
  const html = NodeFS.readFileSync(
    NodePath.join(stack.attachmentsDir, `${reference!.attachmentId}.html`),
    "utf8",
  );
  return { reference: reference!, html, outcome: readMcpAppToolOutcome(result.structuredContent) };
};

const approvalSent = (call: LiveCall) => call.meta[APP_TOOL_APPROVAL_META_KEY];

const contextMeta = (stack: Stack) => ({
  projectId,
  threadId,
  workspaceRoot: stack.workspace.workspaceRoot,
  turnId,
});

const ALL_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const PROMPTING_MODES = new Set<RuntimeMode>(["approval-required", "auto-accept-edits"]);

describe("AppToolkit through /mcp", () => {
  it.effect("runs an ungated headless call in every mode with context meta and its card", () =>
    withStack((stack) =>
      Effect.gen(function* () {
        for (const mode of ALL_MODES) {
          yield* stack.setMode(mode);
          const echoed = yield* stack.call("ex_echo_meta");
          expect(echoed.structuredContent?.meta, mode).toMatchObject({
            [APP_TOOL_CONTEXT_META_KEY]: contextMeta(stack),
            // Auto and Full access tell the app in advance not to ask on its own.
            [APP_TOOL_APPROVAL_META_KEY]: { approved: !PROMPTING_MODES.has(mode) },
          });

          const incremented = yield* stack.call("ex_increment", { by: 2 });
          const card = cardOf(stack, incremented);
          expect(card.reference).toMatchObject({
            server: "lecturn",
            tool: "ex_increment",
            resourceUri: "ui://ex/counter-card",
          });
          expect(card.html).toContain("<p>count</p>");
          expect(card.outcome.result).toMatchObject({
            content: [{ type: "text", text: "count 2" }],
            structuredContent: { count: 2 },
          });
        }
        expect(stack.approvals).toEqual([]);
      }),
    ),
  );

  it.effect("asks once before a gated live call in Supervised and returns its card", () =>
    withStack((stack) =>
      Effect.gen(function* () {
        yield* stack.open;
        const flashed = yield* stack.call("ex_window_flash", { color: "gold" });

        expect(stack.approvals).toEqual([
          {
            appId,
            appName: "Counter",
            toolName: "ex_window_flash",
            reason: null,
            source: "static",
          },
        ]);
        expect(stack.liveCalls).toEqual([
          {
            name: "window_flash",
            arguments: { color: "gold" },
            meta: {
              [APP_TOOL_CONTEXT_META_KEY]: contextMeta(stack),
              [APP_TOOL_APPROVAL_META_KEY]: { approved: true, requestId: "request-1" },
            },
          },
        ]);
        expect(flashed.isError).toBeFalsy();
        const card = cardOf(stack, flashed);
        expect(card.reference).toMatchObject({
          server: "lecturn",
          tool: "ex_window_flash",
          resourceUri: FLASH_CARD_URI,
        });
        // The headless process does not serve this card, so it was read live.
        expect(card.html).toContain("<main>flash</main>");
        expect(card.outcome.result).toMatchObject({
          structuredContent: { ran: 1, requestId: "request-1" },
        });
      }),
    ),
  );

  it.effect("forwards a gated live call approved without asking in Auto and Full access", () =>
    withStack((stack) =>
      Effect.gen(function* () {
        yield* stack.open;
        for (const mode of ["auto", "full-access"] as const) {
          yield* stack.setMode(mode);
          const flashed = yield* stack.call("ex_window_flash");
          expect(cardOf(stack, flashed).outcome.result, mode).toMatchObject({
            structuredContent: { requestId: null },
          });
        }
        expect(stack.approvals).toEqual([]);
        expect(stack.liveCalls.map(approvalSent)).toEqual([{ approved: true }, { approved: true }]);
      }),
    ),
  );

  it.effect("never contacts the app on a declined gated call and shows its card cancelled", () =>
    withStack((stack) =>
      Effect.gen(function* () {
        yield* stack.open;
        yield* stack.answerApprovals("declined");
        const declined = yield* stack.call("ex_window_flash");

        const refusal = "The user declined ex_window_flash (approval declined).";
        expect(declined.isError).toBe(true);
        expect(declined.content).toEqual([{ type: "text", text: refusal }]);
        expect(cardOf(stack, declined).outcome).toEqual({ cancelled: { reason: refusal } });
        expect(stack.approvals).toHaveLength(1);
        expect(stack.liveCalls).toEqual([]);
      }),
    ),
  );

  it.effect("answers a closed app's live call before gating, in every mode", () =>
    withStack((stack) =>
      Effect.gen(function* () {
        yield* stack.open;
        yield* stack.close;
        for (const mode of ALL_MODES) {
          yield* stack.setMode(mode);
          const closed = yield* stack.call("ex_window_flash");
          expect(closed, mode).toMatchObject({
            isError: true,
            content: [{ type: "text", text: CLOSED }],
          });
          expect(closed.structuredContent?.[MCP_APP_OUTPUT_KEY]).toBeUndefined();
        }
        expect(stack.approvals).toEqual([]);
        expect(stack.liveCalls).toEqual([]);

        // Headless tools keep working while the app is closed.
        const incremented = yield* stack.call("ex_increment");
        expect(cardOf(stack, incremented).reference.tool).toBe("ex_increment");
      }),
    ),
  );

  it.effect("re-sends an app-decided call with the request id after asking in Supervised", () =>
    withStack((stack) =>
      Effect.gen(function* () {
        yield* stack.open;
        const headless = yield* stack.call("ex_gated_job");
        expect(headless.structuredContent).toEqual({ ran: true, requestId: "request-1" });

        const live = yield* stack.call("ex_save_snapshot");
        expect(live.structuredContent).toEqual({ ran: 1, requestId: "request-2" });
        expect(stack.liveCalls.map(approvalSent)).toEqual([
          { approved: false },
          { approved: true, requestId: "request-2" },
        ]);

        expect(stack.approvals).toEqual([
          {
            appId,
            appName: "Counter",
            toolName: "ex_gated_job",
            reason: "Runs for a long time.",
            source: "app",
          },
          {
            appId,
            appName: "Counter",
            toolName: "ex_save_snapshot",
            reason: "save_snapshot touches the app.",
            source: "app",
          },
        ]);
        const headlessCalls = stack.workspace
          .events()
          .filter((event) => event.event === "call" && event.name === "gated_job");
        expect(headlessCalls).toHaveLength(2);
      }),
    ),
  );

  it.effect("runs an app-decided call at once in Full access, approved in advance", () =>
    withStack((stack) =>
      Effect.gen(function* () {
        yield* stack.open;
        yield* stack.setMode("full-access");
        expect((yield* stack.call("ex_gated_job")).structuredContent).toEqual({
          ran: true,
          requestId: null,
        });
        expect((yield* stack.call("ex_save_snapshot")).structuredContent).toEqual({
          ran: 1,
          requestId: null,
        });
        expect(stack.approvals).toEqual([]);
        expect(stack.liveCalls.map(approvalSent)).toEqual([{ approved: true }]);
      }),
    ),
  );
});
