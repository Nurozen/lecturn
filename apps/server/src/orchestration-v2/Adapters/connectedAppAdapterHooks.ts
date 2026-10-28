/**
 * Lecturn Apps logic for the Codex and Claude adapters. Those files merge from
 * upstream, so they keep only the call sites listed in
 * `.github/upstream-integration/RESOLUTION_GUIDE.md` (Lecturn Apps).
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderDriverKind, ProviderThreadId, ThreadId } from "@lecturn/contracts";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as McpProviderSession from "@lecturn/provider-core/server/mcpSession";
import { connectedAppInstructionsSection } from "@lecturn/provider-core/server/orchestrationInstructions";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";

type McpSessions = McpProviderSessions.McpProviderSessions["Service"];
type McpSessionConfig = McpProviderSession.McpProviderSessionConfig;

interface McpActivationTarget {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
}

/** `text` followed by a connected app's registered instructions, when it has any. */
export function withConnectedAppInstructions<T extends string | undefined>(
  text: T,
  appInstructions: string | undefined,
): T | string {
  const section = connectedAppInstructionsSection(appInstructions);
  return section === undefined ? text : text === undefined ? section : `${text}\n\n${section}`;
}

/**
 * Lecturn's MCP server gates a connected app's tools by runtime mode, so
 * Codex's own MCP approval is turned off for those tools alone, on app threads
 * alone. A server-wide `default_tools_approval_mode` would also stop
 * Codex asking about Lecturn's own tools.
 */
export function codexAppToolApprovals(mcpSession: McpSessionConfig): {
  readonly tools?: Record<string, { readonly approval_mode: "approve" }>;
} {
  const names = mcpSession.app?.toolNames ?? [];
  return names.length === 0
    ? {}
    : { tools: Object.fromEntries(names.map((name) => [name, { approval_mode: "approve" }])) };
}

/**
 * One per Codex session. Codex starts a thread's MCP servers after
 * `thread/start` or resume answers, and reports a failure by native thread id,
 * possibly before this session knows which app thread that is.
 */
export function makeCodexMcpActivation(mcpSessions: McpSessions, driver: ProviderDriverKind) {
  const threadsByNativeId = new Map<string, McpActivationTarget>();
  const earlyStartupFailures = new Map<string, string>();
  const reportFailure = (target: McpActivationTarget, reason: string) =>
    mcpSessions.reportActivation({ type: "mcp-activation-failed", ...target, driver, reason });

  return {
    /** After `thread/start` or `thread/resume` answers for an app thread. */
    report: (input: {
      readonly nativeThreadId: string;
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly mcpSession: McpSessionConfig | undefined;
    }) =>
      Effect.gen(function* () {
        const target = { threadId: input.threadId, providerThreadId: input.providerThreadId };
        yield* McpProviderSessions.reportThreadMcpActivation({
          mcpSessions,
          ...target,
          driver,
          mcpActivated: input.mcpSession !== undefined,
        });
        // From here to the buffer read nothing yields, so a failure the
        // handler sees lands either in the buffer or on the mapped thread,
        // and always after the activation above.
        if (input.mcpSession !== undefined) {
          threadsByNativeId.set(input.nativeThreadId, target);
        } else {
          threadsByNativeId.delete(input.nativeThreadId);
        }
        const early = earlyStartupFailures.get(input.nativeThreadId);
        earlyStartupFailures.delete(input.nativeThreadId);
        if (early !== undefined && input.mcpSession !== undefined) {
          yield* reportFailure(target, early);
        }
      }),
    /** Handles `mcpServer/startupStatus/updated`. */
    onStartupStatus: (payload: CodexSchema.V2McpServerStatusUpdatedNotification) =>
      Effect.gen(function* () {
        if (payload.name !== "lecturn" || payload.status !== "failed") return;
        const nativeThreadId = payload.threadId;
        if (nativeThreadId === undefined || nativeThreadId === null) return;
        const reason = payload.error ?? "Codex could not start Lecturn's MCP server.";
        const target = threadsByNativeId.get(nativeThreadId);
        if (target === undefined) {
          // Codex's own subagent threads are never mapped; keep the buffer small.
          if (earlyStartupFailures.size < 64) {
            earlyStartupFailures.set(nativeThreadId, reason);
          }
          return;
        }
        yield* reportFailure(target, reason);
      }),
  };
}

/** Claude connects MCP servers per process and reports how it went in `init`. */
export function claudeLecturnMcpStartupFailure(message: SDKMessage): string | undefined {
  if (message.type !== "system" || message.subtype !== "init") return undefined;
  // An unlisted server is not evidence: older CLIs list only configured ones.
  const status = message.mcp_servers.find((server) => server.name === "lecturn")?.status;
  return status === "failed" || status === "needs-auth"
    ? `Claude reported Lecturn's MCP server as ${status}.`
    : undefined;
}

export function makeClaudeMcpActivation(mcpSessions: McpSessions, driver: ProviderDriverKind) {
  return {
    /**
     * After a provider thread is created or resumed. Each query's options carry
     * the thread's session as `mcpServers`, so the session decides; a failed
     * connect shows up later in `init`.
     */
    report: (threadId: ThreadId, providerThreadId: ProviderThreadId) =>
      mcpSessions.read(threadId).pipe(
        Effect.flatMap((session) =>
          McpProviderSessions.reportThreadMcpActivation({
            mcpSessions,
            threadId,
            providerThreadId,
            driver,
            mcpActivated: session !== undefined,
          }),
        ),
      ),
    /** Before each SDK message of a query opened with `mcpSession`. */
    onMessage: (
      turn: {
        readonly threadId: ThreadId;
        readonly providerThread: { readonly id: ProviderThreadId };
      },
      mcpSession: McpSessionConfig | undefined,
      message: SDKMessage,
    ) => {
      const reason = mcpSession === undefined ? undefined : claudeLecturnMcpStartupFailure(message);
      return reason === undefined
        ? Effect.void
        : mcpSessions.reportActivation({
            type: "mcp-activation-failed",
            threadId: turn.threadId,
            providerThreadId: turn.providerThread.id,
            driver,
            reason,
          });
    },
  };
}
