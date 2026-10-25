/**
 * Raises a connected-app tool approval inside the calling provider turn and
 * waits for the user's answer (D1).
 *
 * The request is an ordinary `permission` request with a `live` capability on
 * the calling session, so clients that predate connected apps still decode
 * and render it. `connectedAppTool` is what routes the answer back here
 * instead of to the adapter (`RuntimeRequestService`).
 */
import {
  AppsError,
  type ConnectedAppToolApprovalInfo,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalOption,
} from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import { AppToolApprovalRegistry } from "./AppToolApprovalRegistry.ts";
import {
  type AppToolApprovalContext,
  type AppToolApprovalOutcome,
  AppToolApprovalService,
} from "./services.ts";

// An app approval covers one call, so no option may widen it to the session.
const APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve" },
  { decision: "decline", label: "Decline" },
];

export const approvalPrompt = (info: ConnectedAppToolApprovalInfo) =>
  info.reason === null || info.reason.trim().length === 0
    ? `Approve ${info.toolName}`
    : `Approve ${info.toolName} · ${info.reason.trim()}`;

const CANCELLED: AppToolApprovalOutcome = "cancelled";

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
          if (raised === undefined) return CANCELLED;
          // Claimed before the commit, so an answer that races the write still finds its waiter.
          yield* registry.register(raised.requestId);
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
          if (!committed) return CANCELLED;
          return yield* registry.awaitDecision(raised.requestId);
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
