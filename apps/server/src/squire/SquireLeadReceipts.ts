/**
 * Routing receipts are derived on every read from stored rows, so a receipt follows each item's state without a
 * Lead turn and never drifts.
 * @module squire/SquireLeadReceipts
 */
import {
  type SquireError,
  type SquireLeadReceiptsInput,
  type SquireLeadReceiptsResult,
  type SquireRoutingReceipt,
  SquireId,
  SquireTaskId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { orSquireError } from "./SquireLifecycle.ts";
import * as SquireRepository from "./SquireRepository.ts";

const DEFAULT_LIMIT = 20;

const LogData = Schema.Struct({
  toSquireId: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});
const decodeData = Schema.decodeUnknownOption(Schema.fromJsonString(LogData));

const dataOf = (row: SquireRepository.SquireActionLogRow): typeof LogData.Type =>
  Option.getOrElse(decodeData(row.data_json), () => ({}));

/** Newest first; `nextBefore` pages to older receipts. */
export const list: (
  input: typeof SquireLeadReceiptsInput.Type,
) => Effect.Effect<
  typeof SquireLeadReceiptsResult.Type,
  SquireError,
  SquireRepository.SquireRepository
> = Effect.fn("SquireLeadReceipts.list")(function* (input) {
  const repository = yield* SquireRepository.SquireRepository;
  const lead = yield* repository.getLead;
  if (Option.isNone(lead)) return { receipts: [], nextBefore: null };
  const limit = input.limit ?? DEFAULT_LIMIT;
  const routed = yield* repository.listActionLogBefore({
    squireId: lead.value.id,
    kinds: ["task.routed"],
    ...(input.before === undefined ? {} : { before: input.before }),
    limit,
  });
  const taskIds = routed.flatMap((row) => (row.task_id === null ? [] : [row.task_id]));
  const cards = yield* repository.listCardsForTasks(taskIds);
  const quiet = yield* repository.listActionLogForTasks({
    taskIds,
    kinds: ["quiet.recorded"],
  });
  const wanted = new Set(taskIds);
  const events = (yield* repository.listEvents({
    statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
    kinds: ["routed-task"],
  })).filter((row) => wanted.has(row.state_key));

  const receipts = routed.flatMap((row): ReadonlyArray<SquireRoutingReceipt> => {
    const taskId = row.task_id;
    if (taskId === null) return [];
    const data = dataOf(row);
    const toSquireId = SquireId.make(data.toSquireId ?? "");
    const items = cards
      .filter((card) => card.routed_task_id === taskId)
      .map((card) => ({ cardId: card.id, kind: card.kind, status: card.status }));
    const quietRow = quiet.find(
      (entry) => entry.task_id === taskId && entry.squire_id === toSquireId,
    );
    const event = events.find(
      (entry) => entry.state_key === taskId && entry.squire_id === toSquireId,
    );
    // The task never reached a turn: the target was paused or deleted after routing.
    const rejected =
      items.length === 0 &&
      quietRow === undefined &&
      (event === undefined || event.status === "dropped");
    const status = items.length > 0 ? "acted" : quietRow ? "quiet" : rejected ? "rejected" : "sent";
    return [
      {
        taskId: SquireTaskId.make(taskId),
        toSquireId,
        text: data.text ?? "",
        status,
        quietReason: status === "quiet" && quietRow ? (dataOf(quietRow).reason ?? null) : null,
        items,
        createdAt: row.created_at,
      },
    ];
  });
  const last = routed.at(-1);
  return {
    receipts,
    nextBefore: routed.length === limit && last !== undefined ? last.created_at : null,
  };
}, orSquireError("list routing receipts"));
