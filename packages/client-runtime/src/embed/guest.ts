import {
  checkEmbedMessageSize,
  EMBED_HOST_NOTIFICATIONS,
  EMBED_MAX_MESSAGE_BYTES,
  EMBED_MAX_PENDING_REQUESTS,
  EMBED_NOT_INITIALIZED_ERROR_CODE,
  EmbedDescribeRefsResult,
  EmbedInitializeResult,
  embedInitializeParams,
  EmbedJsonRpcMessage,
  embedMessageBytes,
  EmbedTokenRefreshResult,
  type EmbedGuestNotificationMethod,
  type EmbedGuestNotificationParams,
  type EmbedGuestRequestMethod,
  type EmbedGuestRequestParams,
  type EmbedGuestRequestResult,
  type EmbedHostContext,
  type EmbedHostContextChanged,
  type EmbedHostNotificationMethod,
  type EmbedHostNotificationParams,
  type EmbedJsonRpcId,
  type EmbedTurnState,
} from "@lecturn/contracts/embedBridge";
import type { OrchestrationV2ThreadProjection } from "@lecturn/contracts";
import * as Schema from "effect/Schema";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "../state/models.ts";
import { derivePendingThreadRequests } from "../state/threadRequests.ts";

const METHOD_NOT_FOUND = -32601;
// Notifications still waiting for the host's answer to `ui/initialize`; a host that never
// answers must not grow this without bound.
const MAX_QUEUED_MESSAGES = 64;

/** Host notifications other than host-context changes, which the guest folds into its context. */
export type EmbedHostCommand = {
  [M in Exclude<EmbedHostNotificationMethod, "ui/notifications/host-context-changed">]: {
    readonly method: M;
    readonly params: EmbedHostNotificationParams<M>;
  };
}[Exclude<EmbedHostNotificationMethod, "ui/notifications/host-context-changed">];

export class EmbedGuestRequestError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "EmbedGuestRequestError";
    this.code = code;
  }
}

export interface EmbedGuestOptions {
  /** Delivers one JSON-RPC message to the host. The caller owns the transport and origin checks. */
  readonly post: (message: unknown) => void;
  readonly onHostContext?: (context: EmbedHostContext) => void;
  readonly onHostCommand?: (command: EmbedHostCommand) => void;
}

type GuestRequestMethod = Exclude<EmbedGuestRequestMethod, "ui/initialize">;
type GuestNotificationMethod = Exclude<
  EmbedGuestNotificationMethod,
  "ui/notifications/initialized"
>;

export interface EmbedGuest {
  /** Sends `ui/initialize` once, then `initialized`; later calls return the same handshake. */
  readonly initialize: () => Promise<EmbedHostContext>;
  /** Handles one message from the host; the caller has already checked its source. */
  readonly receive: (data: unknown) => void;
  readonly request: <M extends GuestRequestMethod>(
    method: M,
    params: EmbedGuestRequestParams<M>,
  ) => Promise<EmbedGuestRequestResult<M>>;
  readonly notify: <M extends GuestNotificationMethod>(
    method: M,
    params: EmbedGuestNotificationParams<M>,
  ) => void;
  readonly hostContext: () => EmbedHostContext | null;
  readonly dispose: () => void;
}

const decodeMessage = Schema.decodeUnknownOption(EmbedJsonRpcMessage);
const resultDecoders: { readonly [M in EmbedGuestRequestMethod]: (value: unknown) => unknown } = {
  "ui/initialize": Schema.decodeUnknownSync(EmbedInitializeResult),
  "ui/open-link": () => ({}),
  "lecturn/token.refresh": Schema.decodeUnknownSync(EmbedTokenRefreshResult),
  "lecturn/appRefs.describe": Schema.decodeUnknownSync(EmbedDescribeRefsResult),
};
const hostNotificationDecoders = Object.fromEntries(
  Object.entries(EMBED_HOST_NOTIFICATIONS).map(([method, schema]) => [
    method,
    Schema.decodeUnknownOption(schema as Schema.Codec<unknown, unknown>),
  ]),
);

interface PendingRequest {
  readonly method: EmbedGuestRequestMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The guest side of the embed bridge (I4): Lecturn's embed view talking to the app that hosts it,
 * the mirror of `makeMcpAppHost`. The host may send nothing before `ui/notifications/initialized`,
 * so until the guest has sent it, host requests are refused with -32002 and host notifications are
 * dropped. Outgoing traffic other than the handshake waits for it in order.
 */
export function makeEmbedGuest(options: EmbedGuestOptions): EmbedGuest {
  let initialized = false;
  let disposed = false;
  let context: EmbedHostContext | null = null;
  let handshake: Promise<EmbedHostContext> | null = null;
  let nextId = 0;
  let queue: Array<unknown> = [];
  const pending = new Map<EmbedJsonRpcId, PendingRequest>();

  const send = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const sendWhenInitialized = (message: unknown) => {
    if (initialized) {
      send(message);
      return;
    }
    queue.push(message);
    if (queue.length > MAX_QUEUED_MESSAGES) queue = queue.slice(-MAX_QUEUED_MESSAGES);
  };

  const sendRequest = (
    method: EmbedGuestRequestMethod,
    params: unknown,
    deliver: (message: unknown) => void,
  ): Promise<unknown> => {
    if (disposed) return Promise.reject(new EmbedGuestRequestError(-32000, "The bridge closed."));
    if (pending.size >= EMBED_MAX_PENDING_REQUESTS) {
      return Promise.reject(new EmbedGuestRequestError(-32000, "Too many requests in flight."));
    }
    const id = `guest-${++nextId}`;
    const message = { jsonrpc: "2.0", id, method, params };
    const size = checkEmbedMessageSize(message);
    if (!size.fits) return Promise.reject(new EmbedGuestRequestError(-32000, size.message));
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      deliver(message);
    });
  };

  const setContext = (next: EmbedHostContext) => {
    context = next;
    options.onHostContext?.(next);
  };

  const initialize = () => {
    handshake ??= sendRequest("ui/initialize", embedInitializeParams(), send).then((value) => {
      const result = value as EmbedInitializeResult;
      setContext(result.hostContext);
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      initialized = true;
      const flushed = queue;
      queue = [];
      for (const message of flushed) send(message);
      return result.hostContext;
    });
    return handshake;
  };

  const settle = (id: EmbedJsonRpcId, outcome: { result: unknown } | { error: Error }) => {
    const request = pending.get(id);
    if (request === undefined) return;
    pending.delete(id);
    if ("error" in outcome) {
      request.reject(outcome.error);
      return;
    }
    try {
      request.resolve(resultDecoders[request.method](outcome.result));
    } catch (cause) {
      request.reject(cause);
    }
  };

  const handleNotification = (method: string, params: unknown) => {
    if (!initialized) return;
    const decoded = hostNotificationDecoders[method]?.(params ?? {});
    if (decoded === undefined || decoded._tag === "None") return;
    if (method === "ui/notifications/host-context-changed") {
      if (context === null) return;
      const { composerPlaceholder, ...changed } = decoded.value as EmbedHostContextChanged;
      const { composerPlaceholder: current, ...rest } = context;
      const placeholder = composerPlaceholder === undefined ? current : composerPlaceholder;
      setContext({
        ...rest,
        ...changed,
        ...(placeholder ? { composerPlaceholder: placeholder } : {}),
      });
      return;
    }
    options.onHostCommand?.({ method, params: decoded.value } as EmbedHostCommand);
  };

  return {
    initialize,
    receive(data) {
      if (disposed || embedMessageBytes(data) > EMBED_MAX_MESSAGE_BYTES) return;
      const decoded = decodeMessage(data);
      if (decoded._tag === "None") return;
      const message = decoded.value;
      if ("result" in message) {
        settle(message.id, { result: message.result });
        return;
      }
      if ("error" in message) {
        if (message.id !== null) {
          settle(message.id, {
            error: new EmbedGuestRequestError(message.error.code, message.error.message),
          });
        }
        return;
      }
      if ("id" in message) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: initialized
            ? { code: METHOD_NOT_FOUND, message: `Unknown method ${message.method}.` }
            : {
                code: EMBED_NOT_INITIALIZED_ERROR_CODE,
                message: "The embed view has not finished initializing.",
              },
        });
        return;
      }
      handleNotification(message.method, message.params);
    },
    request: (method, params) =>
      sendRequest(method, params, sendWhenInitialized) as Promise<
        EmbedGuestRequestResult<typeof method>
      >,
    notify(method, params) {
      const message = { jsonrpc: "2.0", method, params };
      const size = checkEmbedMessageSize(message);
      if (!size.fits) throw new EmbedGuestRequestError(-32000, size.message);
      sendWhenInitialized(message);
    },
    hostContext: () => context,
    dispose() {
      if (disposed) return;
      disposed = true;
      queue = [];
      const closed = new EmbedGuestRequestError(-32000, "The bridge closed.");
      for (const request of pending.values()) request.reject(closed);
      pending.clear();
    },
  };
}

/**
 * What the host's rail shows for a thread, matching the server's thread summaries: any pending
 * request wins over a running turn. Before the thread detail loads, the shell's flags stand in.
 */
export function deriveEmbedTurnState(input: {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "runtimeRequests" | "turnItems"
  > | null;
  readonly shell: Pick<
    EnvironmentThreadShell,
    "runtime" | "hasPendingApprovals" | "hasPendingUserInput"
  > | null;
}): EmbedTurnState {
  const awaiting =
    input.projection !== null
      ? (() => {
          const requests = derivePendingThreadRequests(input.projection);
          return requests.approvals.length > 0 || requests.userInputs.length > 0;
        })()
      : input.shell !== null &&
        (input.shell.hasPendingApprovals || input.shell.hasPendingUserInput);
  if (awaiting) return "awaiting-approval";
  return threadRuntimeIsActive(input.shell?.runtime) ? "running" : "idle";
}
