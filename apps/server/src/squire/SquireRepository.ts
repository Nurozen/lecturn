import {
  ProjectId,
  RunId,
  SquireCardId,
  SquireId,
  SquireRoomId,
  SquireRoomPostId,
  SquireGrantKind,
  SquireRuleId,
  SquireTriggerId,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

// Rows mirror the 082_Squire columns. JSON columns stay encoded strings here;
// their owners decode them with the Squire contract schemas.
const Text = Schema.String;
const NullableText = Schema.NullOr(Schema.String);
const Count = Schema.Int;

export const SquireRow = Schema.Struct({
  id: SquireId,
  role: Schema.Literals(["lead", "squire"]),
  name: Text,
  lifecycle: Schema.Literals(["creating", "ready", "rehoming", "deleting", "needs_provider"]),
  home_generation: Count,
  home_thread_id: Schema.NullOr(ThreadId),
  home_project_id: ProjectId,
  provider_instance_id: NullableText,
  model_selection_json: NullableText,
  summary_model_selection_json: NullableText,
  brief: Text,
  status: Schema.Literals(["active", "paused"]),
  events_json: Text,
  permissions_json: Text,
  budgets_json: Text,
  undo_window_seconds: Count,
  digest_json: NullableText,
  digest_last_date: NullableText,
  onboarded_at: NullableText,
  sweep_json: NullableText,
  user_active_at: NullableText,
  inactivity_prompted_at: NullableText,
  automation_paused_at: NullableText,
  companion_json: Text,
  revision: Count,
  create_request_id: NullableText,
  created_at: Text,
  updated_at: Text,
  /** Lead only (IANA): the digest and daily trigger times use it. Optional so row builders may omit it. */
  timezone: Schema.optionalKey(NullableText),
});
export type SquireRow = typeof SquireRow.Type;

export const SquireGrantRow = Schema.Struct({
  squire_id: SquireId,
  kind: SquireGrantKind,
  target_id: Text,
  origin: Schema.Literals(["granted", "created"]),
  created_at: Text,
});
export type SquireGrantRow = typeof SquireGrantRow.Type;

export const SquireEventRow = Schema.Struct({
  id: Count,
  squire_id: SquireId,
  thread_id: Schema.NullOr(ThreadId),
  kind: Text,
  state_key: Text,
  payload_json: NullableText,
  status: Schema.Literals(["deferred", "pending", "batched", "delivered", "dropped"]),
  defer_reason: Schema.NullOr(Schema.Literals(["threshold", "summary", "background", "routing"])),
  not_before: Text,
  batch_id: NullableText,
  created_at: Text,
});
export type SquireEventRow = typeof SquireEventRow.Type;

export const SquireCardRow = Schema.Struct({
  id: SquireCardId,
  squire_id: SquireId,
  owner_squire_id: SquireId,
  kind: Schema.Literals(["steer", "question", "overlap", "proposal", "fyi"]),
  status: Schema.Literals([
    "held",
    "open",
    "accepting",
    "executing",
    "resolved",
    "executed",
    "dismissed",
    "outdated",
  ]),
  target_thread_id: Schema.NullOr(ThreadId),
  project_id: Schema.NullOr(ProjectId),
  title: Text,
  why: Text,
  payload_json: Text,
  evidence_json: Text,
  trigger_json: Text,
  intent_json: NullableText,
  origin: Schema.Literals([
    "event",
    "voice",
    "webhook",
    "test",
    "sweep",
    "message",
    "lead",
    "room",
    "user",
  ]),
  steer_kind: NullableText,
  routed_task_id: NullableText,
  rule_id: Schema.NullOr(SquireRuleId),
  finding_key: NullableText,
  escalate_at: NullableText,
  opened_at: NullableText,
  executes_at: NullableText,
  expires_at: NullableText,
  attempt: Count,
  command_id: NullableText,
  execution_key: NullableText,
  dedupe_key: NullableText,
  replaced_count: Count,
  ask_json: NullableText,
  resolution: NullableText,
  created_at: Text,
  updated_at: Text,
});
export type SquireCardRow = typeof SquireCardRow.Type;
/** How long a background approval waits before it reads Expired; the rule offer outlives it. */
export const SQUIRE_APPROVAL_TTL = Duration.minutes(30);
/** What the user started themselves is theirs to leave open; a voice note counts as the user. */
const APPROVAL_TTL_EXEMPT_ORIGINS: ReadonlySet<SquireCardRow["origin"]> = new Set([
  "user",
  "voice",
]);
/** When an approval raised, or re-raised in place, at `now` expires; null for one that never does. */
export const squireApprovalExpiresAt = (
  card: Pick<SquireCardRow, "kind" | "origin">,
  now: string,
): string | null =>
  (card.kind === "steer" || card.kind === "proposal") &&
  !APPROVAL_TTL_EXEMPT_ORIGINS.has(card.origin)
    ? DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(now), SQUIRE_APPROVAL_TTL))
    : null;

/** Only approvals set `expires_at`, so every other insert leaves it out. */
type SquireCardInsert = Omit<SquireCardRow, "expires_at"> & {
  readonly expires_at?: string | null;
};

export const SquireBudgetUsageRow = Schema.Struct({
  id: Count,
  squire_id: SquireId,
  thread_id: Schema.NullOr(ThreadId),
  kind: Schema.Literals(["steer", "thread", "message"]),
  room_id: Schema.NullOr(SquireRoomId),
  executed_at: Text,
  execution_key: NullableText,
});
export type SquireBudgetUsageRow = typeof SquireBudgetUsageRow.Type;

export const SquireActionLogRow = Schema.Struct({
  id: Count,
  squire_id: SquireId,
  kind: Text,
  room_id: Schema.NullOr(SquireRoomId),
  post_id: Schema.NullOr(SquireRoomPostId),
  trigger_id: NullableText,
  task_id: NullableText,
  thread_id: Schema.NullOr(ThreadId),
  card_id: Schema.NullOr(SquireCardId),
  event_id: Schema.NullOr(Count),
  run_id: NullableText,
  invocation_key: NullableText,
  execution_key: NullableText,
  data_json: Text,
  created_at: Text,
});
export type SquireActionLogRow = typeof SquireActionLogRow.Type;

export const SquireRuleRow = Schema.Struct({
  id: SquireRuleId,
  squire_id: SquireId,
  effect: Schema.Literals(["allow", "ask-first"]),
  action_class: Schema.Literals(["steer", "createThread"]),
  target_kind: Schema.Literals(["thread", "project", "staveSpace", "staveSaga"]),
  target_id: Text,
  steer_kind: NullableText,
  status: Schema.Literals(["active", "disabled"]),
  match_count: Count,
  last_matched_at: NullableText,
  created_at: Text,
});
export type SquireRuleRow = typeof SquireRuleRow.Type;

export const SquireRoomPostRow = Schema.Struct({
  id: SquireRoomPostId,
  message_key: Text,
  room_id: SquireRoomId,
  author_kind: Schema.Literals(["squire", "lead", "user", "system"]),
  author_id: NullableText,
  body: Text,
  reply_to: Schema.NullOr(SquireRoomPostId),
  refs_json: Text,
  hop: Count,
  routing_json: Text,
  rerouted_from: Schema.NullOr(SquireRoomPostId),
  created_at: Text,
});
export type SquireRoomPostRow = typeof SquireRoomPostRow.Type;

export const SquireSummaryRow = Schema.Struct({
  thread_id: ThreadId,
  run_id: RunId,
  stage: Text,
  status: Schema.Literals(["generating", "complete", "partial"]),
  summary_json: Text,
  payer_squire_id: Schema.NullOr(SquireId),
  created_at: Text,
  updated_at: Text,
});
export type SquireSummaryRow = typeof SquireSummaryRow.Type;
export type SquireSummaryKey = Pick<SquireSummaryRow, "thread_id" | "run_id" | "stage">;

/** `secret_ref` names a server secret store entry; the secret itself never lands here. */
export const SquireTriggerRow = Schema.Struct({
  id: SquireTriggerId,
  squire_id: SquireId,
  name: Text,
  kind: Schema.Literals(["schedule", "webhook"]),
  instruction: Text,
  status: Schema.Literals(["active", "paused", "revoked"]),
  schedule_json: NullableText,
  next_slot_at: NullableText,
  secret_ref: NullableText,
  secret_generation: Count,
  last_payload_excerpt: NullableText,
  created_at: Text,
});
export type SquireTriggerRow = typeof SquireTriggerRow.Type;
type SquireTriggerPatch = Partial<
  Omit<SquireTriggerRow, "id" | "squire_id" | "kind" | "created_at">
>;
const decodeTriggers = Schema.decodeUnknownEffect(Schema.Array(SquireTriggerRow));
const triggerImmutableColumns: ReadonlySet<string> = new Set([
  "id",
  "squire_id",
  "kind",
  "created_at",
]);

type SquireCardStatus = SquireCardRow["status"];

export const SquireCardStatRow = Schema.Struct({
  squire_id: SquireId,
  owner_squire_id: SquireId,
  kind: SquireCardRow.fields.kind,
  status: SquireCardRow.fields.status,
  n: Count,
  last_updated_at: Text,
});
export type SquireCardStatRow = typeof SquireCardStatRow.Type;

/** A `notification.pushed` row joined to its card, with every delivery row of that card. */
export const SquireNotificationIntentRow = Schema.Struct({
  intent_id: Count,
  card_id: SquireCardId,
  kind: SquireCardRow.fields.kind,
  status: SquireCardRow.fields.status,
  escalate_at: NullableText,
  target_thread_id: Schema.NullOr(ThreadId),
  /** JSON array of the card's `notification.delivery` `data_json` strings. */
  deliveries_json: Text,
});
export type SquireNotificationIntentRow = typeof SquireNotificationIntentRow.Type;

/** `members_json` holds the Squire members' ids; the Lead and the user are flagged apart. */
export const SquireRoomListRow = Schema.Struct({
  id: SquireRoomId,
  topic: Text,
  status: Schema.Literals(["open", "closed"]),
  muted: Count,
  last_post_at: NullableText,
  members_json: Text,
  includes_lead: Count,
  user_unseen: Count,
});
export type SquireRoomListRow = typeof SquireRoomListRow.Type;
export type SquireCardPatch = Partial<Omit<SquireCardRow, "id" | "created_at">>;
type SquirePatch = Partial<Omit<SquireRow, "id" | "revision" | "created_at">>;
type GrantTarget = { readonly kind: SquireGrantKind; readonly targetId: string };

export interface SquireReactorCursor {
  readonly sequence: number;
  readonly enabled: boolean;
}

type Result<A> = Effect.Effect<A, PersistenceSqlError>;
type StatementError = SqlError | Schema.SchemaError;

export class SquireRepository extends Context.Service<
  SquireRepository,
  {
    /**
     * Runs `effect` in one transaction and publishes one change after it
     * commits. Repository writes inside it publish nothing of their own, so a
     * subscriber never reads ahead of the commit.
     */
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PersistenceSqlError, R>;
    readonly createSquire: (row: SquireRow) => Result<void>;
    readonly getSquire: (id: SquireId) => Result<Option.Option<SquireRow>>;
    /** Oldest first. */
    readonly listSquires: Result<ReadonlyArray<SquireRow>>;
    readonly getLead: Result<Option.Option<SquireRow>>;
    readonly getSquireByCreateRequestId: (requestId: string) => Result<Option.Option<SquireRow>>;
    /**
     * Applies `patch` and bumps `revision`. With `expectedRevision` it is a
     * compare-and-set; None when no row matched. `updatedAt` wins over a
     * patched `updated_at`.
     */
    readonly updateSquire: (input: {
      readonly id: SquireId;
      readonly expectedRevision?: number;
      readonly patch: SquirePatch;
      readonly updatedAt: string;
    }) => Result<Option.Option<SquireRow>>;
    /**
     * Sets `user_active_at` when it is null or at or before `staleBefore`.
     * No revision bump and no change publish: no client renders it, and a
     * bump would fail the user's next compare-and-set edit of the Lead.
     */
    readonly touchUserActiveAt: (input: {
      readonly id: SquireId;
      readonly at: string;
      readonly staleBefore: string;
    }) => Result<boolean>;
    /**
     * Compare-and-set of `digest_last_date` from `from` to `to`; false
     * when another claim moved it first. No revision bump, like
     * `touchUserActiveAt`, so a daily digest never fails the user's next edit.
     */
    readonly claimDigestDate: (input: {
      readonly id: SquireId;
      readonly from: string | null;
      readonly to: string;
    }) => Result<boolean>;
    /**
     * Deletes the Squire and its rows in one transaction and closes open rooms left with fewer than 2 Squire
     * members. Summaries are shared, so they stay with their payer cleared; room posts are the room's log, so they
     * stay too. The caller deletes the returned secrets from the secret store. Idempotent.
     */
    readonly deleteSquireRows: (
      id: SquireId,
    ) => Result<{ readonly triggerSecretRefs: ReadonlyArray<string> }>;
    /** Oldest first. */
    readonly listGrants: (squireId: SquireId) => Result<ReadonlyArray<SquireGrantRow>>;
    readonly listGrantsForTarget: (target: GrantTarget) => Result<ReadonlyArray<SquireGrantRow>>;
    /** False when the grant already exists; its origin is kept. */
    readonly insertGrant: (row: SquireGrantRow) => Result<boolean>;
    readonly deleteGrant: (key: GrantTarget & { readonly squireId: SquireId }) => Result<boolean>;
    readonly deleteGrantsForTarget: (target: GrantTarget) => Result<number>;
    /** False when the dedupe key already exists, pruned payload or not. */
    readonly insertEvent: (row: Omit<SquireEventRow, "id">) => Result<boolean>;
    /** Clears the payload of finished rows created before `before`; their keys stay. */
    readonly pruneEventPayloads: (input: { readonly before: string }) => Result<number>;
    /**
     * The daily retention prune, one transaction; each cutoff is an ISO time
     * and SquireClock says why each is safe. Returns the rows deleted per table.
     */
    readonly pruneHistory: (cutoffs: SquireRetentionCutoffs) => Result<SquireRetentionCounts>;
    /**
     * Drops the Squire's deferred rows on pause, only those created at or
     * before `at` when given.
     */
    readonly dropDeferredEvents: (squireId: SquireId, at?: string) => Result<number>;
    /** Every row the Squire has not been sent yet (deferred or pending) is dropped: a pause. */
    readonly dropQueuedEvents: (squireId: SquireId) => Result<number>;
    /** False when the row left the queue, or its new owner already holds that event. */
    readonly reassignQueuedEvent: (input: {
      readonly id: number;
      readonly squireId: SquireId;
    }) => Result<boolean>;
    readonly insertCard: (row: SquireCardInsert) => Result<void>;
    readonly getCard: (id: SquireCardId) => Result<Option.Option<SquireCardRow>>;
    /** Every given filter must match; an empty `statuses` or `kinds` matches nothing. Oldest first. */
    readonly listCards: (filter: {
      readonly squireId?: SquireId;
      readonly ownerSquireId?: SquireId;
      readonly statuses?: ReadonlyArray<SquireCardStatus>;
      readonly targetThreadId?: ThreadId;
      readonly kinds?: ReadonlyArray<SquireCardRow["kind"]>;
    }) => Result<ReadonlyArray<SquireCardRow>>;
    /**
     * Compare-and-set on the card's current status; None when the card is
     * missing or no longer in `fromStatuses`.
     */
    readonly updateCard: (input: {
      readonly id: SquireCardId;
      readonly fromStatuses: ReadonlyArray<SquireCardStatus>;
      readonly patch: SquireCardPatch;
      readonly updatedAt: string;
    }) => Result<Option.Option<SquireCardRow>>;
    /** Open and held cards targeting the thread become `outdated`. */
    readonly outdateCardsForThread: (input: {
      readonly threadId: ThreadId;
      readonly resolution: string;
      readonly updatedAt: string;
    }) => Result<ReadonlyArray<SquireCardId>>;
    /** Open approvals past `expires_at` become `outdated`/`expired`; what is left of them is the row in chat. */
    readonly expireDueApprovals: (now: string) => Result<ReadonlyArray<SquireCardId>>;
    readonly earliestApprovalExpiryAt: Result<Option.Option<string>>;
    /**
     * A denial stays in force while its card's `expires_at` is null; stamping it ends the denial
     * and keeps the card reading Denied. `before` excludes a denial newer than the user's message.
     */
    readonly clearDenials: (input: {
      readonly squireId: SquireId;
      readonly before: string;
      readonly at: string;
    }) => Result<number>;
    /**
     * Pause: the Squire's holds become open recommendations without a timer. A hold whose open slot (one per Squire,
     * thread, and kind) is taken becomes `outdated`/`superseded` instead, newest first, so the newest wins.
     */
    readonly openHeldCards: (input: {
      readonly squireId: SquireId;
      readonly updatedAt: string;
    }) => Result<ReadonlyArray<SquireCardId>>;
    readonly insertBudgetUsage: (row: Omit<SquireBudgetUsageRow, "id">) => Result<void>;
    readonly insertActionLog: (row: Omit<SquireActionLogRow, "id">) => Result<number>;
    /**
     * Ascending by id, so `afterId` (the last id seen) pages forward. An
     * empty `kinds` matches nothing.
     */
    readonly listActionLog: (input: {
      readonly squireId: SquireId;
      readonly kinds?: ReadonlyArray<string>;
      readonly afterId?: number;
      readonly limit: number;
    }) => Result<ReadonlyArray<SquireActionLogRow>>;
    /** The `tool.called` row for an invocation key. */
    readonly getToolCall: (invocationKey: string) => Result<Option.Option<SquireActionLogRow>>;
    /** The `action.executed` row for an execution key. */
    readonly getExecution: (executionKey: string) => Result<Option.Option<SquireActionLogRow>>;
    /** A card's log rows of the given kinds, oldest first. */
    readonly listCardLog: (input: {
      readonly cardId: SquireCardId;
      readonly kinds: ReadonlyArray<string>;
    }) => Result<ReadonlyArray<SquireActionLogRow>>;
    readonly insertRoomPost: (row: Omit<SquireRoomPostRow, "id">) => Result<SquireRoomPostId>;
    readonly insertRule: (row: SquireRuleRow) => Result<void>;
    /** Oldest first. */
    readonly listRules: (input: {
      readonly squireId: SquireId;
      readonly status?: SquireRuleRow["status"];
    }) => Result<ReadonlyArray<SquireRuleRow>>;
    /**
     * Disabled rules count toward the rule caps: they are still listed in
     * setup and come back when their target returns to scope, so only Remove
     * frees a slot.
     */
    readonly countRules: (input: {
      readonly squireId: SquireId;
      readonly effect: SquireRuleRow["effect"];
    }) => Result<number>;
    readonly getRule: (id: SquireRuleId) => Result<Option.Option<SquireRuleRow>>;
    readonly deleteRule: (id: SquireRuleId) => Result<boolean>;
    /** Counts only rows whose status changed. */
    readonly setRuleStatus: (input: {
      readonly ids: ReadonlyArray<SquireRuleId>;
      readonly status: SquireRuleRow["status"];
    }) => Result<number>;
    /**
     * The rule's match count and last use. Callers run it in the transaction that
     * writes the `rule.matched` row, so a replayed invocation bumps nothing.
     */
    readonly recordRuleMatch: (input: {
      readonly id: SquireRuleId;
      readonly matchedAt: string;
    }) => Result<boolean>;
    /** Rows executed at or after `since`, oldest first. */
    readonly listBudgetUsage: (input: {
      readonly squireId: SquireId;
      readonly since: string;
    }) => Result<ReadonlyArray<SquireBudgetUsageRow>>;
    /** False when a row for the key already exists. */
    readonly insertSummary: (row: SquireSummaryRow) => Result<boolean>;
    readonly getSummary: (key: SquireSummaryKey) => Result<Option.Option<SquireSummaryRow>>;
    /** Every stage of one run, oldest first. */
    readonly listRunSummaries: (
      key: Omit<SquireSummaryKey, "stage">,
    ) => Result<ReadonlyArray<SquireSummaryRow>>;
    /** A thread's settled summaries, newest first, at most `limit` (showcase map). */
    readonly listThreadSummaries: (input: {
      readonly threadId: ThreadId;
      readonly limit: number;
    }) => Result<ReadonlyArray<SquireSummaryRow>>;
    /**
     * The overlap detector's candidates: threads with a settled summary
     * updated at or after `since`, most recent first, at most `limit`.
     */
    readonly listRecentlySummarizedThreadIds: (input: {
      readonly since: string;
      readonly limit: number;
    }) => Result<ReadonlyArray<ThreadId>>;
    /** Thread deletion cascade: summaries are per thread, so they go with it. */
    readonly deleteThreadSummaries: (threadId: ThreadId) => Result<number>;
    /** Settles a `generating` row; false when it was already settled, since settled rows are immutable. */
    readonly finishSummary: (
      row: SquireSummaryKey &
        Pick<SquireSummaryRow, "summary_json" | "payer_squire_id" | "updated_at"> & {
          readonly status: "complete" | "partial";
        },
    ) => Result<boolean>;
    /** Turns every `generating` row `partial`; their stored JSON already holds the deterministic fields. */
    readonly settleGeneratingSummaries: (updatedAt: string) => Result<number>;
    readonly insertTrigger: (row: SquireTriggerRow) => Result<void>;
    readonly getTrigger: (id: SquireTriggerId) => Result<Option.Option<SquireTriggerRow>>;
    /** Revoked rows included, oldest first. */
    readonly listTriggers: (squireId: SquireId) => Result<ReadonlyArray<SquireTriggerRow>>;
    /** Active schedule triggers holding a slot, earliest slot first. */
    readonly listArmedTriggers: Result<ReadonlyArray<SquireTriggerRow>>;
    readonly updateTrigger: (input: {
      readonly id: SquireTriggerId;
      readonly patch: SquireTriggerPatch;
    }) => Result<Option.Option<SquireTriggerRow>>;
    /** The new row's id; None when its dedupe key already exists. */
    readonly insertTriggerEvent: (row: Omit<SquireEventRow, "id">) => Result<Option.Option<number>>;
    /** Whether a thread-less event key exists, pruned payload or not. */
    readonly hasThreadlessEvent: (key: {
      readonly squireId: SquireId;
      readonly kind: string;
      readonly stateKey: string;
    }) => Result<boolean>;
    /** The Squire's log rows of `kinds` created after `after`, oldest first. */
    readonly listActionLogAfter: (input: {
      readonly squireId: SquireId;
      readonly kinds: ReadonlyArray<string>;
      readonly after: string;
    }) => Result<ReadonlyArray<SquireActionLogRow>>;
    // ── Routing receipts ──
    /** The Squire's rows of `kinds` created before `before`, newest first. */
    readonly listActionLogBefore: (input: {
      readonly squireId: SquireId;
      readonly kinds: ReadonlyArray<string>;
      readonly before?: string;
      readonly limit: number;
    }) => Result<ReadonlyArray<SquireActionLogRow>>;
    /** Rows of `kinds` naming one of `taskIds`, oldest first. */
    readonly listActionLogForTasks: (input: {
      readonly taskIds: ReadonlyArray<string>;
      readonly kinds: ReadonlyArray<string>;
    }) => Result<ReadonlyArray<SquireActionLogRow>>;
    /** Cards raised in a routed-task turn, oldest first. */
    readonly listCardsForTasks: (
      taskIds: ReadonlyArray<string>,
    ) => Result<ReadonlyArray<SquireCardRow>>;
    // ── Delivery and clock ──
    /** The Squire's rows in `statuses`, oldest first. */
    readonly listEventsByStatus: (input: {
      readonly squireId: SquireId;
      readonly statuses: ReadonlyArray<SquireEventRow["status"]>;
    }) => Result<ReadonlyArray<SquireEventRow>>;
    /** Every `batched` row, by Squire then id, for the startup re-dispatch. */
    readonly listBatchedEvents: Result<ReadonlyArray<SquireEventRow>>;
    readonly listBatch: (batchId: string) => Result<ReadonlyArray<SquireEventRow>>;
    /** `pending` rows become `batched` under `batchId`; returns how many did. */
    readonly markEventsBatched: (input: {
      readonly ids: ReadonlyArray<number>;
      readonly batchId: string;
    }) => Result<number>;
    /** The batch's `batched` rows become `delivered`; returns only the rows this call moved. */
    readonly markBatchDelivered: (batchId: string) => Result<ReadonlyArray<SquireEventRow>>;
    /** `pending` rows become `dropped`. */
    readonly dropPendingEvents: (ids: ReadonlyArray<number>) => Result<number>;
    /** The earliest `not_before` of deferred rows waiting on a time (threshold, summary). */
    readonly earliestDeferredAt: Result<Option.Option<string>>;
    /**
     * Decision cards held back by presence that are neither escalated
     * nor opened, whatever their status, soonest `escalate_at` first.
     */
    readonly listPendingEscalations: Result<ReadonlyArray<SquireCardRow>>;
    /**
     * A Squire's intents whose card is open, plus any pushed since
     * `since` (a closed card's intent may still lack its mobile row), oldest first.
     */
    readonly listNotificationIntents: (input: {
      readonly squireId: SquireId;
      readonly since: string;
    }) => Result<ReadonlyArray<SquireNotificationIntentRow>>;
    /** Squires holding `pending` rows. */
    readonly listSquiresWithPendingEvents: Result<ReadonlyArray<SquireId>>;
    // ── Integration ──
    /**
     * A re-home: the Squire's `batched` rows return to `pending` with no
     * batch, so they deliver to the new home under a new command id.
     */
    readonly resetBatchedEvents: (squireId: SquireId) => Result<number>;
    /** The batch's `batched` rows become `dropped` (a dispatch the orchestrator refused). */
    readonly dropBatch: (batchId: string) => Result<number>;
    // ── Reactor ──
    /** Rows matching every given filter, oldest first; an empty list filter matches nothing. */
    readonly listEvents: (filter: {
      readonly statuses: ReadonlyArray<SquireEventRow["status"]>;
      readonly deferReasons?: ReadonlyArray<NonNullable<SquireEventRow["defer_reason"]>>;
      readonly threadId?: ThreadId;
      readonly kinds?: ReadonlyArray<string>;
      readonly ids?: ReadonlyArray<number>;
      /** `not_before` at or before this. */
      readonly dueBy?: string;
    }) => Result<ReadonlyArray<SquireEventRow>>;
    /**
     * Compare-and-set on status; returns the rows that moved. An omitted
     * `deferReason` or `notBefore` keeps the stored value.
     */
    readonly setEventStatus: (input: {
      readonly ids: ReadonlyArray<number>;
      readonly fromStatuses: ReadonlyArray<SquireEventRow["status"]>;
      readonly status: SquireEventRow["status"];
      readonly deferReason?: SquireEventRow["defer_reason"];
      readonly notBefore?: string;
    }) => Result<ReadonlyArray<SquireEventRow>>;
    /** Thread deletion cascade: every row of the thread, key rows included. */
    readonly deleteThreadEvents: (threadId: ThreadId) => Result<number>;
    readonly readCursor: Result<SquireReactorCursor>;
    readonly writeCursor: (cursor: SquireReactorCursor) => Result<void>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
    /**
     * Bumped with every published change, before subscribers hear it, so a
     * cache can check freshness in the caller's fiber instead of racing a
     * subscriber.
     */
    readonly changeGeneration: Effect.Effect<number>;
    // ── Dev fixtures ──
    /** Fixture budget seeding starts from none: every usage row of the Squire goes. */
    readonly deleteBudgetUsage: (squireId: SquireId) => Result<number>;
    /** The row holding a dedupe key, pruned payload or not. */
    readonly getEventByKey: (key: {
      readonly squireId: SquireId;
      readonly kind: string;
      readonly threadId: ThreadId | null;
      readonly stateKey: string;
    }) => Result<Option.Option<SquireEventRow>>;
    // ── Read model ──
    /** Card counts and latest `updated_at` per (raiser, owner, kind, status). */
    readonly listCardStats: Result<ReadonlyArray<SquireCardStatRow>>;
    /**
     * Newest first. `queueOf` matches cards the Squire raised or owns; absent
     * matches every card (the Lead's combined queue). An empty list filter
     * matches nothing.
     */
    readonly listCardsPage: (input: {
      readonly queueOf?: SquireId;
      readonly statuses?: ReadonlyArray<SquireCardStatus>;
      readonly kinds?: ReadonlyArray<SquireCardRow["kind"]>;
      /** `created_at` strictly before this. */
      readonly before?: string;
      readonly limit: number;
    }) => Result<ReadonlyArray<SquireCardRow>>;
    /** Newest first, so `beforeId` (the last id seen) pages back. An empty `kinds` matches nothing. */
    readonly listActionLogDesc: (input: {
      readonly squireId: SquireId;
      readonly kinds?: ReadonlyArray<string>;
      readonly triggerId?: SquireTriggerId;
      readonly beforeId?: number;
      readonly limit: number;
    }) => Result<ReadonlyArray<SquireActionLogRow>>;
    /** The Squire's log rows of `kinds` written by any of `runIds`, oldest first. */
    readonly listActionLogForRuns: (input: {
      readonly squireId: SquireId;
      readonly kinds: ReadonlyArray<string>;
      readonly runIds: ReadonlyArray<string>;
    }) => Result<ReadonlyArray<SquireActionLogRow>>;
    /** Every stage of the thread's most recently summarized run, oldest first. */
    readonly listLatestRunSummaries: (
      threadId: ThreadId,
    ) => Result<ReadonlyArray<SquireSummaryRow>>;
    /** Compact rows of open rooms and rooms closed at or after `closedSince`, oldest first. */
    readonly listRoomRows: (input: {
      readonly closedSince: string;
    }) => Result<ReadonlyArray<SquireRoomListRow>>;
  }
>()("lecturn/squire/SquireRepository") {}

export interface SquireRetentionCutoffs {
  readonly eventsBefore: string;
  readonly cardsBefore: string;
  readonly actionLogBefore: string;
  readonly budgetUsageBefore: string;
  readonly closedRoomPostsBefore: string;
}

export interface SquireRetentionCounts {
  readonly events: number;
  readonly cards: number;
  readonly actionLog: number;
  readonly budgetUsage: number;
  readonly roomPosts: number;
}

/**
 * Matches the `squire_card_live` partial index's WHERE exactly, so a query
 * over open or held cards can use it (SQLite needs the literal term).
 */
const SQUIRE_CARD_LIVE = "status IN ('open', 'held')";
const LIVE_CARD_STATUSES: ReadonlySet<string> = new Set(["open", "held"]);

const decodeSquires = Schema.decodeUnknownEffect(Schema.Array(SquireRow));
const decodeSummaries = Schema.decodeUnknownEffect(Schema.Array(SquireSummaryRow));
const decodeGrants = Schema.decodeUnknownEffect(Schema.Array(SquireGrantRow));
const decodeCards = Schema.decodeUnknownEffect(Schema.Array(SquireCardRow));
const decodeActionLogs = Schema.decodeUnknownEffect(Schema.Array(SquireActionLogRow));
const decodeRules = Schema.decodeUnknownEffect(Schema.Array(SquireRuleRow));
const decodeBudgetUsage = Schema.decodeUnknownEffect(Schema.Array(SquireBudgetUsageRow));
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Count })));
const decodeCardIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: SquireCardId })));
const decodeHeldCards = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: SquireCardId,
      kind: SquireCardRow.fields.kind,
      origin: SquireCardRow.fields.origin,
    }),
  ),
);
const decodeExpiresAt = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ expires_at: NullableText })),
);
const decodeCount = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Count })));
const decodeSecretRefs = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ secret_ref: Text })),
);
const decodeRoomIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ room_id: SquireRoomId })),
);
const decodeCursor = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ sequence: Count, enabled: Count })),
);
// Delivery and clock.
const decodeEventRows = Schema.decodeUnknownEffect(Schema.Array(SquireEventRow));
const decodeCardStats = Schema.decodeUnknownEffect(Schema.Array(SquireCardStatRow));
const decodeNotificationIntents = Schema.decodeUnknownEffect(
  Schema.Array(SquireNotificationIntentRow),
);
const decodeRoomRows = Schema.decodeUnknownEffect(Schema.Array(SquireRoomListRow));
const decodeNotBefore = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ not_before: NullableText })),
);
const decodeSummaryThreadIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ thread_id: ThreadId })),
);
const decodeSquireIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ squire_id: SquireId })),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Sliding(1): a change is a dirty signal that readers answer with a fresh
  // read, so a slow subscriber only needs the latest one.
  const changes = yield* PubSub.sliding<void>(1);
  const generation = yield* Ref.make(0);
  const publish = Ref.update(generation, (n) => n + 1).pipe(
    Effect.andThen(PubSub.publish(changes, undefined)),
    Effect.asVoid,
  );

  const publishUnlessInTransaction = Effect.serviceOption(sql.transactionService).pipe(
    Effect.flatMap((outer) => (Option.isNone(outer) ? publish : Effect.void)),
  );

  // Wraps every Squire transaction; the SQL client already traces it.
  const transaction: SquireRepository["Service"]["transaction"] = Effect.fnUntraced(
    function* (effect) {
      const outer = yield* Effect.serviceOption(sql.transactionService);
      const result = yield* sql
        .withTransaction(effect)
        .pipe(
          Effect.catchTags({ SqlError: toPersistenceSqlError("SquireRepository.transaction") }),
        );
      if (Option.isNone(outer)) yield* publish;
      return result;
    },
  );

  const read = <A>(operation: string, effect: Effect.Effect<A, StatementError>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError(`SquireRepository.${operation}`)));
  const write = <A>(
    operation: string,
    effect: Effect.Effect<A, StatementError>,
    changed: (result: A) => boolean = () => true,
  ) =>
    read(operation, effect).pipe(
      Effect.tap((result) => (changed(result) ? publishUnlessInTransaction : Effect.void)),
    );
  const insert = (operation: string, table: string, row: Record<string, unknown>) =>
    write(operation, sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`.pipe(Effect.asVoid));
  const insertReturningId = (operation: string, table: string, row: Record<string, unknown>) =>
    write(
      operation,
      sql`INSERT INTO ${sql(table)} ${sql.insert(row)} RETURNING id`.pipe(
        Effect.flatMap(decodeIds),
        Effect.map((rows) => rows[0]?.id ?? 0),
      ),
    );

  const countOf = (rows: ReadonlyArray<{ readonly n: number }>) => rows[0]?.n ?? 0;
  const changedRows = sql`SELECT changes() AS n`.pipe(
    Effect.flatMap(decodeCount),
    Effect.map(countOf),
  );
  // A patch may come from a spread row, so the immutable columns are stripped
  // at runtime too.
  const setColumns = (
    patch: Record<string, unknown>,
    updatedAt: string,
    immutable: ReadonlyArray<string>,
  ) =>
    sql.update(
      Object.fromEntries(
        Object.entries({ ...patch, updated_at: updatedAt }).filter(
          ([column, value]) => value !== undefined && !immutable.includes(column),
        ),
      ),
    );

  const selectActionLog = (operation: string, kind: string, column: string, key: string) =>
    read(
      operation,
      sql`SELECT * FROM squire_action_log WHERE kind = ${kind} AND ${sql(column)} = ${key}`.pipe(
        Effect.flatMap(decodeActionLogs),
        Effect.map(Option.fromIterable),
      ),
    );

  const deleteSquireRows = (id: SquireId) =>
    read(
      "deleteSquireRows",
      sql.withTransaction(
        Effect.gen(function* () {
          const secrets = yield* sql`SELECT secret_ref FROM squire_trigger
            WHERE squire_id = ${id} AND secret_ref IS NOT NULL ORDER BY created_at, rowid`.pipe(
            Effect.flatMap(decodeSecretRefs),
          );
          const rooms = yield* sql`SELECT DISTINCT room_id FROM squire_room_member
            WHERE member_kind IN ('squire', 'lead') AND member_id = ${id}`.pipe(
            Effect.flatMap(decodeRoomIds),
          );
          let changed = 0;
          for (const statement of [
            sql`DELETE FROM squire_grant WHERE squire_id = ${id}`,
            sql`DELETE FROM squire_event WHERE squire_id = ${id}`,
            sql`DELETE FROM squire_card WHERE squire_id = ${id} OR owner_squire_id = ${id}`,
            sql`DELETE FROM squire_budget_usage WHERE squire_id = ${id}`,
            sql`DELETE FROM squire_action_log WHERE squire_id = ${id}`,
            sql`DELETE FROM squire_rule WHERE squire_id = ${id}`,
            sql`DELETE FROM squire_trigger WHERE squire_id = ${id}`,
            sql`DELETE FROM squire_room_member
              WHERE member_kind IN ('squire', 'lead') AND member_id = ${id}`,
            sql`UPDATE squire_summary SET payer_squire_id = NULL WHERE payer_squire_id = ${id}`,
            sql`DELETE FROM squire WHERE id = ${id}`,
          ]) {
            yield* statement;
            changed += yield* changedRows;
          }
          if (rooms.length > 0) {
            const closedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            yield* sql`UPDATE squire_room
              SET status = 'closed', closed_reason = 'members', revision = revision + 1,
                updated_at = ${closedAt}
              WHERE id IN ${sql.in(rooms.map((room) => room.room_id))} AND status = 'open'
                AND (SELECT count(*) FROM squire_room_member AS member
                  WHERE member.room_id = squire_room.id
                    AND member.member_kind IN ('squire', 'lead')) < 2`;
            changed += yield* changedRows;
          }
          return { triggerSecretRefs: secrets.map((row) => row.secret_ref), changed };
        }),
      ),
    ).pipe(
      Effect.tap(({ changed }) => (changed > 0 ? publishUnlessInTransaction : Effect.void)),
      Effect.map(({ triggerSecretRefs }) => ({ triggerSecretRefs })),
    );

  /** The `squire_card_live` term, when every requested status is open or held. */
  const liveCardTerm = (statuses: ReadonlyArray<string> | undefined) =>
    statuses !== undefined && statuses.every((status) => LIVE_CARD_STATUSES.has(status))
      ? [sql.literal(SQUIRE_CARD_LIVE)]
      : [];

  const pruneHistory: SquireRepository["Service"]["pruneHistory"] = (cutoffs) =>
    read(
      "pruneHistory",
      sql.withTransaction(
        Effect.gen(function* () {
          const deleted = (statement: Effect.Effect<unknown, StatementError>) =>
            statement.pipe(Effect.andThen(changedRows));
          // PR keys stay while their thread lives: the sync reactor republishes
          // an unchanged snapshot, so a deleted key would fire again.
          const events = yield* deleted(sql`DELETE FROM squire_event
            WHERE status IN ('delivered', 'dropped') AND created_at < ${cutoffs.eventsBefore}
              AND kind != 'pull-request-changed'`);
          // Dismissed overlaps and findings, resolved overlaps, and denials still
          // in force are what stops them being raised again, so they stay.
          const cards = yield* deleted(sql`DELETE FROM squire_card
            WHERE status IN ('resolved', 'executed', 'dismissed', 'outdated')
              AND updated_at < ${cutoffs.cardsBefore}
              AND NOT (kind = 'overlap' AND status IN ('dismissed', 'resolved'))
              AND NOT (status = 'dismissed' AND finding_key IS NOT NULL)
              AND NOT (resolution IS 'denied' AND expires_at IS NULL)`);
          // After the cards: a live card keeps its log rows, and the newest two
          // branch rows per thread still mark the overlap change boundary.
          const actionLog = yield* deleted(sql`DELETE FROM squire_action_log AS log
            WHERE log.created_at < ${cutoffs.actionLogBefore}
              AND (log.card_id IS NULL
                OR NOT EXISTS (SELECT 1 FROM squire_card AS card WHERE card.id = log.card_id))
              AND (log.kind != 'overlap.branch' OR log.id NOT IN (
                SELECT branch.id FROM squire_action_log AS branch
                WHERE branch.squire_id = log.squire_id AND branch.kind = 'overlap.branch'
                  AND branch.thread_id IS log.thread_id
                ORDER BY branch.id DESC LIMIT 2))`);
          const budgetUsage = yield* deleted(sql`DELETE FROM squire_budget_usage
            WHERE executed_at < ${cutoffs.budgetUsageBefore}`);
          const roomPosts = yield* deleted(sql`DELETE FROM squire_room_post
            WHERE room_id IN (SELECT id FROM squire_room
              WHERE status = 'closed' AND updated_at < ${cutoffs.closedRoomPostsBefore})`);
          return { events, cards, actionLog, budgetUsage, roomPosts };
        }),
      ),
    ).pipe(
      Effect.tap((counts) =>
        Object.values(counts).some((n) => n > 0) ? publishUnlessInTransaction : Effect.void,
      ),
    );

  const openHeldCards: SquireRepository["Service"]["openHeldCards"] = ({ squireId, updatedAt }) =>
    write(
      "openHeldCards",
      sql.withTransaction(
        Effect.gen(function* () {
          const held = yield* sql`SELECT id, kind, origin FROM squire_card
            WHERE ${sql.literal(SQUIRE_CARD_LIVE)} AND status = 'held'
              AND (squire_id = ${squireId} OR owner_squire_id = ${squireId})
            ORDER BY created_at DESC, rowid DESC`.pipe(Effect.flatMap(decodeHeldCards));
          const opened: Array<SquireCardId> = [];
          for (const row of held) {
            const { id } = row;
            // OR IGNORE skips a row the open-card indexes would reject.
            const expiresAt = squireApprovalExpiresAt(row, updatedAt);
            const rows = yield* sql`UPDATE OR IGNORE squire_card
              SET status = 'open', executes_at = NULL, updated_at = ${updatedAt},
                expires_at = ${expiresAt}
              WHERE id = ${id} AND status = 'held' RETURNING id`;
            if (rows.length > 0) {
              opened.push(id);
            } else {
              yield* sql`UPDATE squire_card
                SET status = 'outdated', resolution = 'superseded', updated_at = ${updatedAt}
                WHERE id = ${id} AND status = 'held'`;
            }
          }
          return { opened, touched: held.length };
        }),
      ),
      ({ touched }) => touched > 0,
    ).pipe(Effect.map(({ opened }) => opened));

  return SquireRepository.of({
    transaction,
    createSquire: (row) => insert("createSquire", "squire", row),
    getSquire: (id) =>
      read(
        "getSquire",
        sql`SELECT * FROM squire WHERE id = ${id}`.pipe(
          Effect.flatMap(decodeSquires),
          Effect.map(Option.fromIterable),
        ),
      ),
    listSquires: read(
      "listSquires",
      sql`SELECT * FROM squire ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeSquires)),
    ),
    getLead: read(
      "getLead",
      sql`SELECT * FROM squire WHERE role = 'lead'`.pipe(
        Effect.flatMap(decodeSquires),
        Effect.map(Option.fromIterable),
      ),
    ),
    getSquireByCreateRequestId: (requestId) =>
      read(
        "getSquireByCreateRequestId",
        sql`SELECT * FROM squire WHERE create_request_id = ${requestId}`.pipe(
          Effect.flatMap(decodeSquires),
          Effect.map(Option.fromIterable),
        ),
      ),
    updateSquire: ({ id, expectedRevision, patch, updatedAt }) =>
      write(
        "updateSquire",
        sql`UPDATE squire
          SET ${setColumns(patch, updatedAt, ["id", "revision", "created_at"])},
            revision = revision + 1
          WHERE ${sql.and([
            sql`id = ${id}`,
            ...(expectedRevision === undefined ? [] : [sql`revision = ${expectedRevision}`]),
          ])}
          RETURNING *`.pipe(Effect.flatMap(decodeSquires), Effect.map(Option.fromIterable)),
        Option.isSome,
      ),
    touchUserActiveAt: ({ id, at, staleBefore }) =>
      read(
        "touchUserActiveAt",
        sql`UPDATE squire SET user_active_at = ${at}
          WHERE id = ${id} AND (user_active_at IS NULL OR user_active_at <= ${staleBefore})
          RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
      ),
    claimDigestDate: ({ id, from, to }) =>
      read(
        "claimDigestDate",
        sql`UPDATE squire SET digest_last_date = ${to}
          WHERE id = ${id} AND digest_last_date IS ${from}
          RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
      ),
    deleteSquireRows,
    listGrants: (squireId) =>
      read(
        "listGrants",
        sql`SELECT * FROM squire_grant WHERE squire_id = ${squireId}
          ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeGrants)),
      ),
    listGrantsForTarget: ({ kind, targetId }) =>
      read(
        "listGrantsForTarget",
        sql`SELECT * FROM squire_grant WHERE kind = ${kind} AND target_id = ${targetId}
          ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeGrants)),
      ),
    insertGrant: (row) =>
      write(
        "insertGrant",
        sql`INSERT OR IGNORE INTO squire_grant ${sql.insert(row)} RETURNING squire_id`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
        (inserted) => inserted,
      ),
    deleteGrant: ({ squireId, kind, targetId }) =>
      write(
        "deleteGrant",
        sql`DELETE FROM squire_grant
          WHERE squire_id = ${squireId} AND kind = ${kind} AND target_id = ${targetId}
          RETURNING squire_id`.pipe(Effect.map((rows) => rows.length > 0)),
        (deleted) => deleted,
      ),
    deleteGrantsForTarget: ({ kind, targetId }) =>
      write(
        "deleteGrantsForTarget",
        sql`DELETE FROM squire_grant WHERE kind = ${kind} AND target_id = ${targetId}
          RETURNING squire_id`.pipe(Effect.map((rows) => rows.length)),
        (deleted) => deleted > 0,
      ),
    insertEvent: (row) =>
      write(
        "insertEvent",
        sql`INSERT OR IGNORE INTO squire_event ${sql.insert(row)} RETURNING id`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
        (inserted) => inserted,
      ),
    pruneEventPayloads: ({ before }) =>
      write(
        "pruneEventPayloads",
        sql`UPDATE squire_event SET payload_json = NULL
          WHERE status IN ('delivered', 'dropped') AND payload_json IS NOT NULL
            AND created_at < ${before}
          RETURNING id`.pipe(Effect.map((rows) => rows.length)),
        (pruned) => pruned > 0,
      ),
    pruneHistory,
    dropDeferredEvents: (squireId, at) =>
      write(
        "dropDeferredEvents",
        sql`UPDATE squire_event SET status = 'dropped'
          WHERE ${sql.and([
            sql`squire_id = ${squireId}`,
            sql`status = 'deferred'`,
            ...(at === undefined ? [] : [sql`created_at <= ${at}`]),
          ])}
          RETURNING id`.pipe(Effect.map((rows) => rows.length)),
        (dropped) => dropped > 0,
      ),
    dropQueuedEvents: (squireId) =>
      write(
        "dropQueuedEvents",
        sql`UPDATE squire_event SET status = 'dropped'
          WHERE squire_id = ${squireId} AND status IN ('deferred', 'pending')
          RETURNING id`.pipe(Effect.map((rows) => rows.length)),
        (dropped) => dropped > 0,
      ),
    reassignQueuedEvent: ({ id, squireId }) =>
      write(
        "reassignQueuedEvent",
        sql`UPDATE OR IGNORE squire_event SET squire_id = ${squireId}
          WHERE id = ${id} AND status IN ('deferred', 'pending')
          RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
        (moved) => moved,
      ),
    insertCard: (row) => insert("insertCard", "squire_card", row),
    getCard: (id) =>
      read(
        "getCard",
        sql`SELECT * FROM squire_card WHERE id = ${id}`.pipe(
          Effect.flatMap(decodeCards),
          Effect.map(Option.fromIterable),
        ),
      ),
    listCards: ({ squireId, ownerSquireId, statuses, targetThreadId, kinds }) =>
      statuses?.length === 0 || kinds?.length === 0
        ? Effect.succeed([])
        : read(
            "listCards",
            sql`SELECT * FROM squire_card WHERE ${sql.and([
              ...(squireId === undefined ? [] : [sql`squire_id = ${squireId}`]),
              ...(ownerSquireId === undefined ? [] : [sql`owner_squire_id = ${ownerSquireId}`]),
              ...liveCardTerm(statuses),
              ...(statuses === undefined ? [] : [sql`status IN ${sql.in(statuses)}`]),
              ...(targetThreadId === undefined ? [] : [sql`target_thread_id = ${targetThreadId}`]),
              ...(kinds === undefined ? [] : [sql`kind IN ${sql.in(kinds)}`]),
            ])} ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeCards)),
          ),
    updateCard: ({ id, fromStatuses, patch, updatedAt }) =>
      fromStatuses.length === 0
        ? Effect.succeedNone
        : write(
            "updateCard",
            sql`UPDATE squire_card
              SET ${setColumns(patch, updatedAt, ["id", "created_at"])}
              WHERE id = ${id} AND status IN ${sql.in(fromStatuses)}
              RETURNING *`.pipe(Effect.flatMap(decodeCards), Effect.map(Option.fromIterable)),
            Option.isSome,
          ),
    outdateCardsForThread: ({ threadId, resolution, updatedAt }) =>
      write(
        "outdateCardsForThread",
        sql`UPDATE squire_card
          SET status = 'outdated', resolution = ${resolution}, updated_at = ${updatedAt}
          WHERE target_thread_id = ${threadId} AND status IN ('open', 'held')
          RETURNING id`.pipe(
          Effect.flatMap(decodeCardIds),
          Effect.map((rows) => rows.map((row) => row.id)),
        ),
        (outdated) => outdated.length > 0,
      ),
    openHeldCards,
    expireDueApprovals: (now) =>
      write(
        "expireDueApprovals",
        sql`UPDATE squire_card
          SET status = 'outdated', resolution = 'expired', executes_at = NULL, updated_at = ${now}
          WHERE ${sql.literal(SQUIRE_CARD_LIVE)} AND status = 'open'
            AND expires_at IS NOT NULL AND expires_at <= ${now}
          RETURNING id`.pipe(
          Effect.flatMap(decodeCardIds),
          Effect.map((rows) => rows.map((row) => row.id)),
        ),
        (ids) => ids.length > 0,
      ),
    earliestApprovalExpiryAt: read(
      "earliestApprovalExpiryAt",
      sql`SELECT min(expires_at) AS expires_at FROM squire_card
        WHERE ${sql.literal(SQUIRE_CARD_LIVE)} AND status = 'open'`.pipe(
        Effect.flatMap(decodeExpiresAt),
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.expires_at)),
      ),
    ),
    clearDenials: ({ squireId, before, at }) =>
      write(
        "clearDenials",
        sql`UPDATE squire_card SET expires_at = ${at}
          WHERE squire_id = ${squireId} AND status = 'dismissed'
            AND resolution = 'denied' AND expires_at IS NULL AND updated_at <= ${before}
          RETURNING id`.pipe(
          Effect.flatMap(decodeCardIds),
          Effect.map((rows) => rows.length),
        ),
        (n) => n > 0,
      ),
    insertBudgetUsage: (row) => insert("insertBudgetUsage", "squire_budget_usage", row),
    insertActionLog: (row) => insertReturningId("insertActionLog", "squire_action_log", row),
    listActionLog: ({ squireId, kinds, afterId, limit }) =>
      kinds?.length === 0
        ? Effect.succeed([])
        : read(
            "listActionLog",
            sql`SELECT * FROM squire_action_log WHERE ${sql.and([
              sql`squire_id = ${squireId}`,
              ...(kinds === undefined ? [] : [sql`kind IN ${sql.in(kinds)}`]),
              ...(afterId === undefined ? [] : [sql`id > ${afterId}`]),
            ])} ORDER BY id LIMIT ${limit}`.pipe(Effect.flatMap(decodeActionLogs)),
          ),
    getToolCall: (invocationKey) =>
      selectActionLog("getToolCall", "tool.called", "invocation_key", invocationKey),
    getExecution: (executionKey) =>
      selectActionLog("getExecution", "action.executed", "execution_key", executionKey),
    listCardLog: ({ cardId, kinds }) =>
      kinds.length === 0
        ? Effect.succeed([])
        : read(
            "listCardLog",
            sql`SELECT * FROM squire_action_log
              WHERE card_id = ${cardId} AND kind IN ${sql.in(kinds)}
              ORDER BY id`.pipe(Effect.flatMap(decodeActionLogs)),
          ),
    insertRoomPost: (row) =>
      insertReturningId("insertRoomPost", "squire_room_post", row).pipe(
        Effect.map(SquireRoomPostId.make),
      ),
    insertRule: (row) => insert("insertRule", "squire_rule", row),
    listRules: ({ squireId, status }) =>
      read(
        "listRules",
        sql`SELECT * FROM squire_rule WHERE ${sql.and([
          sql`squire_id = ${squireId}`,
          ...(status === undefined ? [] : [sql`status = ${status}`]),
        ])} ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeRules)),
      ),
    countRules: ({ squireId, effect }) =>
      read(
        "countRules",
        sql`SELECT count(*) AS n FROM squire_rule
          WHERE squire_id = ${squireId} AND effect = ${effect}`.pipe(
          Effect.flatMap(decodeCount),
          Effect.map(countOf),
        ),
      ),
    getRule: (id) =>
      read(
        "getRule",
        sql`SELECT * FROM squire_rule WHERE id = ${id}`.pipe(
          Effect.flatMap(decodeRules),
          Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
        ),
      ),
    deleteRule: (id) =>
      write(
        "deleteRule",
        sql`DELETE FROM squire_rule WHERE id = ${id} RETURNING id`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
        (deleted) => deleted,
      ),
    setRuleStatus: ({ ids, status }) =>
      ids.length === 0
        ? Effect.succeed(0)
        : write(
            "setRuleStatus",
            sql`UPDATE squire_rule SET status = ${status}
              WHERE id IN ${sql.in(ids)} AND status != ${status}
              RETURNING id`.pipe(Effect.map((rows) => rows.length)),
            (updated) => updated > 0,
          ),
    recordRuleMatch: ({ id, matchedAt }) =>
      write(
        "recordRuleMatch",
        sql`UPDATE squire_rule
          SET match_count = match_count + 1, last_matched_at = ${matchedAt}
          WHERE id = ${id} RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
        (updated) => updated,
      ),
    listBudgetUsage: ({ squireId, since }) =>
      read(
        "listBudgetUsage",
        sql`SELECT * FROM squire_budget_usage
          WHERE squire_id = ${squireId} AND executed_at >= ${since}
          ORDER BY executed_at, id`.pipe(Effect.flatMap(decodeBudgetUsage)),
      ),
    insertSummary: (row) =>
      write(
        "insertSummary",
        sql`INSERT OR IGNORE INTO squire_summary ${sql.insert(row)} RETURNING thread_id`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
        (inserted) => inserted,
      ),
    getSummary: ({ thread_id, run_id, stage }) =>
      read(
        "getSummary",
        sql`SELECT * FROM squire_summary
          WHERE thread_id = ${thread_id} AND run_id = ${run_id} AND stage = ${stage}`.pipe(
          Effect.flatMap(decodeSummaries),
          Effect.map(Option.fromIterable),
        ),
      ),
    listRunSummaries: ({ thread_id, run_id }) =>
      read(
        "listRunSummaries",
        sql`SELECT * FROM squire_summary WHERE thread_id = ${thread_id} AND run_id = ${run_id}
          ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeSummaries)),
      ),
    listThreadSummaries: ({ threadId, limit }) =>
      read(
        "listThreadSummaries",
        sql`SELECT * FROM squire_summary WHERE thread_id = ${threadId} AND status != 'generating'
          ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`.pipe(
          Effect.flatMap(decodeSummaries),
        ),
      ),
    // `+thread_id` keeps SQLite from walking the whole primary key to group;
    // the window's range on squire_summary_recent is the small side.
    listRecentlySummarizedThreadIds: ({ since, limit }) =>
      read(
        "listRecentlySummarizedThreadIds",
        sql`SELECT thread_id FROM squire_summary
          WHERE updated_at >= ${since} AND status != 'generating'
          GROUP BY +thread_id ORDER BY max(updated_at) DESC, thread_id LIMIT ${limit}`.pipe(
          Effect.flatMap(decodeSummaryThreadIds),
          Effect.map((rows) => rows.map((row) => row.thread_id)),
        ),
      ),
    deleteThreadSummaries: (threadId) =>
      write(
        "deleteThreadSummaries",
        sql`DELETE FROM squire_summary WHERE thread_id = ${threadId} RETURNING thread_id`.pipe(
          Effect.map((rows) => rows.length),
        ),
        (deleted) => deleted > 0,
      ),
    finishSummary: ({
      thread_id,
      run_id,
      stage,
      status,
      summary_json,
      payer_squire_id,
      updated_at,
    }) =>
      write(
        "finishSummary",
        sql`UPDATE squire_summary
          SET status = ${status}, summary_json = ${summary_json},
            payer_squire_id = ${payer_squire_id}, updated_at = ${updated_at}
          WHERE thread_id = ${thread_id} AND run_id = ${run_id} AND stage = ${stage}
            AND status = 'generating'
          RETURNING thread_id`.pipe(Effect.map((rows) => rows.length > 0)),
        (finished) => finished,
      ),
    settleGeneratingSummaries: (updatedAt) =>
      write(
        "settleGeneratingSummaries",
        sql`UPDATE squire_summary SET status = 'partial', updated_at = ${updatedAt}
          WHERE status = 'generating' RETURNING thread_id`.pipe(Effect.map((rows) => rows.length)),
        (settled) => settled > 0,
      ),
    insertTrigger: (row) => insert("insertTrigger", "squire_trigger", row),
    getTrigger: (id) =>
      read(
        "getTrigger",
        sql`SELECT * FROM squire_trigger WHERE id = ${id}`.pipe(
          Effect.flatMap(decodeTriggers),
          Effect.map(Option.fromIterable),
        ),
      ),
    listTriggers: (squireId) =>
      read(
        "listTriggers",
        sql`SELECT * FROM squire_trigger WHERE squire_id = ${squireId}
          ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeTriggers)),
      ),
    listArmedTriggers: read(
      "listArmedTriggers",
      sql`SELECT * FROM squire_trigger
        WHERE status = 'active' AND kind = 'schedule' AND next_slot_at IS NOT NULL
        ORDER BY next_slot_at, rowid`.pipe(Effect.flatMap(decodeTriggers)),
    ),
    // squire_trigger has no updated_at, so this skips `setColumns`.
    updateTrigger: ({ id, patch }) => {
      const columns = Object.fromEntries(
        Object.entries(patch).filter(
          ([column, value]) => value !== undefined && !triggerImmutableColumns.has(column),
        ),
      );
      return Object.keys(columns).length === 0
        ? read(
            "updateTrigger",
            sql`SELECT * FROM squire_trigger WHERE id = ${id}`.pipe(
              Effect.flatMap(decodeTriggers),
              Effect.map(Option.fromIterable),
            ),
          )
        : write(
            "updateTrigger",
            sql`UPDATE squire_trigger SET ${sql.update(columns)} WHERE id = ${id}
              RETURNING *`.pipe(Effect.flatMap(decodeTriggers), Effect.map(Option.fromIterable)),
            Option.isSome,
          );
    },
    insertTriggerEvent: (row) =>
      write(
        "insertTriggerEvent",
        sql`INSERT OR IGNORE INTO squire_event ${sql.insert(row)} RETURNING id`.pipe(
          Effect.flatMap(decodeIds),
          Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.id)),
        ),
        Option.isSome,
      ),
    hasThreadlessEvent: ({ squireId, kind, stateKey }) =>
      read(
        "hasThreadlessEvent",
        sql`SELECT count(*) AS n FROM squire_event
          WHERE squire_id = ${squireId} AND kind = ${kind} AND ifnull(thread_id, '') = ''
            AND state_key = ${stateKey}`.pipe(
          Effect.flatMap(decodeCount),
          Effect.map((rows) => countOf(rows) > 0),
        ),
      ),
    listActionLogAfter: ({ squireId, kinds, after }) =>
      kinds.length === 0
        ? Effect.succeed([])
        : read(
            "listActionLogAfter",
            sql`SELECT * FROM squire_action_log
              WHERE squire_id = ${squireId} AND kind IN ${sql.in(kinds)} AND created_at > ${after}
              ORDER BY created_at, id`.pipe(Effect.flatMap(decodeActionLogs)),
          ),
    listActionLogBefore: ({ squireId, kinds, before, limit }) =>
      kinds.length === 0
        ? Effect.succeed([])
        : read(
            "listActionLogBefore",
            sql`SELECT * FROM squire_action_log WHERE ${sql.and([
              sql`squire_id = ${squireId}`,
              sql`kind IN ${sql.in(kinds)}`,
              ...(before === undefined ? [] : [sql`created_at < ${before}`]),
            ])} ORDER BY created_at DESC, id DESC LIMIT ${limit}`.pipe(
              Effect.flatMap(decodeActionLogs),
            ),
          ),
    listActionLogForTasks: ({ taskIds, kinds }) =>
      taskIds.length === 0 || kinds.length === 0
        ? Effect.succeed([])
        : read(
            "listActionLogForTasks",
            sql`SELECT * FROM squire_action_log
              WHERE task_id IN ${sql.in(taskIds)} AND kind IN ${sql.in(kinds)}
              ORDER BY id`.pipe(Effect.flatMap(decodeActionLogs)),
          ),
    listCardsForTasks: (taskIds) =>
      taskIds.length === 0
        ? Effect.succeed([])
        : read(
            "listCardsForTasks",
            sql`SELECT * FROM squire_card WHERE routed_task_id IN ${sql.in(taskIds)}
              ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeCards)),
          ),
    // ── Delivery and clock ──
    listEventsByStatus: ({ squireId, statuses }) =>
      statuses.length === 0
        ? Effect.succeed([])
        : read(
            "listEventsByStatus",
            sql`SELECT * FROM squire_event
              WHERE squire_id = ${squireId} AND status IN ${sql.in(statuses)}
              ORDER BY id`.pipe(Effect.flatMap(decodeEventRows)),
          ),
    listBatchedEvents: read(
      "listBatchedEvents",
      sql`SELECT * FROM squire_event WHERE status = 'batched' ORDER BY squire_id, id`.pipe(
        Effect.flatMap(decodeEventRows),
      ),
    ),
    listBatch: (batchId) =>
      read(
        "listBatch",
        sql`SELECT * FROM squire_event WHERE batch_id = ${batchId} ORDER BY id`.pipe(
          Effect.flatMap(decodeEventRows),
        ),
      ),
    markEventsBatched: ({ ids, batchId }) =>
      ids.length === 0
        ? Effect.succeed(0)
        : write(
            "markEventsBatched",
            sql`UPDATE squire_event SET status = 'batched', batch_id = ${batchId}
              WHERE id IN ${sql.in(ids)} AND status = 'pending'
              RETURNING id`.pipe(Effect.map((rows) => rows.length)),
            (batched) => batched > 0,
          ),
    markBatchDelivered: (batchId) =>
      write(
        "markBatchDelivered",
        sql`UPDATE squire_event SET status = 'delivered'
          WHERE batch_id = ${batchId} AND status = 'batched'
          RETURNING *`.pipe(
          Effect.flatMap(decodeEventRows),
          Effect.map((rows) => rows.toSorted((a, b) => a.id - b.id)),
        ),
        (rows) => rows.length > 0,
      ),
    dropPendingEvents: (ids) =>
      ids.length === 0
        ? Effect.succeed(0)
        : write(
            "dropPendingEvents",
            sql`UPDATE squire_event SET status = 'dropped'
              WHERE id IN ${sql.in(ids)} AND status = 'pending'
              RETURNING id`.pipe(Effect.map((rows) => rows.length)),
            (dropped) => dropped > 0,
          ),
    earliestDeferredAt: read(
      "earliestDeferredAt",
      sql`SELECT min(not_before) AS not_before FROM squire_event
        WHERE status = 'deferred' AND defer_reason IN ('threshold', 'summary')`.pipe(
        Effect.flatMap(decodeNotBefore),
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.not_before)),
      ),
    ),
    listPendingEscalations: read(
      "listPendingEscalations",
      sql`SELECT * FROM squire_card
        WHERE escalate_at IS NOT NULL AND opened_at IS NULL AND kind IN ('steer', 'proposal')
        ORDER BY escalate_at, rowid`.pipe(Effect.flatMap(decodeCards)),
    ),
    listNotificationIntents: ({ squireId, since }) =>
      read(
        "listNotificationIntents",
        // Two indexed halves instead of one OR, which would scan the Squire's whole log.
        sql`WITH intents AS (
            SELECT p.id, p.card_id FROM squire_card c
              JOIN squire_action_log p ON p.card_id = c.id
              WHERE c.status = 'open'
                AND p.squire_id = ${squireId} AND p.kind = 'notification.pushed'
            UNION
            SELECT p.id, p.card_id FROM squire_action_log p
              WHERE p.squire_id = ${squireId} AND p.created_at >= ${since}
                AND p.kind = 'notification.pushed' AND p.card_id IS NOT NULL
          )
          SELECT i.id AS intent_id, c.id AS card_id, c.kind, c.status, c.escalate_at,
            c.target_thread_id,
            (SELECT json_group_array(d.data_json) FROM squire_action_log d
              WHERE d.card_id = c.id AND d.kind = 'notification.delivery') AS deliveries_json
          FROM intents i JOIN squire_card c ON c.id = i.card_id
          ORDER BY i.id`.pipe(Effect.flatMap(decodeNotificationIntents)),
      ),
    listSquiresWithPendingEvents: read(
      "listSquiresWithPendingEvents",
      sql`SELECT DISTINCT squire_id FROM squire_event WHERE status = 'pending'
        ORDER BY squire_id`.pipe(
        Effect.flatMap(decodeSquireIds),
        Effect.map((rows) => rows.map((row) => row.squire_id)),
      ),
    ),
    // ── Integration ──
    resetBatchedEvents: (squireId) =>
      write(
        "resetBatchedEvents",
        sql`UPDATE squire_event SET status = 'pending', batch_id = NULL
          WHERE squire_id = ${squireId} AND status = 'batched'
          RETURNING id`.pipe(Effect.map((rows) => rows.length)),
        (reset) => reset > 0,
      ),
    dropBatch: (batchId) =>
      write(
        "dropBatch",
        sql`UPDATE squire_event SET status = 'dropped'
          WHERE batch_id = ${batchId} AND status = 'batched'
          RETURNING id`.pipe(Effect.map((rows) => rows.length)),
        (dropped) => dropped > 0,
      ),
    // ── Reactor ──
    listEvents: ({ statuses, deferReasons, threadId, kinds, ids, dueBy }) =>
      statuses.length === 0 ||
      deferReasons?.length === 0 ||
      kinds?.length === 0 ||
      ids?.length === 0
        ? Effect.succeed([])
        : read(
            "listEvents",
            sql`SELECT * FROM squire_event WHERE ${sql.and([
              sql`status IN ${sql.in(statuses)}`,
              ...(deferReasons === undefined ? [] : [sql`defer_reason IN ${sql.in(deferReasons)}`]),
              ...(threadId === undefined ? [] : [sql`thread_id = ${threadId}`]),
              ...(kinds === undefined ? [] : [sql`kind IN ${sql.in(kinds)}`]),
              ...(ids === undefined ? [] : [sql`id IN ${sql.in(ids)}`]),
              ...(dueBy === undefined ? [] : [sql`not_before <= ${dueBy}`]),
            ])} ORDER BY id`.pipe(Effect.flatMap(decodeEventRows)),
          ),
    setEventStatus: ({ ids, fromStatuses, status, deferReason, notBefore }) =>
      ids.length === 0 || fromStatuses.length === 0
        ? Effect.succeed([])
        : write(
            "setEventStatus",
            sql`UPDATE squire_event SET ${sql.update({
              status,
              ...(deferReason === undefined ? {} : { defer_reason: deferReason }),
              ...(notBefore === undefined ? {} : { not_before: notBefore }),
            })}
              WHERE id IN ${sql.in(ids)} AND status IN ${sql.in(fromStatuses)}
              RETURNING *`.pipe(
              Effect.flatMap(decodeEventRows),
              Effect.map((rows) => rows.toSorted((a, b) => a.id - b.id)),
            ),
            (rows) => rows.length > 0,
          ),
    deleteThreadEvents: (threadId) =>
      write(
        "deleteThreadEvents",
        sql`DELETE FROM squire_event WHERE thread_id = ${threadId} RETURNING id`.pipe(
          Effect.map((rows) => rows.length),
        ),
        (deleted) => deleted > 0,
      ),
    // The cursor is reactor bookkeeping that advances on every event, so its
    // writes publish nothing. A missing row (migrate-dev-db clears the table)
    // reads as disabled, so the next enabling start fast-forwards it.
    readCursor: read(
      "readCursor",
      sql`SELECT sequence, enabled FROM squire_reactor_cursor WHERE id = 1`.pipe(
        Effect.flatMap(decodeCursor),
        Effect.map((rows) => ({
          sequence: rows[0]?.sequence ?? 0,
          enabled: rows[0]?.enabled === 1,
        })),
      ),
    ),
    writeCursor: ({ sequence, enabled }) =>
      read(
        "writeCursor",
        sql`INSERT INTO squire_reactor_cursor(id, sequence, enabled)
          VALUES (1, ${sequence}, ${enabled ? 1 : 0})
          ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, enabled = excluded.enabled`.pipe(
          Effect.asVoid,
        ),
      ),
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    changeGeneration: Ref.get(generation),
    // ── Dev fixtures ──
    deleteBudgetUsage: (squireId) =>
      write(
        "deleteBudgetUsage",
        sql`DELETE FROM squire_budget_usage WHERE squire_id = ${squireId} RETURNING id`.pipe(
          Effect.map((rows) => rows.length),
        ),
        (deleted) => deleted > 0,
      ),
    getEventByKey: ({ squireId, kind, threadId, stateKey }) =>
      read(
        "getEventByKey",
        sql`SELECT * FROM squire_event
          WHERE squire_id = ${squireId} AND kind = ${kind}
            AND ifnull(thread_id, '') = ${threadId ?? ""} AND state_key = ${stateKey}`.pipe(
          Effect.flatMap(decodeEventRows),
          Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
        ),
      ),
    // ── Read model ──
    listCardStats: read(
      "listCardStats",
      sql`SELECT squire_id, owner_squire_id, kind, status, count(*) AS n,
          max(updated_at) AS last_updated_at
        FROM squire_card GROUP BY squire_id, owner_squire_id, kind, status`.pipe(
        Effect.flatMap(decodeCardStats),
      ),
    ),
    listCardsPage: ({ queueOf, statuses, kinds, before, limit }) =>
      statuses?.length === 0 || kinds?.length === 0
        ? Effect.succeed([])
        : read(
            "listCardsPage",
            sql`SELECT * FROM squire_card WHERE ${sql.and([
              ...(queueOf === undefined
                ? []
                : [sql`(squire_id = ${queueOf} OR owner_squire_id = ${queueOf})`]),
              ...liveCardTerm(statuses),
              ...(statuses === undefined ? [] : [sql`status IN ${sql.in(statuses)}`]),
              ...(kinds === undefined ? [] : [sql`kind IN ${sql.in(kinds)}`]),
              ...(before === undefined ? [] : [sql`created_at < ${before}`]),
            ])} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`.pipe(
              Effect.flatMap(decodeCards),
            ),
          ),
    listActionLogDesc: ({ squireId, kinds, triggerId, beforeId, limit }) =>
      kinds?.length === 0
        ? Effect.succeed([])
        : read(
            "listActionLogDesc",
            sql`SELECT * FROM squire_action_log WHERE ${sql.and([
              sql`squire_id = ${squireId}`,
              ...(kinds === undefined ? [] : [sql`kind IN ${sql.in(kinds)}`]),
              ...(triggerId === undefined ? [] : [sql`trigger_id = ${triggerId}`]),
              ...(beforeId === undefined ? [] : [sql`id < ${beforeId}`]),
            ])} ORDER BY id DESC LIMIT ${limit}`.pipe(Effect.flatMap(decodeActionLogs)),
          ),
    listActionLogForRuns: ({ squireId, kinds, runIds }) =>
      kinds.length === 0 || runIds.length === 0
        ? Effect.succeed([])
        : read(
            "listActionLogForRuns",
            sql`SELECT * FROM squire_action_log
              WHERE squire_id = ${squireId} AND kind IN ${sql.in(kinds)}
                AND run_id IN ${sql.in(runIds)}
              ORDER BY id`.pipe(Effect.flatMap(decodeActionLogs)),
          ),
    listLatestRunSummaries: (threadId) =>
      read(
        "listLatestRunSummaries",
        sql`SELECT * FROM squire_summary WHERE thread_id = ${threadId}
            AND run_id = (SELECT run_id FROM squire_summary WHERE thread_id = ${threadId}
              ORDER BY created_at DESC, rowid DESC LIMIT 1)
          ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeSummaries)),
      ),
    // A user who posts has seen the room, so only others' posts make it unread.
    listRoomRows: ({ closedSince }) =>
      read(
        "listRoomRows",
        sql`SELECT room.id, room.topic, room.status, room.muted, room.last_post_at,
          (SELECT json_group_array(member_id) FROM (
            SELECT member_id FROM squire_room_member AS member
            WHERE member.room_id = room.id AND member.member_kind = 'squire'
            ORDER BY member.rowid)) AS members_json,
          EXISTS(SELECT 1 FROM squire_room_member AS member
            WHERE member.room_id = room.id AND member.member_kind = 'lead') AS includes_lead,
          EXISTS(SELECT 1 FROM squire_room_member AS member
            JOIN squire_room_post AS post ON post.room_id = member.room_id
              AND post.id > ifnull(member.user_seen_cursor, 0) AND post.author_kind != 'user'
            WHERE member.room_id = room.id AND member.member_kind = 'user') AS user_unseen
        FROM squire_room AS room
        WHERE room.status = 'open' OR room.updated_at >= ${closedSince}
        ORDER BY room.created_at, room.rowid`.pipe(Effect.flatMap(decodeRoomRows)),
      ),
  });
});

export const layer = Layer.effect(SquireRepository, make);
