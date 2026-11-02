/**
 * The loop guards every bot-authored message passes (P19.7): the hop count
 * and the sender's message budgets (P9.1). Messages have no undo window, so
 * a budget is charged when the send commits and an exhausted one rejects.
 */
import {
  DEFAULT_SQUIRE_BUDGETS,
  SQUIRE_MAX_HOP,
  SquireBudgets,
  SquireEvent,
  type SquireRoomId,
  isUnknownUnionMember,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as SquireRepository from "./SquireRepository.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEvent));
const decodeBudgets = Schema.decodeUnknownOption(Schema.fromJsonString(SquireBudgets));

export const HOP_LIMIT_TEXT = `This would be hop ${SQUIRE_MAX_HOP + 1}, past the limit of ${SQUIRE_MAX_HOP}. Raise an item or answer the user instead.`;

/**
 * The hop a message sent during this turn carries: 1 plus the highest hop
 * among the message events of the turn's batch, 1 when there were none (a
 * user turn or a thread-event batch is hop 0).
 */
export function nextHop(batch: ReadonlyArray<SquireRepository.SquireEventRow>): number {
  let highest = 0;
  for (const row of batch) {
    if (row.kind !== "message") continue;
    const event = Option.getOrNull(decodeEvent(row.payload_json ?? ""));
    if (event !== null && !isUnknownUnionMember(event) && event.type === "message") {
      highest = Math.max(highest, event.hop);
    }
  }
  return highest + 1;
}

export const overHopLimit = (hop: number) => hop > SQUIRE_MAX_HOP;

export type MessageBudgetCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "budget";
      /** When the oldest counted send leaves the 24 h window. */
      readonly until: string;
      readonly text: string;
    };

/**
 * P9.1: `messagesPerDay` counts every `message` usage row of the sender; a
 * room post also counts against `roomPostsPerRoomPerDay` for that room
 * (per sender, per room). Rolling 24 h, like steers.
 */
export const checkMessageBudget = (
  repository: SquireRepository.SquireRepository["Service"],
  input: {
    readonly squire: Pick<SquireRepository.SquireRow, "id" | "budgets_json">;
    readonly now: string;
    readonly roomId?: SquireRoomId | null;
  },
) =>
  Effect.gen(function* () {
    const budgets = Option.getOrElse(
      decodeBudgets(input.squire.budgets_json),
      () => DEFAULT_SQUIRE_BUDGETS,
    );
    const now = DateTime.makeUnsafe(input.now);
    const since = DateTime.formatIso(DateTime.subtract(now, { milliseconds: DAY_MS }));
    const rows = (yield* repository.listBudgetUsage({ squireId: input.squire.id, since })).filter(
      (row) => row.kind === "message",
    );
    const exhausted = (
      counted: ReadonlyArray<SquireRepository.SquireBudgetUsageRow>,
      limit: number,
    ) => {
      if (counted.length < limit) return undefined;
      const oldest = counted
        .map((row) => row.executed_at)
        .toSorted()
        .at(Math.max(0, counted.length - limit));
      const until = DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(oldest ?? input.now), { milliseconds: DAY_MS }),
      );
      return {
        ok: false,
        reason: "budget",
        until,
        text: `message budget reached until ${until}`,
      } satisfies MessageBudgetCheck;
    };
    const daily = exhausted(rows, budgets.messagesPerDay);
    if (daily) return daily;
    if (input.roomId != null) {
      const room = exhausted(
        rows.filter((row) => row.room_id === input.roomId),
        budgets.roomPostsPerRoomPerDay,
      );
      if (room) return room;
    }
    return { ok: true } satisfies MessageBudgetCheck;
  });
