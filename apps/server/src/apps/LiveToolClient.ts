/**
 * The Streamable-HTTP MCP client for an app's live endpoint, shaped
 * like `callAcpMcpTool` (AcpMcpStdioBridge.ts). Every operation opens its own
 * MCP session and ends it, so nothing outlives a lease and a restarted app
 * never sees a session id from its previous run.
 *
 * Lease checks happen in AppToolkit before gating; a lease handed here is
 * contacted.
 */
// Foreign JSON-RPC is decoded only as far as routing needs; results are then
// decoded with the MCP schemas. The fetch is injectable so tests can count
// requests, and the default is global fetch because the app's endpoint is a
// plain loopback URL that needs no platform HTTP client.
// @effect-diagnostics preferSchemaOverJson:off globalFetchInEffect:off
import { AppsError } from "@lecturn/contracts";
import { discardResponseBody, responsePayloads } from "@lecturn/shared/mcpResponsePayloads";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";

import { HEADLESS_MCP_PROTOCOL_VERSION } from "./headlessMcpProcess.ts";
import { type AppLease, LiveToolClient } from "./services.ts";

/** One version for both tiers, so an app serves one MCP server shape. */
export const LIVE_MCP_PROTOCOL_VERSION = HEADLESS_MCP_PROTOCOL_VERSION;

export interface LiveToolClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Handshake, listing and resource reads. */
  readonly requestTimeout?: Duration.Input;
  /** A live tool may do real work in the app (a render, a flash), so calls get longer. */
  readonly callTimeout?: Duration.Input;
}

const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(15);
const DEFAULT_CALL_TIMEOUT = Duration.minutes(2);
const SESSION_END_TIMEOUT = Duration.seconds(2);
/** A server that keeps returning a cursor would otherwise list forever. */
const MAX_LIST_PAGES = 50;

const failure = (message: string) => new AppsError({ code: "unavailable", message });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The bearer is never part of a message: tool errors land in thread history.
const endpointLabel = (lease: AppLease) => {
  try {
    return new URL(lease.url).origin;
  } catch {
    return "the app";
  }
};

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(McpSchema.Tool));
const decodeCallResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);
const decodeReadResult = Schema.decodeUnknownEffect(McpSchema.ReadResourceResult);

const rpcErrorMessage = (error: unknown) =>
  isRecord(error) && typeof error.message === "string" ? error.message : JSON.stringify(error);

export const make = (options: LiveToolClientOptions = {}) => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const callTimeout = options.callTimeout ?? DEFAULT_CALL_TIMEOUT;

  interface Session {
    readonly request: (
      method: string,
      params: unknown,
      timeout: Duration.Input,
    ) => Effect.Effect<unknown, AppsError>;
  }

  const withSession = <A>(
    lease: AppLease,
    use: (session: Session) => Effect.Effect<A, AppsError>,
  ): Effect.Effect<A, AppsError> =>
    Effect.suspend(() => {
      const label = endpointLabel(lease);
      let sessionId: string | null = null;
      let protocolVersion: string | null = null;
      let nextId = 0;

      const headers = () => ({
        authorization: `Bearer ${lease.bearer}`,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
      });

      const unreachable = () => failure(`The app's live tool server at ${label} is not answering.`);

      const post = (message: unknown, method: string, timeout: Duration.Input) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              fetchImpl(lease.url, {
                method: "POST",
                headers: {
                  ...headers(),
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                },
                body: JSON.stringify(message),
                // A redirect would carry the bearer somewhere the lease never named.
                redirect: "error",
                signal,
              }),
            catch: unreachable,
          });
          sessionId = response.headers.get("mcp-session-id") ?? sessionId;
          if (!response.ok) {
            yield* discardResponseBody(response);
            return yield* failure(
              `The app's live tool server at ${label} answered ${method} with HTTP ${response.status}.`,
            );
          }
          return yield* Stream.runCollect(
            responsePayloads(response, () =>
              failure(`The app's live tool server at ${label} sent a reply Lecturn cannot read.`),
            ),
          );
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                failure(`The app's live tool server at ${label} did not answer ${method} in time.`),
              ),
          }),
        );

      const request: Session["request"] = (method, params, timeout) =>
        Effect.gen(function* () {
          const id = ++nextId;
          const payloads = yield* post({ jsonrpc: "2.0", id, method, params }, method, timeout);
          const envelope = payloads.find((payload) => isRecord(payload) && payload.id === id);
          if (!isRecord(envelope)) {
            return yield* failure(
              `The app's live tool server at ${label} sent no answer to ${method}.`,
            );
          }
          if (envelope.error !== undefined) {
            return yield* failure(
              `The app's live tool server refused ${method}: ${rpcErrorMessage(envelope.error)}`,
            );
          }
          return envelope.result;
        });

      // Best effort: a stateless server answers 405, and a gone one not at all.
      const endSession = Effect.suspend(() =>
        sessionId === null
          ? Effect.void
          : Effect.tryPromise({
              try: (signal) =>
                fetchImpl(lease.url, {
                  method: "DELETE",
                  headers: headers(),
                  redirect: "error",
                  signal,
                }).then((response) => response.body?.cancel()),
              catch: () => undefined,
            }).pipe(Effect.timeout(SESSION_END_TIMEOUT), Effect.ignore),
      );

      return Effect.gen(function* () {
        const initialized = yield* request(
          "initialize",
          {
            protocolVersion: LIVE_MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "lecturn", version: "0.0.0" },
          },
          requestTimeout,
        );
        // The server's answer is accepted whatever it says, as for headless tools.
        if (isRecord(initialized) && typeof initialized.protocolVersion === "string") {
          protocolVersion = initialized.protocolVersion;
        }
        yield* post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          "notifications/initialized",
          requestTimeout,
        );
        return yield* use({ request });
      }).pipe(Effect.ensuring(endSession));
    });

  const unreadable = (lease: AppLease, what: string) => () =>
    failure(
      `The app's live tool server at ${endpointLabel(lease)} sent ${what} Lecturn cannot read.`,
    );

  const listTools: LiveToolClient["Service"]["listTools"] = (lease) =>
    withSession(lease, (session) =>
      Effect.gen(function* () {
        const tools: Array<McpSchema.Tool> = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const result = yield* session.request(
            "tools/list",
            cursor === undefined ? {} : { cursor },
            requestTimeout,
          );
          const decoded = yield* decodeTools(isRecord(result) ? result.tools : undefined).pipe(
            Effect.mapError(unreadable(lease, "tool definitions")),
          );
          tools.push(...decoded);
          cursor =
            isRecord(result) && typeof result.nextCursor === "string"
              ? result.nextCursor
              : undefined;
          if (cursor === undefined) return tools;
        }
        return yield* failure(
          `The app's live tool server at ${endpointLabel(lease)} listed more than ${MAX_LIST_PAGES} pages of tools.`,
        );
      }),
    );

  const call: LiveToolClient["Service"]["call"] = (lease, request) =>
    withSession(lease, (session) =>
      session
        .request(
          "tools/call",
          { name: request.name, arguments: request.arguments, _meta: request.meta },
          callTimeout,
        )
        .pipe(
          Effect.flatMap((result) =>
            decodeCallResult(result).pipe(Effect.mapError(unreadable(lease, "a tool result"))),
          ),
        ),
    );

  const readResource: LiveToolClient["Service"]["readResource"] = (lease, uri) =>
    withSession(lease, (session) =>
      session
        .request("resources/read", { uri }, requestTimeout)
        .pipe(
          Effect.flatMap((result) =>
            decodeReadResult(result).pipe(Effect.mapError(unreadable(lease, "a resource"))),
          ),
        ),
    );

  return LiveToolClient.of({ listTools, call, readResource });
};

export const layer = Layer.sync(LiveToolClient, () => make());
