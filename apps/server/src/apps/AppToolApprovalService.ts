/**
 * Raises a connected-app tool approval inside the calling provider turn and
 * waits for the user's answer (D1).
 *
 * The request is an ordinary `permission` request with a `live` capability on
 * the calling session, so clients that predate connected apps still decode
 * and render it. `connectedAppTool` is what routes the answer back here
 * instead of to the adapter (`RuntimeRequestService`).
 *
 * Every way a request can end is a committed `runtime-request.updated`: the
 * answer, an interrupt or Stop of the run (which cancels the run's pending
 * requests), and expiry. The call reads its outcome from that event, so it
 * ends exactly when the card does.
 */
import {
  AppsError,
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
import {
  type AppToolApprovalAnswer,
  type AppToolApprovalContext,
  type AppToolApprovalOutcome,
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
) => {
  switch (outcome) {
    case "declined":
      return `The user declined ${toolName} (approval declined).`;
    case "cancelled":
      return `${toolName} did not run (approval cancelled).`;
    case "expired":
      return `${toolName} did not run: nobody answered within 10 minutes (approval expired).`;
  }
};

export const approvalPrompt = (info: ConnectedAppToolApprovalInfo) =>
  info.reason === null || info.reason.trim().length === 0
    ? `Approve ${info.toolName}`
    : `Approve ${info.toolName} · ${info.reason.trim()}`;

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
   * The request records for the turn the calling session is running, or
   * undefined when that session holds no running turn on the thread. A gated
   * call outside one has nobody to show the request to.
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
      providerThread.providerSessionId !== context.providerSessionId ||
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
          const raised = yield* buildRequest(context, info).pipe(
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
            const outcome = yield* registry.awaitDecision(requestId);
            return { outcome, requestId } satisfies AppToolApprovalAnswer;
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
              return yield* restore(wait).pipe(
                Effect.onInterrupt(() => withdraw(context.threadId, requestId)),
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
