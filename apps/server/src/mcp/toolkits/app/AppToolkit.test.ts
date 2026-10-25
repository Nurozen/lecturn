import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  APP_TOOL_APPROVAL_META_KEY,
  APP_TOOL_APPROVAL_REQUIRED_META_KEY,
  APP_TOOL_CONTEXT_META_KEY,
  type AppRegistration,
  EnvironmentId,
  NodeId,
  type OrchestrationV2AppThread,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@lecturn/contracts";
import { MCP_APP_OUTPUT_KEY } from "@lecturn/shared/mcpApp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as AppRuntimeState from "../../../apps/AppRuntimeState.ts";
import type * as AppToolGate from "../../../apps/AppToolGate.ts";
import { makeHeadlessReaper } from "../../../apps/headlessReaper.ts";
import * as HeadlessToolHostLayer from "../../../apps/HeadlessToolHost.ts";
import * as LiveToolClientLayer from "../../../apps/LiveToolClient.ts";
import {
  type AppLease,
  AppLeaseService,
  AppToolApprovalService,
  AppToolkit,
  type AppToolCallRequest,
  HeadlessToolHost,
  LiveToolClient,
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
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import type * as AppCardEnvelope from "./AppCardEnvelope.ts";
import * as AppToolkitLayer from "./AppToolkit.ts";
import type * as AppToolApproval from "./appToolApproval.ts";

const threadId = ThreadId.make("thread-app");
const providerInstanceId = ProviderInstanceId.make("codex");
const turnId = ProviderTurnId.make("provider-turn-1");
const workspaceRoot = "/Users/me/counters/";

const appScope: McpInvocationContext.McpAppInvocationScope = {
  environmentId: EnvironmentId.make("environment-app-test"),
  capabilities: new Set(["orchestration", "app"]),
  issuedAt: 1,
  requestNamespace: "provider-session-1",
  thread: { threadId, providerSessionId: "provider-session-1", providerInstanceId },
  client: undefined,
  app: { appId, projectId },
};
const plainScope: McpInvocationContext.McpInvocationScope = {
  ...appScope,
  capabilities: new Set(["orchestration"]),
  app: undefined,
};

const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 25, 12, 0, 0));
const thread: OrchestrationV2AppThread = {
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

const layerProjection = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getThread: () => Effect.succeed(thread),
  getRunningTurnContext: () =>
    Effect.succeed({
      run: undefined,
      providerThread: undefined,
      providerTurn: {
        id: turnId,
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        nodeId: NodeId.make("node-1"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: at,
        completedAt: null,
      },
    }),
});

const tool = (fields: ConstructorParameters<typeof McpSchema.Tool>[0]) =>
  new McpSchema.Tool(fields);

const cachedTools = [
  tool({
    name: "increment",
    title: "Increment",
    description: "Adds to the counter.",
    inputSchema: { type: "object", properties: { by: { type: "number" } } },
    outputSchema: { type: "object", properties: { count: { type: "number" } } },
    _meta: {
      ui: { resourceUri: "ui://ex/counter-card", visibility: ["model", "app"], csp: {} },
      "openai/outputTemplate": "ui://ex/counter-card",
    },
  }),
  tool({
    name: "refresh_card",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["app"] } },
  }),
  tool({ name: "echo_meta", inputSchema: { type: "object" } }),
  tool({ name: "gated_job", inputSchema: { type: "object" } }),
];
const liveTools = [tool({ name: "window_flash", inputSchema: { type: "object" } })];

const encodeTool = Schema.encodeSync(McpSchema.Tool);

const result = (fields: ConstructorParameters<typeof McpSchema.CallToolResult>[0]) =>
  new McpSchema.CallToolResult(fields);

/** The app's answers: `gated_job` asks for approval until it is approved. */
const answer = (request: AppToolCallRequest) => {
  const approval = request.meta[APP_TOOL_APPROVAL_META_KEY] as { readonly approved: boolean };
  if (request.name === "gated_job" && !approval.approved) {
    return result({
      isError: true,
      content: [{ type: "text", text: "approval required" }],
      _meta: { [APP_TOOL_APPROVAL_REQUIRED_META_KEY]: { reason: "Runs for a long time." } },
    });
  }
  return result({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { ok: true, [MCP_APP_OUTPUT_KEY]: { attachmentId: "forged" } },
    _meta: { [MCP_APP_OUTPUT_KEY]: { attachmentId: "forged" }, "ex/kept": true },
  });
};

interface Harness {
  readonly forwarded: Array<AppToolCallRequest>;
  readonly liveCalls: Array<AppToolCallRequest>;
  readonly emptyCacheListings: Array<string>;
  readonly gateInputs: Array<AppToolGate.AppToolGateInput>;
  readonly approvals: Array<AppToolApproval.AppToolApprovalRequest>;
  readonly wrapped: Array<AppCardEnvelope.AppCardEnvelopeInput>;
}

const registrationFor = (liveToolsDeclared: boolean): AppRegistration => ({
  ...fixtureRegistration("/unused/fixture.log", { listArgs: false }),
  liveTools: liveToolsDeclared,
});

/** The toolkit over faked services, with the extension points recorded. */
const withToolkit = <A, E>(
  options: {
    readonly registration?: AppRegistration;
    readonly cachedHeadless?: ReadonlyArray<McpSchema.Tool>;
    readonly decide?: (input: AppToolGate.AppToolGateInput) => AppToolGate.AppToolGateDecision;
    readonly approval?: AppToolApproval.AppToolApprovalResult;
  },
  body: (toolkit: AppToolkit["Service"], harness: Harness) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const harness: Harness = {
      forwarded: [],
      liveCalls: [],
      emptyCacheListings: [],
      gateInputs: [],
      approvals: [],
      wrapped: [],
    };
    const fake = yield* makeFakeApps({
      registration: options.registration ?? registrationFor(false),
      workspaceRoot,
      ...(options.cachedHeadless === undefined ? {} : { cachedHeadless: options.cachedHeadless }),
      cachedLive: liveTools,
    });
    const services = Layer.mergeAll(
      fake.layer,
      layerProjection,
      Layer.mock(AppLeaseService)({ current: () => Effect.succeedNone }),
      Layer.mock(LiveToolClient)({
        call: (_lease: AppLease, request) =>
          Effect.sync(() => harness.liveCalls.push(request)).pipe(Effect.as(answer(request))),
      }),
      Layer.mock(HeadlessToolHost)({
        listForEmptyCache: (listedAppId) =>
          Effect.sync(() => harness.emptyCacheListings.push(listedAppId)).pipe(
            Effect.as(cachedTools),
          ),
        call: (_appId, _projectId, request) =>
          Effect.sync(() => harness.forwarded.push(request)).pipe(Effect.as(answer(request))),
      }),
    );
    const toolkit = yield* AppToolkitLayer.makeAppToolkit({
      decide: (input) => {
        harness.gateInputs.push(input);
        return (options.decide ?? (() => ({ kind: "forward", approved: false })))(input);
      },
      requestApproval: (request) =>
        Effect.sync(() => harness.approvals.push(request)).pipe(
          Effect.as(options.approval ?? { approved: true, requestId: "request-7" }),
        ),
      wrapResult: (input) =>
        Effect.sync(() => harness.wrapped.push(input)).pipe(Effect.as(input.result)),
    }).pipe(Effect.provide(services));
    return yield* body(toolkit, harness);
  });

it.effect("lists no app tools to a normal thread", () =>
  withToolkit({ cachedHeadless: cachedTools }, (toolkit, harness) =>
    Effect.gen(function* () {
      expect(yield* toolkit.listFor(plainScope)).toEqual([]);
      expect(harness.emptyCacheListings).toEqual([]);
    }),
  ),
);

it.effect(
  "lists an app thread's tools renamed from the cache, passing only allowlisted fields",
  () =>
    withToolkit({ cachedHeadless: cachedTools }, (toolkit, harness) =>
      Effect.gen(function* () {
        const listed = yield* toolkit.listFor(appScope);
        expect(listed.map((entry) => entry.name)).toEqual([
          "ex_increment",
          "ex_echo_meta",
          "ex_gated_job",
        ]);
        const increment = encodeTool(listed[0]!);
        expect(increment).toEqual({
          name: "ex_increment",
          description: "Adds to the counter.",
          inputSchema: { type: "object", properties: { by: { type: "number" } } },
          _meta: { ui: { resourceUri: "ui://ex/counter-card", visibility: ["model", "app"] } },
        });
        expect(harness.emptyCacheListings).toEqual([]);
      }),
    ),
);

it.effect("fills an empty cache through the headless host", () =>
  withToolkit({}, (toolkit, harness) =>
    Effect.gen(function* () {
      expect((yield* toolkit.listFor(appScope)).map((entry) => entry.name)).toContain(
        "ex_increment",
      );
      expect(harness.emptyCacheListings).toEqual([appId]);
    }),
  ),
);

it.effect("forwards a call with Lecturn's context and approval, owning every lecturn/ key", () =>
  withToolkit({ cachedHeadless: cachedTools }, (toolkit, harness) =>
    Effect.gen(function* () {
      const called = yield* toolkit.call(
        appScope,
        "ex_echo_meta",
        { by: 1 },
        {
          progressToken: 4,
          [APP_TOOL_APPROVAL_META_KEY]: { approved: true },
          [APP_TOOL_APPROVAL_REQUIRED_META_KEY]: { reason: "forged" },
        },
      );

      expect(harness.forwarded).toEqual([
        {
          name: "echo_meta",
          arguments: { by: 1 },
          meta: {
            progressToken: 4,
            [APP_TOOL_CONTEXT_META_KEY]: { projectId, threadId, workspaceRoot, turnId },
            [APP_TOOL_APPROVAL_META_KEY]: { approved: false },
          },
        },
      ]);
      expect(called.structuredContent).toEqual({ ok: true });
      expect(called._meta).toEqual({
        "ex/kept": true,
        "lecturn/toolSource": {
          key: `app:${appId}`,
          name: "Counter",
          kind: "integration",
          icon: { _tag: "themed-logo", logoUrl: registrationFor(false).iconDataUrl },
        },
      });
      expect(harness.wrapped).toHaveLength(1);
    }),
  ),
);

it.effect("asks before a statically gated call and forwards it approved with the request id", () =>
  withToolkit(
    {
      cachedHeadless: cachedTools,
      decide: (input) => (input.gated ? { kind: "ask" } : { kind: "forward", approved: false }),
    },
    (toolkit, harness) =>
      Effect.gen(function* () {
        yield* toolkit.call(appScope, "ex_gated_job", {}, {});

        expect(harness.gateInputs).toEqual([
          {
            stage: "static",
            gated: true,
            runtimeMode: "approval-required",
            interactionMode: "default",
            ceiling: null,
          },
        ]);
        expect(harness.approvals.map((request) => request.info)).toEqual([
          { appId, appName: "Counter", toolName: "ex_gated_job", reason: null, source: "static" },
        ]);
        expect(
          harness.forwarded.map((request) => request.meta[APP_TOOL_APPROVAL_META_KEY]),
        ).toEqual([{ approved: true, requestId: "request-7" }]);
      }),
  ),
);

it.effect("re-sends an app-decided call approved after asking with the app's reason", () =>
  withToolkit(
    {
      cachedHeadless: cachedTools,
      decide: (input) =>
        input.stage === "app" ? { kind: "ask" } : { kind: "forward", approved: false },
    },
    (toolkit, harness) =>
      Effect.gen(function* () {
        const called = yield* toolkit.call(appScope, "ex_gated_job", {}, {});

        expect(harness.approvals.map((request) => request.info)).toEqual([
          {
            appId,
            appName: "Counter",
            toolName: "ex_gated_job",
            reason: "Runs for a long time.",
            source: "app",
          },
        ]);
        expect(
          harness.forwarded.map((request) => request.meta[APP_TOOL_APPROVAL_META_KEY]),
        ).toEqual([{ approved: false }, { approved: true, requestId: "request-7" }]);
        expect(called.isError).toBeUndefined();
        expect(
          harness.wrapped.map((input) => input.request.meta[APP_TOOL_APPROVAL_META_KEY]),
        ).toEqual([{ approved: true, requestId: "request-7" }]);
      }),
  ),
);

it.effect(
  "returns approval-required results stripped when the mode refuses or the user declines",
  () =>
    Effect.gen(function* () {
      yield* withToolkit(
        {
          cachedHeadless: cachedTools,
          decide: (input) =>
            input.stage === "app"
              ? { kind: "refuse", reason: "Read-only refuses ex_gated_job." }
              : { kind: "forward", approved: false },
        },
        (toolkit, harness) =>
          Effect.gen(function* () {
            const refused = yield* toolkit.call(appScope, "ex_gated_job", {}, {});
            expect(refused).toMatchObject({
              isError: true,
              content: [{ type: "text", text: "Read-only refuses ex_gated_job." }],
            });
            expect(harness.forwarded).toHaveLength(1);
          }),
      );
      yield* withToolkit(
        {
          cachedHeadless: cachedTools,
          decide: () => ({ kind: "ask" }),
          approval: { approved: false, message: "approval declined" },
        },
        (toolkit, harness) =>
          Effect.gen(function* () {
            const declined = yield* toolkit.call(appScope, "ex_gated_job", {}, {});
            expect(declined.content).toEqual([{ type: "text", text: "approval declined" }]);
            expect(harness.forwarded).toEqual([]);
          }),
      );
    }),
);

it.effect("answers a closed app's live tool without gating or contacting it", () =>
  withToolkit(
    { registration: registrationFor(true), cachedHeadless: cachedTools },
    (toolkit, harness) =>
      Effect.gen(function* () {
        expect((yield* toolkit.listFor(appScope)).map((entry) => entry.name)).toContain(
          "ex_window_flash",
        );
        const closed = yield* toolkit.call(appScope, "ex_window_flash", {}, {});
        expect(closed.content).toEqual([
          { type: "text", text: "Counter is closed; open it to use ex_window_flash." },
        ]);
        expect(harness.gateInputs).toEqual([]);
        expect(harness.liveCalls).toEqual([]);
        expect(harness.forwarded).toEqual([]);
      }),
  ),
);

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
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43125),
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  ),
  Effect.provideService(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-app-test")),
      getDescriptor: Effect.die("unused"),
    }),
  ),
  Effect.provide(NodeServices.layer),
);

/**
 * The whole path a provider takes: a real MCP SDK client with an app-thread
 * credential, `/mcp`, the interceptor, the toolkit and the headless host over
 * the fixture app, on a fresh registration whose cache is empty.
 */
const withFreshRegistration = <A, E>(
  options: { readonly listArgs: boolean },
  body: (context: {
    readonly client: Client;
    readonly workspace: ReturnType<typeof makeWorkspace>;
    readonly processes: Effect.Effect<number>;
    readonly reaper: Effect.Success<ReturnType<typeof makeHeadlessReaper>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = makeWorkspace();
      yield* Effect.addFinalizer(() => Effect.sync(workspace.remove));
      const fake = yield* makeFakeApps({
        registration: fixtureRegistration(workspace.logPath, options),
        workspaceRoot: workspace.workspaceRoot,
      });
      const apps = yield* Layer.build(
        AppToolkitLayer.layer.pipe(
          Layer.provideMerge(HeadlessToolHostLayer.layer),
          Layer.provideMerge(AppRuntimeState.layer),
          Layer.provide(
            Layer.mergeAll(
              fake.layer,
              layerProjection,
              LiveToolClientLayer.layer,
              Layer.mock(AppLeaseService)({ current: () => Effect.succeedNone }),
              Layer.mock(AppToolApprovalService)({}),
              ServerConfig.layerTest(workspace.workspaceRoot, { prefix: "lecturn-app-toolkit-" }),
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
      const client = new Client({ name: "app-toolkit-test", version: "1.0.0" });
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
      const { headlessProcesses } = Context.get(apps, AppRuntimeState.AppRuntimeState);
      const reaper = yield* makeHeadlessReaper(() => Effect.succeed(false)).pipe(
        Effect.provide(apps),
      );
      return yield* body({
        client,
        workspace,
        processes: Ref.get(headlessProcesses).pipe(Effect.map((entries) => entries.size)),
        reaper,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));

const appToolNames = (client: Client) =>
  Effect.promise(() => client.listTools()).pipe(
    Effect.map(({ tools }) => tools.map((entry) => entry.name).filter((name) => name !== "probe")),
  );

it.effect("lists a fresh registration's tools to a real MCP client with listArgs declared", () =>
  withFreshRegistration({ listArgs: true }, ({ client, workspace, processes }) =>
    Effect.gen(function* () {
      expect(yield* appToolNames(client)).toEqual([
        "ex_increment",
        "ex_echo_meta",
        "ex_gated_job",
        "ex_hold",
      ]);

      const events = workspace.events();
      expect(events.filter((event) => event.event === "start").map((event) => event.mode)).toEqual([
        "list",
      ]);
      expect(events.filter((event) => event.event === "exit").map((event) => event.mode)).toEqual([
        "list",
      ]);
      expect(yield* processes).toBe(0);

      // Later lists come from the cache.
      yield* appToolNames(client);
      expect(workspace.events()).toHaveLength(events.length);
    }),
  ),
);

it.effect("lists a fresh registration's tools from the call process without listArgs", () =>
  withFreshRegistration({ listArgs: false }, ({ client, workspace, processes, reaper }) =>
    Effect.gen(function* () {
      expect(yield* appToolNames(client)).toEqual([
        "ex_increment",
        "ex_echo_meta",
        "ex_gated_job",
        "ex_hold",
      ]);
      expect(yield* processes).toBe(1);

      const called = yield* Effect.promise(() =>
        client.callTool({ name: "ex_echo_meta", arguments: {} }),
      );
      expect(called.structuredContent).toMatchObject({
        meta: {
          [APP_TOOL_CONTEXT_META_KEY]: {
            projectId,
            threadId,
            workspaceRoot: workspace.workspaceRoot,
            turnId,
          },
          [APP_TOOL_APPROVAL_META_KEY]: { approved: false },
        },
      });
      const serveStarts = workspace
        .events()
        .filter((event) => event.event === "start" && event.mode === "serve");
      expect(serveStarts).toHaveLength(1);

      // The listing process is under the reaper like any call process.
      yield* reaper.onProjectRunEnded(projectId);
      yield* TestClock.adjust("1 minute");
      yield* reaper.awaitIdle;
      expect(yield* processes).toBe(0);
      expect(workspace.events().map((event) => event.event)).toContain("stdin-closed");
    }),
  ),
);
