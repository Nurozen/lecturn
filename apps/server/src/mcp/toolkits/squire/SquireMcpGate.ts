import type { SquireRole } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as SquireSwitch from "../../../squire/SquireSwitch.ts";
import { SQUIRE_TOOL_NAMES } from "../../../squire/squireToolNames.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readMessages, writeMessages } from "../app/AppToolInterceptor.ts";

/**
 * The tools each role may list and call on `/mcp` while Squires are on: the
 * role tools `SquireToolInterceptor` serves, and nothing else. Those include
 * `html_render` and `html_preview` in their locked mode (`SquireHtmlTools`):
 * the ordinary tools inline any local image a page names, and its scripts
 * can send it on.
 */
const SQUIRE_ROLE_TOOLS: Readonly<Record<SquireRole, ReadonlyArray<string>>> = {
  lead: SQUIRE_TOOL_NAMES.lead,
  squire: SQUIRE_TOOL_NAMES.squire,
};

/** With the switch off a Squire credential reaches no tool at all. */
export const squireToolAllowlist = (
  role: SquireRole | undefined,
  squireEnabled: boolean,
): ReadonlySet<string> =>
  new Set(squireEnabled && role !== undefined ? SQUIRE_ROLE_TOOLS[role] : []);

/** Protocol plumbing a client needs before it can list tools; none of it runs a tool. */
const passesThrough = (method: string) =>
  method === "initialize" || method === "ping" || method.startsWith("notifications/");

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

type JsonRpcMessage = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRpcMessage =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refuse = (status: number, id: unknown, code: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code, message },
    },
    { status, headers: { "cache-control": "no-store" } },
  );

const keepAllowedTools = (allowed: ReadonlySet<string>) => (message: unknown) => {
  if (!isRecord(message) || !isRecord(message.result) || !Array.isArray(message.result.tools)) {
    return message;
  }
  const tools = message.result.tools.filter(
    (tool) => isRecord(tool) && typeof tool.name === "string" && allowed.has(tool.name),
  );
  return { ...message, result: { ...message.result, tools } };
};

/**
 * The shared `/mcp` registry is flat and `actsAsCaller` tools check no
 * capability, so a capability alone cannot fence a Squire's home thread.
 * This runs before dispatch for every credential with a Squire scope:
 * `tools/list` answers only the role allowlist, any other tool call is
 * refused without reaching the transport, and so is every method that is
 * neither a tool request nor protocol plumbing. Other credentials pass
 * untouched. The switch is read per request, so turning it off fences a
 * running Squire at once; a missing `SquireSwitch` reads as off.
 */
export const make = Effect.gen(function* () {
  const squireSwitch = yield* Effect.serviceOption(SquireSwitch.SquireSwitch);
  const squireEnabled = Option.match(squireSwitch, {
    onNone: () => Effect.succeed(false),
    onSome: (service) => service.isOn,
  });
  return <E, R>(
    invocation: McpInvocationContext.McpInvocationScope,
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > => {
    if (invocation.squire === undefined && !invocation.capabilities.has("squire")) {
      return httpEffect;
    }
    return Effect.gen(function* () {
      const allowed = squireToolAllowlist(invocation.squire?.role, yield* squireEnabled);
      const request = yield* HttpServerRequest.HttpServerRequest;
      // GET opens the server's event stream and DELETE ends the session; neither runs a tool.
      if (request.method !== "POST") return yield* httpEffect;
      // The body is cached, so the transport can still read it.
      const body = yield* request.text.pipe(Effect.option);
      const parsed = Option.flatMap(body, decodeJson);
      if (Option.isNone(parsed)) return refuse(400, null, -32700, "Parse error.");
      const message = parsed.value;
      if (!isRecord(message)) {
        return refuse(400, null, -32600, "Send one JSON-RPC message per request on this thread.");
      }
      const { id, method } = message;
      if (typeof method !== "string") {
        return refuse(400, id, -32600, "Only JSON-RPC requests are accepted on this thread.");
      }
      if (passesThrough(method)) return yield* httpEffect;
      const hasId = typeof id === "string" || typeof id === "number";
      if (method === "tools/list" && hasId) {
        const response = yield* httpEffect;
        // The transport's own refusals (bad session, bad headers) carry no tools.
        if (response.status !== 200) return response;
        const read = readMessages(response);
        if (Option.isNone(read)) {
          return refuse(200, id, -32603, "The tool list could not be checked for this thread.");
        }
        return writeMessages(
          response,
          read.value.sse,
          read.value.messages.map(keepAllowedTools(allowed)),
        );
      }
      if (method === "tools/call" && hasId) {
        const name = isRecord(message.params) ? message.params.name : undefined;
        if (typeof name === "string" && allowed.has(name)) return yield* httpEffect;
        return refuse(
          200,
          id,
          -32602,
          `Tool '${typeof name === "string" ? name : ""}' is not available on this thread.`,
        );
      }
      return refuse(200, id, -32601, `Method '${method}' is not available on this thread.`);
    });
  };
});
