import { APPS_WS_METHODS as M, AppsError, AppsRpcs, type AppId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import {
  AppAuthorization,
  AppHostContextStore,
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  ThreadCopyService,
  type AppsFailure,
  type AppsNotImplemented,
} from "./services.ts";
import { type AppSubject, parseAppSubject } from "./subjects.ts";

const unavailable = (error: AppsNotImplemented) =>
  new AppsError({ code: "unavailable", message: error.message });

const toRpcError = <A>(effect: Effect.Effect<A, AppsFailure>) =>
  effect.pipe(Effect.catchTags({ AppsNotImplemented: (error) => Effect.fail(unavailable(error)) }));

const toRpcStreamError = <A>(stream: Stream.Stream<A, AppsFailure>) =>
  stream.pipe(Stream.catchTags({ AppsNotImplemented: (error) => Stream.fail(unavailable(error)) }));

// Only for typing the handler record; ws.ts serves these through its own group.
const AppsRpcGroup = RpcGroup.make(...AppsRpcs);

const forbidden = (message: string) => new AppsError({ code: "forbidden", message });

/**
 * One handler record per connection: the session's subject names the app (or
 * embed token) a call acts for, so services never read it from the request.
 */
export const make = Effect.fn("AppsRpcHandlers.make")(function* (session: AuthenticatedSession) {
  const registry = yield* AppRegistryService;
  const leases = yield* AppLeaseService;
  const projects = yield* AppProjectService;
  const authorization = yield* AppAuthorization;
  const hostContext = yield* AppHostContextStore;
  const threadCopy = yield* ThreadCopyService;

  const subject = parseAppSubject(session.subject);
  // `apps:host` is only ever granted to app subjects; this keeps a mis-scoped
  // session from reaching a service without an app id.
  const asApp = <A>(run: (appId: AppId) => Effect.Effect<A, AppsFailure>) =>
    subject?.kind === "app"
      ? toRpcError(run(subject.appId))
      : Effect.fail(forbidden("Only a connected app can call this method."));
  const asEmbed = <A>(run: (embed: AppSubject) => Effect.Effect<A, AppsFailure>) =>
    subject?.kind === "embed"
      ? toRpcError(run(subject))
      : Effect.fail(forbidden("Only an embedded Lecturn view can call this method."));

  return AppsRpcGroup.of({
    [M.appsList]: () => toRpcError(registry.list),
    [M.appsSubscribeStatus]: () => toRpcStreamError(registry.streamStatus),
    [M.appsDecidePairing]: (input) => toRpcError(registry.decidePairing(input)),
    [M.appsRevoke]: ({ appId }) => toRpcError(registry.revoke(appId)),
    [M.appsSetRuntimeCeiling]: (input) => toRpcError(registry.setRuntimeCeiling(input)),
    [M.appsDelete]: (input) => toRpcError(registry.delete(input).pipe(Effect.as({}))),
    [M.appsSubscribeEmbedContext]: ({ projectId }) =>
      toRpcStreamError(registry.streamEmbedContext(projectId)),
    [M.appsCreateEmbedThread]: (input) =>
      asEmbed((embed) => projects.createEmbedThread(embed, input)),
    [M.appsEnsureWorkspace]: (input) => asApp((appId) => projects.ensureWorkspace(appId, input)),
    [M.appsSetLiveLease]: (input) => asApp((appId) => leases.set(appId, input)),
    [M.appsClearLiveLease]: () => asApp((appId) => leases.clear(appId).pipe(Effect.as({}))),
    [M.appsMintEmbedToken]: (input) => asApp((appId) => authorization.mintEmbedToken(appId, input)),
    [M.appsUpdateHostContext]: ({ target, text }) =>
      asApp(() => hostContext.set(target, text).pipe(Effect.as({}))),
    [M.appsExportThreads]: ({ projectIds }) =>
      asApp((appId) => threadCopy.export(appId, projectIds)),
    [M.appsImportThreads]: ({ bundle }) => asApp((appId) => threadCopy.import(appId, bundle)),
    [M.appsListThreads]: ({ projectId }) => asApp(() => projects.listThreads(projectId)),
    [M.appsSubscribeThreads]: ({ projectId }) =>
      subject?.kind === "app"
        ? toRpcStreamError(projects.streamThreads(projectId))
        : Stream.fail(forbidden("Only a connected app can call this method.")),
    [M.appsSetThreadAppData]: (input) =>
      asApp((appId) => projects.setThreadAppData(appId, input).pipe(Effect.as({}))),
    [M.appsMarkThreadsCopied]: (input) =>
      asApp((appId) => projects.markThreadsCopied(appId, input).pipe(Effect.as({}))),
  });
});
