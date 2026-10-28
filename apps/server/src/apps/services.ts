/**
 * Service tags for connected apps. Each service has its own layer file and
 * `AppsLayer.ts` composes them; the tags live together so a service's
 * consumers never import another service's layer file.
 *
 * Operations fail with `AppsError`, the wire error, whose `code` already names
 * the categories every transport shows.
 */
import type {
  AppBinding,
  AppEmbedContext,
  AppEmbedTarget,
  AppId,
  AppLiveLeaseInput,
  AppLoopbackHttpUrl,
  AppPairingPoll,
  AppPairingRequestCreated,
  AppPairingRequestId,
  AppRegistration,
  AppsCreateEmbedThreadInput,
  AppsSetEmbedDefaultModelInput,
  AppsDecidePairingInput,
  AppsDeleteInput,
  AppSidecarBootstrap,
  AppsEnsureWorkspaceInput,
  AppsError,
  AppsImportThreadsResult,
  AppsMarkThreadsCopiedInput,
  AppsMintEmbedTokenInput,
  AppsSetRuntimeCeilingInput,
  AppsSetThreadAppDataInput,
  AppStatus,
  AppStatusStreamEvent,
  AppsUpdateHostContextInput,
  ConnectedAppThreadBundleV1,
  ConnectedAppThreadSummary,
  ConnectedAppThreadsStreamEvent,
  ConnectedAppToolApprovalInfo,
  EnvironmentAuthorizationError,
  IsoDateTime,
  OrchestrationV2ShellStreamItem,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { McpSchema } from "effect/ai";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { AppSubject } from "./subjects.ts";

export type AppToolTier = "headless" | "live";

/** `None` means never listed, which is different from an app with no tools. */
export interface AppCachedTools {
  readonly headless: Option.Option<ReadonlyArray<McpSchema.Tool>>;
  readonly live: Option.Option<ReadonlyArray<McpSchema.Tool>>;
}

/** The registration is kept whole: tools need fields `AppStatus` leaves out (instructions, liveTools). */
export interface AppRecord {
  readonly status: AppStatus;
  readonly registration: AppRegistration;
}

export interface AppLease {
  readonly appId: AppId;
  readonly url: AppLoopbackHttpUrl;
  readonly bearer: string;
  readonly expiresAt: DateTime.Utc;
}

export interface AppLeaseChange {
  readonly appId: AppId;
  readonly lease: Option.Option<AppLease>;
}

/** A tool call as the app declared the tool: unprefixed name, Lecturn `_meta` already merged. */
export interface AppToolCallRequest {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface AppToolApprovalContext {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
}

export type AppToolApprovalOutcome = "approved" | "declined" | "cancelled" | "expired";

/** `requestId` is null when no request was raised; an approved call re-sends it to the app. */
export interface AppToolApprovalAnswer {
  readonly outcome: AppToolApprovalOutcome;
  readonly requestId: RuntimeRequestId | null;
  /** Set on a `cancelled` outcome Lecturn caused, e.g. "RocketWright was revoked". */
  readonly reason?: string;
}

export class AppRegistryService extends Context.Service<
  AppRegistryService,
  {
    readonly createPairingRequest: (
      registration: AppRegistration,
    ) => Effect.Effect<AppPairingRequestCreated, AppsError>;
    readonly pollPairingRequest: (input: {
      readonly requestId: AppPairingRequestId;
      readonly pollSecret: string;
    }) => Effect.Effect<AppPairingPoll, AppsError>;
    readonly decidePairing: (input: AppsDecidePairingInput) => Effect.Effect<AppStatus, AppsError>;
    readonly revoke: (appId: AppId) => Effect.Effect<AppStatus, AppsError>;
    readonly delete: (input: AppsDeleteInput) => Effect.Effect<void, AppsError>;
    readonly setRuntimeCeiling: (
      input: AppsSetRuntimeCeilingInput,
    ) => Effect.Effect<AppStatus, AppsError>;
    readonly list: Effect.Effect<ReadonlyArray<AppStatus>, AppsError>;
    readonly streamStatus: Stream.Stream<AppStatusStreamEvent, AppsError>;
    readonly get: (appId: AppId) => Effect.Effect<Option.Option<AppRecord>, AppsError>;
    readonly isGranted: (appId: AppId) => Effect.Effect<boolean, AppsError>;
    readonly cachedTools: (appId: AppId) => Effect.Effect<AppCachedTools, AppsError>;
    readonly setCachedTools: (
      appId: AppId,
      tier: AppToolTier,
      definitions: ReadonlyArray<McpSchema.Tool>,
    ) => Effect.Effect<void, AppsError>;
    readonly seedSidecarGrant: (envelope: AppSidecarBootstrap) => Effect.Effect<void, AppsError>;
    /** The app that owns `projectId`, for the embed banner; fails `not-found` for other projects. */
    readonly streamEmbedContext: (
      projectId: ProjectId,
    ) => Stream.Stream<AppEmbedContext, AppsError>;
  }
>()("lecturn/apps/services/AppRegistryService") {}

/** In-memory only: a lease dies with the server, and the app re-publishes it on its heartbeat. */
export class AppLeaseService extends Context.Service<
  AppLeaseService,
  {
    readonly set: (
      appId: AppId,
      input: AppLiveLeaseInput,
    ) => Effect.Effect<{ readonly expiresAt: IsoDateTime }, AppsError>;
    readonly clear: (appId: AppId) => Effect.Effect<void, AppsError>;
    readonly current: (appId: AppId) => Effect.Effect<Option.Option<AppLease>>;
    readonly stream: Stream.Stream<AppLeaseChange>;
  }
>()("lecturn/apps/services/AppLeaseService") {}

export class AppProjectService extends Context.Service<
  AppProjectService,
  {
    readonly ensureWorkspace: (
      appId: AppId,
      input: AppsEnsureWorkspaceInput,
    ) => Effect.Effect<{ readonly projectId: ProjectId }, AppsError>;
    readonly resolveAppForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<AppBinding>, AppsError>;
    readonly listThreads: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ConnectedAppThreadSummary>, AppsError>;
    readonly streamThreads: (
      projectId: ProjectId,
    ) => Stream.Stream<ConnectedAppThreadsStreamEvent, AppsError>;
    readonly setThreadAppData: (
      appId: AppId,
      input: AppsSetThreadAppDataInput,
    ) => Effect.Effect<void, AppsError>;
    /** The subject decides who may set `appData`, so it is passed, not inferred. */
    readonly createEmbedThread: (
      subject: AppSubject,
      input: AppsCreateEmbedThreadInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, AppsError>;
    readonly setEmbedDefaultModel: (
      subject: AppSubject,
      input: AppsSetEmbedDefaultModelInput,
    ) => Effect.Effect<void, AppsError>;
    readonly markThreadsCopied: (
      appId: AppId,
      input: AppsMarkThreadsCopiedInput,
    ) => Effect.Effect<void, AppsError>;
    /** Every project bound to the app, with its threads (`apps.delete` with `deleteThreads`). */
    readonly deleteAppProjects: (appId: AppId) => Effect.Effect<void, AppsError>;
  }
>()("lecturn/apps/services/AppProjectService") {}

/**
 * Called only for `app:` and `embed:` sessions; other sessions keep the plain
 * scope check with no per-call work (see appRpcAuthorization.ts).
 */
export class AppAuthorization extends Context.Service<
  AppAuthorization,
  {
    readonly authorizeRpc: (
      session: AuthenticatedSession,
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    /** `None` drops the item. */
    readonly filterShellItem: (
      session: AuthenticatedSession,
      item: OrchestrationV2ShellStreamItem,
    ) => Effect.Effect<Option.Option<OrchestrationV2ShellStreamItem>>;
    readonly authorizeHttp: (
      session: AuthenticatedSession,
      path: string,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly mintEmbedToken: (
      appId: AppId,
      input: AppsMintEmbedTokenInput,
    ) => Effect.Effect<AppEmbedTarget, AppsError>;
  }
>()("lecturn/apps/services/AppAuthorization") {}

export class AppToolkit extends Context.Service<
  AppToolkit,
  {
    readonly listFor: (
      scope: McpInvocationScope,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, AppsError>;
    /** `name` is prefixed, as the agent called it. */
    readonly call: (
      scope: McpInvocationScope,
      name: string,
      args: Readonly<Record<string, unknown>>,
      meta: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<McpSchema.CallToolResult, AppsError>;
  }
>()("lecturn/apps/services/AppToolkit") {}

/** One ref-counted stdio process per (appId, projectId). */
export class HeadlessToolHost extends Context.Service<
  HeadlessToolHost,
  {
    /** Holds the process for the caller's scope. */
    readonly acquire: (
      appId: AppId,
      projectId: ProjectId,
    ) => Effect.Effect<void, AppsError, Scope.Scope>;
    readonly listTools: (
      appId: AppId,
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, AppsError>;
    readonly call: (
      appId: AppId,
      projectId: ProjectId,
      request: AppToolCallRequest,
    ) => Effect.Effect<McpSchema.CallToolResult, AppsError>;
    /** On the call-path process, for card documents and the resources cards read. */
    readonly readResource: (
      appId: AppId,
      projectId: ProjectId,
      uri: string,
    ) => Effect.Effect<McpSchema.ReadResourceResult, AppsError>;
    /** Runs the registration's `listArgs`; never the call-path command. */
    readonly refreshDefinitions: (
      appId: AppId,
      projectId: ProjectId,
    ) => Effect.Effect<void, AppsError>;
    /** Acquires the call-path process to fill an empty cache. */
    readonly listForEmptyCache: (
      appId: AppId,
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, AppsError>;
    readonly stopApp: (appId: AppId) => Effect.Effect<void>;
  }
>()("lecturn/apps/services/HeadlessToolHost") {}

export class LiveToolClient extends Context.Service<
  LiveToolClient,
  {
    readonly listTools: (
      lease: AppLease,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, AppsError>;
    readonly call: (
      lease: AppLease,
      request: AppToolCallRequest,
    ) => Effect.Effect<McpSchema.CallToolResult, AppsError>;
    readonly readResource: (
      lease: AppLease,
      uri: string,
    ) => Effect.Effect<McpSchema.ReadResourceResult, AppsError>;
  }
>()("lecturn/apps/services/LiveToolClient") {}

export class AppToolApprovalService extends Context.Service<
  AppToolApprovalService,
  {
    readonly request: (
      context: AppToolApprovalContext,
      info: ConnectedAppToolApprovalInfo,
    ) => Effect.Effect<AppToolApprovalAnswer, AppsError>;
  }
>()("lecturn/apps/services/AppToolApprovalService") {}

export class AppHostContextStore extends Context.Service<
  AppHostContextStore,
  {
    readonly set: (
      target: AppsUpdateHostContextInput["target"],
      text: string,
    ) => Effect.Effect<void, AppsError>;
    /** The thread entry comes before the project entry. */
    readonly forTurn: (
      threadId: ThreadId,
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("lecturn/apps/services/AppHostContextStore") {}

export class ThreadCopyService extends Context.Service<
  ThreadCopyService,
  {
    readonly export: (
      appId: AppId,
      projectIds: ReadonlyArray<ProjectId> | undefined,
    ) => Effect.Effect<ConnectedAppThreadBundleV1, AppsError>;
    readonly import: (
      appId: AppId,
      bundle: ConnectedAppThreadBundleV1,
    ) => Effect.Effect<AppsImportThreadsResult, AppsError>;
  }
>()("lecturn/apps/services/ThreadCopyService") {}
