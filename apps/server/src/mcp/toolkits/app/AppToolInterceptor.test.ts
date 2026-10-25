import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AppId,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as AppToolInterceptor from "./AppToolInterceptor.ts";

const app = { appId: AppId.make("dev.lecturn.counter"), projectId: ProjectId.make("project-app") };
const appThreadId = ThreadId.make("thread-app");
const plainThreadId = ThreadId.make("thread-plain");

const incrementTool: AppToolInterceptor.AppToolDefinition = {
  name: "ex_increment",
  description: "Adds to the counter.",
  inputSchema: { type: "object", properties: { by: { type: "number" } } },
};

const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "A built-in Lecturn tool.",
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

interface FakeApp {
  tools: ReadonlyArray<AppToolInterceptor.AppToolDefinition>;
  listFails: boolean;
  readonly calls: Array<{
    readonly threadId: ThreadId;
    readonly appId: string;
    readonly name: string;
    readonly args: unknown;
    readonly meta: unknown;
  }>;
}

const makeFakeApp = (): FakeApp => ({ tools: [incrementTool], listFails: false, calls: [] });

const fakeAppSource = (fake: FakeApp) =>
  AppToolInterceptor.AppToolSource.of({
    listFor: (scope) =>
      fake.listFails
        ? Effect.die("app process crashed")
        : Effect.succeed(scope.app.appId === app.appId ? fake.tools : []),
    call: (scope, name, args, meta) =>
      Effect.sync(() => {
        fake.calls.push({
          threadId: scope.thread.threadId,
          appId: scope.app.appId,
          name,
          args,
          meta,
        });
        const by = (args as { readonly by?: number }).by ?? 1;
        return {
          content: [{ type: "text", text: `count ${by}` }],
          structuredContent: { count: by },
        };
      }),
  });

const makeRegistry = McpSessionRegistry.__testing.make().pipe(
  Effect.provideService(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
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

const JsonRpcAnswer = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeAnswer = Schema.decodeUnknownEffect(JsonRpcAnswer);

/** Serves `/mcp` with one built-in tool and the fake app behind the interceptor. */
const serveMcp = (fake: FakeApp) =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry;
    const issue = (threadId: ThreadId, withApp: boolean) =>
      registry
        .issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          ...(withApp ? { app } : {}),
        })
        .pipe(Effect.map(({ config }) => config.authorizationHeader));
    const credentials = {
      app: yield* issue(appThreadId, true),
      plain: yield* issue(plainThreadId, false),
    };
    const builtInCalls: Array<string> = [];
    const serverLayer = McpHttpServer.toolkitRegistration(
      ProbeToolkit,
      McpToolAccess.toLayer(ProbeToolkit, {
        probe: McpToolAccess.reads(() =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.tap((scope) => Effect.sync(() => builtInCalls.push(scope.requestNamespace))),
            Effect.as({ ok: true }),
          ),
        ),
      }),
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerMcpTransport),
      Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
      Layer.provide(Layer.succeed(AppToolInterceptor.AppToolSource, fakeAppSource(fake))),
    );
    yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    const httpClient = yield* HttpClient.HttpClient;

    const connect = (authorization: string) =>
      Effect.gen(function* () {
        const headers = { accept: "application/json, text/event-stream", authorization };
        const initialize = yield* httpClient.post("/mcp", {
          headers,
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"app-test","version":"1.0.0"}}}`,
            "application/json",
          ),
        });
        expect(initialize.status).toBe(200);
        const sessionHeaders = {
          ...headers,
          "mcp-session-id": initialize.headers["mcp-session-id"]!,
          "mcp-protocol-version": "2025-06-18",
        };
        let nextId = 2;
        const send = (method: string, params: unknown) =>
          Effect.gen(function* () {
            const response = yield* httpClient.post("/mcp", {
              headers: sessionHeaders,
              body: HttpBody.text(
                JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
                "application/json",
              ),
            });
            expect(response.status).toBe(200);
            return yield* decodeAnswer(yield* response.json);
          });
        return {
          listToolNames: send("tools/list", {}).pipe(
            Effect.map(({ result }) =>
              (result as { readonly tools: ReadonlyArray<{ readonly name: string }> }).tools.map(
                (tool) => tool.name,
              ),
            ),
          ),
          callTool: (name: string, args: unknown, meta?: Record<string, unknown>) =>
            send("tools/call", {
              name,
              arguments: args,
              ...(meta === undefined ? {} : { _meta: meta }),
            }),
        };
      });

    return {
      app: yield* connect(credentials.app),
      plain: yield* connect(credentials.plain),
      builtInCalls,
    };
  });

it.effect("lists an app's tools only to credentials issued for that app's threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeApp();
      const { app: appThread, plain } = yield* serveMcp(fake);

      expect(yield* appThread.listToolNames).toEqual(["probe", "ex_increment"]);
      expect(yield* plain.listToolNames).toEqual(["probe"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("routes app tool calls to the app with the caller's scope and meta", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeApp();
      const { app: appThread, plain, builtInCalls } = yield* serveMcp(fake);
      const meta = { "lecturn/approval": { approved: true, requestId: "request-1" } };

      const answer = yield* appThread.callTool("ex_increment", { by: 2 }, meta);
      expect(answer.result).toEqual({
        content: [{ type: "text", text: "count 2" }],
        structuredContent: { count: 2 },
      });
      expect(fake.calls).toEqual([
        { threadId: appThreadId, appId: app.appId, name: "ex_increment", args: { by: 2 }, meta },
      ]);

      // A plain thread's credential never reaches the app, even by guessing the name.
      const refused = yield* plain.callTool("ex_increment", { by: 3 });
      expect(refused.error?.message).toBe("Tool 'ex_increment' not found");
      expect(fake.calls).toHaveLength(1);

      // Built-in tools still run for app threads.
      const builtIn = yield* appThread.callTool("probe", {});
      expect(builtIn.error).toBeUndefined();
      expect(builtInCalls).toHaveLength(1);
      expect(fake.calls).toHaveLength(1);

      // An app tool the app no longer lists is unknown.
      fake.tools = [];
      const gone = yield* appThread.callTool("ex_increment", {});
      expect(gone.error?.message).toBe("Tool 'ex_increment' not found");
      expect(fake.calls).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps built-in tools when the app clashes with one or fails to list", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeApp();
      const { app: appThread, builtInCalls } = yield* serveMcp(fake);

      fake.tools = [incrementTool, { ...incrementTool, name: "probe" }];
      expect(yield* appThread.listToolNames).toEqual(["probe", "ex_increment"]);
      yield* appThread.callTool("probe", {});
      expect(builtInCalls).toHaveLength(1);
      expect(fake.calls).toEqual([]);

      fake.listFails = true;
      expect(yield* appThread.listToolNames).toEqual(["probe"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
