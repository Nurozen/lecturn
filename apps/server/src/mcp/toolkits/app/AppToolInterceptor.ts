import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { McpSchema } from "effect/ai";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

export type AppToolDefinition = typeof McpSchema.Tool.Encoded;
export type AppToolCallResult = typeof McpSchema.CallToolResult.Encoded;

/**
 * Lists and runs one app's tools for an app-thread credential. Names are the
 * agent-visible, prefixed ones. Both methods must succeed: an app failure is a
 * tool result, never a reason to drop the thread's built-in Lecturn tools.
 */
export interface AppToolSourceShape {
  readonly listFor: (
    scope: McpInvocationContext.McpAppInvocationScope,
  ) => Effect.Effect<ReadonlyArray<AppToolDefinition>>;
  readonly call: (
    scope: McpInvocationContext.McpAppInvocationScope,
    name: string,
    args: unknown,
    meta: Readonly<Record<string, unknown>> | undefined,
  ) => Effect.Effect<AppToolCallResult>;
}

export class AppToolSource extends Context.Service<AppToolSource, AppToolSourceShape>()(
  "lecturn/mcp/toolkits/app/AppToolInterceptor/AppToolSource",
) {}

/** For `/mcp` servers that serve no connected apps, such as tests of built-in toolkits. */
export const layerNoAppTools = Layer.succeed(AppToolSource)({
  listFor: () => Effect.succeed([]),
  call: (_scope, name) =>
    Effect.succeed({
      isError: true,
      content: [{ type: "text", text: `Unknown app tool ${name}.` }],
    }),
});

const JsonRpcId = Schema.Union([Schema.String, Schema.Number]);

const decodeToolRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ id: JsonRpcId, method: Schema.Literal("tools/list") }),
      Schema.Struct({
        id: JsonRpcId,
        method: Schema.Literal("tools/call"),
        params: Schema.Struct({
          name: Schema.String,
          arguments: Schema.optional(Schema.Unknown),
          _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      }),
    ]),
  ),
);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

type JsonRpcMessage = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRpcMessage =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The effect MCP transport answers in one JSON message, or frames every
 * message as an SSE `data:` event when notifications precede the result.
 */
const readMessages = (response: HttpServerResponse.HttpServerResponse) => {
  if (response.status !== 200 || response.body._tag !== "Uint8Array") return Option.none();
  const text = new TextDecoder().decode(response.body.body);
  const sse = (response.body.contentType ?? "").includes("text/event-stream");
  const chunks = sse
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
    : [text];
  const messages = chunks.map((chunk) => decodeJson(chunk));
  return messages.every(Option.isSome)
    ? Option.some({ sse, messages: messages.map((message) => message.value) })
    : Option.none();
};

const writeMessages = (
  response: HttpServerResponse.HttpServerResponse,
  sse: boolean,
  messages: ReadonlyArray<unknown>,
) => {
  const text = sse
    ? messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join("")
    : `${JSON.stringify(messages[0])}\n`;
  const contentType = response.body._tag === "Uint8Array" ? response.body.contentType : undefined;
  return HttpServerResponse.setBody(response, HttpBody.text(text, contentType));
};

/**
 * Rewrites the message answering `id`. Returning `undefined` keeps the
 * transport's own response untouched.
 */
const rewriteAnswer = <E, R>(
  response: HttpServerResponse.HttpServerResponse,
  id: string | number,
  rewrite: (answer: JsonRpcMessage) => Effect.Effect<JsonRpcMessage | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const read = readMessages(response);
    if (Option.isNone(read)) return response;
    const index = read.value.messages.findIndex(
      (message) => isRecord(message) && message.id === id && !("method" in message),
    );
    const answer = read.value.messages[index];
    if (!isRecord(answer)) return response;
    const next = yield* rewrite(answer);
    if (next === undefined) return response;
    const messages = read.value.messages.with(index, next);
    return writeMessages(response, read.value.sse, messages);
  });

/** The effect McpServer's answer for a name no registered tool has. */
const isToolNotFound = (answer: JsonRpcMessage, name: string) =>
  isRecord(answer.error) &&
  answer.error.code === -32602 &&
  answer.error.message === `Tool '${name}' not found`;

const appendAppTools = (
  source: AppToolSourceShape,
  scope: McpInvocationContext.McpAppInvocationScope,
  answer: JsonRpcMessage,
) =>
  Effect.gen(function* () {
    const result = answer.result;
    // Later pages already got the app tools on the last one.
    if (!isRecord(result) || !Array.isArray(result.tools) || result.nextCursor !== undefined) {
      return undefined;
    }
    const builtIn = new Set(result.tools.flatMap((tool) => (isRecord(tool) ? [tool.name] : [])));
    const appTools = (yield* source.listFor(scope)).filter((tool) => !builtIn.has(tool.name));
    if (appTools.length === 0) return undefined;
    return { ...answer, result: { ...result, tools: [...result.tools, ...appTools] } };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("app tools left out of tools/list", { appId: scope.app.appId, cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

const answerAppCall = (
  source: AppToolSourceShape,
  scope: McpInvocationContext.McpAppInvocationScope,
  answer: JsonRpcMessage,
  params: {
    readonly name: string;
    readonly arguments?: unknown;
    readonly _meta?: Readonly<Record<string, unknown>> | undefined;
  },
) =>
  Effect.gen(function* () {
    if (!isToolNotFound(answer, params.name)) return undefined;
    const tools = yield* source.listFor(scope);
    if (!tools.some((tool) => tool.name === params.name)) return undefined;
    const result = yield* source.call(scope, params.name, params.arguments ?? {}, params._meta);
    return { jsonrpc: "2.0", id: answer.id, result };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("app tool call failed", {
        appId: scope.app.appId,
        tool: params.name,
        cause,
      }).pipe(
        Effect.as({
          jsonrpc: "2.0",
          id: answer.id,
          error: { code: -32603, message: `App tool '${params.name}' failed.` },
        }),
      ),
    ),
  );

/**
 * The shared `/mcp` server has one flat tool registry, so per-thread app tools
 * cannot be registered on it. Instead the transport answers first, which keeps
 * its session and protocol checks, and this rewrites the answer for app-thread
 * credentials: app tools join `tools/list`, and a `tools/call` the transport
 * did not recognize goes to the app. Built-in tools win every name clash.
 */
export const make = Effect.gen(function* () {
  const tools = yield* AppToolSource;
  return <E, R>(
    invocation: McpInvocationContext.McpInvocationScope,
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > => {
    const scope = McpInvocationContext.appInvocationScope(invocation);
    if (scope === undefined) return httpEffect;
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // The body is cached, so the transport can still read it.
      const body = yield* request.text.pipe(Effect.option);
      const toolRequest = Option.flatMap(body, decodeToolRequest);
      const response = yield* httpEffect;
      if (Option.isNone(toolRequest)) return response;
      const parsed = toolRequest.value;
      return yield* rewriteAnswer(response, parsed.id, (answer) =>
        parsed.method === "tools/list"
          ? appendAppTools(tools, scope, answer)
          : answerAppCall(tools, scope, answer, parsed.params),
      );
    });
  };
});
