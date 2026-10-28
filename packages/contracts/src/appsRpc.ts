import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { ConnectedAppThreadBundleV1 } from "./appsBundle.ts";
import {
  AppsExportThreadsInput,
  AppsCoreRpcs,
  AppsImportThreadsResult,
  APPS_WS_METHODS,
  AppsError,
} from "./appsRpcCore.ts";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthAppHostScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ProjectId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export * from "./appsRpcCore.ts";

/**
 * The embed's own project default for new threads; null returns it to the
 * environment default. Kept out of appsRpcCore so @lecturn/embed does not
 * bundle the model schemas it never sends.
 */
export const AppsSetEmbedDefaultModelInput = Schema.Struct({
  projectId: ProjectId,
  modelSelection: Schema.NullOr(ModelSelection),
});
export type AppsSetEmbedDefaultModelInput = typeof AppsSetEmbedDefaultModelInput.Type;

const error = Schema.Union([AppsError, EnvironmentAuthorizationError]);
const M = APPS_WS_METHODS;

export const AppsRpcs = [
  ...AppsCoreRpcs,
  Rpc.make(M.appsSetEmbedDefaultModel, {
    payload: AppsSetEmbedDefaultModelInput,
    success: Schema.Struct({}),
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
  [M.appsSetEmbedDefaultModel]: AuthOrchestrationOperateScope,
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
