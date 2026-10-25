import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AppBinding,
  AppEmbedContext,
  AppEmbedTarget,
  AppId,
  AppLiveLeaseInput,
  AppPairingRequestId,
  AppRuntimeCeiling,
  AppStatus,
  AppStatusStreamEvent,
  ConnectedAppThreadContinuedIn,
  ConnectedAppThreadData,
  ConnectedAppThreadSubtitle,
  ConnectedAppThreadSummary,
  ConnectedAppThreadsStreamEvent,
} from "./apps.ts";
import { ConnectedAppThreadBundleV1 } from "./appsBundle.ts";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthAppHostScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { utf8ByteLength } from "./embedBridge.ts";

export class AppsError extends Schema.TaggedError<AppsError>()("AppsError", {
  code: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "unavailable"]),
  message: Schema.String,
}) {}

const error = Schema.Union([AppsError, EnvironmentAuthorizationError]);
const empty = Schema.Struct({});
const threadTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const AppsDecidePairingInput = Schema.Struct({
  requestId: AppPairingRequestId,
  decision: Schema.Literals(["grant", "deny"]),
});
export type AppsDecidePairingInput = typeof AppsDecidePairingInput.Type;

export const AppsSetRuntimeCeilingInput = Schema.Struct({
  appId: AppId,
  ceiling: AppRuntimeCeiling,
});
export type AppsSetRuntimeCeilingInput = typeof AppsSetRuntimeCeilingInput.Type;

export const AppsDeleteInput = Schema.Struct({ appId: AppId, deleteThreads: Schema.Boolean });
export type AppsDeleteInput = typeof AppsDeleteInput.Type;

export const AppsCreateEmbedThreadInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optionalKey(threadTitle),
  appData: Schema.optionalKey(ConnectedAppThreadData),
});
export type AppsCreateEmbedThreadInput = typeof AppsCreateEmbedThreadInput.Type;

export const AppsEnsureWorkspaceInput = Schema.Struct({
  workspaceRoot: AppBinding.fields.workspaceRoot,
  title: threadTitle,
});
export type AppsEnsureWorkspaceInput = typeof AppsEnsureWorkspaceInput.Type;

export const APP_EMBED_TOKEN_MAX_TTL_SECONDS = 15 * 60;

export const AppsMintEmbedTokenInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  ttlSeconds: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: APP_EMBED_TOKEN_MAX_TTL_SECONDS }),
  ),
});
export type AppsMintEmbedTokenInput = typeof AppsMintEmbedTokenInput.Type;

export const APP_HOST_CONTEXT_MAX_BYTES = 4 * 1024;

export const AppsUpdateHostContextInput = Schema.Struct({
  target: Schema.Union([
    Schema.Struct({ threadId: ThreadId }),
    Schema.Struct({ projectId: ProjectId }),
  ]),
  text: Schema.String.check(
    Schema.makeFilter((text: string) => utf8ByteLength(text) <= APP_HOST_CONTEXT_MAX_BYTES, {
      expected: `at most ${APP_HOST_CONTEXT_MAX_BYTES} UTF-8 bytes`,
    }),
  ),
});
export type AppsUpdateHostContextInput = typeof AppsUpdateHostContextInput.Type;

export const AppsExportThreadsInput = Schema.Struct({
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
});
export type AppsExportThreadsInput = typeof AppsExportThreadsInput.Type;

export const AppsImportThreadsResult = Schema.Struct({
  imported: NonNegativeInt,
  skipped: NonNegativeInt,
});
export type AppsImportThreadsResult = typeof AppsImportThreadsResult.Type;

export const AppsSetThreadAppDataInput = Schema.Struct({
  threadId: ThreadId,
  appData: Schema.NullOr(ConnectedAppThreadData),
  /** Absent leaves the subtitle unchanged; null clears it. */
  subtitle: Schema.optionalKey(Schema.NullOr(ConnectedAppThreadSubtitle)),
});
export type AppsSetThreadAppDataInput = typeof AppsSetThreadAppDataInput.Type;

export const AppsMarkThreadsCopiedInput = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({ threadId: ThreadId, continuedIn: ConnectedAppThreadContinuedIn }),
  ).check(Schema.isMaxLength(1000)),
});
export type AppsMarkThreadsCopiedInput = typeof AppsMarkThreadsCopiedInput.Type;

export const APPS_WS_METHODS = {
  appsList: "apps.list",
  appsSubscribeStatus: "apps.subscribeStatus",
  appsDecidePairing: "apps.decidePairing",
  appsRevoke: "apps.revoke",
  appsSetRuntimeCeiling: "apps.setRuntimeCeiling",
  appsDelete: "apps.delete",
  appsSubscribeEmbedContext: "apps.subscribeEmbedContext",
  appsCreateEmbedThread: "apps.createEmbedThread",
  appsEnsureWorkspace: "apps.ensureWorkspace",
  appsSetLiveLease: "apps.setLiveLease",
  appsClearLiveLease: "apps.clearLiveLease",
  appsMintEmbedToken: "apps.mintEmbedToken",
  appsUpdateHostContext: "apps.updateHostContext",
  appsExportThreads: "apps.exportThreads",
  appsImportThreads: "apps.importThreads",
  appsListThreads: "apps.listThreads",
  appsSubscribeThreads: "apps.subscribeThreads",
  appsSetThreadAppData: "apps.setThreadAppData",
  appsMarkThreadsCopied: "apps.markThreadsCopied",
} as const;
const M = APPS_WS_METHODS;

export const AppsRpcs = [
  Rpc.make(M.appsList, { payload: empty, success: Schema.Array(AppStatus), error }),
  Rpc.make(M.appsSubscribeStatus, {
    payload: empty,
    success: AppStatusStreamEvent,
    error,
    stream: true,
  }),
  Rpc.make(M.appsDecidePairing, { payload: AppsDecidePairingInput, success: AppStatus, error }),
  Rpc.make(M.appsRevoke, { payload: { appId: AppId }, success: AppStatus, error }),
  Rpc.make(M.appsSetRuntimeCeiling, {
    payload: AppsSetRuntimeCeilingInput,
    success: AppStatus,
    error,
  }),
  Rpc.make(M.appsDelete, { payload: AppsDeleteInput, success: empty, error }),
  Rpc.make(M.appsSubscribeEmbedContext, {
    payload: { projectId: ProjectId },
    success: AppEmbedContext,
    error,
    stream: true,
  }),
  Rpc.make(M.appsCreateEmbedThread, {
    payload: AppsCreateEmbedThreadInput,
    success: Schema.Struct({ threadId: ThreadId }),
    error,
  }),
  Rpc.make(M.appsEnsureWorkspace, {
    payload: AppsEnsureWorkspaceInput,
    success: Schema.Struct({ projectId: ProjectId }),
    error,
  }),
  Rpc.make(M.appsSetLiveLease, {
    payload: AppLiveLeaseInput,
    success: Schema.Struct({ expiresAt: IsoDateTime }),
    error,
  }),
  Rpc.make(M.appsClearLiveLease, { payload: empty, success: empty, error }),
  Rpc.make(M.appsMintEmbedToken, {
    payload: AppsMintEmbedTokenInput,
    success: AppEmbedTarget,
    error,
  }),
  Rpc.make(M.appsUpdateHostContext, {
    payload: AppsUpdateHostContextInput,
    success: empty,
    error,
  }),
  Rpc.make(M.appsExportThreads, {
    payload: AppsExportThreadsInput,
    success: ConnectedAppThreadBundleV1,
    error,
  }),
  Rpc.make(M.appsImportThreads, {
    payload: { bundle: ConnectedAppThreadBundleV1 },
    success: AppsImportThreadsResult,
    error,
  }),
  Rpc.make(M.appsListThreads, {
    payload: { projectId: ProjectId },
    success: Schema.Array(ConnectedAppThreadSummary),
    error,
  }),
  Rpc.make(M.appsSubscribeThreads, {
    payload: { projectId: ProjectId },
    success: ConnectedAppThreadsStreamEvent,
    error,
    stream: true,
  }),
  Rpc.make(M.appsSetThreadAppData, {
    payload: AppsSetThreadAppDataInput,
    success: empty,
    error,
  }),
  Rpc.make(M.appsMarkThreadsCopied, {
    payload: AppsMarkThreadsCopiedInput,
    success: empty,
    error,
  }),
] as const;

/**
 * Scope checks only. Which project an `app:` or embed subject may touch is
 * decided after this, by the apps authorization layer on the server.
 */
export const APPS_RPC_SCOPES = {
  [M.appsList]: AuthAccessReadScope,
  [M.appsSubscribeStatus]: AuthAccessReadScope,
  [M.appsDecidePairing]: AuthAccessWriteScope,
  [M.appsRevoke]: AuthAccessWriteScope,
  [M.appsSetRuntimeCeiling]: AuthAccessWriteScope,
  [M.appsDelete]: AuthAccessWriteScope,
  [M.appsSubscribeEmbedContext]: AuthOrchestrationReadScope,
  [M.appsCreateEmbedThread]: AuthOrchestrationOperateScope,
  [M.appsEnsureWorkspace]: AuthAppHostScope,
  [M.appsSetLiveLease]: AuthAppHostScope,
  [M.appsClearLiveLease]: AuthAppHostScope,
  [M.appsMintEmbedToken]: AuthAppHostScope,
  [M.appsUpdateHostContext]: AuthAppHostScope,
  [M.appsExportThreads]: AuthAppHostScope,
  [M.appsImportThreads]: AuthAppHostScope,
  [M.appsListThreads]: AuthAppHostScope,
  [M.appsSubscribeThreads]: AuthAppHostScope,
  [M.appsSetThreadAppData]: AuthAppHostScope,
  [M.appsMarkThreadsCopied]: AuthAppHostScope,
} as const;
