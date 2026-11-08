import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as SquireTools from "../../../squire/SquireTools.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readMessages, writeMessages } from "../app/AppToolInterceptor.ts";

const JsonRpcId = Schema.Union([Schema.String, Schema.Number]);

const decodeToolRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ id: JsonRpcId, method: Schema.Literal("tools/list") }),
      Schema.Struct({
        id: JsonRpcId,
        method: Schema.Literal("tools/call"),
        params: Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.Unknown) }),
      }),
    ]),
  ),
);

type JsonRpcMessage = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRpcMessage =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const answer = (id: string | number, result: unknown) =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", id, result },
    { status: 200, headers: { "cache-control": "no-store" } },
  );

/**
 * A role tool that shares a registered tool's name (`html_render`) replaces it,
 * so a Squire sees only its own definition.
 */
const appendTools =
  (id: string | number, tools: ReadonlyArray<SquireTools.SquireToolDefinition>) =>
  (message: unknown) => {
    if (!isRecord(message) || message.id !== id || !isRecord(message.result)) return message;
    const result = message.result;
    if (!Array.isArray(result.tools)) return message;
    const names = new Set(tools.map((tool) => tool.name));
    const kept = result.tools.filter(
      (tool) => !isRecord(tool) || typeof tool.name !== "string" || !names.has(tool.name),
    );
    // Later pages already got the Squire tools on the last one.
    const added = result.nextCursor === undefined ? tools : [];
    return { ...message, result: { ...result, tools: [...kept, ...added] } };
  };

/**
 * Squire role tools exist only for a home thread's credential and only while the switch builds
 * `SquireTools`; otherwise this passes everything through. A role tool call is answered here, never
 * reaching the transport: the shared registry has no such tool and Cursor's 60 s MCP timeout needs
 * the result at once. `SquireMcpGate` runs first, so a refused call never gets here.
 */
export const make = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(SquireTools.SquireTools);
  return <E, R>(
    invocation: McpInvocationContext.McpInvocationScope,
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > => {
    const squire = invocation.squire;
    const thread = invocation.thread;
    if (Option.isNone(service) || squire === undefined || thread === undefined) {
      return httpEffect;
    }
    const tools = service.value;
    const definitions = tools.definitions(squire.role);
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // The body is cached, so the transport can still read it.
      const body = yield* request.text.pipe(Effect.option);
      const toolRequest = Option.flatMap(body, decodeToolRequest);
      if (Option.isNone(toolRequest)) return yield* httpEffect;
      const parsed = toolRequest.value;
      if (parsed.method === "tools/list") {
        const response = yield* httpEffect;
        const read = readMessages(response);
        if (Option.isNone(read)) return response;
        return writeMessages(
          response,
          read.value.sse,
          read.value.messages.map(appendTools(parsed.id, definitions)),
        );
      }
      const name = parsed.params.name;
      if (!definitions.some((tool) => tool.name === name)) return yield* httpEffect;
      const caller = { squireId: squire.squireId, role: squire.role, threadId: thread.threadId };
      const result = yield* tools
        .call(caller, name, parsed.params.arguments ?? {})
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("squire tool call failed", { tool: name, cause }).pipe(
              Effect.as({ isError: true, text: `Squire tool '${name}' failed.` }),
            ),
          ),
        );
      return answer(parsed.id, {
        content: [
          { type: "text", text: result.text },
          ...("image" in result && result.image !== undefined
            ? [{ type: "image", data: result.image.data, mimeType: result.image.mimeType }]
            : []),
        ],
        isError: result.isError,
        ...("structuredContent" in result && result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        // Lecturn: MCP Apps result `_meta` (the showcase card).
        ...("_meta" in result && result._meta !== undefined ? { _meta: result._meta } : {}),
      });
    });
  };
});
