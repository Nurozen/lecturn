/**
 * The loop guards every bot-authored message passes: the hop count
 * and the sender's message budgets. Messages have no undo window, so
 * a budget is charged when the send commits and an exhausted one rejects.
 */
import {
  DEFAULT_SQUIRE_BUDGETS,
  SQUIRE_MAX_HOP,
  SquireBudgets,
  SquireEvent,
  type SquireId,
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
 * among the bot-authored input the turn was shown (its batch's message
 * events, plus `shownHops` for room posts in its context or read mid-turn),
 * 1 when there was none (a user turn or a thread-event batch is hop 0).
 */
export function nextHop(
  batch: ReadonlyArray<SquireRepository.SquireEventRow>,
  shownHops: ReadonlyArray<number> = [],
): number {
  let highest = Math.max(0, ...shownHops);
  for (const row of batch) {
    if (row.kind !== "message") continue;
    const event = Option.getOrNull(decodeEvent(row.payload_json ?? ""));
    if (event !== null && !isUnknownUnionMember(event) && event.type === "message") {
      highest = Math.max(highest, event.hop);
    }
  }
  return highest + 1;
}

// ── Squire-written text ──
//
// Text a Squire wrote never drives Auto or a rule, directly or through the
// Lead. The Lead's words count as the user's only when a user started the
// Lead turn that wrote them: its plain message, or a room post of the user's.
const USER_STARTED_ORIGINS: ReadonlySet<string> = new Set(["user", "room"]);

const ToolCallData = Schema.Struct({
  tool: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.Struct({
      structuredContent: Schema.optional(
        Schema.Struct({
          squireText: Schema.optional(Schema.Boolean),
          botPostHop: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
});
const decodeToolCallData = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCallData));

/**
 * Whether the Lead message or post written under `messageKey` (the sending
 * call's invocation key) came from a Lead turn the user started; anything
 * unreadable is Squire text.
 */
export const sentInUserStartedTurn = (
  repository: SquireRepository.SquireRepository["Service"],
  messageKey: string,
) =>
  repository.getToolCall(messageKey).pipe(
    Effect.map((row) => {
      if (Option.isNone(row)) return false;
      const origin = Option.getOrNull(decodeToolCallData(row.value.data_json))?.origin;
      return origin !== undefined && USER_STARTED_ORIGINS.has(origin);
    }),
  );

/** The message keys of the batch's Lead messages that a user-started Lead turn sent. */
export const userStartedLeadKeys = Effect.fn("squireMessageGuards.userStartedLeadKeys")(function* (
  repository: SquireRepository.SquireRepository["Service"],
  rows: ReadonlyArray<SquireRepository.SquireEventRow>,
) {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "message") continue;
    const event = Option.getOrNull(decodeEvent(row.payload_json ?? ""));
    if (event === null || isUnknownUnionMember(event) || event.type !== "message") continue;
    if (event.from.kind !== "lead") continue;
    if (yield* sentInUserStartedTurn(repository, event.messageKey)) keys.add(event.messageKey);
  }
  return keys as ReadonlySet<string>;
});

/** The `squire_read_room` result fields that record what the read showed. */
export const roomReadMarks = (input: {
  readonly squireText: boolean;
  readonly botPostHop: number | null;
}) => ({
  ...(input.squireText ? { squireText: true } : {}),
  ...(input.botPostHop === null ? {} : { botPostHop: input.botPostHop }),
});

/**
 * What the run's `squire_read_room` calls showed: whether another Squire's
 * words reached the model (the run then only recommends), and the highest
 * hop among other bots' posts.
 */
export const readSquireText = (
  repository: SquireRepository.SquireRepository["Service"],
  input: { readonly squireId: SquireId; readonly runId: string },
) =>
  repository
    .listActionLogForRuns({
      squireId: input.squireId,
      kinds: ["tool.called"],
      runIds: [input.runId],
    })
    .pipe(
      Effect.map((rows) => {
        let tainted = false;
        const hops: Array<number> = [];
        for (const row of rows) {
          const data = Option.getOrNull(decodeToolCallData(row.data_json));
          if (data?.tool !== "squire_read_room") continue;
          const marks = data.result?.structuredContent;
          if (marks?.squireText === true) tainted = true;
          if (marks?.botPostHop !== undefined) hops.push(marks.botPostHop);
        }
        return { tainted, hops };
      }),
    );

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
 * `messagesPerDay` counts every `message` usage row of the sender; a
 * room post also counts against `roomPostsPerRoomPerDay` for that room
 * (per sender, per room). Rolling 24 h, like steers.
 */
export const checkMessageBudget = Effect.fn("squireMessageGuards.checkMessageBudget")(function* (
  repository: SquireRepository.SquireRepository["Service"],
  input: {
    readonly squire: Pick<SquireRepository.SquireRow, "id" | "budgets_json">;
    readonly now: string;
    readonly roomId?: SquireRoomId | null;
  },
) {
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
