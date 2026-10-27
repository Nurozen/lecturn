/**
 * Decides `runtime-request.app-expire` for the orchestrator: an unanswered
 * connected-app approval moves to `expired` and its card closes, under the
 * thread lock, so it cannot race the user's answer. A request that is no
 * longer pending is refused, which leaves whatever settled it in place.
 */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2InternalCommand,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";

type AppExpireCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "runtime-request.app-expire" }
>;

export const expire = <E>(
  command: AppExpireCommand,
  projections: Pick<ProjectionStoreV2Shape, "getRuntimeResponseContext">,
  emit: (event: Omit<OrchestrationV2DomainEvent, "id">) => Effect.Effect<unknown, E>,
) =>
  Effect.gen(function* () {
    const { request, node, item, session } = yield* projections.getRuntimeResponseContext(
      command.threadId,
      command.requestId,
    );
    if (request?.connectedAppTool === undefined) {
      return yield* Effect.fail(
        `Runtime request ${command.requestId} is not a connected-app approval.`,
      );
    }
    if (request.status !== "pending") {
      return yield* Effect.fail(`Runtime request ${command.requestId} is ${request.status}.`);
    }
    const now = yield* DateTime.now;
    const base = {
      threadId: command.threadId,
      ...(node?.runId == null ? {} : { runId: node.runId }),
      ...(session === undefined
        ? {}
        : { driver: session.driver, providerInstanceId: session.providerInstanceId }),
      occurredAt: now,
    };
    yield* emit({
      ...base,
      type: "runtime-request.updated",
      nodeId: request.nodeId,
      payload: { ...request, status: "expired", resolvedAt: now },
    });
    if (node !== undefined) {
      yield* emit({
        ...base,
        type: "node.updated",
        nodeId: node.id,
        payload: { ...node, status: "cancelled", completedAt: now },
      });
    }
    if (item !== undefined) {
      yield* emit({
        ...base,
        type: "turn-item.updated",
        ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
        payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
      });
    }
  });
