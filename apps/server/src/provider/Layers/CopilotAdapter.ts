/**
 * CopilotAdapterLive — GitHub Copilot CLI (`copilot --acp`) via ACP.
 *
 * Plan interaction maps to Copilot's `#plan` session mode and everything else to
 * `#agent`. Full access turns on Copilot's session-wide `allow_all` switch and
 * auto-approves any permission request that still arrives; other runtime modes
 * surface approvals to the user. In plan mode Copilot writes its plan to `plan.md`
 * in its session-state directory; the adapter surfaces that file as the proposed
 * plan and hides the write, which is outside the project.
 *
 * @module CopilotAdapterLive
 */
import * as NodeOS from "node:os";

import {
  ApprovalRequestId,
  EventId,
  type GithubCopilotSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@lecturn/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessEnvironment } from "@lecturn/shared/hostProcess";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { StaveMemoryWiring, noop as noopStaveMemoryWiring } from "../../stave/StaveMemoryWiring.ts";
import { prepareContextualDispatch } from "../ContextualDispatch.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { mapAcpToAdapterError, selectAcpPermissionOptionId } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  applyCopilotModelSelection,
  applyCopilotSessionConfiguration,
  copilotActionableErrorDetail,
  copilotSessionStateDir,
  isCopilotSessionStateEdit,
  makeCopilotAcpRuntime,
} from "../acp/CopilotAcpSupport.ts";
import { type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("githubCopilot");

// Exported so capability/presentation parity is testable without a runtime.
export const COPILOT_ADAPTER_CAPABILITIES = {
  sessionModelSwitch: "in-session",
  conversationFork: "unsupported",
  conversationForkRequiresAnchor: false,
} as const;
const COPILOT_RESUME_VERSION = 1 as const;
/** Bounds the post-cancel discard if a prompt never opens with `usage_update`. */
const CANCELLED_STREAM_GRACE = "1 second";

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface CopilotAdapterLiveOptions {
  readonly staveMemoryWiring?: StaveMemoryWiring["Service"];
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Selections are honored when `modelSelection.instanceId` matches this value. */
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface CopilotSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Model last sent with `session/set_model`. */
  currentModelId: string | undefined;
  /** Copilot's session-state directory for this ACP session (holds the plan-mode `plan.md`). */
  readonly sessionStateDir: string;
  /** Set when any prompt of the active turn ran in plan interaction mode. */
  planTurn: boolean;
  /** `plan.md` mtime and size when the plan turn started; a change means Copilot wrote a plan. */
  planFileStampAtTurnStart: string | undefined;
  /** Text of the latest assistant message segment, the proposed-plan fallback. */
  lastAssistantText: string;
  /** >0 means a turn is running, so a new sendTurn steers it and only the last prompt settles it. */
  promptsInFlight: number;
  /**
   * Set while the tail of a cancelled reply may still arrive. Copilot resolves a cancelled
   * prompt, then keeps streaming the reply it already generated, with no end marker. Updates are
   * dropped until the next prompt opens with `usage_update`, which Copilot sends before any of
   * that prompt's output; the deferred settles then.
   */
  cancelledStreamEnd: Deferred.Deferred<void> | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCopilotResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== COPILOT_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/** Maps ACP failures, rewriting Copilot sign-in and policy errors into actionable detail. */
function mapCopilotAcpError(
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  const mapped = mapAcpToAdapterError(PROVIDER, threadId, method, error);
  const detail = copilotActionableErrorDetail(error.message);
  return detail !== undefined && mapped._tag === "ProviderAdapterRequestError"
    ? new ProviderAdapterRequestError({ provider: PROVIDER, method, detail, cause: error })
    : mapped;
}

export function makeCopilotAdapter(
  copilotSettings: GithubCopilotSettings,
  options?: CopilotAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("githubCopilot");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();
    // Copilot resolves COPILOT_HOME from the environment it is spawned with.
    const copilotEnvironment = options?.environment ?? (yield* HostProcessEnvironment);

    const sessions = new Map<ThreadId, CopilotSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate GitHub Copilot runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process GitHub Copilot ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) =>
        Option.match(Option.fromNullishOr(current.get(threadId)), {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        }),
      );

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CopilotSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const planFilePath = (ctx: CopilotSessionContext) => path.join(ctx.sessionStateDir, "plan.md");

    /** mtime and size of the session's `plan.md`, or undefined when it does not exist. */
    const readPlanFileStamp = (ctx: CopilotSessionContext) =>
      fileSystem.stat(planFilePath(ctx)).pipe(
        Effect.map(
          (info) =>
            `${Option.getOrUndefined(Option.map(info.mtime, (mtime) => mtime.getTime()))}:${info.size}`,
        ),
        Effect.orElseSucceed(() => undefined),
      );

    /**
     * Surfaces a plan turn's plan: the `plan.md` Copilot wrote during the turn, or the
     * final assistant message when it wrote none.
     */
    const emitProposedPlan = (ctx: CopilotSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        const planStamp = yield* readPlanFileStamp(ctx);
        const planFile =
          planStamp !== undefined && planStamp !== ctx.planFileStampAtTurnStart
            ? yield* fileSystem
                .readFileString(planFilePath(ctx))
                .pipe(Effect.orElseSucceed(() => ""))
            : "";
        const planMarkdown = planFile.trim() || ctx.lastAssistantText.trim();
        if (!planMarkdown) {
          return;
        }
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { planMarkdown },
        });
      });

    const stopSessionInternal = (ctx: CopilotSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          if (input.fork !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Conversation fork is not supported by this provider.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx: CopilotSessionContext | undefined;

          const resumeSessionId = parseCopilotResume(input.resumeCursor)?.sessionId;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const memory = yield* (options?.staveMemoryWiring ?? noopStaveMemoryWiring).resolve(cwd);
          const mcpServers: Array<EffectAcpSchema.McpServer> = [];
          if (mcpSession) {
            mcpServers.push({
              type: "http",
              name: "lecturn",
              url: mcpSession.endpoint,
              headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
            });
          }
          if (memory.state === "configured") {
            mcpServers.push({
              name: "context-marmot",
              command: memory.config.command,
              args: memory.config.args,
              env: Object.entries(memory.config.env ?? {}).map(([name, value]) => ({
                name,
                value,
              })),
            });
          }
          const acp = yield* makeCopilotAcpRuntime({
            copilotSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            // Copilot answers session/cancel by resolving the prompt as cancelled.
            cancelBehavior: "wait-for-prompt",
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "lecturn", version: "0.0.0" },
            ...(mcpServers.length > 0 ? { mcpServers } : {}),
            ...makeAcpNativeLoggers({
              nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: copilotActionableErrorDetail(cause.message) ?? cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApproved =
                      selectAcpPermissionOptionId(params, "acceptForSession") ??
                      selectAcpPermissionOptionId(params, "accept");
                    if (autoApproved !== undefined) {
                      return {
                        outcome: { outcome: "selected" as const, optionId: autoApproved },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const optionId =
                    resolved === "cancel"
                      ? undefined
                      : selectAcpPermissionOptionId(params, resolved);
                  return {
                    outcome:
                      optionId === undefined
                        ? ({ outcome: "cancelled" } as const)
                        : { outcome: "selected" as const, optionId },
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) => mapCopilotAcpError(input.threadId, "session/start", error)),
          );

          const currentModelId = yield* applyCopilotModelSelection({
            runtime: acp,
            currentModelId: undefined,
            requestedModelId: modelSelection?.model,
            mapError: (cause) => mapCopilotAcpError(input.threadId, "session/set_model", cause),
          });
          yield* applyCopilotSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            mapError: ({ cause, method }) => mapCopilotAcpError(input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: { schemaVersion: COPILOT_RESUME_VERSION, sessionId: started.sessionId },
            createdAt: now,
            updatedAt: now,
          };

          const context: CopilotSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            currentModelId,
            sessionStateDir: copilotSessionStateDir(
              path,
              copilotEnvironment,
              NodeOS.homedir(),
              started.sessionId,
            ),
            planTurn: false,
            planFileStampAtTurnStart: undefined,
            lastAssistantText: "",
            promptsInFlight: 0,
            cancelledStreamEnd: undefined,
            stopped: false,
          };
          ctx = context;

          const emitEvent = (event: AcpSessionRuntime.AcpSessionRuntimeEvent) =>
            Effect.gen(function* () {
              if (event._tag === "EventStreamBarrier") {
                yield* Deferred.succeed(event.acknowledge, undefined);
                return;
              }
              if (event._tag === "UsageUpdated") {
                if (context.cancelledStreamEnd !== undefined && context.promptsInFlight > 0) {
                  yield* Deferred.succeed(context.cancelledStreamEnd, undefined);
                  context.cancelledStreamEnd = undefined;
                }
                return;
              }
              if (context.cancelledStreamEnd !== undefined) {
                return;
              }
              switch (event._tag) {
                case "AssistantItemStarted":
                case "AssistantItemCompleted":
                  if (event._tag === "AssistantItemStarted") {
                    context.lastAssistantText = "";
                  }
                  yield* offerRuntimeEvent(
                    makeAcpAssistantItemEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      itemId: event.itemId,
                      lifecycle:
                        event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                    }),
                  );
                  return;
                case "PlanUpdated": {
                  yield* logNative(context.threadId, "session/update", event.rawPayload);
                  const fingerprint = `${context.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(event.payload) ?? "[unserializable payload]"}`;
                  if (context.lastPlanFingerprint === fingerprint) {
                    return;
                  }
                  context.lastPlanFingerprint = fingerprint;
                  yield* offerRuntimeEvent(
                    makeAcpPlanUpdatedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      payload: event.payload,
                      source: "acp.jsonrpc",
                      method: "session/update",
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                }
                case "ToolCallUpdated":
                  yield* logNative(context.threadId, "session/update", event.rawPayload);
                  // Plan-mode plan.md writes are Copilot's own state, not project changes.
                  if (isCopilotSessionStateEdit(path, event.toolCall, context.sessionStateDir)) {
                    return;
                  }
                  yield* offerRuntimeEvent(
                    makeAcpToolCallEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ContentDelta":
                case "ThoughtDelta":
                  yield* logNative(context.threadId, "session/update", event.rawPayload);
                  if (event._tag === "ContentDelta") {
                    context.lastAssistantText += event.text;
                  }
                  yield* offerRuntimeEvent(
                    makeAcpContentDeltaEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      ...(event._tag === "ContentDelta" && event.itemId
                        ? { itemId: event.itemId }
                        : {}),
                      ...(event._tag === "ThoughtDelta"
                        ? { streamKind: "reasoning_text" as const }
                        : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                default:
                  return;
              }
            });

          context.notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), emitEvent),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process GitHub Copilot runtime notification.", { cause }),
            ),
            // The session scope owns the consumer; a child of startSession would die on return.
            Effect.forkIn(context.scope),
          );
          sessions.set(input.threadId, context);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "GitHub Copilot ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a prompt is in flight steers the running turn.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        // Count this prompt now so a superseded prompt resolving later does not settle
        // the turn; the matching decrement is the `ensuring` below.
        ctx.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          ctx.currentModelId = yield* applyCopilotModelSelection({
            runtime: ctx.acp,
            currentModelId: ctx.currentModelId,
            requestedModelId: model,
            mapError: (cause) => mapCopilotAcpError(input.threadId, "session/set_model", cause),
          });
          yield* applyCopilotSessionConfiguration({
            runtime: ctx.acp,
            runtimeMode: ctx.session.runtimeMode,
            interactionMode: input.interactionMode,
            mapError: ({ cause, method }) => mapCopilotAcpError(input.threadId, method, cause),
          });
          ctx.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
            ctx.planTurn = false;
            ctx.lastAssistantText = "";
          }
          if (input.interactionMode === "plan" && !ctx.planTurn) {
            ctx.planTurn = true;
            ctx.planFileStampAtTurnStart = yield* readPlanFileStamp(ctx);
          }
          ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };

          if (steeringTurnId === undefined) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: model ? { model } : {},
            });
          }

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          const rawPrompt = input.input?.trim() ?? "";
          if (rawPrompt) {
            promptParts.push({ type: "text", text: rawPrompt });
          }
          for (const attachment of input.attachments ?? []) {
            // Copilot ingests images. Generic files reach the agent through the
            // path line ProviderService puts in the prompt.
            if (attachment.type !== "image") {
              continue;
            }
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          const nativeSessionId = parseCopilotResume(ctx.session.resumeCursor)?.sessionId;
          const contextual = prepareContextualDispatch(
            input,
            steeringTurnId === undefined && ctx.promptsInFlight === 1 ? "fresh" : "steered",
            boundInstanceId,
            nativeSessionId,
          );
          yield* contextual.receipt("unknown", turnId, null);
          // ACP has no system-message field; keep runtime context separate from the user's text.
          const dispatched = yield* Deferred.make<void>();
          const promptFiber = yield* ctx.acp
            .prompt(
              {
                prompt: [
                  ...promptParts,
                  ...(contextual.text ? [{ type: "text" as const, text: contextual.text }] : []),
                  {
                    type: "text",
                    text: buildRuntimeInstructions({
                      harness: "GitHub Copilot",
                      model,
                    }),
                  },
                ],
              },
              { dispatched },
            )
            .pipe(
              Effect.mapError((error) =>
                mapCopilotAcpError(input.threadId, "session/prompt", error),
              ),
              Effect.forkChild({ startImmediately: true }),
            );
          yield* Effect.raceFirst(
            Deferred.await(dispatched),
            Fiber.join(promptFiber).pipe(Effect.asVoid),
          );
          const cancelledStreamEnd = ctx.cancelledStreamEnd;
          if (cancelledStreamEnd !== undefined) {
            yield* Deferred.await(cancelledStreamEnd).pipe(
              Effect.timeout(CANCELLED_STREAM_GRACE),
              Effect.ignore,
              Effect.andThen(
                Effect.sync(() => {
                  if (ctx.cancelledStreamEnd === cancelledStreamEnd) {
                    ctx.cancelledStreamEnd = undefined;
                  }
                }),
              ),
              Effect.forkIn(ctx.scope),
            );
          }
          if (input.onDispatch) yield* input.onDispatch;
          const result = yield* Fiber.join(promptFiber);

          const contextualReceipt = yield* contextual.receipt(
            result.stopReason === "cancelled" ? "unknown" : "accepted",
            turnId,
            result.stopReason === "cancelled"
              ? null
              : `acp:${nativeSessionId}:${input.contextualEvidence?.dispatchId ?? turnId}`,
            undefined,
            true,
          );
          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: promptParts, result });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            model,
          };

          // Only the last remaining prompt settles the turn.
          if (ctx.promptsInFlight === 1) {
            // Deliver every update Copilot sent before its prompt response ahead of the settle.
            yield* ctx.acp.drainEvents;
            if (result.stopReason === "cancelled") {
              ctx.cancelledStreamEnd = yield* Deferred.make<void>();
              // Let an update already past the check land before turn.completed.
              yield* ctx.acp.drainEvents;
            }
            if (ctx.planTurn && result.stopReason !== "cancelled") {
              yield* emitProposedPlan(ctx, turnId);
            }
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason ?? null,
              },
            });
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
            ...(contextualReceipt ? { contextualReceipt } : {}),
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(ctx.acp.cancel);
      });

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "user-input/respond",
          detail: `GitHub Copilot has no pending user-input request for thread ${threadId}.`,
        }),
      );

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal)));

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit GitHub Copilot session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: COPILOT_ADAPTER_CAPABILITIES,
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies CopilotAdapterShape;
  });
}
