// @effect-diagnostics preferSchemaOverJson:off
/**
 * Test-only provider (R10b, D22): replays a JSON script per turn and makes
 * real MCP calls against the session Lecturn configured, so the app toolkit,
 * gating and `lecturn/context` run as they do for a model.
 */
import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@lecturn/provider-core/server/mcpSession";
import * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@lecturn/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@lecturn/provider-core/server/failure";
import { mcpToolPresentation } from "@lecturn/provider-core/server/mcpToolPresentation";
import { turnScopedSelectionTransition } from "@lecturn/provider-core/server/selectionTransition";
import { responsePayloads } from "@lecturn/shared/mcpResponsePayloads";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  jsonEquals,
  readPath,
  savedToolValue,
  type ScriptedScript,
  ScriptedScriptError,
  type ScriptedToolCall,
  type ScriptedToolResult,
  scriptFromFile,
  scriptFromMessage,
  substitute,
  toolResultText,
} from "./scriptedScript.ts";

export const SCRIPTED_PROVIDER = ProviderDriverKind.make("scripted");
export const SCRIPTED_PROVIDER_SCRIPTS_ENV = "LECTURN_SCRIPTED_PROVIDER_SCRIPTS";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_POLL_TRIES = 30;
const DEFAULT_POLL_INTERVAL_MS = 500;

export const ScriptedProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export class ScriptedMcpError extends Schema.TaggedError<ScriptedMcpError>()("ScriptedMcpError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Scripted provider MCP: ${this.detail}`;
  }
}

const isScriptedMcpError = Schema.is(ScriptedMcpError);
const isScriptedScriptError = Schema.is(ScriptedScriptError);

type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

interface McpConnection {
  readonly callTool: (
    name: string,
    args: unknown,
  ) => Effect.Effect<ScriptedToolResult, ScriptedMcpError>;
  readonly close: Effect.Effect<void>;
}

/** The `mcpOverAcpBridge.ts` JSON-RPC-over-HTTP pattern, for one client session. */
const openMcpConnection = Effect.fnUntraced(function* (
  config: McpProviderSessionConfig,
  fetchImplementation: FetchImplementation,
) {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;
  const mcpError = (cause: unknown) =>
    isScriptedMcpError(cause)
      ? cause
      : new ScriptedMcpError({ detail: cause instanceof Error ? cause.message : String(cause) });
  const headers = () => ({
    authorization: config.authorizationHeader,
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });
  const send = (message: Record<string, unknown>) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetchImplementation(config.endpoint, {
            method: "POST",
            signal,
            headers: {
              ...headers(),
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(message),
          }),
        catch: mcpError,
      });
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      if (!response.ok) {
        yield* Effect.promise(
          () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        );
        return yield* new ScriptedMcpError({
          detail: `${String(message.method)} got HTTP ${response.status}`,
        });
      }
      return [...(yield* Stream.runCollect(responsePayloads(response, mcpError)))];
    });
  const request = (method: string, params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const id = ++nextId;
      const payloads = yield* send({ jsonrpc: "2.0", id, method, params });
      const envelope = payloads.map(asRecord).find((payload) => payload?.id === id);
      if (envelope === undefined) {
        return yield* new ScriptedMcpError({ detail: `${method} got no matching response` });
      }
      if (envelope.error !== undefined) {
        const message = asRecord(envelope.error)?.message;
        return yield* new ScriptedMcpError({
          detail: `${method} failed: ${typeof message === "string" ? message : "error"}`,
        });
      }
      return asRecord(envelope.result) ?? {};
    });

  const initialized = yield* request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "lecturn-scripted-provider", version: "1" },
  });
  protocolVersion =
    typeof initialized.protocolVersion === "string"
      ? initialized.protocolVersion
      : MCP_PROTOCOL_VERSION;
  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    callTool: (name, args) =>
      request("tools/call", { name, arguments: args }).pipe(
        Effect.map((result) => result as ScriptedToolResult),
      ),
    close: Effect.suspend(() => {
      if (sessionId === null) return Effect.void;
      const init = { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(5_000) };
      return Effect.promise(() =>
        fetchImplementation(config.endpoint, init).then(
          (response) => response.body?.cancel().catch(() => undefined),
          () => undefined,
        ),
      );
    }),
  } satisfies McpConnection;
});

/** How often the stat fallback looks for a `hold.until` file. */
const HOLD_FALLBACK_INTERVAL = "500 millis";

/**
 * Succeeds once `file` exists. The directory watch gives the prompt signal;
 * the stat schedule covers a directory that does not exist yet and lost
 * watch events. Interrupting the wait closes both.
 */
export const waitForFile = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
    if (yield* exists) return;
    const watched = fileSystem.watch(path.dirname(file)).pipe(
      Stream.mapEffect(() => exists),
      Stream.filter((found) => found),
      Stream.take(1),
      Stream.runDrain,
      Effect.catch(() => Effect.never),
    );
    const polled = exists.pipe(
      Effect.repeat({ until: (found) => found, schedule: Schedule.spaced(HOLD_FALLBACK_INTERVAL) }),
    );
    yield* Effect.raceFirst(watched, polled);
  });

export interface ScriptedAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly fetchImplementation?: FetchImplementation;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  fiber?: Fiber.Fiber<void>;
  openTool: OrchestrationV2TurnItem | undefined;
  nextItem: number;
  finished: boolean;
}

const nativeRef = (nativeId: string) => ({
  driver: SCRIPTED_PROVIDER,
  nativeId,
  strength: "strong" as const,
});

export const makeScriptedAdapterV2 = Effect.fn("makeScriptedAdapterV2")(function* (
  options: ScriptedAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providerHost = yield* ProviderHost.ProviderHost;
  const protocolError = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({ driver: SCRIPTED_PROVIDER, detail });

  const loadScript = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    Effect.gen(function* () {
      const fromMessage = yield* Effect.try({
        try: () => scriptFromMessage(input.message.text),
        catch: scriptError,
      });
      if (fromMessage !== undefined) return fromMessage;
      const file = options.environment[SCRIPTED_PROVIDER_SCRIPTS_ENV];
      const fromFile =
        file === undefined || file.length === 0
          ? undefined
          : yield* fileSystem.readFileString(file).pipe(
              Effect.mapError(scriptError),
              Effect.flatMap((text) =>
                Effect.try({
                  try: () => scriptFromFile(text, input.runOrdinal),
                  catch: scriptError,
                }),
              ),
            );
      if (fromFile !== undefined) return fromFile;
      return yield* new ScriptedScriptError({
        detail: `turn ${input.runOrdinal} has no fenced scripted block and no ${SCRIPTED_PROVIDER_SCRIPTS_ENV} entry`,
      });
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: SCRIPTED_PROVIDER,
    getCapabilities: () => Effect.succeed(ScriptedProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("ScriptedAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const openedAt = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: SCRIPTED_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? providerHost.paths.cwd,
        model: input.modelSelection.model,
        capabilities: ScriptedProviderCapabilitiesV2,
        createdAt: openedAt,
        updatedAt: openedAt,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;

      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: SCRIPTED_PROVIDER,
          providerSession: session,
        });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (thread === undefined) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: SCRIPTED_PROVIDER,
          providerThread: thread,
        });
      });

      const baseItem = (turn: ActiveTurn, time: DateTime.Utc) => {
        const ordinal = turn.input.providerTurnOrdinal * 1000 + ++turn.nextItem;
        const identity = `${options.instanceId}:${turn.providerTurn.id}:${ordinal}`;
        return {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: SCRIPTED_PROVIDER,
            nativeItemId: identity,
          }),
          nodeId: idAllocator.derive.nodeFromProviderItem({
            driver: SCRIPTED_PROVIDER,
            nativeItemId: identity,
          }),
          identity,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: nativeRef(identity),
          parentItemId: null,
          ordinal,
          startedAt: time,
          updatedAt: time,
        };
      };
      const emitNode = (
        turn: ActiveTurn,
        item: OrchestrationV2TurnItem,
        kind: OrchestrationV2ExecutionNode["kind"],
      ) =>
        emit({
          type: "node.updated",
          driver: SCRIPTED_PROVIDER,
          node: {
            id: item.nodeId!,
            threadId: item.threadId,
            runId: item.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind,
            status: item.status,
            countsForRun: false,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: item.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: item.startedAt,
            completedAt: item.completedAt,
          },
        });

      const publishAssistantText = Effect.fnUntraced(function* (turn: ActiveTurn, text: string) {
        const time = yield* DateTime.now;
        const { identity, ...base } = baseItem(turn, time);
        const messageId = idAllocator.derive.messageFromProviderItem({
          driver: SCRIPTED_PROVIDER,
          nativeItemId: identity,
        });
        const message: OrchestrationV2ConversationMessage = {
          id: messageId,
          threadId: base.threadId,
          runId: base.runId,
          nodeId: base.nodeId,
          role: "assistant",
          text,
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: time,
          updatedAt: time,
        };
        const item: OrchestrationV2TurnItem = {
          ...base,
          type: "assistant_message",
          status: "completed",
          title: null,
          completedAt: time,
          messageId,
          text,
          streaming: false,
        };
        yield* emitNode(turn, item, "assistant_message");
        yield* emit({ type: "message.updated", driver: SCRIPTED_PROVIDER, message });
        yield* emit({ type: "turn_item.updated", driver: SCRIPTED_PROVIDER, turnItem: item });
      });

      const settleTool = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        item: OrchestrationV2TurnItem,
        status: OrchestrationV2TurnItemStatus,
        output?: unknown,
      ) {
        if (item.type !== "dynamic_tool") return;
        const time = yield* DateTime.now;
        const settled: OrchestrationV2TurnItem = {
          ...item,
          status,
          completedAt: time,
          updatedAt: time,
          ...(output === undefined ? {} : { output }),
        };
        turn.openTool = undefined;
        yield* emitNode(turn, settled, "tool_call");
        yield* emit({ type: "turn_item.updated", driver: SCRIPTED_PROVIDER, turnItem: settled });
      });

      /** One real `tools/call`, shown as a `lecturn.<tool>` row. */
      const callTool = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        mcp: McpConnection,
        call: ScriptedToolCall,
        saved: ReadonlyMap<string, unknown>,
      ) {
        const args = yield* Effect.try({
          try: () => substitute(call.arguments ?? {}, saved),
          catch: scriptError,
        });
        const time = yield* DateTime.now;
        const { identity: _identity, ...base } = baseItem(turn, time);
        const item: OrchestrationV2TurnItem = {
          ...base,
          title: null,
          ...mcpToolPresentation({ serverName: "lecturn", toolName: call.name }),
          type: "dynamic_tool",
          status: "running",
          completedAt: null,
          toolName: `lecturn.${call.name}`,
          input: args,
        };
        turn.openTool = item;
        yield* emitNode(turn, item, "tool_call");
        yield* emit({ type: "turn_item.updated", driver: SCRIPTED_PROVIDER, turnItem: item });
        const result = yield* mcp
          .callTool(call.name, args)
          .pipe(
            Effect.tapError((error) => settleTool(turn, item, "failed", { error: error.detail })),
          );
        yield* settleTool(turn, item, result.isError === true ? "failed" : "completed", result);
        return result;
      });

      const runScript = (turn: ActiveTurn, script: ScriptedScript) =>
        Effect.scoped(
          Effect.gen(function* () {
            const saved = new Map<string, unknown>();
            let connection: McpConnection | undefined;
            let expectApproval = false;
            const mcp = Effect.gen(function* () {
              if (connection !== undefined) return connection;
              const config = yield* mcpSessions.read(turn.input.threadId);
              if (config === undefined) {
                return yield* new ScriptedMcpError({
                  detail: "this session has no Lecturn MCP configuration",
                });
              }
              const opened = yield* openMcpConnection(config, fetchImplementation);
              yield* Effect.addFinalizer(() => opened.close);
              connection = opened;
              return opened;
            });
            // Lecturn's MCP gate raises approvals and holds the call open meanwhile, so the
            // provider never sees the card; `expectApproval` can only assert the outcome.
            const checkApproval = (call: ScriptedToolCall, result: ScriptedToolResult) => {
              const expected = expectApproval;
              expectApproval = false;
              return expected && result.isError === true
                ? Effect.fail(
                    new ScriptedScriptError({
                      detail: `expected ${call.name} to be approved, got: ${toolResultText(result)}`,
                    }),
                  )
                : Effect.void;
            };

            for (const step of script) {
              if ("assistantText" in step) {
                yield* publishAssistantText(turn, step.assistantText);
              } else if ("expectApproval" in step) {
                expectApproval = true;
              } else if ("hold" in step) {
                if (step.hold === true) return yield* Effect.never;
                yield* waitForFile(step.hold.until).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                );
              } else if ("toolCall" in step) {
                const result = yield* callTool(turn, yield* mcp, step.toolCall, saved);
                yield* checkApproval(step.toolCall, result);
                if (step.saveAs !== undefined) saved.set(step.saveAs, savedToolValue(result));
              } else {
                const { toolCall, until } = step.poll;
                const maxTries = step.poll.maxTries ?? DEFAULT_POLL_TRIES;
                const intervalMs = step.poll.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
                let value: unknown;
                for (let attempt = 1; ; attempt++) {
                  const result = yield* callTool(turn, yield* mcp, toolCall, saved);
                  yield* checkApproval(toolCall, result);
                  value = savedToolValue(result);
                  const found = readPath(value, until.path);
                  if (found.found && jsonEquals(found.value, until.equals)) break;
                  if (attempt >= maxTries) {
                    return yield* new ScriptedScriptError({
                      detail: `poll ${toolCall.name}: ${until.path} did not equal ${JSON.stringify(until.equals)} after ${maxTries} tries`,
                    });
                  }
                  if (intervalMs > 0) yield* Effect.sleep(intervalMs);
                }
                if (step.saveAs !== undefined) saved.set(step.saveAs, value);
              }
            }
          }),
        );

      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "interrupted" | "failed",
        detail?: string,
      ) {
        if (turn.finished) return;
        turn.finished = true;
        if (turn.openTool !== undefined) {
          yield* settleTool(turn, turn.openTool, status);
        }
        const completedAt = yield* DateTime.now;
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        yield* emit({
          type: "provider_turn.updated",
          driver: SCRIPTED_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({
          status: "idle",
          ...(status === "completed"
            ? { nativeConversationHeadRef: nativeRef(String(turn.providerTurn.id)) }
            : {}),
        });
        yield* updateSession("ready", status === "failed" ? (detail ?? null) : null);
        if (active === turn) active = undefined;
        if (status === "failed") {
          const failure = makeProviderFailure({
            class: "provider_error",
            message: detail ?? "The scripted turn failed.",
          });
          const { identity: _identity, ...base } = baseItem(turn, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: SCRIPTED_PROVIDER,
            turnItem: {
              ...base,
              type: "error",
              status: "failed",
              title: null,
              completedAt,
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: SCRIPTED_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure,
            failureItemOrdinal: base.ordinal,
            threadDisposition: "reusable",
          });
          return;
        }
        yield* emit({
          type: "turn.terminal",
          driver: SCRIPTED_PROVIDER,
          providerThreadId: turn.providerTurn.providerThreadId,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          status,
          failure: null,
          threadDisposition: "reusable",
        });
      });

      const attach = (args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) =>
        Effect.gen(function* () {
          const existing = args.existingProviderThread;
          if (
            existing !== undefined &&
            (existing.driver !== SCRIPTED_PROVIDER ||
              existing.providerInstanceId !== options.instanceId)
          ) {
            return yield* protocolError("The provider thread belongs to another instance");
          }
          if (thread !== undefined && thread.appThreadId === args.threadId) return thread;
          if (thread !== undefined) {
            return yield* protocolError("A scripted session holds one provider thread");
          }
          const now = yield* DateTime.now;
          const nativeThreadId = `${options.instanceId}:${args.threadId}`;
          thread =
            existing !== undefined
              ? {
                  ...existing,
                  providerSessionId: input.providerSessionId,
                  status: "idle",
                  updatedAt: now,
                }
              : {
                  id: idAllocator.derive.providerThread({
                    driver: SCRIPTED_PROVIDER,
                    providerInstanceId: options.instanceId,
                    nativeThreadId,
                  }),
                  driver: SCRIPTED_PROVIDER,
                  providerInstanceId: options.instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: args.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: nativeRef(nativeThreadId),
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                };
          yield* emit({
            type: "provider_thread.updated",
            driver: SCRIPTED_PROVIDER,
            providerThread: thread,
          });
          return thread;
        });

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        if (thread === undefined || turnInput.providerThread.id !== thread.id) {
          return yield* protocolError("The provider thread is not attached to this session");
        }
        if (active !== undefined) {
          return yield* protocolError("A scripted turn is already running");
        }
        const startedAt = yield* DateTime.now;
        const nativeTurnId = `${thread.id}:${turnInput.attemptId}`;
        const turn: ActiveTurn = {
          input: turnInput,
          providerTurn: {
            id: idAllocator.derive.providerTurn({ driver: SCRIPTED_PROVIDER, nativeTurnId }),
            providerThreadId: thread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: nativeRef(nativeTurnId),
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          },
          openTool: undefined,
          nextItem: 0,
          finished: false,
        };
        active = turn;
        thread = turnInput.providerThread;
        yield* emit({
          type: "provider_turn.updated",
          driver: SCRIPTED_PROVIDER,
          threadId: turnInput.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({
          status: "active",
          firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
          lastRunOrdinal: turnInput.runOrdinal,
        });
        yield* updateSession("running");
        // An interrupt that landed while the turn was being announced already ended it.
        if (turn.finished) return;
        turn.fiber = yield* loadScript(turnInput).pipe(
          Effect.flatMap((script) => runScript(turn, script)),
          Effect.matchCauseEffect({
            // Uninterruptible so an interrupt racing the last step cannot cut the terminal events short.
            onSuccess: () => Effect.uninterruptible(finish(turn, "completed")),
            onFailure: (cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.uninterruptible(
                    finish(turn, "failed", failureDetail(Cause.squash(cause))),
                  ),
          }),
          Effect.forkIn(scope),
        );
      });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const turn = active;
          if (turn?.fiber !== undefined) yield* Fiber.interrupt(turn.fiber);
          yield* Queue.end(events);
        }),
      );

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: SCRIPTED_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        backgroundTasksEndWithProcess: true,
        ensureThread: (args) =>
          attach(args).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: SCRIPTED_PROVIDER,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          attach({
            threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
            modelSelection: args.modelSelection ?? input.modelSelection,
            runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: args.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: SCRIPTED_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (args) =>
          start(args).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: SCRIPTED_PROVIDER,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: SCRIPTED_PROVIDER,
              providerThreadId: args.providerThread.id,
            }),
          ),
        interruptTurn: (args) =>
          Effect.gen(function* () {
            const turn = active;
            if (turn === undefined || turn.providerTurn.id !== args.providerTurnId) return;
            if (turn.fiber !== undefined) yield* Fiber.interrupt(turn.fiber);
            yield* finish(turn, "interrupted");
          }),
        respondToRuntimeRequest: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver: SCRIPTED_PROVIDER,
              requestId: args.requestId,
              cause: "The scripted provider raises no runtime requests.",
            }),
          ),
        readThreadSnapshot: (args) =>
          Effect.succeed({
            providerThread: args.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: SCRIPTED_PROVIDER,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "The scripted provider does not roll back.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: SCRIPTED_PROVIDER,
              providerThreadId: args.sourceProviderThread.id,
              cause: "The scripted provider does not fork.",
            }),
          ),
      };
      return runtime;
    }),
  });
});

function scriptError(cause: unknown): ScriptedScriptError {
  return isScriptedScriptError(cause)
    ? cause
    : new ScriptedScriptError({ detail: cause instanceof Error ? cause.message : String(cause) });
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
