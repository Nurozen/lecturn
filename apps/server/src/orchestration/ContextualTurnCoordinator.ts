import {
  ContextualError,
  ProviderInstanceId,
  type ContextualPacket,
  type ContextualPreparation,
  type ProviderContextualEvidence,
  type ContextualDeliveryReceipt,
} from "@lecturn/contracts";
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect";
import { ContextualService } from "../contextual/ContextualService.ts";
import { ContextualRepository } from "../contextual/ContextualRepository.ts";
import type { TaskSnapshotInput } from "../contextual/ContextualService.ts";
import { contextualPacketText } from "../contextual/ContextualPacketText.ts";
export { contextualPacketText } from "../contextual/ContextualPacketText.ts";
import { contextualEvidenceFits } from "../provider/ContextualDispatch.ts";
import { ContextualTurnQueue, type ContextualQueuedTurn } from "./ContextualTurnQueue.ts";

const encodePacket = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export type ContextualTurnDecision =
  | { readonly action: "hold" | "cancel" }
  | {
      readonly action: "send";
      readonly preparation: ContextualPreparation | null;
      readonly packet: ContextualPacket | null;
      readonly deadlineAt?: number;
    };

export function makeCoordinator(
  service: Pick<
    ContextualService["Service"],
    "taskSnapshot" | "prepare" | "revalidate" | "recover"
  >,
  repository: Pick<ContextualRepository["Service"], "get" | "update" | "receipt">,
  queue: Pick<ContextualTurnQueue["Service"], "setState">,
) {
  const prepare = Effect.fn("Contextual.prepareQueuedTurn")(function* (
    queued: ContextualQueuedTurn,
    input: TaskSnapshotInput,
  ): Effect.fn.Return<ContextualTurnDecision, never> {
    const deadlineAt = (yield* Clock.currentTimeMillis) + 60_000;
    return yield* Effect.gen(function* () {
      if (queued.state === "dispatching") return { action: "cancel" } as const;
      let preparation: ContextualPreparation;
      if (queued.preparationId) preparation = yield* repository.get(queued.preparationId);
      else {
        const task = yield* service.taskSnapshot(input);
        yield* queue.setState(input.threadId, queued.event.eventId, "preparing", null);
        preparation = yield* service.prepare(
          task,
          encodePacket({ eventId: queued.event.eventId, dispatchId: queued.dispatchId }),
        );
        yield* queue.setState(input.threadId, queued.event.eventId, "ready", preparation.id);
      }
      if (preparation.state === "awaiting-conflict-review") {
        yield* queue.setState(input.threadId, queued.event.eventId, "held", preparation.id);
        return { action: "hold" } as const;
      }
      if (["canceled", "dispatching", "delivered", "delivery-unknown"].includes(preparation.state))
        return { action: "cancel" } as const;
      if (preparation.state !== "prepared")
        return { action: "send", preparation, packet: null } as const;
      const current = yield* service.revalidate(preparation.id);
      return { action: "send", ...current } as const;
    }).pipe(
      Effect.map((decision) =>
        decision.action === "send" ? { ...decision, deadlineAt } : decision,
      ),
      Effect.timeout("60 seconds"),
      Effect.catch(() =>
        Effect.succeed(
          queued.state === "held"
            ? ({ action: "hold" } as const)
            : ({ action: "send", preparation: null, packet: null } as const),
        ),
      ),
    );
  });
  const begin = Effect.fn("Contextual.beginDispatch")(function* (
    queued: ContextualQueuedTurn,
    decision: Extract<ContextualTurnDecision, { action: "send" }>,
    providerContextId: string | null,
  ) {
    if (decision.preparation) {
      const latest = yield* repository.get(decision.preparation.id);
      if (
        [
          "canceled",
          "awaiting-conflict-review",
          "delivery-unknown",
          "delivered",
          "dispatching",
        ].includes(latest.state)
      )
        return yield* new ContextualError({
          code: "stale-revision",
          message: "This turn was canceled, held, or already dispatched.",
        });
    }
    let contextualEvidence: ProviderContextualEvidence | undefined;
    if (decision.packet && decision.preparation) {
      const remaining = Math.max(
        0,
        (decision.deadlineAt ?? (yield* Clock.currentTimeMillis) + 5_000) -
          (yield* Clock.currentTimeMillis),
      );
      const current = yield* service
        .revalidate(decision.preparation.id)
        .pipe(Effect.timeout(remaining), Effect.option);
      if (
        current._tag === "Some" &&
        [
          "canceled",
          "awaiting-conflict-review",
          "delivery-unknown",
          "delivered",
          "dispatching",
        ].includes(current.value.preparation.state)
      )
        return yield* new ContextualError({
          code: "stale-revision",
          message: "This turn was canceled, held, or already dispatched.",
        });
      if (
        current._tag === "Some" &&
        current.value.packet &&
        current.value.preparation.state === "prepared"
      ) {
        const p = current.value.preparation;
        const text = contextualPacketText(current.value.packet);
        if (contextualEvidenceFits(text)) {
          yield* repository.update(
            {
              ...p,
              state: "dispatching",
              dispatchId: queued.dispatchId,
              revision: p.revision + 1,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
            p.revision,
          );
          contextualEvidence = {
            preparationId: p.id,
            packetId: current.value.packet.id,
            dispatchId: queued.dispatchId,
            submissionId: p.task.submissionId,
            providerInstanceId: ProviderInstanceId.make(p.task.providerInstanceId),
            providerContextEpoch: p.task.providerContextEpoch,
            providerContextId,
            text,
            evidenceIds: [
              ...new Set(current.value.packet.groups.flatMap((g) => g.evidence.map((e) => e.id))),
            ],
          };
        }
      }
    }
    if (!contextualEvidence && decision.preparation) {
      const latest = yield* repository.get(decision.preparation.id).pipe(Effect.option);
      if (latest._tag === "Some" && latest.value.state === "prepared") {
        yield* repository.update(
          {
            ...latest.value,
            state: "skipped",
            skipReason: "unavailable",
            revision: latest.value.revision + 1,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          },
          latest.value.revision,
        );
      }
    }
    // Durable marker comes before every native dispatch, including a fail-open turn.
    yield* queue.setState(
      queued.event.payload.threadId,
      queued.event.eventId,
      "dispatching",
      decision.preparation?.id ?? null,
    );
    return contextualEvidence;
  });
  const observe = (receipt: ContextualDeliveryReceipt) =>
    repository.receipt(receipt).pipe(Effect.asVoid);
  return { prepare, begin, observe, recover: service.recover };
}
export const make = Effect.gen(function* () {
  return makeCoordinator(
    yield* ContextualService,
    yield* ContextualRepository,
    yield* ContextualTurnQueue,
  );
});
export class ContextualTurnCoordinator extends Context.Service<
  ContextualTurnCoordinator,
  Effect.Success<typeof make>
>()("lecturn/orchestration/ContextualTurnCoordinator") {}
export const layer = Layer.effect(ContextualTurnCoordinator, make);
