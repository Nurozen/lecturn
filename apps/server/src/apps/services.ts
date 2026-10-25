/**
 * Service tags for connected apps (plan interface I6). Each service has one
 * layer file and one owning step; `AppsLayer.ts` composes them. The tags live
 * together so a service's consumers never import another owner's layer file.
 *
 * Operations fail with `AppsError` (the wire error, whose `code` already
 * names the categories every transport shows) or `AppsNotImplemented` while a
 * service is still a stub. Transports map `AppsNotImplemented` once.
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
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { McpSchema } from "effect/ai";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { AppSubject } from "./subjects.ts";

export class AppsNotImplemented extends Schema.TaggedError<AppsNotImplemented>()(
  "AppsNotImplemented",
  { service: Schema.String, method: Schema.String },
) {
  override get message(): string {
    return `${this.service}.${this.method} is not implemented yet.`;
  }
}

export type AppsFailure = AppsError | AppsNotImplemented;

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

/** A `tools/call` from an MCP App card (A21), outside any provider turn. */
export interface AppCardToolCall {
  readonly appId: AppId;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
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
    ) => Effect.Effect<AppPairingRequestCreated, AppsFailure>;
    readonly pollPairingRequest: (input: {
      readonly requestId: AppPairingRequestId;
      readonly pollSecret: string;
    }) => Effect.Effect<AppPairingPoll, AppsFailure>;
    readonly decidePairing: (
      input: AppsDecidePairingInput,
    ) => Effect.Effect<AppStatus, AppsFailure>;
    readonly revoke: (appId: AppId) => Effect.Effect<AppStatus, AppsFailure>;
    readonly delete: (input: AppsDeleteInput) => Effect.Effect<void, AppsFailure>;
    readonly setRuntimeCeiling: (
      input: AppsSetRuntimeCeilingInput,
    ) => Effect.Effect<AppStatus, AppsFailure>;
    readonly list: Effect.Effect<ReadonlyArray<AppStatus>, AppsFailure>;
    readonly streamStatus: Stream.Stream<AppStatusStreamEvent, AppsFailure>;
    readonly get: (appId: AppId) => Effect.Effect<Option.Option<AppRecord>, AppsFailure>;
    readonly isGranted: (appId: AppId) => Effect.Effect<boolean, AppsFailure>;
    readonly cachedTools: (appId: AppId) => Effect.Effect<AppCachedTools, AppsFailure>;
    readonly setCachedTools: (
      appId: AppId,
      tier: AppToolTier,
      definitions: ReadonlyArray<McpSchema.Tool>,
    ) => Effect.Effect<void, AppsFailure>;
    readonly seedSidecarGrant: (envelope: AppSidecarBootstrap) => Effect.Effect<void, AppsFailure>;
    /** The app that owns `projectId`, for the embed banner; fails `not-found` for other projects. */
    readonly streamEmbedContext: (
      projectId: ProjectId,
    ) => Stream.Stream<AppEmbedContext, AppsFailure>;
  }
>()("lecturn/apps/services/AppRegistryService") {}

/** In-memory only: a lease dies with the server, and the app re-publishes it on its heartbeat. */
export class AppLeaseService extends Context.Service<
  AppLeaseService,
  {
    readonly set: (
      appId: AppId,
      input: AppLiveLeaseInput,
    ) => Effect.Effect<{ readonly expiresAt: IsoDateTime }, AppsFailure>;
    readonly clear: (appId: AppId) => Effect.Effect<void, AppsFailure>;
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
    ) => Effect.Effect<{ readonly projectId: ProjectId }, AppsFailure>;
    readonly resolveAppForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<AppBinding>, AppsFailure>;
    readonly listThreads: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ConnectedAppThreadSummary>, AppsFailure>;
    readonly streamThreads: (
      projectId: ProjectId,
    ) => Stream.Stream<ConnectedAppThreadsStreamEvent, AppsFailure>;
    readonly setThreadAppData: (
      appId: AppId,
      input: AppsSetThreadAppDataInput,
    ) => Effect.Effect<void, AppsFailure>;
    /** The subject decides who may set `appData` (D32), so it is passed, not inferred. */
    readonly createEmbedThread: (
      subject: AppSubject,
      input: AppsCreateEmbedThreadInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, AppsFailure>;
    readonly setEmbedDefaultModel: (
      subject: AppSubject,
      input: AppsSetEmbedDefaultModelInput,
    ) => Effect.Effect<void, AppsFailure>;
    readonly markThreadsCopied: (
      appId: AppId,
      input: AppsMarkThreadsCopiedInput,
    ) => Effect.Effect<void, AppsFailure>;
    /** Every project bound to the app, with its threads (`apps.delete` with `deleteThreads`). */
    readonly deleteAppProjects: (appId: AppId) => Effect.Effect<void, AppsFailure>;
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
    ) => Effect.Effect<void, EnvironmentAuthorizationError | AppsNotImplemented>;
    /** `None` drops the item. */
    readonly filterShellItem: (
      session: AuthenticatedSession,
      item: OrchestrationV2ShellStreamItem,
    ) => Effect.Effect<Option.Option<OrchestrationV2ShellStreamItem>>;
    readonly authorizeHttp: (
      session: AuthenticatedSession,
      path: string,
    ) => Effect.Effect<void, EnvironmentAuthorizationError | AppsNotImplemented>;
    readonly mintEmbedToken: (
      appId: AppId,
      input: AppsMintEmbedTokenInput,
    ) => Effect.Effect<AppEmbedTarget, AppsFailure>;
  }
>()("lecturn/apps/services/AppAuthorization") {}

export class AppToolkit extends Context.Service<
  AppToolkit,
  {
    readonly listFor: (
      scope: McpInvocationScope,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, AppsFailure>;
    /** `name` is prefixed, as the agent called it. */
    readonly call: (
      scope: McpInvocationScope,
      name: string,
      args: Readonly<Record<string, unknown>>,
      meta: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<McpSchema.CallToolResult, AppsFailure>;
    readonly readResource: (
      scope: McpInvocationScope,
      uri: string,
    ) => Effect.Effect<McpSchema.ReadResourceResult, AppsFailure>;
    readonly cardToolCall: (
      input: AppCardToolCall,
    ) => Effect.Effect<McpSchema.CallToolResult, AppsFailure>;
  }
>()("lecturn/apps/services/AppToolkit") {}

/** One ref-counted stdio process per (appId, projectId) (D5). */
export class HeadlessToolHost extends Context.Service<
  HeadlessToolHost,
  {
    /** Holds the process for the caller's scope. */
    readonly acquire: (
      appId: AppId,
      projectId: ProjectId,
    ) => Effect.Effect<void, AppsFailure, Scope.Scope>;
    readonly listTools: (
      appId: AppId,
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, AppsFailure>;
    readonly call: (
      appId: AppId,
      projectId: ProjectId,
      request: AppToolCallRequest,
    ) => Effect.Effect<McpSchema.CallToolResult, AppsFailure>;
    /** On the call-path process, for card documents and the resources cards read (A21). */
    readonly readResource: (
      appId: AppId,
      projectId: ProjectId,
      uri: string,
    ) => Effect.Effect<McpSchema.ReadResourceResult, AppsFailure>;
    /** Runs the registration's `listArgs`; never the call-path command. */
    readonly refreshDefinitions: (
      appId: AppId,
      projectId: ProjectId,
    ) => Effect.Effect<void, AppsFailure>;
    /** Acquires the call-path process to fill an empty cache (D5, decision 11). */
    readonly listForEmptyCache: (
      appId: AppId,
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, AppsFailure>;
    readonly stopApp: (appId: AppId) => Effect.Effect<void>;
  }
>()("lecturn/apps/services/HeadlessToolHost") {}

export class LiveToolClient extends Context.Service<
  LiveToolClient,
  {
    readonly listTools: (
      lease: AppLease,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, AppsFailure>;
    readonly call: (
      lease: AppLease,
      request: AppToolCallRequest,
    ) => Effect.Effect<McpSchema.CallToolResult, AppsFailure>;
    readonly readResource: (
      lease: AppLease,
      uri: string,
    ) => Effect.Effect<McpSchema.ReadResourceResult, AppsFailure>;
  }
>()("lecturn/apps/services/LiveToolClient") {}

export class AppToolApprovalService extends Context.Service<
  AppToolApprovalService,
  {
    readonly request: (
      context: AppToolApprovalContext,
      info: ConnectedAppToolApprovalInfo,
    ) => Effect.Effect<AppToolApprovalAnswer, AppsFailure>;
  }
>()("lecturn/apps/services/AppToolApprovalService") {}

export class AppHostContextStore extends Context.Service<
  AppHostContextStore,
  {
    readonly set: (
      target: AppsUpdateHostContextInput["target"],
      text: string,
    ) => Effect.Effect<void, AppsFailure>;
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
    ) => Effect.Effect<ConnectedAppThreadBundleV1, AppsFailure>;
    readonly import: (
      appId: AppId,
      bundle: ConnectedAppThreadBundleV1,
    ) => Effect.Effect<AppsImportThreadsResult, AppsFailure>;
  }
>()("lecturn/apps/services/ThreadCopyService") {}
