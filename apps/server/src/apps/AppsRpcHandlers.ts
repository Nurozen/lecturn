import {
  APPS_WS_METHODS as M,
  AppsError,
  AppsRpcs,
  type AppId,
  type AppStatus,
  type ProjectId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  AppAuthorization,
  AppHostContextStore,
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  HeadlessToolHost,
  ThreadCopyService,
} from "./services.ts";
import { type AppSubject, parseAppSubject } from "./subjects.ts";

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
  const headless = yield* HeadlessToolHost;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const subject = parseAppSubject(session.subject);
  // `apps:host` is only ever granted to app subjects; this keeps a mis-scoped
  // session from reaching a service without an app id.
  const asApp = <A>(run: (appId: AppId) => Effect.Effect<A, AppsError>) =>
    subject?.kind === "app"
      ? run(subject.appId)
      : Effect.fail(forbidden("Only a connected app can call this method."));
  const asEmbed = <A>(run: (embed: AppSubject) => Effect.Effect<A, AppsError>) =>
    subject?.kind === "embed"
      ? run(subject)
      : Effect.fail(forbidden("Only an embedded Lecturn view can call this method."));

  // Definitions refresh through the app's lock-free listArgs, which spawn
  // nothing without them; never delays the answer.
  const refreshDefinitions = (appId: AppId, projectId: ProjectId) =>
    headless
      .refreshDefinitions(appId, projectId)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

  // The cache is per app, so the most recently used project lists for all.
  const refreshAfterGrant = (status: AppStatus) =>
    projectStore.list().pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => row.appBinding?.appId === status.appId)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .at(0),
      ),
      Effect.flatMap((row) =>
        row === undefined ? Effect.void : refreshDefinitions(status.appId, row.projectId),
      ),
      Effect.ignoreCause({ log: true }),
    );

  return AppsRpcGroup.of({
    [M.appsList]: () => registry.list,
    [M.appsSubscribeStatus]: () => registry.streamStatus,
    [M.appsDecidePairing]: (input) =>
      registry
        .decidePairing(input)
        .pipe(
          Effect.tap((status) =>
            input.decision === "grant" ? refreshAfterGrant(status) : Effect.void,
          ),
        ),
    [M.appsRevoke]: ({ appId }) => registry.revoke(appId),
    [M.appsSetRuntimeCeiling]: (input) => registry.setRuntimeCeiling(input),
    [M.appsDelete]: (input) => registry.delete(input).pipe(Effect.as({})),
    [M.appsSubscribeEmbedContext]: ({ projectId }) => registry.streamEmbedContext(projectId),
    [M.appsCreateEmbedThread]: (input) =>
      asEmbed((embed) => projects.createEmbedThread(embed, input)),
    [M.appsSetEmbedDefaultModel]: (input) =>
      asEmbed((embed) => projects.setEmbedDefaultModel(embed, input).pipe(Effect.as({}))),
    [M.appsEnsureWorkspace]: (input) =>
      asApp((appId) =>
        projects
          .ensureWorkspace(appId, input)
          .pipe(Effect.tap(({ projectId }) => refreshDefinitions(appId, projectId))),
      ),
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
        ? projects.streamThreads(projectId)
        : Stream.fail(forbidden("Only a connected app can call this method.")),
    [M.appsSetThreadAppData]: (input) =>
      asApp((appId) => projects.setThreadAppData(appId, input).pipe(Effect.as({}))),
    [M.appsMarkThreadsCopied]: (input) =>
      asApp((appId) => projects.markThreadsCopied(appId, input).pipe(Effect.as({}))),
  });
});
