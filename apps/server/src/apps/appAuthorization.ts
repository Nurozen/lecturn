/**
 * Default-deny authorization for `app:` and `embed:` sessions.
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
  type ChatAttachment,
  type EnvironmentId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  ThreadId,
  type ThreadNoteId,
  type WsRpcGroup,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { formatHostForUrl, isWildcardHost } from "../startupAccess.ts";
import { appHttpRouteFor } from "./appHttpAuthorization.ts";
import * as AppStreamFilter from "./appStreamFilter.ts";
import { AppAuthorization, AppProjectService } from "./services.ts";
import { type AppSubject, formatEmbedSubject, parseAppSubject } from "./subjects.ts";

type WsRpc = RpcGroup.Rpcs<typeof WsRpcGroup>;
export type WsRpcMethod = WsRpc["_tag"];
type PayloadOf<M extends WsRpcMethod> = Rpc.Payload<Rpc.ExtractTag<WsRpc, M>>;

export type AccessTarget =
  | { readonly projectId: ProjectId }
  | { readonly threadId: ThreadId }
  /** A filesystem path that must be the embed token's project root. */
  | { readonly projectRoot: string }
  /**
   * A file path that must stay inside the embed token's project root, through any links.
   * A relative path is read from `relativeTo`'s workspace when given, else the root.
   */
  | { readonly projectPath: string; readonly relativeTo?: ThreadId }
  /** A stored attachment, owned by the thread whose history references it. */
  | { readonly attachmentId: string }
  /** A saved note, owned by the project of the thread it quotes. */
  | { readonly noteId: ThreadNoteId };

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

/** What an embedded chat may do to its own threads; creation goes through `apps.createEmbedThread`. */
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

const isPendingUpload = (attachmentId: string) =>
  parseThreadSegmentFromAttachmentId(attachmentId) === PENDING_ATTACHMENT_THREAD_SEGMENT;

/**
 * A pending upload is claimed into the command's own thread. Any other id is
 * handed to the provider as stored, so it must already belong to one of the
 * embed's threads.
 */
const storedAttachmentTargets = (
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ReadonlyArray<AccessTarget> =>
  (attachments ?? [])
    .filter((attachment) => !isPendingUpload(attachment.id))
    .map((attachment) => ({ attachmentId: attachment.id }));

/** Threads and files a command reads besides the thread it is addressed to. */
const commandReferences = (command: OrchestrationV2Command): ReadonlyArray<AccessTarget> => {
  switch (command.type) {
    case "message.dispatch":
      return [
        ...(command.senderThreadId === undefined ? [] : [{ threadId: command.senderThreadId }]),
        ...(command.sourcePlanRef === undefined
          ? []
          : [{ threadId: command.sourcePlanRef.threadId }]),
        ...storedAttachmentTargets(command.attachments),
      ];
    case "queued-run.edit":
      return storedAttachmentTargets(command.attachments);
    case "runtime-request.respond":
      return storedAttachmentTargets(Object.values(command.attachmentsByQuestionId ?? {}).flat());
    default:
      return [];
  }
};

/**
 * Preparation binds the thread to whatever worktree or branch a strategy names, and provider
 * turns and relative asset paths then run there. Unchecked, an embed could aim its thread at any
 * directory, so it keeps the project root, as `TITLE_UPDATE_KEYS` already keeps it there.
 */
const staysInProjectRoot = (strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined) =>
  strategy === undefined || (strategy.type === "root" && strategy.branch === undefined);

const commandTargets = (command: OrchestrationV2Command): ReadonlyArray<AccessTarget> | null => {
  if (!EMBED_COMMAND_TYPES.has(command.type) || !("threadId" in command)) return null;
  if (
    command.type === "thread.metadata.update" &&
    Object.keys(command).some((key) => !TITLE_UPDATE_KEYS.has(key))
  ) {
    return null;
  }
  if (
    command.type === "message.dispatch" &&
    command.dispatchMode.type === "defer_start" &&
    !staysInProjectRoot(command.dispatchMode.workspaceStrategy)
  ) {
    return null;
  }
  return [{ threadId: command.threadId }, ...commandReferences(command)];
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
      return [
        { threadId: resource.threadId },
        { projectPath: resource.path, relativeTo: resource.threadId },
      ];
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

const APP_RPC_RULES: AppRpcTable = {
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
  // The providers panel's one write: the default model of the token's own project.
  [A.appsSetEmbedDefaultModel]: { resolve: "projectId", ...embed },
  [O.subscribeShell]: { resolve: "none", ...embed },
  [O.subscribeThread]: { resolve: "threadId", ...embed },
  [O.getThreadProjection]: { resolve: "threadId", ...embed },
  [O.getTurnItem]: { resolve: "threadId", ...embed },
  [O.getTurnDiff]: { resolve: "threadId", ...embed },
  [O.searchThread]: { resolve: "threadId", ...embed },
  // Only an existing thread: any create from an embed goes through apps.createEmbedThread.
  [O.launchThread]: {
    resolve: ({ projectId, threadId, reuseExistingThread, workspaceStrategy, initialMessage }) =>
      threadId === undefined ||
      reuseExistingThread !== true ||
      !staysInProjectRoot(workspaceStrategy)
        ? null
        : [{ projectId }, { threadId }, ...storedAttachmentTargets(initialMessage?.attachments)],
    ...embed,
  },
  [O.dispatchCommand]: { resolve: commandTargets, ...embed },
  // App cards in the pane: each call names the tool call that produced the card, and the
  // environment resolves the card's server from that item.
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
  // server.probe, so an embed that can read the config needs both.
  [W.serverGetConfig]: { resolve: "none", ...embed },
  [W.subscribeServerConfig]: { resolve: "none", ...embed },
  [W.serverProbe]: { resolve: "none", ...embed },
  [W.serverRefreshProviders]: { resolve: "none", ...embed },
  [W.providerInstallSubscribe]: { resolve: "none", ...embed },
  [W.serverReportClientActivity]: { resolve: "none", ...embed },
  [W.projectsSearchEntries]: { resolve: ({ cwd }) => [{ projectRoot: cwd }], ...embed },
  [W.assetsCreateUrl]: { resolve: assetTargets, ...embed },
  // The welcome event carries no project data beyond what serverGetConfig already shows.
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
  [W.threadNotesCreate]: { resolve: "threadId", ...embed },
  [W.threadNotesUpdate]: { resolve: ({ id }) => [{ noteId: id }], ...embed },
  [W.threadNotesDelete]: { resolve: ({ id }) => [{ noteId: id }], ...embed },
  // A pending upload belongs to no thread until a dispatch the embed may send claims it into
  // one of its own threads (commandTargets); nobody else can name it.
  [W.attachmentsCreateUploadUrl]: { resolve: "none", ...embed },
  // A claimed attachment is part of its thread's history; only a pending upload may go.
  [W.attachmentsDelete]: {
    resolve: ({ attachmentId }) => (isPendingUpload(attachmentId) ? [] : null),
    ...embed,
  },
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

const isAbsolutePath = (path: string) => /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path);

/** Textual; `ownsProjectPath` also checks where the path's links lead. */
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
  ) => Effect.Effect<Option.Option<AppBinding>, AppsError>;
  /** `None` when the thread does not exist. */
  readonly projectIdForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectId>, AppsError>;
  /** `None` for a pending upload or an attachment no thread's history references. */
  readonly threadIdForAttachment: (
    attachmentId: string,
  ) => Effect.Effect<Option.Option<ThreadId>, AppsError>;
  /** `None` when the note does not exist. */
  readonly projectIdForNote: (
    noteId: ThreadNoteId,
  ) => Effect.Effect<Option.Option<ProjectId>, AppsError>;
  /** `None` when the thread runs in its project's root, or does not exist. */
  readonly worktreePathForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<string>, AppsError>;
  /** Where `path`, read from `from`, really is after its links; `None` when it does not resolve. */
  readonly canonicalPath: (path: string, from?: string) => Effect.Effect<Option.Option<string>>;
  readonly issueEmbedSession: (input: {
    readonly subject: string;
    readonly ttl: Duration.Duration;
    readonly label: string;
  }) => Effect.Effect<{ readonly token: string; readonly expiresAt: DateTime.DateTime }, AppsError>;
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

  /**
   * The asset service signs whatever file a path's links lead to, so the path must stay inside
   * the workspace it is read from after them as well as by its text. Absolute paths name the
   * project root; relative ones the thread's own workspace, as the asset service reads them.
   */
  const ownsProjectPath = Effect.fnUntraced(function* (
    subject: AppSubject,
    { projectPath, relativeTo }: Extract<AccessTarget, { readonly projectPath: string }>,
  ) {
    if (subject.kind !== "embed") return false;
    const binding = yield* deps.resolveAppForProject(subject.projectId);
    if (Option.isNone(binding) || binding.value.appId !== subject.appId) return false;
    const root = binding.value.workspaceRoot;
    if (!isInsideRoot(root, projectPath)) return false;
    const workspace =
      isAbsolutePath(projectPath) || relativeTo === undefined
        ? root
        : Option.getOrElse(yield* deps.worktreePathForThread(relativeTo), () => root);
    const [canonicalWorkspace, canonicalFile] = yield* Effect.all([
      deps.canonicalPath(workspace),
      deps.canonicalPath(projectPath, workspace),
    ]);
    return (
      Option.isSome(canonicalWorkspace) &&
      Option.isSome(canonicalFile) &&
      isInsideRoot(canonicalWorkspace.value, canonicalFile.value)
    );
  });

  const ownsAttachment = (subject: AppSubject, attachmentId: string) =>
    deps.threadIdForAttachment(attachmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: (threadId) => ownsThread(subject, threadId),
        }),
      ),
    );

  const ownsNote = (subject: AppSubject, noteId: ThreadNoteId) =>
    deps.projectIdForNote(noteId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: (projectId) => ownsProject(subject, projectId),
        }),
      ),
    );

  const ownsTarget = (
    subject: AppSubject,
    target: AccessTarget,
  ): Effect.Effect<boolean, AppsError> =>
    "projectId" in target
      ? ownsProject(subject, target.projectId)
      : "threadId" in target
        ? ownsThread(subject, target.threadId)
        : "projectRoot" in target
          ? ownsProjectRoot(subject, target.projectRoot)
          : "projectPath" in target
            ? ownsProjectPath(subject, target)
            : "noteId" in target
              ? ownsNote(subject, target.noteId)
              : ownsAttachment(subject, target.attachmentId);

  const ownsAll = (subject: AppSubject, targets: ReadonlyArray<AccessTarget>) =>
    Effect.forEach(targets, (target) => ownsTarget(subject, target)).pipe(
      Effect.map((owned) => owned.every(Boolean)),
    );

  /** A lookup failure denies. */
  const decide = (
    allowed: Effect.Effect<boolean, AppsError>,
    deny: () => EnvironmentAuthorizationError,
  ): Effect.Effect<void, EnvironmentAuthorizationError> =>
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

/**
 * An attachment id carries its thread only as a lossy segment. A thread whose id is that
 * segment owns it as minted; any other thread must be one whose segment matches and whose
 * history references the id, since several reshaped ids can share a segment.
 */
const makeThreadIdForAttachment = (
  sql: SqlClient.SqlClient,
  projections: ProjectionStoreV2["Service"],
): AppAuthorizationDeps["threadIdForAttachment"] =>
  Effect.fn("AppAuthorization.threadIdForAttachment")(
    function* (attachmentId) {
      const segment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (segment === null || segment === PENDING_ATTACHMENT_THREAD_SEGMENT) {
        return Option.none<ThreadId>();
      }
      // Besides the exact id, only ids the segment reshapes: anything outside its alphabet
      // (copies are `copy:<appId>:<env>:<thread>`) or longer than it keeps.
      const rows = yield* sql<{ readonly thread_id: ThreadId }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE thread_id = ${segment}
          OR thread_id GLOB '*[^a-z0-9_-]*'
          OR length(thread_id) > 80
      `;
      if (rows.some((row) => row.thread_id === segment)) {
        return Option.some(ThreadId.make(segment));
      }
      for (const { thread_id: threadId } of rows) {
        if (toSafeThreadAttachmentSegment(threadId) !== segment) continue;
        const referenced = yield* projections.getThreadAttachmentIds(threadId);
        if (referenced.includes(attachmentId)) return Option.some(threadId);
      }
      return Option.none<ThreadId>();
    },
    Effect.mapError(() => unavailable("Attachment lookup failed.")),
  );

export const canonicalPathOnDisk = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalPath: AppAuthorizationDeps["canonicalPath"] = (target, from) =>
    Effect.option(fileSystem.realPath(from === undefined ? target : path.resolve(from, target)));
  return canonicalPath;
});

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
    const sql = yield* SqlClient.SqlClient;
    const canonicalPath = yield* canonicalPathOnDisk;
    return makeWith({
      resolveAppForProject: projects.resolveAppForProject,
      projectIdForThread: (threadId) =>
        projections.getThreadShell(threadId).pipe(
          Effect.map((shell) => Option.map(Option.fromNullOr(shell), (found) => found.projectId)),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeedNone }),
          Effect.mapError(() => unavailable("Thread lookup failed.")),
        ),
      threadIdForAttachment: makeThreadIdForAttachment(sql, projections),
      projectIdForNote: (noteId) =>
        sql<{
          readonly project_id: ProjectId;
        }>`SELECT project_id FROM thread_notes WHERE id = ${noteId}`.pipe(
          Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.project_id)),
          Effect.mapError(() => unavailable("Note lookup failed.")),
        ),
      worktreePathForThread: (threadId) =>
        projections.getThreadShell(threadId).pipe(
          Effect.map((shell) => Option.fromNullOr(shell?.worktreePath ?? null)),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeedNone }),
          Effect.mapError(() => unavailable("Thread lookup failed.")),
        ),
      canonicalPath,
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
