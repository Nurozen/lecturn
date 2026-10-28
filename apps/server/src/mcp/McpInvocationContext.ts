import {
  type AppId,
  type AuthMcpClientAccess,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
  "app",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

/** Identity of the connected app whose project the calling thread belongs to. */
export interface McpAppCaller {
  readonly appId: AppId;
  readonly projectId: ProjectId;
}

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
}

/**
 * A read-only client never reaches a write (`McpToolAccess` refuses it first),
 * so it maps to the lowest mode rather than to nothing.
 */
export const clientRuntimeModeCeiling = (client: McpClientCaller | undefined): RuntimeMode =>
  client === undefined || client.access === "read-only" ? "approval-required" : client.access;

/**
 * A thread caller's omitted target falls back to its own thread; a client
 * caller has no own thread, so tools that act as the caller (delegate_task,
 * preview, worktree handoff) need `thread`.
 */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
  /** Set exactly when `capabilities` has "app"; a capability alone cannot say which app. */
  readonly app?: McpAppCaller | undefined;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("lecturn/mcp/McpInvocationContext") {}

export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

export const requireThreadMcpCapability = <const C extends "preview" | "device">(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities.has(capability) && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling Lecturn thread, so it needs an agent running inside Lecturn. This MCP client signed in from outside a thread.`,
  });

export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

export type McpAppInvocationScope = McpThreadInvocationScope & { readonly app: McpAppCaller };

export const appInvocationScope = (scope: McpInvocationScope): McpAppInvocationScope | undefined =>
  scope.capabilities.has("app") && scope.app !== undefined && scope.thread !== undefined
    ? (scope as McpAppInvocationScope)
    : undefined;

/**
 * An app thread's agent works for that app, so its credential reaches only the
 * app's own project; every other caller is unaffected.
 */
export const assertProjectReach = (
  scope: McpInvocationScope,
  projectId: ProjectId,
): Effect.Effect<void, OrchestratorMcpFailure> =>
  scope.app === undefined || scope.app.projectId === projectId
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "This thread belongs to a connected app, so it can reach only the app's own project.",
        }),
      );

/** For operations that reach beyond every single project, such as creating one. */
export const refuseAppCaller = (
  scope: McpInvocationScope,
  message: string,
): Effect.Effect<void, OrchestratorMcpFailure> =>
  scope.app === undefined
    ? Effect.void
    : Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message }));

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
