import {
  checkEmbedMessageSize,
  EMBED_GUEST_NOTIFICATIONS,
  EMBED_HOST_NOTIFICATIONS,
  EMBED_MAX_MESSAGE_BYTES,
  EMBED_MAX_PENDING_REQUESTS,
  EmbedHostContext,
  type EmbedHostContextChanged,
  EmbedHostStyles,
  type EmbedHostNotificationMethod,
  type EmbedHostNotificationParams,
  EmbedInitializeParams,
  embedInitializeResult,
  EmbedJsonRpcMessage,
  embedMessageBytes,
  EmbedDescribeRefsParams,
  EmbedOpenLinkParams,
  type EmbedJsonRpcId,
  type EmbedTokenRefreshResult,
} from "@lecturn/contracts/embedBridge";
import * as Schema from "effect/Schema";

import { EmbedViewError } from "./errors.ts";

export type EmbedThemeMode = EmbedHostContext["theme"];

/** A bare mode, or a mode with the host's theme variables and fonts. */
export type EmbedThemeInput =
  | EmbedThemeMode
  | { readonly theme: EmbedThemeMode; readonly styles?: EmbedHostStyles };

export interface EmbedBridgeEvents {
  readonly "lecturn/navigate": (typeof EMBED_GUEST_NOTIFICATIONS)["lecturn/navigate"]["Type"];
  readonly "lecturn/thread.changed": (typeof EMBED_GUEST_NOTIFICATIONS)["lecturn/thread.changed"]["Type"];
  readonly "lecturn/turn.state": (typeof EMBED_GUEST_NOTIFICATIONS)["lecturn/turn.state"]["Type"];
  readonly "lecturn/ready": (typeof EMBED_GUEST_NOTIFICATIONS)["lecturn/ready"]["Type"];
}
export type EmbedBridgeEvent = keyof EmbedBridgeEvents;

const FORWARDED_EVENTS: ReadonlySet<string> = new Set<EmbedBridgeEvent>([
  "lecturn/navigate",
  "lecturn/thread.changed",
  "lecturn/turn.state",
  "lecturn/ready",
]);

// Host notifications wait for `initialized`; a guest that never initializes
// must not grow this without bound.
const MAX_QUEUED_NOTIFICATIONS = 64;

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const decodeMessage = Schema.decodeUnknownOption(EmbedJsonRpcMessage);
const decodeHostContext = Schema.decodeUnknownOption(EmbedHostContext);
const decodeInitializeParams = Schema.decodeUnknownOption(EmbedInitializeParams);
const decodeOpenLinkParams = Schema.decodeUnknownOption(EmbedOpenLinkParams);
const decodeDescribeRefsParams = Schema.decodeUnknownOption(EmbedDescribeRefsParams);
const MAX_REF_LABEL_CHARS = 256;
const guestNotificationDecoders = Object.fromEntries(
  Object.entries(EMBED_GUEST_NOTIFICATIONS).map(([method, schema]) => [
    method,
    Schema.decodeUnknownOption(schema as Schema.Codec<unknown, unknown>),
  ]),
);
const hostNotificationDecoders = Object.fromEntries(
  Object.entries(EMBED_HOST_NOTIFICATIONS).map(([method, schema]) => [
    method,
    Schema.decodeUnknownOption(schema as Schema.Codec<unknown, unknown>),
  ]),
);

/** `composerPlaceholder` replaces the idle composer prompt; null or absent keeps Lecturn's. */
export function hostContextFor(
  theme: EmbedThemeInput,
  locale: string,
  composerPlaceholder: string | null = null,
): EmbedHostContext {
  const input = typeof theme === "string" ? { theme } : theme;
  const decoded = decodeHostContext({
    theme: input.theme,
    displayMode: "inline",
    locale,
    ...(input.styles === undefined ? {} : { styles: input.styles }),
    ...(composerPlaceholder === null ? {} : { composerPlaceholder }),
  });
  if (decoded._tag === "None") {
    throw new EmbedViewError(
      "bridge-message-rejected",
      "The embed theme or composer placeholder is not a valid host context (EmbedHostContext).",
    );
  }
  return decoded.value;
}

/** Refuses a host context the guest would drop for size, naming the size. */
export function assertHostContextFits(context: EmbedHostContext): void {
  const check = checkEmbedMessageSize({
    jsonrpc: "2.0",
    id: 0,
    result: embedInitializeResult(context),
  });
  if (!check.fits) throw new EmbedViewError("message-too-large", check.message);
}

/** The host's names for its references, by reference; a reference left out shows as itself. */
export type EmbedRefLabels = Readonly<Record<string, string>>;
export type EmbedDescribeRefs = (
  refs: ReadonlyArray<string>,
) => EmbedRefLabels | Promise<EmbedRefLabels>;

/** Keeps the names the guest would accept for the references it asked about, and nothing else. */
function sanitizeRefLabels(refs: ReadonlyArray<string>, labels: unknown): EmbedRefLabels {
  if (typeof labels !== "object" || labels === null) return {};
  const accepted: Record<string, string> = {};
  for (const ref of refs) {
    const label = Object.hasOwn(labels, ref) ? (labels as Record<string, unknown>)[ref] : undefined;
    if (typeof label !== "string") continue;
    const name = label.trim().slice(0, MAX_REF_LABEL_CHARS);
    if (name.length > 0) accepted[ref] = name;
  }
  return accepted;
}

export interface EmbedHostSessionDeps {
  /** Delivers one JSON-RPC message to the current guest document. */
  readonly send: (message: unknown) => void;
  readonly refreshToken: () => Promise<EmbedTokenRefreshResult>;
  readonly openLink: (url: string) => Promise<void>;
  /** Without it the guest hears that no reference has a name, and shows each one as itself. */
  readonly describeRefs?: EmbedDescribeRefs;
  readonly emit: <E extends EmbedBridgeEvent>(event: E, params: EmbedBridgeEvents[E]) => void;
  readonly emitError: (error: EmbedViewError) => void;
}

/**
 * The host side of the embed bridge for one guest view, independent of
 * the transport. The host sends nothing before the guest's `initialized`;
 * notifications queue until then. A new document starts the handshake again.
 */
export function createEmbedHostSession(
  initialContext: EmbedHostContext,
  deps: EmbedHostSessionDeps,
) {
  let context = initialContext;
  let initialized = false;
  let documentEpoch = 0;
  let pending = 0;
  let queue: Array<unknown> = [];

  const deliver = (message: unknown) => {
    if (initialized) {
      deps.send(message);
      return;
    }
    queue.push(message);
    if (queue.length > MAX_QUEUED_NOTIFICATIONS) queue = queue.slice(-MAX_QUEUED_NOTIFICATIONS);
  };

  const respond = (epoch: number, message: unknown) => {
    // A reply for a document that is gone could collide with the new one's ids.
    if (epoch === documentEpoch) deps.send(message);
  };
  const reply = (epoch: number, id: EmbedJsonRpcId, result: unknown) =>
    respond(epoch, { jsonrpc: "2.0", id, result });
  const fail = (epoch: number, id: EmbedJsonRpcId, code: number, message: string) =>
    respond(epoch, { jsonrpc: "2.0", id, error: { code, message } });

  const handleRequest = async (id: EmbedJsonRpcId, method: string, params: unknown) => {
    const epoch = documentEpoch;
    switch (method) {
      case "ui/initialize": {
        if (decodeInitializeParams(params)._tag === "None") {
          return fail(epoch, id, INVALID_PARAMS, "Invalid ui/initialize params.");
        }
        return reply(epoch, id, embedInitializeResult(context));
      }
      case "lecturn/token.refresh": {
        try {
          const refreshed = await deps.refreshToken();
          return reply(epoch, id, { token: refreshed.token, expiresAt: refreshed.expiresAt });
        } catch (cause) {
          deps.emitError(
            new EmbedViewError("token-refresh-failed", "Could not refresh the embed token.", {
              cause,
            }),
          );
          return fail(epoch, id, INTERNAL_ERROR, "Could not refresh the embed token.");
        }
      }
      case "ui/open-link": {
        const decoded = decodeOpenLinkParams(params);
        if (decoded._tag === "None") {
          return fail(epoch, id, INVALID_PARAMS, "Invalid ui/open-link params.");
        }
        try {
          await deps.openLink(decoded.value.url);
          return reply(epoch, id, {});
        } catch (cause) {
          return fail(
            epoch,
            id,
            INVALID_PARAMS,
            cause instanceof Error ? cause.message : "The link was not opened.",
          );
        }
      }
      case "lecturn/appRefs.describe": {
        const decoded = decodeDescribeRefsParams(params);
        if (decoded._tag === "None") {
          return fail(epoch, id, INVALID_PARAMS, "Invalid lecturn/appRefs.describe params.");
        }
        if (deps.describeRefs === undefined) return reply(epoch, id, { labels: {} });
        try {
          const labels = await deps.describeRefs(decoded.value.refs);
          return reply(epoch, id, { labels: sanitizeRefLabels(decoded.value.refs, labels) });
        } catch {
          return fail(epoch, id, INTERNAL_ERROR, "The host could not name these references.");
        }
      }
      default:
        return fail(epoch, id, METHOD_NOT_FOUND, `Unknown method ${method}.`);
    }
  };

  const handleNotification = (method: string, params: unknown) => {
    const decoder = guestNotificationDecoders[method];
    if (decoder === undefined) return;
    const decoded = decoder(params ?? {});
    if (decoded._tag === "None") return;
    if (method === "ui/notifications/initialized") {
      if (initialized) return;
      initialized = true;
      const flushed = queue;
      queue = [];
      for (const message of flushed) deps.send(message);
      return;
    }
    if (FORWARDED_EVENTS.has(method)) {
      deps.emit(method as EmbedBridgeEvent, decoded.value as never);
    }
  };

  const notify = <M extends EmbedHostNotificationMethod>(
    method: M,
    params: EmbedHostNotificationParams<M>,
  ): void => {
    const decoder = hostNotificationDecoders[method];
    if (decoder === undefined || decoder(params)._tag === "None") {
      throw new EmbedViewError(
        "bridge-message-rejected",
        `Invalid params for ${method} (see EMBED_HOST_NOTIFICATIONS).`,
      );
    }
    const message = { jsonrpc: "2.0", method, params };
    const size = checkEmbedMessageSize(message);
    if (!size.fits) throw new EmbedViewError("message-too-large", size.message);
    deliver(message);
  };

  return {
    handleGuestMessage(raw: unknown): void {
      if (embedMessageBytes(raw) > EMBED_MAX_MESSAGE_BYTES) return;
      const decoded = decodeMessage(raw);
      if (decoded._tag === "None") return;
      const message = decoded.value;
      if (!("method" in message)) return;
      if (!("id" in message)) {
        handleNotification(message.method, message.params);
        return;
      }
      if (pending >= EMBED_MAX_PENDING_REQUESTS) {
        fail(documentEpoch, message.id, INTERNAL_ERROR, "Too many pending requests.");
        return;
      }
      pending += 1;
      void handleRequest(message.id, message.method, message.params).finally(() => {
        pending -= 1;
      });
    },

    notify,

    /** Raw host input (the renderer's `sendBridge`), validated like `notify`. */
    notifyUnknown(message: unknown): void {
      if (typeof message !== "object" || message === null || !("method" in message)) {
        throw new EmbedViewError("bridge-message-rejected", "A bridge message needs a method.");
      }
      const { method, params } = message as { method: unknown; params?: unknown };
      if (typeof method !== "string" || !(method in EMBED_HOST_NOTIFICATIONS)) {
        throw new EmbedViewError(
          "bridge-message-rejected",
          `${String(method)} is not a host notification.`,
        );
      }
      notify(method as EmbedHostNotificationMethod, (params ?? {}) as never);
    },

    setHostContext(next: EmbedHostContext): void {
      assertHostContextFits(next);
      const changed: EmbedHostContextChanged = {
        theme: next.theme,
        ...(next.styles === undefined ? {} : { styles: next.styles }),
        ...(next.composerPlaceholder === context.composerPlaceholder
          ? {}
          : { composerPlaceholder: next.composerPlaceholder ?? null }),
      };
      context = next;
      deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: changed });
    },

    /** The guest navigated: its next document must initialize again. */
    resetDocument(): void {
      initialized = false;
      documentEpoch += 1;
    },

    /** A retarget: anything queued for the old target is void. */
    clearQueue(): void {
      queue = [];
    },
  };
}

export type EmbedHostSession = ReturnType<typeof createEmbedHostSession>;
