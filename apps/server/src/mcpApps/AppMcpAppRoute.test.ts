import { assert, describe, expect, it } from "@effect/vitest";
import {
  APP_TOOL_APPROVAL_META_KEY,
  APP_TOOL_APPROVAL_REQUIRED_META_KEY,
  APP_TOOL_CONTEXT_META_KEY,
  AppsError,
  type AppGrantState,
  type AppRegistration,
  type AppRuntimeCeiling,
  type McpAppRequestError,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type RuntimeMode,
  ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import { MCP_APP_OUTPUT_KEY } from "@lecturn/shared/mcpApp";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import * as AppRuntimeState from "../apps/AppRuntimeState.ts";
import {
  type AppLease,
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  AppToolApprovalService,
  type AppToolApprovalAnswer,
  type AppToolCallRequest,
  HeadlessToolHost,
  LiveToolClient,
} from "../apps/services.ts";
import {
  fixtureAppId as appId,
  fixtureProjectId as projectId,
  fixtureRegistration,
  statusOf,
} from "../apps/testing/headlessAppFixture.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AppMcpAppRoute from "./AppMcpAppRoute.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";
import * as McpAppRequests from "./McpAppRequests.ts";

const threadId = ThreadId.make("thread-card");
const itemId = TurnItemId.make("item-card");
const otherProjectId = ProjectId.make("project-plain");
const turnId = ProviderTurnId.make("provider-turn-card");
const workspaceRoot = "/Users/me/counters";
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 25, 12, 0, 0));

const card = {
  attachmentId: "thread-card-00000000-0000-0000-0000-000000000000-html",
  server: "lecturn",
  tool: "ex_increment",
  resourceUri: "ui://ex/counter-card",
};

const tool = (fields: ConstructorParameters<typeof McpSchema.Tool>[0]) =>
  new McpSchema.Tool(fields);

const headlessTools = [
  tool({
    name: "increment",
    title: "Increment",
    inputSchema: { type: "object", properties: { by: { type: "number" } } },
    annotations: { readOnlyHint: false },
    _meta: { ui: { resourceUri: "ui://ex/counter-card", visibility: ["model", "app"] } },
  }),
  tool({
    name: "refresh_card",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] } },
  }),
  tool({
    name: "model_only",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["model"] } },
  }),
  tool({ name: "gated_job", inputSchema: { type: "object" } }),
  tool({ name: "app_decides", inputSchema: { type: "object" } }),
];
const liveTools = [tool({ name: "window_flash", inputSchema: { type: "object" } })];

const result = (fields: ConstructorParameters<typeof McpSchema.CallToolResult>[0]) =>
  new McpSchema.CallToolResult(fields);

const answer = (request: AppToolCallRequest) => {
  const approval = request.meta[APP_TOOL_APPROVAL_META_KEY] as { readonly approved: boolean };
  if (request.name === "app_decides" && !approval.approved) {
    return result({
      isError: true,
      content: [{ type: "text", text: "approval required" }],
      _meta: { [APP_TOOL_APPROVAL_REQUIRED_META_KEY]: { reason: "Runs for a long time." } },
    });
  }
  return result({
    content: [{ type: "text", text: `ran ${request.name}` }],
    structuredContent: { count: 3, [MCP_APP_OUTPUT_KEY]: { attachmentId: "forged" } },
    _meta: { [MCP_APP_OUTPUT_KEY]: { attachmentId: "forged" }, "ex/kept": true },
  });
};

const cardDocument = (tier: string) => ({
  contents: [{ uri: card.resourceUri, mimeType: "text/html;profile=mcp-app", text: tier }],
});
const decodeRead = Schema.decodeUnknownSync(McpSchema.ReadResourceResult);

interface Options {
  /** A live-only app. */
  readonly noHeadless?: boolean;
  readonly state?: AppGrantState;
  readonly ceiling?: AppRuntimeCeiling;
  readonly runtimeMode?: RuntimeMode;
  /** The thread has a running turn on a provider session. */
  readonly running?: boolean;
  readonly leased?: boolean;
  readonly headlessReadFails?: boolean;
  readonly approval?: AppToolApprovalAnswer;
  readonly threadProjectId?: ProjectId;
  /** The tool call item the card belongs to; defaults to a Claude call. */
  readonly item?: Partial<OrchestrationV2TurnItem>;
}

const lease: AppLease = {
  appId,
  url: "http://127.0.0.1:4100/mcp" as AppLease["url"],
  bearer: "secret",
  expiresAt: at,
};

/**
 * McpAppRequests over a real route registration, with the app's services
 * faked. Provider sessions are never live: the route must not need one.
 */
const withCards = <A, E>(
  options: Options,
  body: (
    requests: McpAppRequests.McpAppRequests["Service"],
    log: {
      readonly forwarded: Array<AppToolCallRequest>;
      readonly liveCalls: Array<AppToolCallRequest>;
      readonly reads: Array<string>;
      readonly approvals: Array<{ readonly providerSessionId: string; readonly info: unknown }>;
    },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const log = {
      forwarded: [] as Array<AppToolCallRequest>,
      liveCalls: [] as Array<AppToolCallRequest>,
      reads: [] as Array<string>,
      approvals: [] as Array<{ readonly providerSessionId: string; readonly info: unknown }>,
    };
    const { headlessTools: fixtureHeadless, ...fixture } = fixtureRegistration(
      "/unused/fixture.log",
      { listArgs: false },
    );
    const registration: AppRegistration = {
      ...fixture,
      ...(options.noHeadless === true ? {} : { headlessTools: fixtureHeadless! }),
      openUrlTemplate: "counter://open?root={workspaceRoot}&thread={threadId}",
      gatedTools: ["gated_job"],
      liveTools: true,
    };
    const thread = {
      id: threadId,
      projectId: options.threadProjectId ?? projectId,
      runtimeMode: options.runtimeMode ?? "approval-required",
      interactionMode: "default",
    } as OrchestrationV2AppThread;
    const item = {
      id: itemId,
      threadId,
      type: "dynamic_tool",
      status: "completed",
      toolName: "mcp__lecturn__ex_increment",
      providerThreadId: ProviderThreadId.make("provider-thread-card"),
      input: { by: 1 },
      output: { [MCP_APP_OUTPUT_KEY]: card, result: { content: [] } },
      ...options.item,
    } as OrchestrationV2TurnItem;

    const appServices = Layer.mergeAll(
      Layer.mock(AppRegistryService)({
        get: (id) =>
          Effect.succeed(
            id === appId
              ? Option.some({
                  status: {
                    ...statusOf(registration, options.state ?? "granted"),
                    runtimeCeiling: options.ceiling ?? null,
                  },
                  registration,
                })
              : Option.none(),
          ),
        cachedTools: () =>
          Effect.succeed({ headless: Option.some(headlessTools), live: Option.some(liveTools) }),
      }),
      Layer.mock(AppProjectService)({
        resolveAppForProject: (id) =>
          Effect.succeed(id === projectId ? Option.some({ appId, workspaceRoot }) : Option.none()),
      }),
      Layer.mock(AppLeaseService)({
        current: () => Effect.succeed(options.leased === true ? Option.some(lease) : Option.none()),
      }),
      Layer.mock(HeadlessToolHost)({
        call: (_appId, _projectId, request) =>
          Effect.sync(() => log.forwarded.push(request)).pipe(Effect.as(answer(request))),
        readResource: (_appId, _projectId, uri) =>
          options.headlessReadFails === true
            ? Effect.fail(new AppsError({ code: "unavailable", message: "no process" }))
            : Effect.sync(() => log.reads.push(`headless ${uri}`)).pipe(
                Effect.as(decodeRead(cardDocument("headless"))),
              ),
      }),
      Layer.mock(LiveToolClient)({
        call: (_lease, request) =>
          Effect.sync(() => log.liveCalls.push(request)).pipe(Effect.as(answer(request))),
        readResource: (_lease, uri) =>
          Effect.sync(() => log.reads.push(`live ${uri}`)).pipe(
            Effect.as(decodeRead(cardDocument("live"))),
          ),
      }),
      Layer.mock(AppToolApprovalService)({
        request: (context, info) =>
          Effect.sync(() =>
            log.approvals.push({ providerSessionId: context.providerSessionId, info }),
          ).pipe(
            Effect.as(
              options.approval ?? {
                outcome: "approved",
                requestId: RuntimeRequestId.make("request-card"),
              },
            ),
          ),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () => Effect.succeed(thread),
        getRunningTurnContext: () =>
          Effect.succeed(
            (options.running === true
              ? {
                  run: { id: "run-1" },
                  providerThread: { providerSessionId: "session-card" },
                  providerTurn: { id: turnId },
                }
              : { run: undefined, providerThread: undefined, providerTurn: undefined }) as never,
          ),
      }),
    );

    const requestsLayer = McpAppRequests.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(McpAppModelContext.McpAppModelContext)({ set: () => Effect.void }),
          Layer.mock(Orchestrator.OrchestratorV2)({ getTurnItem: () => Effect.succeed(item) }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.die("cards never read provider threads"),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.die("cards never reach a provider session"),
          }),
        ),
      ),
      Layer.provideMerge(AppRuntimeState.layer),
    );
    const context = yield* Layer.build(requestsLayer);
    yield* AppMcpAppRoute.register.pipe(
      Effect.provide(Layer.merge(appServices, Layer.succeedContext(context))),
    );
    return yield* body(Context.get(context, McpAppRequests.McpAppRequests), log);
  }).pipe(Effect.scoped);

const target = { threadId, itemId };

const reason = <A, R>(effect: Effect.Effect<A, McpAppRequestError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("AppMcpAppRoute", () => {
  it.effect("serves a stopped thread's card from the app, never a provider session", () =>
    withCards({ item: { toolName: "lecturn.ex_increment" } }, (requests, log) =>
      Effect.gen(function* () {
        const read = yield* requests.readResource({ ...target, uri: card.resourceUri });
        expect(read.contents).toEqual(cardDocument("headless").contents);
        expect(log.reads).toEqual([`headless ${card.resourceUri}`]);
      }),
    ),
  );

  it.effect("tells a non-Codex card its tool under the agent's name, with the app's links", () =>
    withCards({}, (requests) =>
      Effect.gen(function* () {
        const info = yield* requests.toolInfo({ ...target, name: card.tool });
        expect(info).toMatchObject({
          callable: true,
          readOnly: false,
          title: "Increment",
          tool: { name: "ex_increment", _meta: { ui: { resourceUri: card.resourceUri } } },
          connectedApp: {
            refPrefixes: ["ex:"],
            openUrl: `counter://open?root=${encodeURIComponent(workspaceRoot)}&thread=${threadId}`,
          },
        });
        const bare = yield* requests.toolInfo({ ...target, name: "refresh_card" });
        expect(bare).toMatchObject({
          callable: true,
          readOnly: true,
          tool: { name: "ex_refresh_card" },
        });
        const modelOnly = yield* requests.toolInfo({ ...target, name: "model_only" });
        expect(modelOnly.callable).toBe(false);
      }),
    ),
  );

  it.effect("works in a copied thread, whose items have no provider thread", () =>
    withCards(
      { item: { providerThreadId: null, toolName: "lecturn.ex_increment" } },
      (requests, log) =>
        Effect.gen(function* () {
          const called = yield* requests.callTool({
            ...target,
            name: "refresh_card",
            arguments: {},
          });
          expect(called.content).toEqual([{ type: "text", text: "ran refresh_card" }]);
          expect(log.forwarded.map((request) => request.name)).toEqual(["refresh_card"]);
        }),
    ),
  );

  it.effect(
    "calls app-visible tools by bare or prefixed name with Lecturn's context, stripped",
    () =>
      withCards({ running: true }, (requests, log) =>
        Effect.gen(function* () {
          const called = yield* requests.callTool({
            ...target,
            name: "ex_refresh_card",
            arguments: { page: 2 },
          });
          expect(called).toEqual({
            content: [{ type: "text", text: "ran refresh_card" }],
            structuredContent: { count: 3 },
            _meta: { "ex/kept": true },
          });
          expect(log.forwarded).toEqual([
            {
              name: "refresh_card",
              arguments: { page: 2 },
              meta: {
                [APP_TOOL_CONTEXT_META_KEY]: { projectId, threadId, workspaceRoot, turnId },
                [APP_TOOL_APPROVAL_META_KEY]: { approved: false },
              },
            },
          ]);
          for (const name of ["model_only", "ex_model_only", "missing"]) {
            assert.equal(
              yield* reason(requests.callTool({ ...target, name, arguments: {} })),
              "tool-not-callable",
            );
          }
          expect(log.forwarded).toHaveLength(1);
        }),
      ),
  );

  it.effect(
    "gates a card's call like the agent's: asks in Supervised inside the running turn",
    () =>
      withCards({ running: true }, (requests, log) =>
        Effect.gen(function* () {
          yield* requests.callTool({ ...target, name: "gated_job", arguments: {} });
          expect(log.approvals).toEqual([
            {
              providerSessionId: "session-card",
              info: {
                appId,
                appName: "Counter",
                toolName: "ex_gated_job",
                reason: null,
                source: "static",
              },
            },
          ]);
          expect(log.forwarded.map((request) => request.meta[APP_TOOL_APPROVAL_META_KEY])).toEqual([
            { approved: true, requestId: "request-card" },
          ]);
        }),
      ),
  );

  it.effect("re-sends an app-decided call approved after asking with the app's reason", () =>
    withCards({ running: true }, (requests, log) =>
      Effect.gen(function* () {
        const called = yield* requests.callTool({ ...target, name: "app_decides", arguments: {} });
        expect(called.isError).toBeUndefined();
        expect(log.approvals.map((entry) => entry.info)).toMatchObject([
          { reason: "Runs for a long time.", source: "app" },
        ]);
        expect(log.forwarded.map((request) => request.meta[APP_TOOL_APPROVAL_META_KEY])).toEqual([
          { approved: false },
          { approved: true, requestId: "request-card" },
        ]);
      }),
    ),
  );

  it.effect("refuses a gated card call in a stopped thread instead of running it unasked", () =>
    withCards({ running: false }, (requests, log) =>
      Effect.gen(function* () {
        const called = yield* requests.callTool({ ...target, name: "gated_job", arguments: {} });
        expect(called.isError).toBe(true);
        expect(JSON.stringify(called.content)).toContain("running turn");
        expect(log.approvals).toEqual([]);
        expect(log.forwarded).toEqual([]);
      }),
    ),
  );

  it.effect("reports a declined approval as the agent's call would", () =>
    withCards(
      { running: true, approval: { outcome: "declined", requestId: RuntimeRequestId.make("r") } },
      (requests, log) =>
        Effect.gen(function* () {
          const called = yield* requests.callTool({ ...target, name: "gated_job", arguments: {} });
          expect(called).toEqual({
            isError: true,
            content: [
              { type: "text", text: "The user declined ex_gated_job (approval declined)." },
            ],
          });
          expect(log.forwarded).toEqual([]);
        }),
    ),
  );

  it.effect("forwards approved without asking in Full access, and refuses under Read-only", () =>
    Effect.gen(function* () {
      yield* withCards({ runtimeMode: "full-access" }, (requests, log) =>
        Effect.gen(function* () {
          yield* requests.callTool({ ...target, name: "gated_job", arguments: {} });
          expect(log.approvals).toEqual([]);
          expect(log.forwarded.map((request) => request.meta[APP_TOOL_APPROVAL_META_KEY])).toEqual([
            { approved: true },
          ]);
        }),
      );
      yield* withCards(
        { runtimeMode: "full-access", ceiling: "read-only", running: true },
        (requests, log) =>
          Effect.gen(function* () {
            const called = yield* requests.callTool({
              ...target,
              name: "gated_job",
              arguments: {},
            });
            expect(called.isError).toBe(true);
            expect(log.approvals).toEqual([]);
            expect(log.forwarded).toEqual([]);
          }),
      );
    }),
  );

  it.effect("routes live tools to the open app and says when it is closed", () =>
    Effect.gen(function* () {
      yield* withCards({ leased: true }, (requests, log) =>
        Effect.gen(function* () {
          yield* requests.callTool({ ...target, name: "window_flash", arguments: {} });
          expect(log.liveCalls.map((request) => request.name)).toEqual(["window_flash"]);
          expect(log.forwarded).toEqual([]);
        }),
      );
      yield* withCards({ leased: false }, (requests, log) =>
        Effect.gen(function* () {
          const called = yield* requests.callTool({
            ...target,
            name: "window_flash",
            arguments: {},
          });
          expect(called).toEqual({
            isError: true,
            content: [{ type: "text", text: "Counter is closed; open it to use ex_window_flash." }],
          });
          expect(log.liveCalls).toEqual([]);
        }),
      );
    }),
  );

  it.effect("reads headless first, then live, and reports an app it cannot reach", () =>
    Effect.gen(function* () {
      yield* withCards({ headlessReadFails: true, leased: true }, (requests, log) =>
        Effect.gen(function* () {
          const read = yield* requests.readResource({ ...target, uri: card.resourceUri });
          expect(read.contents).toEqual(cardDocument("live").contents);
          expect(log.reads).toEqual([`live ${card.resourceUri}`]);
        }),
      );
      yield* withCards({ headlessReadFails: true, leased: false }, (requests) =>
        Effect.gen(function* () {
          assert.equal(
            yield* reason(requests.readResource({ ...target, uri: card.resourceUri })),
            "request-failed",
          );
        }),
      );
      yield* withCards({ noHeadless: true, leased: false }, (requests) =>
        Effect.gen(function* () {
          assert.equal(
            yield* reason(requests.readResource({ ...target, uri: card.resourceUri })),
            "app-unavailable",
          );
        }),
      );
    }),
  );

  it.effect("keeps a card to its own app: project, prefix and grant", () =>
    Effect.gen(function* () {
      const run = (options: Options) =>
        withCards(options, (requests) =>
          reason(requests.readResource({ ...target, uri: card.resourceUri })),
        );
      assert.equal(yield* run({ threadProjectId: otherProjectId }), "not-an-app");
      assert.equal(
        yield* run({
          item: {
            toolName: "mcp__lecturn__zz_increment",
            output: { [MCP_APP_OUTPUT_KEY]: { ...card, tool: "zz_increment" } },
          },
        }),
        "not-an-app",
      );
      assert.equal(yield* run({ state: "revoked" }), "app-unavailable");
    }),
  );
});
