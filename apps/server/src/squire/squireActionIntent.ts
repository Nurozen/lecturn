/**
 * What a held or accepted card will do, stored immutably per attempt in
 * `squire_card.intent_json`, and the command ids that name its
 * receipts, and the trigger precondition the command hook re-checks.
 *
 * @module squire/squireActionIntent
 */
import {
  MessageId,
  type OrchestrationV2ThreadShell,
  RunId,
  SquireCardId,
  SquireCreateInput,
  SquireGrantInput,
  SquireGrantKind,
  SquireId,
  SquireRef,
  SquireStatus,
  SquireSteerKind,
  ThreadId,
  TrimmedNonEmptyString,
} from "@lecturn/contracts";
import { threadPullRequestKeyOf } from "@lecturn/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SquireLaunchIntent } from "./SquireLaunchAction.ts";

/**
 * What the target looked like when the intent was written. The command hook
 * refuses the dispatch when a user message or a newer trigger appeared since.
 */
export const SquireActionPrecondition = Schema.Struct({
  latestRunId: Schema.optionalKey(RunId),
  lastUserMessageId: Schema.optionalKey(MessageId),
  prKey: Schema.optionalKey(Schema.String),
  headSha: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
});
export type SquireActionPrecondition = typeof SquireActionPrecondition.Type;

export const SquireSteerIntent = Schema.Struct({
  type: Schema.Literal("steer"),
  threadId: ThreadId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  steerKind: SquireSteerKind,
  /** `auto` only where the target's driver supports active steering. */
  dispatchMode: Schema.Literals(["auto", "queue"]),
  precondition: SquireActionPrecondition,
});
export type SquireSteerIntent = typeof SquireSteerIntent.Type;

export const SquireThreadCreateIntent = Schema.Struct({
  type: Schema.Literal("thread-create"),
  // Suspended: SquireLaunchAction imports this module's command ids, so the
  // schema is read lazily whichever module loads first.
  launch: Schema.suspend(() => SquireLaunchIntent),
  precondition: SquireActionPrecondition,
});
export type SquireThreadCreateIntent = typeof SquireThreadCreateIntent.Type;

export const SquireControlAction = Schema.Literals([
  "pause",
  "resume",
  "rescope",
  "forward",
  "merge",
]);
export type SquireControlAction = typeof SquireControlAction.Type;

/** What a Lead control action changes, as it was; `squire.control.revert` restores it. */
export const SquireControlBefore = Schema.Struct({
  status: Schema.optionalKey(SquireStatus),
  grants: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: SquireGrantKind,
        targetId: TrimmedNonEmptyString,
        origin: Schema.Literals(["granted", "created"]),
      }),
    ),
  ),
  cards: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: SquireCardId, squireId: SquireId, ownerSquireId: SquireId })),
  ),
});
export type SquireControlBefore = typeof SquireControlBefore.Type;

/**
 * A Lead control action. Squire-store executions have no orchestration
 * receipt: the `action.executed` row, unique on the execution key, is theirs.
 */
export const SquireControlIntent = Schema.Struct({
  type: Schema.Literal("control"),
  action: SquireControlAction,
  leadId: SquireId,
  /** The Squire paused, resumed, or rescoped; null for forward and merge. */
  squireId: Schema.NullOr(SquireId),
  reason: Schema.String,
  /** Rescope: the whole new grant set, exclusions included. */
  grants: Schema.optionalKey(Schema.Array(SquireGrantInput)),
  /** Forward: the one item. Merge: the kept item first, then the duplicates. */
  cardIds: Schema.optionalKey(Schema.Array(SquireCardId)),
  toSquireId: Schema.optionalKey(SquireId),
  /** As it was when the intent was written; execution logs the state it actually replaced. */
  before: SquireControlBefore,
});
export type SquireControlIntent = typeof SquireControlIntent.Type;

/** Accepting a Lead Squire proposal; `requestId` makes the create idempotent. */
export const SquireCreateIntent = Schema.Struct({
  type: Schema.Literal("squire-create"),
  input: SquireCreateInput.mapFields(Struct.omit(["requestId"])),
  requestId: TrimmedNonEmptyString,
});
export type SquireCreateIntent = typeof SquireCreateIntent.Type;

export const squireProposalRequestId = (cardId: SquireCardId | string, attempt: number) =>
  `squire-proposal:${cardId}:${attempt}`;

/**
 * The Lead opening a room: a Squire-store execution like a
 * control action, run by `SquireRooms.applyOpen`, whose receipt is its
 * `action.executed` row.
 */
export const SquireRoomOpenIntent = Schema.Struct({
  type: Schema.Literal("room-open"),
  leadId: SquireId,
  members: Schema.Array(SquireId),
  includesLead: Schema.Boolean,
  topic: TrimmedNonEmptyString,
  about: Schema.Array(SquireRef),
  reason: Schema.String,
  /** The approved `room-proposed` event's proposal id and row id, when approving one. */
  proposalId: Schema.NullOr(TrimmedNonEmptyString),
  proposalEventId: Schema.NullOr(Schema.Int),
});
export type SquireRoomOpenIntent = typeof SquireRoomOpenIntent.Type;

/** Intents whose whole effect is a Squire-store transaction. */
export type SquireStoreIntent = SquireControlIntent | SquireCreateIntent;
export const isSquireStoreIntent = (intent: SquireActionIntent): intent is SquireStoreIntent =>
  intent.type === "control" || intent.type === "squire-create";

export const SquireActionIntent = Schema.Union([
  SquireSteerIntent,
  SquireThreadCreateIntent,
  SquireControlIntent,
  SquireCreateIntent,
  SquireRoomOpenIntent,
]);
export type SquireActionIntent = typeof SquireActionIntent.Type;

export const isRoomOpenIntent = (intent: SquireActionIntent): intent is SquireRoomOpenIntent =>
  intent.type === "room-open";

export const SquireActionIntentJson = Schema.fromJsonString(SquireActionIntent);
export const encodeSquireActionIntent = Schema.encodeSync(SquireActionIntentJson);
export const decodeSquireActionIntent = Schema.decodeUnknownOption(SquireActionIntentJson);

export type SquireActionVerb = "execute" | "accept";

const COMMAND_ID = /^server:squire:(execute|accept):(.+):(\d+)$/;

/** A held execution's or an accept's command id; the receipt of this id decides its outcome. */
export const squireActionCommandId = (
  verb: SquireActionVerb,
  cardId: SquireCardId | string,
  attempt: number,
) => `server:squire:${verb}:${cardId}:${attempt}`;

export const parseSquireActionCommandId = (
  id: string,
):
  | { readonly verb: SquireActionVerb; readonly cardId: string; readonly attempt: number }
  | undefined => {
  const match = COMMAND_ID.exec(id);
  if (match === null) return undefined;
  const [, verb, cardId, attempt] = match;
  return {
    verb: verb === "execute" ? "execute" : "accept",
    cardId: cardId!,
    attempt: Number(attempt),
  };
};

// ── Trigger precondition ──────────────────────────────

type Projections = ProjectionStore.ProjectionStoreV2["Service"];

/** The thread's last message the user wrote (`createdBy: "user"`), if any. */
const lastUserAuthoredMessage = (projections: Projections, threadId: ThreadId) =>
  projections.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }).pipe(
    Effect.map(({ messages }) =>
      messages
        .filter((message) => message.createdBy === "user")
        .toSorted(
          (a, b) =>
            DateTime.toEpochMillis(a.updatedAt) - DateTime.toEpochMillis(b.updatedAt) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .at(-1),
    ),
  );

const linkedHead = (shell: OrchestrationV2ThreadShell) =>
  (shell.pullRequests ?? []).find((link) => link.snapshot?.headSha !== undefined);

/** What the target looks like now, stored with an intent so the hook can tell what changed. */
export const captureSquirePrecondition = Effect.fn("squireActionIntent.captureSquirePrecondition")(
  function* (projections: Projections, threadId: ThreadId) {
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null) return {} satisfies SquireActionPrecondition;
    const message = yield* lastUserAuthoredMessage(projections, threadId);
    const link = linkedHead(shell);
    return {
      ...(shell.latestRunId === null ? {} : { latestRunId: shell.latestRunId }),
      ...(message === undefined ? {} : { lastUserMessageId: message.id }),
      ...(link?.snapshot?.headSha === undefined
        ? {}
        : { prKey: threadPullRequestKeyOf(link), headSha: link.snapshot.headSha }),
    } satisfies SquireActionPrecondition;
  },
);

/**
 * Why the intent's trigger no longer holds, or undefined while it does: the
 * user wrote in the thread, a newer turn started, or the PR head moved.
 * Read under the target's command lock by the hook.
 */
export const squirePreconditionBroken = Effect.fn("squireActionIntent.squirePreconditionBroken")(
  function* (projections: Projections, threadId: ThreadId, precondition: SquireActionPrecondition) {
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) return "the thread no longer exists";
    const latestUser = shell.latestUserAuthoredMessageAt ?? null;
    if (latestUser !== null) {
      if (precondition.lastUserMessageId === undefined) return "the user wrote in the thread";
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageIds: [precondition.lastUserMessageId],
      });
      const known = messages[0];
      if (
        known === undefined ||
        DateTime.toEpochMillis(latestUser) > DateTime.toEpochMillis(known.updatedAt)
      ) {
        return "the user wrote in the thread";
      }
    }
    if ((shell.latestRunId ?? undefined) !== precondition.latestRunId) {
      return "a newer turn started in the thread";
    }
    if (precondition.prKey !== undefined && precondition.headSha !== undefined) {
      const link = (shell.pullRequests ?? []).find(
        (candidate) => threadPullRequestKeyOf(candidate) === precondition.prKey,
      );
      if (link?.snapshot?.headSha !== precondition.headSha) {
        return "the pull request changed";
      }
    }
    return undefined;
  },
);

/**
 * Squire steers never interrupt a running turn. `auto` (steer the active
 * run) only where the target's provider session steers natively without
 * interrupting tools; otherwise `queue` (after the current turn).
 */
export const steerDispatchMode = (projections: Projections, threadId: ThreadId) =>
  projections.getThreadRecords(threadId, ["providerSessions"]).pipe(
    Effect.map(({ providerSessions }) => {
      const latest = providerSessions
        .toSorted(
          (a, b) => DateTime.toEpochMillis(a.updatedAt) - DateTime.toEpochMillis(b.updatedAt),
        )
        .at(-1);
      const turns = latest?.capabilities.turns;
      return turns?.supportsActiveSteering === true && turns.activeSteeringInterruptsTools !== true
        ? ("auto" as const)
        : ("queue" as const);
    }),
  );
