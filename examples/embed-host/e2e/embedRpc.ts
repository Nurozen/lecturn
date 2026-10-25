// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Test-side client for a server the e2e launched.
import {
  APPS_WS_METHODS,
  AppsCoreRpcs,
  AppsCreateEmbedThreadInput,
} from "@lecturn/contracts/appsRpcCore";
import { AuthWebSocketTicketResult } from "@lecturn/contracts/auth";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@lecturn/contracts/environment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

const AppsClientGroup = RpcGroup.make(...AppsCoreRpcs);
// JSON codec: `expiresAt` arrives as an ISO string, not a DateTime.
const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult));
const decodeCreateInput = Schema.decodeEffect(AppsCreateEmbedThreadInput);

/** A WebSocket handshake cannot carry a bearer header, so the bearer buys a one-use ticket for the URL. */
export async function ticketedSocketUrl(origin: string, bearer: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/websocket-ticket", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`websocket-ticket answered ${response.status}`);
  const { ticket } = decodeTicket(await response.json());
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

/**
 * Creates a thread the way the embed view does (D32): with the embed token,
 * so the server sets the thread's app fields. The guest has no new-thread
 * control of its own yet, and the tracer needs a thread to type into.
 */
export async function createEmbedThread(input: {
  readonly origin: string;
  readonly embedToken: string;
  readonly projectId: string;
  readonly title: string;
}): Promise<string> {
  const url = await ticketedSocketUrl(input.origin, input.embedToken);
  const program = Effect.gen(function* () {
    const protocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket()).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
          RpcSerialization.layerJson,
        ),
      ),
    );
    // Built into this scope: `Effect.provide` would close the socket as soon
    // as the client is made.
    const context = yield* Layer.build(protocol);
    const client = yield* RpcClient.make(AppsClientGroup).pipe(Effect.provideContext(context));
    const payload = yield* decodeCreateInput({ projectId: input.projectId, title: input.title });
    const { threadId } = yield* client[APPS_WS_METHODS.appsCreateEmbedThread](payload);
    return threadId;
  });
  return Effect.runPromise(program.pipe(Effect.scoped));
}
