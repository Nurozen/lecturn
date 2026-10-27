/**
 * Raises a connected-app tool approval inside the calling provider turn and
 * waits for the user's answer.
 *
 * The request is an ordinary `permission` request with a `live` capability on
 * the calling session, so clients that predate connected apps still decode
 * and render it. `connectedAppTool` is what routes the answer back here
 * instead of to the adapter (`RuntimeRequestService`).
 *
 * Every way a request can end is a committed `runtime-request.updated`: the
 * answer, an interrupt or Stop of the run (which cancels the run's pending
 * requests), expiry, the app being revoked or removed, and its ceiling being
 * lowered to one that refuses the call. The call reads its outcome from that
 * event, so it ends exactly when the card does.
 */
import {
  type AppId,
  AppsError,
  type AppStatus,
  CommandId,
  type ConnectedAppToolApprovalInfo,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalOption,
  type RuntimeRequestId,
  type ThreadId,
} from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import { appToolApprovalLabel, appToolTitle } from "@lecturn/shared/appToolPresentation";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import { AppToolApprovalRegistry, outcomeFromDecision } from "./AppToolApprovalRegistry.ts";
import { ceilingRefusesApprovals } from "./AppToolGate.ts";
import {
  type AppToolApprovalAnswer,
  type AppToolApprovalContext,
  type AppToolApprovalOutcome,
  AppRegistryService,
  AppToolApprovalService,
} from "./services.ts";

// An app approval covers one call, so no option may widen it to the session.
// Clients draw the buttons in this order.
const APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
  { decision: "cancel", label: "Cancel" },
];

export const APPROVAL_TTL = Duration.minutes(10);

/** What the waiting call returns once its request leaves `pending`. */
export const outcomeFromRequest = (
  request: Pick<OrchestrationV2RuntimeRequest, "status" | "decision">,
): AppToolApprovalOutcome | undefined => {
  switch (request.status) {
    case "pending":
      return undefined;
    case "resolved":
      return outcomeFromDecision(request.decision);
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
  }
};

/** The tool error the agent sees for a call that did not get its approval. */
export const refusalMessage = (
  toolName: string,
  outcome: Exclude<AppToolApprovalOutcome, "approved">,
  reason?: string,
) => {
  switch (outcome) {
    case "declined":
      return `The user declined ${toolName} (approval declined).`;
    case "cancelled":
      return reason === undefined
        ? `${toolName} did not run (approval cancelled).`
        : `${toolName} did not run: ${reason} (approval cancelled).`;
    case "expired":
      return `${toolName} did not run: nobody answered within 10 minutes (approval expired).`;
  }
};

export const approvalPrompt = (info: ConnectedAppToolApprovalInfo) =>
  info.reason === null || info.reason.trim().length === 0
    ? appToolApprovalLabel(info)
    : `${appToolApprovalLabel(info)} · ${info.reason.trim()}`;

const NOT_RAISED: AppToolApprovalAnswer = { outcome: "cancelled", requestId: null };

const unavailable = (message: string) => (cause: unknown) =>
  new AppsError({
    code: "unavailable",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const registry = yield* AppToolApprovalRegistry;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const apps = yield* AppRegistryService;

  // Calls waiting on an answer in this process, so a revoke can end them. A
  // request without a waiter is never left pending: the call withdraws it
  // when interrupted, and runtime recovery settles runs after a restart.
  const waiting = new Map<
    RuntimeRequestId,
    { readonly threadId: ThreadId; readonly appId: AppId; readonly appName: string }
  >();
  const cancelReasons = new Map<RuntimeRequestId, string>();

  /** Takes down every card of an app the user shut out; other approvals are not in `waiting`. */
  const cancelForApp = (appId: AppId, reason: (appName: string) => string) =>
    Effect.forEach(
      [...waiting].filter(
        ([requestId, entry]) => entry.appId === appId && !cancelReasons.has(requestId),
      ),
      ([requestId, entry]) => {
        cancelReasons.set(requestId, reason(entry.appName));
        // The ordinary answer path, so every client clears the card from the event.
        return orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`apps:approval-revoked:${requestId}`),
            threadId: entry.threadId,
            requestId,
            decision: "cancel",
          })
          .pipe(
            // Answered meanwhile, or its thread is gone: the call still must not wait on.
            Effect.catch(() => registry.resolve(requestId, "cancelled")),
            Effect.asVoid,
          );
      },
      { discard: true },
    );

  const revokedReason = (appName: string) => `${appName} was revoked`;
  const removedReason = (appName: string) => `${appName} was removed`;
  const limitedReason = (appName: string) => `${appName} was limited to Read-only`;

  // Every waiting call is gated, so a ceiling that refuses gated calls refuses them all.
  const shutOutReason = (status: Pick<AppStatus, "state" | "runtimeCeiling">) =>
    status.state === "revoked"
      ? revokedReason
      : ceilingRefusesApprovals(status.runtimeCeiling)
        ? limitedReason
        : undefined;

  const cancelIfStatusShutsOut = (status: AppStatus) => {
    const reason = shutOutReason(status);
    return reason === undefined ? Effect.void : cancelForApp(status.appId, reason);
  };

  // The registry sits below this service, so revoke, delete and ceiling
  // changes arrive as status changes.
  yield* apps.streamStatus.pipe(
    Stream.runForEach((event) => {
      switch (event.type) {
        case "snapshot":
          return Effect.forEach(event.apps, cancelIfStatusShutsOut, { discard: true });
        case "upsert":
          return cancelIfStatusShutsOut(event.app);
        case "remove":
          return cancelForApp(event.appId, removedReason);
      }
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("App tool approvals no longer follow app status", { cause }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  // A revoke or lowered ceiling that landed between the caller's gate and the
  // commit published its status before this request was waiting.
  const cancelIfShutOut = (appId: AppId) =>
    apps.get(appId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => cancelForApp(appId, removedReason),
          onSome: ({ status }) => cancelIfStatusShutsOut(status),
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not re-check the app behind an approval", { appId, cause }),
      ),
    );

  /**
   * Names the tool by its declared title on every client, read from the
   * definitions the toolkit lists (headless first, as there). A title that
   * cannot be read leaves the request on the tool's name.
   */
  const withToolTitle = (info: ConnectedAppToolApprovalInfo) =>
    Effect.gen(function* () {
      if (info.toolTitle !== undefined) return info;
      const found = yield* apps.get(info.appId);
      if (Option.isNone(found)) return info;
      const { registration } = found.value;
      const prefix = `${registration.toolPrefix}_`;
      if (!info.toolName.startsWith(prefix)) return info;
      const bare = info.toolName.slice(prefix.length);
      const cached = yield* apps.cachedTools(info.appId);
      const tool = [
        ...Option.getOrElse(cached.headless, () => []),
        ...(registration.liveTools ? Option.getOrElse(cached.live, () => []) : []),
      ].find((definition) => definition.name === bare);
      const toolTitle = tool === undefined ? undefined : appToolTitle(tool);
      return toolTitle === undefined ? info : { ...info, toolTitle };
    }).pipe(Effect.orElseSucceed(() => info));

  const settleFromEvents = (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    afterSequence: number,
  ) =>
    eventSink.stream({ threadId, afterSequence, eventType: "runtime-request.updated" }).pipe(
      Stream.map((stored) =>
        stored.event.type === "runtime-request.updated" && stored.event.payload.id === requestId
          ? outcomeFromRequest(stored.event.payload)
          : undefined,
      ),
      Stream.filter((outcome) => outcome !== undefined),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (outcome) => registry.resolve(requestId, outcome),
        }),
      ),
      // The answer still arrives through RuntimeRequestService, and expiry still fires.
      Effect.catch((cause) =>
        Effect.logWarning("Stopped following an app tool approval", { requestId, cause }),
      ),
    );

  const expireAfterTtl = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    Effect.gen(function* () {
      yield* Effect.sleep(APPROVAL_TTL);
      const expired = yield* orchestrator
        .dispatch({
          type: "runtime-request.app-expire",
          commandId: CommandId.make(`apps:approval-expire:${requestId}`),
          threadId,
          requestId,
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      // Refused when the request already ended; that end is the outcome.
      const ended = expired
        ? "expired"
        : yield* projections.getRuntimeRequest(threadId, requestId).pipe(
            Effect.map((request) =>
              request === undefined ? undefined : outcomeFromRequest(request),
            ),
            Effect.orElseSucceed(() => undefined),
          );
      yield* registry.resolve(requestId, ended ?? "expired");
    });

  // The agent gave up on the call (or the server is stopping); nobody acts on an answer now.
  const withdraw = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    orchestrator
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`apps:approval-withdraw:${requestId}`),
        threadId,
        requestId,
        decision: "cancel",
      })
      .pipe(Effect.ignore);

  /**
   * The request records for the thread's running turn, or undefined when the
   * thread has none. A gated call outside one has nobody to show the request
   * to. The caller's session id is not compared with the turn's: a toolkit
   * call carries its MCP credential's id, which is per thread and outlives
   * provider sessions, so it never equals the provider session id.
   */
  const buildRequest = Effect.fnUntraced(function* (
    context: AppToolApprovalContext,
    info: ConnectedAppToolApprovalInfo,
  ) {
    const { run, providerThread, providerTurn } = yield* projections.getRunningTurnContext(
      context.threadId,
    );
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.activeAttemptId === null ||
      providerThread === undefined ||
      providerThread.providerSessionId === null ||
      providerTurn === undefined
    ) {
      return undefined;
    }
    const providerSessionId = providerThread.providerSessionId;
    const createdAt = yield* DateTime.now;
    const requestId = yield* idAllocator.allocate.runtimeRequest({
      driver: providerThread.driver,
      providerTurnId: providerTurn.id,
    });
    const nodeId = idAllocator.derive.approvalNode({ requestId });
    const ordinal = yield* projections.getNextTurnItemOrdinal(context.threadId);

    // A child of the run's root node: interrupting or settling the run cancels it with the run.
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: context.threadId,
      runId: run.id,
      parentNodeId: run.rootNodeId,
      rootNodeId: run.rootNodeId,
      kind: "approval_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: providerThread.id,
      providerTurnId: providerTurn.id,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: null,
    };
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: providerTurn.id,
      nativeRequestRef: null,
      kind: "permission",
      status: "pending",
      responseCapability: { type: "live", providerSessionId },
      createdAt,
      resolvedAt: null,
      connectedAppTool: info,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: context.threadId,
      runId: run.id,
      nodeId,
      providerThreadId: providerThread.id,
      providerTurnId: providerTurn.id,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "waiting",
      title: null,
      startedAt: createdAt,
      completedAt: null,
      updatedAt: createdAt,
      type: "approval_request",
      requestId,
      requestKind: "permission",
      appName: info.appName,
      prompt: approvalPrompt(info),
      options: [...APPROVAL_OPTIONS],
    };
    const event = Effect.fnUntraced(function* (
      fields: Pick<OrchestrationV2DomainEvent, "type" | "payload">,
    ) {
      return {
        ...fields,
        id: yield* idAllocator.allocate.event({
          threadId: context.threadId,
          providerSessionId,
        }),
        threadId: context.threadId,
        runId: run.id,
        nodeId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: createdAt,
      } as OrchestrationV2DomainEvent;
    });
    return {
      requestId,
      runId: run.id,
      activeAttemptId: run.activeAttemptId,
      events: [
        yield* event({ type: "node.updated", payload: node }),
        yield* event({ type: "runtime-request.updated", payload: request }),
        yield* event({ type: "turn-item.updated", payload: turnItem }),
      ],
    };
  });

  return AppToolApprovalService.of({
    request: (context, info) =>
      Effect.scoped(
        Effect.gen(function* () {
          const shown = yield* withToolTitle(info);
          const raised = yield* buildRequest(context, shown).pipe(
            Effect.mapError(unavailable("Could not prepare the app tool approval")),
          );
          if (raised === undefined) return NOT_RAISED;
          const { requestId } = raised;
          // Claimed before the commit, so an answer that races the write still finds its waiter.
          yield* registry.register(requestId);
          const afterSequence = yield* eventSink
            .latestSequence({ threadId: context.threadId })
            .pipe(Effect.mapError(unavailable("Could not raise the app tool approval")));
          const wait = Effect.gen(function* () {
            yield* Effect.forkScoped(settleFromEvents(context.threadId, requestId, afterSequence));
            yield* Effect.forkScoped(expireAfterTtl(context.threadId, requestId));
            yield* cancelIfShutOut(info.appId);
            const outcome = yield* registry.awaitDecision(requestId);
            const reason = outcome === "cancelled" ? cancelReasons.get(requestId) : undefined;
            return (
              reason === undefined ? { outcome, requestId } : { outcome, requestId, reason }
            ) satisfies AppToolApprovalAnswer;
          });
          // From the commit on, a call that stops waiting has a card to take down.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const { committed } = yield* eventSink
                .writeIfRunCurrent({
                  threadId: context.threadId,
                  runId: raised.runId,
                  activeAttemptId: raised.activeAttemptId,
                  expectedStatus: "running",
                  events: raised.events,
                })
                .pipe(Effect.mapError(unavailable("Could not raise the app tool approval")));
              // The run settled between the read and the write; nobody can answer the request now.
              if (!committed) return NOT_RAISED;
              waiting.set(requestId, {
                threadId: context.threadId,
                appId: info.appId,
                appName: info.appName,
              });
              return yield* restore(wait).pipe(
                Effect.onInterrupt(() => withdraw(context.threadId, requestId)),
                Effect.ensuring(
                  Effect.sync(() => {
                    waiting.delete(requestId);
                    cancelReasons.delete(requestId);
                  }),
                ),
              );
            }),
          );
        }),
      ),
  });
});

// The runtime's own EventSink layer value: memoized, so writes publish to the same live subscribers.
export const layer = Layer.effect(AppToolApprovalService, make).pipe(
  Layer.provide(
    Layer.mergeAll(RuntimeLayer.layerEventSink, ProjectionStore.layer, IdAllocator.layer),
  ),
);
