/**
 * Default-deny authorization for `app:` and `embed:` sessions (spec R2.3).
 * Scopes have already been checked by the time this runs; this decides which
 * methods such a session may call at all and which projects it may touch.
 * A method missing from `APP_RPC_RULES` is refused, so a new RPC is closed
 * to connected apps until someone decides otherwise.
 */
import {
  APPS_WS_METHODS as A,
  AppsError,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS as O,
  WS_METHODS as W,
  authScopeRequiredResponse,
  type AppBinding,
  type AppId,
  type AppsMintEmbedTokenInput,
  type AssetCreateUrlInput,
  type EnvironmentId,
  type OrchestrationV2Command,
  type ProjectId,
  ThreadId,
  type WsRpcGroup,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
} from "../attachmentStore.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { formatHostForUrl, isWildcardHost } from "../startupAccess.ts";
import { appHttpRouteFor } from "./appHttpAuthorization.ts";
import * as AppStreamFilter from "./appStreamFilter.ts";
import {
  AppAuthorization,
  type AppsFailure,
  AppProjectService,
  type AppsNotImplemented,
} from "./services.ts";
import { type AppSubject, formatEmbedSubject, parseAppSubject } from "./subjects.ts";

type WsRpc = RpcGroup.Rpcs<typeof WsRpcGroup>;
export type WsRpcMethod = WsRpc["_tag"];
type PayloadOf<M extends WsRpcMethod> = Rpc.Payload<Rpc.ExtractTag<WsRpc, M>>;

export type AccessTarget =
  | { readonly projectId: ProjectId }
  | { readonly threadId: ThreadId }
  /** A filesystem path that must be the embed token's project root. */
  | { readonly projectRoot: string }
  /** A file path that must stay inside the embed token's project root. */
  | { readonly projectPath: string }
  /** A stored attachment, owned by the thread its id was minted for. */
  | { readonly attachmentId: string };

/**
 * How a call names the projects it touches. A function returning `null`
 * refuses the call outright: the payload asks for something the subject may
 * never do, whichever project it names.
 */
type Resolve<P> =
  | "none"
  | (P extends { readonly projectId: ProjectId } ? "projectId" : never)
  | (P extends { readonly threadId: ThreadId } ? "threadId" : never)
  | ((payload: P) => ReadonlyArray<AccessTarget> | null);

export interface AppRpcRule<P> {
  readonly resolve: Resolve<P>;
  readonly app: boolean;
  readonly embed: boolean;
}

type AppRpcTable = { readonly [M in WsRpcMethod]?: AppRpcRule<PayloadOf<M>> };

/** What an embedded chat may do to its own threads; creation goes through `apps.createEmbedThread` (D32). */
const EMBED_COMMAND_TYPES: ReadonlySet<OrchestrationV2Command["type"]> = new Set([
  "message.dispatch",
  "run.interrupt",
  "queued-run.cancel",
  "queued-run.edit",
  "queued-run.reorder",
  "queued-message.promote-to-steer",
  "runtime-request.respond",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.model-selection.set",
  "thread.metadata.update",
  "thread.settle",
  "thread.unsettle",
  // The chat view marks its thread read whenever it shows new activity.
  "thread.visit",
  "thread.mark-unread",
  // A held queue and an agent's question each need their way out in the embed too.
  "queue.resume",
  "thread.user-input.dismiss",
]);

/** `thread.metadata.update` also moves branches and worktrees; an embed may only rename. */
const TITLE_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "type",
  "commandId",
  "threadId",
  "title",
  "regenerateTitle",
]);

const commandTargets = (command: OrchestrationV2Command): ReadonlyArray<AccessTarget> | null => {
  if (!EMBED_COMMAND_TYPES.has(command.type) || !("threadId" in command)) return null;
  if (
    command.type === "thread.metadata.update" &&
    Object.keys(command).some((key) => !TITLE_UPDATE_KEYS.has(key))
  ) {
    return null;
  }
  return [{ threadId: command.threadId }];
};

/**
 * Attachments name no thread, so they resolve through the thread their id was
 * minted for. Pending uploads belong to no thread yet. Paths outside the
 * project are refused, as are host-wide lookups (GitHub media).
 */
const assetTargets = ({ resource }: AssetCreateUrlInput): ReadonlyArray<AccessTarget> | null => {
  switch (resource._tag) {
    case "attachment":
      return [{ attachmentId: resource.attachmentId }];
    case "workspace-file":
    case "tool-output-image":
      return [{ threadId: resource.threadId }];
    case "media-file":
      return [{ threadId: resource.threadId }, { projectPath: resource.path }];
    case "draft-workspace-file":
      return [{ projectRoot: resource.cwd }, { projectPath: resource.path }];
    case "project-favicon":
      return [{ projectRoot: resource.cwd }];
    case "native-app-icon":
      return [];
    case "github-media":
      return null;
  }
};

const app = { app: true, embed: false } as const;
const embed = { app: false, embed: true } as const;

export const APP_RPC_RULES: AppRpcTable = {
  [A.appsEnsureWorkspace]: { resolve: "none", ...app },
  [A.appsSetLiveLease]: { resolve: "none", ...app },
  [A.appsClearLiveLease]: { resolve: "none", ...app },
  [A.appsMintEmbedToken]: {
    resolve: ({ projectId, threadId }) =>
      threadId === undefined ? [{ projectId }] : [{ projectId }, { threadId }],
    ...app,
  },
  [A.appsUpdateHostContext]: { resolve: ({ target }) => [target], ...app },
  // An absent list means "all of the app's projects", which the service scopes by app id.
  [A.appsExportThreads]: {
    resolve: ({ projectIds }) => (projectIds ?? []).map((projectId) => ({ projectId })),
    ...app,
  },
  [A.appsImportThreads]: { resolve: "none", ...app },
  [A.appsListThreads]: { resolve: "projectId", ...app },
  [A.appsSubscribeThreads]: { resolve: "projectId", ...app },
  [A.appsSetThreadAppData]: { resolve: "threadId", ...app },
  [A.appsMarkThreadsCopied]: {
    resolve: ({ entries }) => entries.map(({ threadId }) => ({ threadId })),
    ...app,
  },
  [A.appsSubscribeEmbedContext]: { resolve: "projectId", ...embed },
  [A.appsCreateEmbedThread]: { resolve: "projectId", ...embed },
  [O.subscribeShell]: { resolve: "none", ...embed },
  [O.subscribeThread]: { resolve: "threadId", ...embed },
  [O.getThreadProjection]: { resolve: "threadId", ...embed },
  [O.getTurnItem]: { resolve: "threadId", ...embed },
  [O.getTurnDiff]: { resolve: "threadId", ...embed },
  [O.searchThread]: { resolve: "threadId", ...embed },
  // Only an existing thread: any create from an embed goes through apps.createEmbedThread.
  [O.launchThread]: {
    resolve: ({ projectId, threadId, reuseExistingThread }) =>
      threadId === undefined || reuseExistingThread !== true ? null : [{ projectId }, { threadId }],
    ...embed,
  },
  [O.dispatchCommand]: { resolve: commandTargets, ...embed },
  // App cards in the pane: each call names the tool call that produced the card, and the
  // environment resolves the card's server from that item (D3).
  [W.mcpAppsReadResource]: { resolve: "threadId", ...embed },
  [W.mcpAppsToolInfo]: { resolve: "threadId", ...embed },
  [W.mcpAppsCallTool]: { resolve: "threadId", ...embed },
  [W.mcpAppsUpdateModelContext]: {
    resolve: ({ threadId, conversationThreadId }) => [
      { threadId },
      { threadId: conversationThreadId },
    ],
    ...embed,
  },
  // The web client's connection handshake: it opens on the config stream and probes with
  // server.probe, so an embed that can read the config needs both (D31).
  [W.serverGetConfig]: { resolve: "none", ...embed },
  [W.subscribeServerConfig]: { resolve: "none", ...embed },
  [W.serverProbe]: { resolve: "none", ...embed },
  [W.serverRefreshProviders]: { resolve: "none", ...embed },
  [W.providerInstallSubscribe]: { resolve: "none", ...embed },
  [W.serverReportClientActivity]: { resolve: "none", ...embed },
  [W.projectsSearchEntries]: { resolve: ({ cwd }) => [{ projectRoot: cwd }], ...embed },
  [W.assetsCreateUrl]: { resolve: assetTargets, ...embed },
  // The welcome event carries no project data beyond what serverGetConfig already shows (D31).
  [W.subscribeServerLifecycle]: { resolve: "none", ...embed },
  [W.subscribeVcsStatus]: { resolve: ({ cwd }) => [{ projectRoot: cwd }], ...embed },
  // Without a project the list spans every project.
  [W.threadNotesList]: {
    resolve: ({ projectId }) => (projectId === undefined ? null : [{ projectId }]),
    ...embed,
  },
  // Contextual reads of the embed's own threads only. Changing sources or settings would pull
  // host-wide context into a thread the app can read, and the change stream spans every project.
  [W.contextualStatus]: { resolve: "threadId", ...embed },
  [W.contextualDisclosures]: { resolve: "threadId", ...embed },
  [W.contextualConflicts]: { resolve: "threadId", ...embed },
};

export const EMBED_TOKEN_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthFilesystemReadScope,
] as const;

/** The table's per-method payload types are checked where rules are written; lookups are by name. */
interface UntypedRule {
  readonly resolve:
    | "none"
    | "projectId"
    | "threadId"
    | ((payload: unknown) => ReadonlyArray<AccessTarget> | null);
  readonly app: boolean;
  readonly embed: boolean;
}

const lookupRule = (method: string): UntypedRule | undefined =>
  Object.hasOwn(APP_RPC_RULES, method)
    ? (APP_RPC_RULES[method as WsRpcMethod] as UntypedRule | undefined)
    : undefined;

const targetsFor = (rule: UntypedRule, payload: unknown): ReadonlyArray<AccessTarget> | null => {
  switch (rule.resolve) {
    case "none":
      return [];
    case "projectId":
      return [{ projectId: (payload as { readonly projectId: ProjectId }).projectId }];
    case "threadId":
      return [{ threadId: (payload as { readonly threadId: ThreadId }).threadId }];
    default:
      return rule.resolve(payload);
  }
};

/** A refused command names its type, so a gap in `EMBED_COMMAND_TYPES` shows in the log. */
const describeCall = (method: string, payload: unknown) =>
  method === O.dispatchCommand &&
  typeof payload === "object" &&
  payload !== null &&
  "type" in payload &&
  typeof payload.type === "string"
    ? `${method} (${payload.type})`
    : method;

const withoutTrailingSlashes = (path: string) => path.replace(/[/\\]+$/, "") || path;

const isThreadId = Schema.is(ThreadId);

const isAbsolutePath = (path: string) => /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path);

/**
 * Textual only: a relative path resolves against the thread's own workspace,
 * and the asset service still confines and canonicalizes what it serves.
 */
const isInsideRoot = (root: string, path: string) => {
  if (path.startsWith("~") || path.split(/[/\\]/).includes("..")) return false;
  if (!isAbsolutePath(path)) return true;
  const base = withoutTrailingSlashes(root);
  return path.startsWith(base) && /^[/\\]/.test(path.slice(base.length));
};

/** What the authorization needs from the rest of the server, narrowed so tests can fake it. */
export interface AppAuthorizationDeps {
  readonly resolveAppForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<AppBinding>, AppsFailure>;
  /** `None` when the thread does not exist. */
  readonly projectIdForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectId>, AppsFailure>;
  readonly issueEmbedSession: (input: {
    readonly subject: string;
    readonly ttl: Duration.Duration;
    readonly label: string;
  }) => Effect.Effect<
    { readonly token: string; readonly expiresAt: DateTime.DateTime },
    AppsFailure
  >;
  readonly environmentId: Effect.Effect<EnvironmentId>;
  /** The origin the embed page is served from. */
  readonly embedOrigin: string;
}

export const makeWith = (deps: AppAuthorizationDeps): AppAuthorization["Service"] => {
  const ownsProject = (subject: AppSubject, projectId: ProjectId) =>
    subject.kind === "embed" && projectId !== subject.projectId
      ? Effect.succeed(false)
      : deps
          .resolveAppForProject(projectId)
          .pipe(
            Effect.map((binding) =>
              Option.exists(binding, (bound) => bound.appId === subject.appId),
            ),
          );

  const ownsThread = (subject: AppSubject, threadId: ThreadId) =>
    deps.projectIdForThread(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: (projectId) => ownsProject(subject, projectId),
        }),
      ),
    );

  const ownsProjectRoot = (subject: AppSubject, root: string) =>
    subject.kind !== "embed"
      ? Effect.succeed(false)
      : deps
          .resolveAppForProject(subject.projectId)
          .pipe(
            Effect.map((binding) =>
              Option.exists(
                binding,
                (bound) =>
                  bound.appId === subject.appId &&
                  withoutTrailingSlashes(bound.workspaceRoot) === withoutTrailingSlashes(root),
              ),
            ),
          );

  const ownsProjectPath = (subject: AppSubject, path: string) =>
    subject.kind !== "embed"
      ? Effect.succeed(false)
      : deps
          .resolveAppForProject(subject.projectId)
          .pipe(
            Effect.map((binding) =>
              Option.exists(
                binding,
                (bound) => bound.appId === subject.appId && isInsideRoot(bound.workspaceRoot, path),
              ),
            ),
          );

  const ownsAttachment = (subject: AppSubject, attachmentId: string) => {
    const segment = parseThreadSegmentFromAttachmentId(attachmentId);
    // Thread ids are lowercase UUIDs, which the attachment segment keeps verbatim; any other
    // id is refused rather than guessed at.
    return segment === null || segment === PENDING_ATTACHMENT_THREAD_SEGMENT || !isThreadId(segment)
      ? Effect.succeed(false)
      : ownsThread(subject, segment);
  };

  const ownsTarget = (
    subject: AppSubject,
    target: AccessTarget,
  ): Effect.Effect<boolean, AppsFailure> =>
    "projectId" in target
      ? ownsProject(subject, target.projectId)
      : "threadId" in target
        ? ownsThread(subject, target.threadId)
        : "projectRoot" in target
          ? ownsProjectRoot(subject, target.projectRoot)
          : "projectPath" in target
            ? ownsProjectPath(subject, target.projectPath)
            : ownsAttachment(subject, target.attachmentId);

  const ownsAll = (subject: AppSubject, targets: ReadonlyArray<AccessTarget>) =>
    Effect.forEach(targets, (target) => ownsTarget(subject, target)).pipe(
      Effect.map((owned) => owned.every(Boolean)),
    );

  /** A lookup failure denies; only `AppsNotImplemented` survives, so the caller can say why. */
  const decide = (
    allowed: Effect.Effect<boolean, AppsFailure>,
    deny: () => EnvironmentAuthorizationError,
  ): Effect.Effect<void, EnvironmentAuthorizationError | AppsNotImplemented> =>
    allowed.pipe(
      Effect.catchTags({ AppsError: () => Effect.succeed(false) }),
      Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(deny()))),
    );

  const authorizeRpc: AppAuthorization["Service"]["authorizeRpc"] = (session, method, payload) => {
    const subject = parseAppSubject(session.subject);
    if (subject === null) return Effect.void;
    const call = describeCall(method, payload);
    const deny = () =>
      new EnvironmentAuthorizationError({
        message: `This connected app cannot call ${call} here.`,
        ...authScopeRequiredResponse(requiredScopeForRpcMethod(method)),
      });
    const rule = lookupRule(method);
    const targets = rule === undefined || !rule[subject.kind] ? null : targetsFor(rule, payload);
    const decided =
      targets === null ? Effect.fail(deny()) : decide(ownsAll(subject, targets), deny);
    // A refusal is either a misbehaving app or a gap in the table; the log tells them apart.
    return decided.pipe(
      Effect.tapErrorTag("EnvironmentAuthorizationError", () =>
        Effect.logWarning("Refused a connected app call.", {
          subject: subject.kind,
          appId: subject.appId,
          call,
        }),
      ),
    );
  };

  const filterShellItem: AppAuthorization["Service"]["filterShellItem"] = (session, item) => {
    const subject = parseAppSubject(session.subject);
    if (subject === null) return Effect.succeedSome(item);
    return AppStreamFilter.filterShellItem(subject, item, (projectId) =>
      ownsProject(subject, projectId),
    ).pipe(Effect.orElseSucceed(() => Option.none()));
  };

  const authorizeHttp: AppAuthorization["Service"]["authorizeHttp"] = (session, path) => {
    const subject = parseAppSubject(session.subject);
    if (subject === null) return Effect.void;
    const deny = () =>
      new EnvironmentAuthorizationError({
        message: "This connected app cannot use this route.",
        ...authScopeRequiredResponse(AuthOrchestrationReadScope),
      });
    const route = appHttpRouteFor(subject, path);
    if (route === null) return Effect.fail(deny());
    return route.kind === "thread"
      ? decide(ownsThread(subject, route.threadId), deny)
      : Effect.void;
  };

  const mintEmbedToken = Effect.fn("AppAuthorization.mintEmbedToken")(function* (
    appId: AppId,
    input: AppsMintEmbedTokenInput,
  ) {
    const subject: AppSubject = { kind: "embed", appId, projectId: input.projectId };
    const notFound = new AppsError({
      code: "not-found",
      message: "No project or thread of this app has that id.",
    });
    if (!(yield* ownsProject({ kind: "app", appId }, input.projectId))) {
      return yield* notFound;
    }
    if (input.threadId !== undefined && !(yield* ownsThread(subject, input.threadId))) {
      return yield* notFound;
    }
    const issued = yield* deps.issueEmbedSession({
      subject: formatEmbedSubject(appId, input.projectId),
      ttl: Duration.seconds(input.ttlSeconds),
      label: appId,
    });
    const environmentId = yield* deps.environmentId;
    const path = [environmentId, input.projectId, ...(input.threadId ? [input.threadId] : [])]
      .map(encodeURIComponent)
      .join("/");
    return {
      url: `${deps.embedOrigin}/embed/${path}`,
      token: issued.token,
      expiresAt: DateTime.formatIso(DateTime.toUtc(issued.expiresAt)),
    };
  });

  return AppAuthorization.of({ authorizeRpc, filterShellItem, authorizeHttp, mintEmbedToken });
};

const unavailable = (message: string) => new AppsError({ code: "unavailable", message });

/** Embedding is local-only, so the page is served from this server's own loopback origin. */
const resolveEmbedOrigin = (config: ServerConfig.ServerConfig["Service"]) => {
  if (config.devUrl !== undefined) return config.devUrl.origin;
  const host =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${host}:${config.port}`;
};

export const layer = Layer.effect(
  AppAuthorization,
  Effect.gen(function* () {
    const projects = yield* AppProjectService;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* SessionStore.SessionStore;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const config = yield* ServerConfig.ServerConfig;
    return makeWith({
      resolveAppForProject: projects.resolveAppForProject,
      projectIdForThread: (threadId) =>
        projections.getThreadShell(threadId).pipe(
          Effect.map((shell) => Option.map(Option.fromNullOr(shell), (found) => found.projectId)),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeedNone }),
          Effect.mapError(() => unavailable("Thread lookup failed.")),
        ),
      issueEmbedSession: ({ subject, ttl, label }) =>
        sessions
          .issue({
            subject,
            method: "bearer-access-token",
            scopes: EMBED_TOKEN_SCOPES,
            ttl,
            client: { label, deviceType: "bot" },
          })
          .pipe(Effect.mapError(() => unavailable("The embed token could not be issued."))),
      environmentId: environment.getEnvironmentId,
      embedOrigin: resolveEmbedOrigin(config),
    });
  }),
);
