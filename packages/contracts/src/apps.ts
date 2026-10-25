/**
 * Connected apps: third-party programs that register with a Lecturn
 * environment, get app-bound projects and threads, expose tools to agents and
 * embed Lecturn's chat. Mobile imports this module, so it must stay
 * Hermes-safe and must not import orchestrationV2.ts, which imports it.
 */
import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { EmbedTurnState, utf8ByteLength } from "./embedBridge.ts";

const maxUtf8Bytes = (bytes: number) =>
  Schema.makeFilter((value: string) => utf8ByteLength(value) <= bytes, {
    expected: `at most ${bytes} UTF-8 bytes`,
  });

const shortText = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const AppId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9]+(\.[a-z0-9-]+)+$/),
).pipe(Schema.brand("AppId"));
export type AppId = typeof AppId.Type;

/** Agent-visible tool names become `<prefix>_<tool>`. */
export const AppToolPrefix = Schema.String.check(Schema.isPattern(/^[a-z0-9]{2,12}$/));
export type AppToolPrefix = typeof AppToolPrefix.Type;

/** Unprefixed tool name as the app itself declares it. */
export const AppToolName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,64}$/));
export type AppToolName = typeof AppToolName.Type;

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5}|\*)$/;
const validPort = (port: string) => port === "*" || (Number(port) >= 1 && Number(port) <= 65535);

/**
 * Loopback only, because embedding is local. The `*` port is allowed since
 * `frame-ancestors` accepts it and app dev servers often bind port 0.
 */
export const AppEmbedOrigin = Schema.String.check(
  Schema.makeFilter(
    (origin: string) => {
      const match = LOOPBACK_ORIGIN.exec(origin);
      return match !== null && validPort(match[2] ?? "");
    },
    { expected: "a loopback http(s) origin such as http://127.0.0.1:*" },
  ),
);
export type AppEmbedOrigin = typeof AppEmbedOrigin.Type;

const PORT = /^\d{1,5}$/;

/** Whether a page origin is one an app declared, with `*` standing for any port. */
export function matchesAppEmbedOrigin(
  origin: string,
  embedOrigins: ReadonlyArray<AppEmbedOrigin>,
): boolean {
  return embedOrigins.some((pattern) => {
    if (!pattern.endsWith(":*")) return origin === pattern;
    const base = pattern.slice(0, -1);
    return origin.startsWith(base) && PORT.test(origin.slice(base.length));
  });
}

export const AppAbsolutePath = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^(\/|[A-Za-z]:[\\/]|\\\\)/),
);
export type AppAbsolutePath = typeof AppAbsolutePath.Type;

export const APP_WORKSPACE_ROOT_PLACEHOLDER = "{workspaceRoot}";

const commandArgs = Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
  Schema.isMaxLength(64),
);

export const AppHeadlessTools = Schema.Struct({
  command: AppAbsolutePath,
  args: commandArgs,
  /**
   * Lists tool definitions as JSON on stdout and exits without taking the
   * app's locks. Without it, an empty definition cache is filled by starting
   * the long-lived call process.
   */
  listArgs: Schema.optionalKey(commandArgs),
  env: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/)),
      Schema.String.check(Schema.isMaxLength(4096)),
    ).check(Schema.isMaxProperties(64)),
  ),
  cwd: Schema.Literal(APP_WORKSPACE_ROOT_PLACEHOLDER),
});
export type AppHeadlessTools = typeof AppHeadlessTools.Type;

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
export const APP_ICON_MAX_BYTES = 64 * 1024;

export function base64DecodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Checked without decoding, so mobile needs no base64 or image support. */
export const AppIconDataUrl = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      if (!value.startsWith(PNG_DATA_URL_PREFIX)) return false;
      const payload = value.slice(PNG_DATA_URL_PREFIX.length);
      return (
        payload.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(payload) &&
        // Base64 of the PNG signature, so other image types are refused.
        payload.startsWith("iVBORw0KGgo") &&
        base64DecodedByteLength(payload) <= APP_ICON_MAX_BYTES
      );
    },
    { expected: `a base64 PNG data URL of at most ${APP_ICON_MAX_BYTES} bytes` },
  ),
);
export type AppIconDataUrl = typeof AppIconDataUrl.Type;

/** Message text starting with one of these renders as an app reference chip. */
export const AppRefPrefix = Schema.String.check(
  Schema.isMaxLength(16),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*:$/),
);
export type AppRefPrefix = typeof AppRefPrefix.Type;

export const AppRegistration = Schema.Struct({
  appId: AppId,
  name: shortText(64),
  iconDataUrl: AppIconDataUrl,
  toolPrefix: AppToolPrefix,
  /** Placeholders `{workspaceRoot}` and `{threadId}`. */
  openUrlTemplate: Schema.optionalKey(shortText(2048)),
  refPrefixes: Schema.Array(AppRefPrefix).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  headlessTools: Schema.optionalKey(AppHeadlessTools),
  liveTools: Schema.Boolean,
  gatedTools: Schema.Array(AppToolName).check(Schema.isMaxLength(256)),
  embedOrigins: Schema.optionalKey(Schema.Array(AppEmbedOrigin).check(Schema.isMaxLength(16))),
  instructions: Schema.optionalKey(Schema.String.check(maxUtf8Bytes(8 * 1024))),
});
export type AppRegistration = typeof AppRegistration.Type;

/** sha256 hex of `appGrantFingerprintSource`. */
export const AppGrantFingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type AppGrantFingerprint = typeof AppGrantFingerprint.Type;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * What the user approved at pairing: the exact command the server will run
 * and the origins allowed to frame Lecturn. A registration whose source
 * differs from the granted one needs a new approval.
 */
export function appGrantFingerprintSource(
  registration: Pick<AppRegistration, "headlessTools" | "embedOrigins">,
): string {
  return canonicalJson({
    headlessTools: registration.headlessTools ?? null,
    embedOrigins: registration.embedOrigins ?? [],
  });
}

export const AppGrantState = Schema.Literals(["pairing-requested", "granted", "denied", "revoked"]);
export type AppGrantState = typeof AppGrantState.Type;

/** Null means no ceiling: the thread's own runtime mode applies. */
export const AppRuntimeCeiling = Schema.NullOr(AuthMcpClientAccess);
export type AppRuntimeCeiling = typeof AppRuntimeCeiling.Type;

export const AppLiveState = Schema.NullOr(Schema.Struct({ expiresAt: IsoDateTime }));
export type AppLiveState = typeof AppLiveState.Type;

export const AppPairingRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type AppPairingRequestId = typeof AppPairingRequestId.Type;

export const AppPendingPairingRequest = Schema.Struct({
  requestId: AppPairingRequestId,
  registration: AppRegistration,
  requestedAt: IsoDateTime,
});
export type AppPendingPairingRequest = typeof AppPendingPairingRequest.Type;

export const AppStatus = Schema.Struct({
  appId: AppId,
  name: AppRegistration.fields.name,
  iconDataUrl: AppIconDataUrl,
  toolPrefix: AppToolPrefix,
  refPrefixes: AppRegistration.fields.refPrefixes,
  openUrlTemplate: Schema.NullOr(shortText(2048)),
  state: AppGrantState,
  live: AppLiveState,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  runtimeCeiling: AppRuntimeCeiling,
  headlessTools: Schema.NullOr(AppHeadlessTools),
  gatedTools: AppRegistration.fields.gatedTools,
  embedOrigins: Schema.Array(AppEmbedOrigin),
  pendingRequest: Schema.NullOr(AppPendingPairingRequest),
});
export type AppStatus = typeof AppStatus.Type;

export const AppStatusStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), apps: Schema.Array(AppStatus) }),
  Schema.Struct({ type: Schema.Literal("upsert"), app: AppStatus }),
  Schema.Struct({ type: Schema.Literal("remove"), appId: AppId }),
]);
export type AppStatusStreamEvent = typeof AppStatusStreamEvent.Type;

/**
 * Stored and echoed exactly as the app sent it: hosts key their state by this
 * string, so normalizing it would break their lookups. Surrounding whitespace
 * is refused rather than trimmed for the same reason.
 */
export const AppWorkspaceRoot = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter((value: string) => value.trim() === value, {
    expected: "a path without surrounding whitespace",
  }),
);
export type AppWorkspaceRoot = typeof AppWorkspaceRoot.Type;

export const AppBinding = Schema.Struct({
  appId: AppId,
  workspaceRoot: AppWorkspaceRoot,
});
export type AppBinding = typeof AppBinding.Type;

/** Which credential created an app thread; `creationSource` stays a closed upstream literal. */
export const AppOrigin = Schema.Literals(["app-credential", "embed"]);
export type AppOrigin = typeof AppOrigin.Type;

/** Opaque to Lecturn; only the owning app writes it. */
export const ConnectedAppThreadData = Schema.String.check(maxUtf8Bytes(1024));
export type ConnectedAppThreadData = typeof ConnectedAppThreadData.Type;

export const ConnectedAppThreadSubtitle = Schema.String.check(Schema.isMaxLength(80));
export type ConnectedAppThreadSubtitle = typeof ConnectedAppThreadSubtitle.Type;

/**
 * Monotonic per thread: the event sequence of the last message, turn item or
 * terminal provider turn. Metadata writes never move it, so they never cause
 * a re-copy.
 */
export const ConnectedAppHistoryRevision = NonNegativeInt;

export const ConnectedAppThreadCopyOrigin = Schema.Struct({
  appId: AppId,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  copiedAt: IsoDateTime,
  sourceHistoryRevision: ConnectedAppHistoryRevision,
});
export type ConnectedAppThreadCopyOrigin = typeof ConnectedAppThreadCopyOrigin.Type;

export const ConnectedAppThreadContinuedIn = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  copiedAt: IsoDateTime,
});
export type ConnectedAppThreadContinuedIn = typeof ConnectedAppThreadContinuedIn.Type;

export const ConnectedAppThreadState = EmbedTurnState;
export type ConnectedAppThreadState = typeof ConnectedAppThreadState.Type;

export const ConnectedAppThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: AppWorkspaceRoot,
  title: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  historyRevision: ConnectedAppHistoryRevision,
  state: ConnectedAppThreadState,
  appData: Schema.NullOr(ConnectedAppThreadData),
  subtitle: Schema.NullOr(ConnectedAppThreadSubtitle),
  copiedFrom: Schema.optionalKey(ConnectedAppThreadCopyOrigin),
  continuedIn: Schema.optionalKey(ConnectedAppThreadContinuedIn),
});
export type ConnectedAppThreadSummary = typeof ConnectedAppThreadSummary.Type;

export const ConnectedAppThreadsStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    threads: Schema.Array(ConnectedAppThreadSummary),
  }),
  Schema.Struct({ type: Schema.Literal("upsert"), thread: ConnectedAppThreadSummary }),
  Schema.Struct({ type: Schema.Literal("remove"), threadId: ThreadId }),
]);
export type ConnectedAppThreadsStreamEvent = typeof ConnectedAppThreadsStreamEvent.Type;

export const AppPairingRequestCreated = Schema.Struct({
  requestId: AppPairingRequestId,
  pollSecret: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type AppPairingRequestCreated = typeof AppPairingRequestCreated.Type;

export const AppCredential = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  environmentId: EnvironmentId,
});
export type AppCredential = typeof AppCredential.Type;

/** `credential` is present only on the first poll after the grant. */
export const AppPairingPoll = Schema.Struct({
  state: Schema.Union([AppGrantState, Schema.Literal("expired")]),
  credential: Schema.optionalKey(AppCredential),
});
export type AppPairingPoll = typeof AppPairingPoll.Type;

/** Bootstrap-fd envelope of a sidecar server that the app owns; granted without a prompt. */
export const AppSidecarBootstrap = Schema.Struct({
  mode: Schema.Literal("app-sidecar"),
  registration: AppRegistration,
  appSeedToken: TrimmedNonEmptyString,
});
export type AppSidecarBootstrap = typeof AppSidecarBootstrap.Type;

export const AppLoopbackHttpUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter(
    (url: string) => {
      const match = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(\/\S*)?$/.exec(url);
      return match !== null && match[2] !== "*" && validPort(match[2] ?? "");
    },
    { expected: "a loopback http(s) URL with an explicit port" },
  ),
);
export type AppLoopbackHttpUrl = typeof AppLoopbackHttpUrl.Type;

export const AppLiveLeaseInput = Schema.Struct({
  url: AppLoopbackHttpUrl,
  bearer: TrimmedNonEmptyString,
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 60 })),
});
export type AppLiveLeaseInput = typeof AppLiveLeaseInput.Type;

/** The token travels separately so it never lands in history or logs with the URL. */
export const AppEmbedTarget = Schema.Struct({
  url: shortText(4096),
  token: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type AppEmbedTarget = typeof AppEmbedTarget.Type;

export const AppEmbedContext = Schema.Struct({
  appId: AppId,
  name: AppRegistration.fields.name,
  iconDataUrl: AppIconDataUrl,
  refPrefixes: AppRegistration.fields.refPrefixes,
  openUrlTemplate: Schema.NullOr(shortText(2048)),
  live: AppLiveState,
  state: AppGrantState,
  /** The iframe guest answers only a parent on one of these origins. */
  embedOrigins: Schema.Array(AppEmbedOrigin),
});
export type AppEmbedContext = typeof AppEmbedContext.Type;

/**
 * Marks a `permission` runtime request raised by Lecturn for an app tool.
 * Older clients ignore the field and still render and answer the request.
 */
export const ConnectedAppToolApprovalInfo = Schema.Struct({
  appId: AppId,
  appName: AppRegistration.fields.name,
  /** Prefixed, as the agent called it. */
  toolName: shortText(128),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  source: Schema.Literals(["static", "app"]),
});
export type ConnectedAppToolApprovalInfo = typeof ConnectedAppToolApprovalInfo.Type;

export const APP_TOOL_CONTEXT_META_KEY = "lecturn/context";
export const APP_TOOL_APPROVAL_META_KEY = "lecturn/approval";
export const APP_TOOL_APPROVAL_REQUIRED_META_KEY = "lecturn/approval-required";

export const AppToolContextMeta = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  workspaceRoot: AppWorkspaceRoot,
  turnId: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppToolContextMeta = typeof AppToolContextMeta.Type;

export const AppToolApprovalMeta = Schema.Struct({
  approved: Schema.Boolean,
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AppToolApprovalMeta = typeof AppToolApprovalMeta.Type;

export const AppToolApprovalRequiredMeta = Schema.Struct({
  reason: Schema.String.check(Schema.isMaxLength(2000)),
});
export type AppToolApprovalRequiredMeta = typeof AppToolApprovalRequiredMeta.Type;
