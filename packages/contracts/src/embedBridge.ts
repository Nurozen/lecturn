/**
 * Bridge between an app host (iframe parent or Electron preload) and Lecturn's
 * embed view. The roles are reversed from MCP Apps: Lecturn's web UI is the
 * guest and the app is the host. Methods MCP Apps already names keep its names
 * so the framing helpers stay shared; Lecturn additions use the `lecturn/`
 * prefix and are advertised under `experimental.lecturn`, because MCP Apps
 * sanctions no vendor namespace.
 *
 * This module imports only `effect/Schema` so `@lecturn/embed/browser` can use
 * it through the `./embedBridge` subpath without the contracts barrel.
 */
import * as Schema from "effect/Schema";

export const EMBED_MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
export const EMBED_LECTURN_BRIDGE_VERSION = 1;
// Same limits as the MCP Apps host (client-runtime mcpApps/host.ts), so either
// side can reuse the other's framing.
export const EMBED_MAX_MESSAGE_BYTES = 256 * 1024;
export const EMBED_MAX_PENDING_REQUESTS = 16;
export const EMBED_FONTS_CSS_MAX_BYTES = 200 * 1024;
/** The guest answers requests sent before `ui/notifications/initialized` with this code. */
export const EMBED_NOT_INITIALIZED_ERROR_CODE = -32002;

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** UTF-8 size of a message as it crosses the bridge; unserializable values never fit. */
export function embedMessageBytes(message: unknown): number {
  try {
    const json = JSON.stringify(message);
    return json === undefined ? Number.POSITIVE_INFINITY : utf8ByteLength(json);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export type EmbedMessageSizeCheck =
  | { readonly fits: true; readonly bytes: number }
  | { readonly fits: false; readonly bytes: number; readonly message: string };

/**
 * The guest drops oversize messages without a reply, so a host must check
 * before sending. Fonts make `ui/initialize` the message most likely to overflow.
 */
export function checkEmbedMessageSize(message: unknown): EmbedMessageSizeCheck {
  const bytes = embedMessageBytes(message);
  if (bytes <= EMBED_MAX_MESSAGE_BYTES) return { fits: true, bytes };
  return {
    fits: false,
    bytes,
    message: `Embed bridge message is ${bytes} bytes; the limit is ${EMBED_MAX_MESSAGE_BYTES} bytes.`,
  };
}

export const EmbedJsonRpcId = Schema.Union([Schema.String, Schema.Finite]);
export type EmbedJsonRpcId = typeof EmbedJsonRpcId.Type;

const jsonrpc = Schema.Literal("2.0");
const method = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const EmbedJsonRpcRequest = Schema.Struct({
  jsonrpc,
  id: EmbedJsonRpcId,
  method,
  params: Schema.optionalKey(Schema.Unknown),
});
export type EmbedJsonRpcRequest = typeof EmbedJsonRpcRequest.Type;

export const EmbedJsonRpcNotification = Schema.Struct({
  jsonrpc,
  method,
  params: Schema.optionalKey(Schema.Unknown),
});
export type EmbedJsonRpcNotification = typeof EmbedJsonRpcNotification.Type;

export const EmbedJsonRpcSuccess = Schema.Struct({
  jsonrpc,
  id: EmbedJsonRpcId,
  result: Schema.Unknown,
});
export type EmbedJsonRpcSuccess = typeof EmbedJsonRpcSuccess.Type;

export const EmbedJsonRpcErrorObject = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});
export type EmbedJsonRpcErrorObject = typeof EmbedJsonRpcErrorObject.Type;

export const EmbedJsonRpcError = Schema.Struct({
  jsonrpc,
  id: Schema.NullOr(EmbedJsonRpcId),
  error: EmbedJsonRpcErrorObject,
});
export type EmbedJsonRpcError = typeof EmbedJsonRpcError.Type;

// Order matters: structs ignore unknown keys, so the shapes with an `id` must
// be tried before the notification, which has none.
export const EmbedJsonRpcMessage = Schema.Union([
  EmbedJsonRpcRequest,
  EmbedJsonRpcSuccess,
  EmbedJsonRpcError,
  EmbedJsonRpcNotification,
]);
export type EmbedJsonRpcMessage = typeof EmbedJsonRpcMessage.Type;

export const EMBED_THEME_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--muted",
  "--muted-foreground",
  "--secondary",
  "--secondary-foreground",
  "--border",
  "--input",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--ring",
  // The running turn's stop button.
  "--destructive",
  "--radius",
  "--font-sans",
  "--font-mono",
] as const;
export const EmbedThemeVar = Schema.Literals(EMBED_THEME_VARS);
export type EmbedThemeVar = typeof EmbedThemeVar.Type;

const themeValue = Schema.String.check(Schema.isMaxLength(1024));
const FONT_FACE_BLOCK = /@font-face\s*\{([^{}]*)\}/g;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const CSS_URL = /url\(\s*(["']?)\s*([a-zA-Z][a-zA-Z0-9+.-]*:)?/g;

/**
 * Fonts are inlined because the guest's CSP and the host's loopback origin
 * leave it no font URL it may fetch. Anything other than `@font-face` rules
 * with `data:` sources would let a host restyle or exfiltrate from the guest.
 */
export function isDataUrlFontFaceCss(css: string): boolean {
  const uncommented = css.replace(CSS_COMMENT, " ");
  let blocks = 0;
  for (const match of uncommented.matchAll(FONT_FACE_BLOCK)) {
    const body = match[1] ?? "";
    let sources = 0;
    for (const url of body.matchAll(CSS_URL)) {
      if (url[2]?.toLowerCase() !== "data:") return false;
      sources += 1;
    }
    if (sources === 0) return false;
    blocks += 1;
  }
  return blocks > 0 && uncommented.replace(FONT_FACE_BLOCK, "").trim() === "";
}

export const EmbedFontsCss = Schema.String.check(
  Schema.makeFilter((css: string) => utf8ByteLength(css) <= EMBED_FONTS_CSS_MAX_BYTES, {
    expected: `at most ${EMBED_FONTS_CSS_MAX_BYTES} UTF-8 bytes`,
  }),
  Schema.makeFilter(isDataUrlFontFaceCss, {
    expected: "only @font-face rules whose sources are data: URLs",
  }),
);

/** Unknown variable names are dropped on decode, never applied. */
export const EmbedHostStyles = Schema.Struct({
  variables: Schema.optionalKey(Schema.Record(EmbedThemeVar, Schema.optionalKey(themeValue))),
  css: Schema.optionalKey(Schema.Struct({ fonts: Schema.optionalKey(EmbedFontsCss) })),
});
export type EmbedHostStyles = typeof EmbedHostStyles.Type;

/** The host's wording for the idle composer prompt; Lecturn's own stays without it. */
export const EmbedComposerPlaceholder = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);

const hostContextFields = {
  theme: Schema.Literals(["light", "dark"]),
  displayMode: Schema.Literal("inline"),
  locale: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  styles: Schema.optionalKey(EmbedHostStyles),
  composerPlaceholder: Schema.optionalKey(EmbedComposerPlaceholder),
};

export const EmbedHostContext = Schema.Struct(hostContextFields);
export type EmbedHostContext = typeof EmbedHostContext.Type;

/**
 * `host-context-changed` carries only the keys that changed, as in MCP Apps. A key left out keeps
 * its value, so a null placeholder is how the host hands the prompt back to Lecturn's wording.
 */
export const EmbedHostContextChanged = Schema.Struct({
  theme: Schema.optionalKey(hostContextFields.theme),
  displayMode: Schema.optionalKey(hostContextFields.displayMode),
  locale: Schema.optionalKey(hostContextFields.locale),
  styles: Schema.optionalKey(EmbedHostStyles),
  composerPlaceholder: Schema.optionalKey(Schema.NullOr(EmbedComposerPlaceholder)),
});
export type EmbedHostContextChanged = typeof EmbedHostContextChanged.Type;

const lecturnCapability = Schema.Struct({
  experimental: Schema.Struct({
    lecturn: Schema.Struct({ version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  }),
});

export const EmbedInitializeParams = Schema.Struct({
  protocolVersion: Schema.String,
  appCapabilities: lecturnCapability,
});
export type EmbedInitializeParams = typeof EmbedInitializeParams.Type;

export const EmbedInitializeResult = Schema.Struct({
  hostContext: EmbedHostContext,
  hostCapabilities: lecturnCapability,
});
export type EmbedInitializeResult = typeof EmbedInitializeResult.Type;

const threadId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const ref = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));

export const EmbedTurnState = Schema.Literals(["idle", "running", "awaiting-approval"]);
export type EmbedTurnState = typeof EmbedTurnState.Type;

const empty = Schema.Struct({});
const dimension = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const EmbedOpenLinkParams = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(8192)),
});
export const EmbedSizeChangedParams = Schema.Struct({
  width: Schema.optionalKey(dimension),
  height: Schema.optionalKey(dimension),
});
export const EmbedTokenRefreshResult = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1)),
  expiresAt: Schema.String,
});
export type EmbedTokenRefreshResult = typeof EmbedTokenRefreshResult.Type;
export const EmbedInsertMentionParams = Schema.Struct({
  ref,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  // Room for a 64 KB icon as a base64 data URL.
  iconUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(96 * 1024))),
});
export const EmbedSetDraftParams = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(64 * 1024)),
});
export const EmbedThreadOpenParams = Schema.Struct({ threadId });
export const EmbedThreadNewParams = Schema.Struct({
  title: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  appData: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter((value: string) => utf8ByteLength(value) <= 1024, {
        expected: "at most 1024 UTF-8 bytes",
      }),
    ),
  ),
});
export const EmbedNavigateParams = Schema.Struct({ ref });
export const EmbedThreadChangedParams = Schema.Struct({ threadId: Schema.NullOr(threadId) });
export const EmbedTurnStateParams = Schema.Struct({ threadId, state: EmbedTurnState });
export const EmbedReadyParams = Schema.Struct({ threadId: Schema.NullOr(threadId) });
/** Most references one `lecturn/appRefs.describe` names; the guest splits a longer list. */
export const EMBED_DESCRIBE_REFS_MAX = 64;
const refLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const EmbedDescribeRefsParams = Schema.Struct({
  refs: Schema.Array(ref).check(Schema.isMinLength(1), Schema.isMaxLength(EMBED_DESCRIBE_REFS_MAX)),
});
/** Labels by reference; a reference the host cannot name is left out and shows as itself. */
export const EmbedDescribeRefsResult = Schema.Struct({
  labels: Schema.Record(Schema.String, refLabel),
});
export type EmbedDescribeRefsResult = typeof EmbedDescribeRefsResult.Type;

/** Requests the guest sends to the host, with their results. */
export const EMBED_GUEST_REQUESTS = {
  "ui/initialize": { params: EmbedInitializeParams, result: EmbedInitializeResult },
  "ui/open-link": { params: EmbedOpenLinkParams, result: empty },
  "lecturn/token.refresh": { params: empty, result: EmbedTokenRefreshResult },
  // Names the app references a thread shows that no message stored a label for.
  "lecturn/appRefs.describe": { params: EmbedDescribeRefsParams, result: EmbedDescribeRefsResult },
} as const;

/** Notifications the guest sends to the host. */
export const EMBED_GUEST_NOTIFICATIONS = {
  "ui/notifications/initialized": empty,
  "ui/notifications/size-changed": EmbedSizeChangedParams,
  "lecturn/navigate": EmbedNavigateParams,
  "lecturn/thread.changed": EmbedThreadChangedParams,
  "lecturn/turn.state": EmbedTurnStateParams,
  "lecturn/ready": EmbedReadyParams,
} as const;

/**
 * Notifications the host sends to the guest. None may be sent before the
 * guest's `ui/notifications/initialized`.
 */
export const EMBED_HOST_NOTIFICATIONS = {
  "ui/notifications/host-context-changed": EmbedHostContextChanged,
  "lecturn/composer.insertMention": EmbedInsertMentionParams,
  "lecturn/composer.setDraft": EmbedSetDraftParams,
  "lecturn/thread.open": EmbedThreadOpenParams,
  "lecturn/thread.new": EmbedThreadNewParams,
  "lecturn/providers.open": empty,
} as const;

export type EmbedGuestRequestMethod = keyof typeof EMBED_GUEST_REQUESTS;
export type EmbedGuestNotificationMethod = keyof typeof EMBED_GUEST_NOTIFICATIONS;
export type EmbedHostNotificationMethod = keyof typeof EMBED_HOST_NOTIFICATIONS;
export type EmbedGuestRequestParams<M extends EmbedGuestRequestMethod> =
  (typeof EMBED_GUEST_REQUESTS)[M]["params"]["Type"];
export type EmbedGuestRequestResult<M extends EmbedGuestRequestMethod> =
  (typeof EMBED_GUEST_REQUESTS)[M]["result"]["Type"];
export type EmbedGuestNotificationParams<M extends EmbedGuestNotificationMethod> =
  (typeof EMBED_GUEST_NOTIFICATIONS)[M]["Type"];
export type EmbedHostNotificationParams<M extends EmbedHostNotificationMethod> =
  (typeof EMBED_HOST_NOTIFICATIONS)[M]["Type"];

export function embedInitializeParams(): EmbedInitializeParams {
  return {
    protocolVersion: EMBED_MCP_APPS_PROTOCOL_VERSION,
    appCapabilities: { experimental: { lecturn: { version: EMBED_LECTURN_BRIDGE_VERSION } } },
  };
}

export function embedInitializeResult(hostContext: EmbedHostContext): EmbedInitializeResult {
  return {
    hostContext,
    hostCapabilities: { experimental: { lecturn: { version: EMBED_LECTURN_BRIDGE_VERSION } } },
  };
}
