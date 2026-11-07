/**
 * Held executions and accepts under the durable action protocol. Every execution runs under the budget owner's lock, then
 * the target's, reconciles every unfinished execution for both by receipt
 * before it is admitted, and holds the policy lock from re-validation through
 * finalize, so a pause, untrack, permission or rule change either commits
 * before re-validation (which then refuses) or waits until the dispatch has
 * committed. A dispatch error never decides the outcome: the receipt does.
 *
 * Held actions run as the granting user outside the MCP mode guard:
 * nothing raises the target's modes, and the steer is attributed to the
 * Squire (`createdBy: "agent"` plus `senderThreadId`).
 *
 * @module squire/SquireActions
 */
import {
  CommandId,
  MessageId,
  type SquireCardId,
  SquireCardPayload,
  SquireCardStatus,
  SquireCardTrigger,
  SquireError,
  SquireErrorCode,
  type SquireId,
  type SquireItemsActInput,
  type SquireItemsActResult,
  type ThreadId,
  isUnknownUnionMember,
} from "@lecturn/contracts";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  type SquireActionIntent,
  type SquireActionVerb,
  SquireCreateIntent,
  type SquireRoomOpenIntent,
  type SquireSteerIntent,
  type SquireStoreIntent,
  type SquireThreadCreateIntent,
  captureSquirePrecondition,
  decodeSquireActionIntent,
  encodeSquireActionIntent,
  isRoomOpenIntent,
  isSquireStoreIntent,
  squireActionCommandId,
  squirePreconditionBroken,
  squireProposalRequestId,
  steerDispatchMode,
} from "./squireActionIntent.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireControl from "./SquireControl.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import { squirePullRequestRevision, squirePullRequestStates } from "./squireEvents.ts";
import * as SquireItems from "./SquireItems.ts";
import * as SquireLaunchAction from "./SquireLaunchAction.ts";
import { writeLeadItemsResolved } from "./squireLeadItems.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as squirePolicy from "./squirePolicy.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireScope from "./SquireScope.ts";
import { policySquireOf, squireBudgetCaption, toRule as toPolicyRule } from "./SquireTools.ts";
import * as SquireTriggers from "./SquireTriggers.ts";
import { touchUserActivity } from "./squireUserActivity.ts";

type CardRow = SquireRepository.SquireCardRow;
type ItemResult = (typeof SquireItemsActResult.Type)["results"][number];

/**
 * `squire.items.act`. A question card's answer rides along as `answer` until
 * the RPC contract carries it; the act contract itself has only `text`.
 */
export type SquireActionsActInput = typeof SquireItemsActInput.Type & {
  readonly answer?: SquireItems.SquireQuestionAnswer;
};

/** The log row mapping an accept request to its attempt and, once settled, its result. */
const ACCEPTED = "action.accepted";
const decodeAccepted = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      requestId: Schema.String,
      attempt: Schema.Number,
      result: Schema.optionalKey(
        Schema.Struct({
          status: SquireCardStatus,
          error: Schema.NullOr(Schema.Struct({ code: SquireErrorCode, message: Schema.String })),
        }),
      ),
    }),
  ),
);

/** A hold this far past `executes_at` (server down, switch toggled) never executes. */
const SQUIRE_OVERDUE_MS = 60_000;

export const squireActionMessageId = (cardId: SquireCardId, attempt: number) =>
  MessageId.make(`message:squire-action:${cardId}:${attempt}`);

export class SquireActions extends Context.Service<
  SquireActions,
  {
    /** Every hold due by now: past the overdue limit it becomes a card, else it executes. */
    readonly executeDue: Effect.Effect<void, SquireError>;
    /** The earliest `executes_at` among holds and unfinished executions, for the clock. */
    readonly nextDueAt: Effect.Effect<Option.Option<DateTime.Utc>, SquireError>;
    readonly act: (
      input: SquireActionsActInput,
    ) => Effect.Effect<typeof SquireItemsActResult.Type, SquireError>;
    /** Settles every unfinished execution from its receipts; runs once at startup, before the clock arms. */
    readonly reconcileStartup: Effect.Effect<void, SquireError>;
  }
>()("lecturn/squire/SquireActions") {}

const DAY_MS = 24 * 60 * 60 * 1000;
const isSquireError = Schema.is(SquireError);

const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardPayload));
const decodeTrigger = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardTrigger));
const decodeCreateFields = Schema.decodeUnknownOption(SquireCreateIntent.fields.input);
const decodeModelJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The outcome the receipts record for one attempt. */
type Outcome =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly reason: string }
  /** Create committed, initial message not: re-launch replays the create. */
  | { readonly status: "partial" }
  | { readonly status: "absent" };

/** Why an execution is not admitted, and where its card goes. */
type Refusal =
  | { readonly to: "open"; readonly reason: string; readonly caption?: string | undefined }
  | { readonly to: "outdated"; readonly reason: string };

type Built =
  | { readonly ok: true; readonly intent: SquireActionIntent }
  | { readonly ok: false; readonly reason: string };
const built = (intent: SquireActionIntent): Built => ({ ok: true, intent });
const notBuilt = (reason: string): Built => ({ ok: false, reason });

const toOpen = (reason: string, caption?: string): Refusal =>
  caption === undefined ? { to: "open", reason } : { to: "open", reason, caption };
const toOutdated = (reason: string): Refusal => ({ to: "outdated", reason });

/** Intents whose whole effect is one Squire-store transaction, receipted by its `action.executed` row. */
type StoreExecution = SquireStoreIntent | SquireRoomOpenIntent;
const isStoreExecution = (intent: SquireActionIntent): intent is StoreExecution =>
  isSquireStoreIntent(intent) || isRoomOpenIntent(intent);

const keyedLocks = () => {
  const locks = new Map<string, Semaphore.Semaphore>();
  return <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => {
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return lock.withPermits(1)(effect);
  };
};

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const scope = yield* SquireScope.SquireScope;
  const containers = yield* SquireContainers.SquireContainers;
  const { withPolicyLock } = yield* SquirePolicyLock.SquirePolicyLock;
  const rules = yield* Effect.serviceOption(SquireRules.SquireRules);
  const items = yield* Effect.serviceOption(SquireItems.SquireItems);
  const launcher = yield* Effect.serviceOption(SquireLaunchAction.SquireLaunchAction);
  const delivery = yield* Effect.serviceOption(SquireDelivery.SquireDelivery);
  const control = yield* Effect.serviceOption(SquireControl.SquireControl);
  const rooms = yield* Effect.serviceOption(SquireRooms.SquireRooms);
  const triggers = yield* Effect.serviceOption(SquireTriggers.SquireTriggers);

  const withOwner = keyedLocks();
  const withTarget = keyedLocks();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const wakeLead = (lead: Option.Option<SquireId>) =>
    Option.isSome(lead) && Option.isSome(delivery) ? delivery.value.wake(lead.value) : Effect.void;

  const logRow = (
    card: CardRow,
    kind: string,
    data: Record<string, unknown>,
    now: string,
    executionKey: string | null = null,
  ) =>
    repository.insertActionLog({
      squire_id: card.squire_id,
      kind,
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: card.target_thread_id,
      card_id: card.id,
      event_id: null,
      run_id: null,
      invocation_key: null,
      execution_key: executionKey,
      data_json: encodeLogData(data),
      created_at: now,
    });

  const intentOf = (card: CardRow) => decodeSquireActionIntent(card.intent_json);
  /** The lock key of what the action writes to: the target thread, or the thread it creates. */
  const targetKey = (card: CardRow, intent: Option.Option<SquireActionIntent>) =>
    card.target_thread_id ??
    Option.match(intent, {
      onNone: () => `card:${card.id}`,
      onSome: (value) => {
        switch (value.type) {
          case "steer":
            return value.threadId;
          case "thread-create":
            return value.launch.threadId;
          // A Squire-store action writes to the Squire it changes, not a thread.
          case "control":
            return `squire:${value.squireId ?? card.id}`;
          case "squire-create":
          case "room-open":
            return `card:${card.id}`;
        }
      },
    });

  // ── Receipts ──

  const outcomeOf = Effect.fn("SquireActions.outcomeOf")(function* (
    card: CardRow,
    intent: SquireActionIntent,
  ) {
    // A Squire-store execution's receipt is its `action.executed` row.
    if (isStoreExecution(intent)) {
      if (card.command_id === null) return { status: "absent" } satisfies Outcome;
      return Option.isSome(yield* repository.getExecution(card.command_id))
        ? ({ status: "accepted" } satisfies Outcome)
        : ({ status: "absent" } satisfies Outcome);
    }
    if (intent.type === "steer") {
      if (card.command_id === null) return { status: "absent" } satisfies Outcome;
      const receipt = yield* receipts.getByCommandId(CommandId.make(card.command_id));
      return Option.match(receipt, {
        onNone: (): Outcome => ({ status: "absent" }),
        onSome: (found): Outcome =>
          found.status === "accepted"
            ? { status: "accepted" }
            : { status: "rejected", reason: found.error ?? "The thread refused the steer." },
      });
    }
    if (Option.isNone(launcher)) return { status: "absent" } satisfies Outcome;
    const both = yield* launcher.value.receipts(intent.launch);
    if (both.create.status === "rejected") {
      return { status: "rejected", reason: both.create.reason } satisfies Outcome;
    }
    if (both.create.status === "absent") return { status: "absent" } satisfies Outcome;
    if (both.message.status === "accepted") return { status: "accepted" } satisfies Outcome;
    if (both.message.status === "rejected") {
      return { status: "rejected", reason: both.message.reason } satisfies Outcome;
    }
    return { status: "partial" } satisfies Outcome;
  });

  // ── Card transitions ──

  /** One transaction, unique on the execution key, so it charges once. */
  const finalize = Effect.fn("SquireActions.finalize")(function* (
    card: CardRow,
    intent: SquireActionIntent,
    verb: SquireActionVerb,
  ) {
    const executionKey = card.command_id!;
    const now = yield* nowIso;
    const lead = yield* repository.transaction(
      Effect.gen(function* () {
        const done = yield* repository.updateCard({
          id: card.id,
          fromStatuses: ["accepting", "executing"],
          patch:
            verb === "execute"
              ? {
                  status: "executed",
                  resolution: "executed",
                  execution_key: executionKey,
                  executes_at: null,
                }
              : {
                  status: "resolved",
                  resolution: "accepted",
                  execution_key: executionKey,
                  executes_at: null,
                },
          updatedAt: now,
        });
        if (Option.isNone(done)) return Option.none<SquireId>();
        // A Squire-store execution committed its own row; it charges no budget.
        if (
          !isStoreExecution(intent) &&
          Option.isNone(yield* repository.getExecution(executionKey))
        ) {
          const steer = intent.type === "steer";
          yield* repository.insertBudgetUsage({
            squire_id: card.owner_squire_id,
            thread_id: steer ? intent.threadId : null,
            kind: steer ? "steer" : "thread",
            room_id: null,
            executed_at: now,
            execution_key: executionKey,
          });
          yield* logRow(
            done.value,
            "action.executed",
            steer
              ? {
                  action: "steer",
                  verb,
                  threadId: intent.threadId,
                  dispatchMode: intent.dispatchMode,
                  steerKind: intent.steerKind,
                  attempt: card.attempt,
                }
              : {
                  action: "create_thread",
                  verb,
                  threadId: intent.launch.threadId,
                  projectId: intent.launch.projectId,
                  attempt: card.attempt,
                },
            now,
            executionKey,
          );
          if (!steer) {
            yield* repository.insertGrant({
              squire_id: card.owner_squire_id,
              kind: "thread",
              target_id: intent.launch.threadId,
              origin: "created",
              created_at: now,
            });
          }
        }
        return yield* writeLeadItemsResolved(repository, [done.value], now);
      }),
    );
    yield* wakeLead(lead);
  });

  const notifyOn = (squireId: SquireId) =>
    repository.getSquire(squireId).pipe(
      Effect.map((row) =>
        Option.match(row, {
          onNone: () => false,
          onSome: (squire) => policySquireOf(squire).permissions.notify === "on",
        }),
      ),
    );

  /**
   * The action becomes a recommendation card.
   * `push` is false for Undo: the user is already looking. An
   * older open card for the same target and kind is superseded.
   */
  const reopen = Effect.fn("SquireActions.reopen")(function* (
    card: CardRow,
    fromStatuses: ReadonlyArray<CardRow["status"]>,
    reason: string,
    options: {
      readonly caption?: string | undefined;
      readonly push: boolean;
      readonly undone?: boolean;
    },
  ) {
    const now = yield* nowIso;
    const push = options.push && (yield* notifyOn(card.owner_squire_id));
    return yield* repository.transaction(
      Effect.gen(function* () {
        const current = yield* repository.getCard(card.id);
        if (Option.isNone(current) || !fromStatuses.includes(current.value.status)) {
          return Option.none<CardRow>();
        }
        // The older card leaves the open slot first, or squire_card_one_open rejects the reopen.
        if (card.target_thread_id !== null) {
          const older = yield* repository.listCards({
            squireId: card.squire_id,
            targetThreadId: card.target_thread_id,
            kinds: [card.kind],
            statuses: ["open"],
          });
          for (const other of older) {
            if (other.id === card.id) continue;
            yield* repository.updateCard({
              id: other.id,
              fromStatuses: ["open"],
              patch: { status: "outdated", resolution: "superseded" },
              updatedAt: now,
            });
          }
        }
        const opened = yield* repository.updateCard({
          id: card.id,
          fromStatuses,
          patch: { status: "open", executes_at: null },
          updatedAt: now,
        });
        if (Option.isNone(opened)) return Option.none<CardRow>();
        if (options.undone === true) {
          yield* logRow(opened.value, "action.undone", { attempt: card.attempt }, now);
        } else if (fromStatuses.includes("held") || fromStatuses.includes("executing")) {
          yield* logRow(opened.value, "action.cancelled", { reason, to: "card" }, now);
        }
        yield* logRow(
          opened.value,
          "card.created",
          {
            kind: card.kind,
            origin: card.origin,
            caption: options.caption ?? null,
            reason,
            ...(card.steer_kind === null ? {} : { steerKind: card.steer_kind }),
          },
          now,
        );
        if (push) {
          yield* logRow(
            opened.value,
            "notification.pushed",
            { kind: card.kind, source: "card" },
            now,
          );
        }
        return Option.some(opened.value);
      }),
    );
  });

  const outdate = Effect.fn("SquireActions.outdate")(function* (
    card: CardRow,
    fromStatuses: ReadonlyArray<CardRow["status"]>,
    reason: string,
  ) {
    const now = yield* nowIso;
    const lead = yield* repository.transaction(
      Effect.gen(function* () {
        const moved = yield* repository.updateCard({
          id: card.id,
          fromStatuses,
          patch: { status: "outdated", resolution: "outdated", executes_at: null },
          updatedAt: now,
        });
        if (Option.isNone(moved)) return Option.none<SquireId>();
        yield* logRow(moved.value, "action.cancelled", { reason, to: "outdated" }, now);
        return yield* writeLeadItemsResolved(repository, [moved.value], now);
      }),
    );
    yield* wakeLead(lead);
  });

  const refuseTo = (
    card: CardRow,
    fromStatuses: ReadonlyArray<CardRow["status"]>,
    refusal: Refusal,
  ) =>
    refusal.to === "outdated"
      ? outdate(card, fromStatuses, refusal.reason)
      : reopen(card, fromStatuses, refusal.reason, { caption: refusal.caption, push: true }).pipe(
          Effect.asVoid,
        );

  // ── Reconcile ──

  /** Settles one unfinished execution from its receipts; no re-validation, no `sendToThread`. */
  const reconcileOne = Effect.fn("SquireActions.reconcileOne")(function* (card: CardRow) {
    const intent = intentOf(card);
    if (Option.isNone(intent) || card.command_id === null) return;
    const verb: SquireActionVerb = card.status === "accepting" ? "accept" : "execute";
    const outcome = yield* outcomeOf(card, intent.value);
    switch (outcome.status) {
      case "accepted":
        return yield* finalize(card, intent.value, verb);
      case "rejected":
        return yield* reopen(card, [card.status], outcome.reason, { push: false });
      case "partial":
        if (intent.value.type === "thread-create") yield* relaunch(card, intent.value, verb);
        return;
      case "absent":
        // Nothing committed and, under the owner lock, nothing in flight: its
        // own timer or accept runs it.
        return;
    }
  });

  const reconcileFor = Effect.fn("SquireActions.reconcileFor")(function* (
    owner: SquireId,
    target: string,
  ) {
    const unfinished = yield* repository.listCards({ statuses: ["accepting", "executing"] });
    for (const card of unfinished) {
      if (card.command_id === null) continue;
      const key = targetKey(card, intentOf(card));
      if (card.owner_squire_id !== owner && key !== target) continue;
      yield* reconcileOne(card);
    }
  });

  // ── Re-validation ──

  const budgetRowsOf = (squireId: SquireId, now: string) =>
    repository
      .listBudgetUsage({
        squireId,
        since: DateTime.formatIso(
          DateTime.subtract(DateTime.makeUnsafe(now), { milliseconds: DAY_MS }),
        ),
      })
      .pipe(
        Effect.map((rows) =>
          rows.map((row): squirePolicy.SquirePolicyBudgetRow => ({
            kind: row.kind,
            threadId: row.thread_id,
            executedAt: row.executed_at,
          })),
        ),
      );

  const rulesOf = (squireId: SquireId) =>
    repository
      .listRules({ squireId })
      .pipe(Effect.map((rows) => rows.flatMap((row) => Option.toArray(toPolicyRule(row)))));

  const trackersFor = Effect.fn("SquireActions.trackersFor")(function* (threadId: ThreadId) {
    const trackers: Array<squirePolicy.SquirePolicyTracker> = [];
    for (const id of yield* scope.trackersOf(threadId)) {
      const row = yield* repository.getSquire(id);
      if (Option.isSome(row)) {
        trackers.push({ squire: policySquireOf(row.value), rules: yield* rulesOf(id) });
      }
    }
    return trackers;
  });

  const reasonText: Record<squirePolicy.SquirePolicyReason, string> = {
    permission: "this Squire's permission no longer allows it",
    "single-auto": "another Squire holds Auto on this thread",
    budget: "budget reached",
    voice: "a voice note never sends on its own",
    origin: "this turn's origin only recommends",
    rule: "an ask-first rule matched",
    intersection: "the owning Squire's permission is lower",
    paused: "this Squire is paused",
  };

  const refusalOf = (decision: squirePolicy.SquirePolicyDecision, caption: () => string): Refusal =>
    toOpen(reasonText[decision.reason], decision.reason === "budget" ? caption() : undefined);

  /**
   * The user's own accept needs only a class that is not Off, paused or not.
   * `decide` answers a pause before it reads the class or the Lead's
   * intersection with the owner, so both are read here as if active.
   */
  const acceptRefusal = (input: squirePolicy.SquirePolicyInput) => {
    const decision = squirePolicy.decide({
      ...input,
      squire: { ...input.squire, status: "active" },
      ...(input.lead === undefined ? {} : { lead: { ...input.lead, status: "active" } }),
    });
    return decision.level === "off" ? toOpen(reasonText[decision.reason]) : undefined;
  };

  /** Why the PR transition a steer answers (its card's trigger) no longer holds, if it does not. */
  const pullRequestMoved = Effect.fn("SquireActions.pullRequestMoved")(function* (
    card: CardRow,
    threadId: ThreadId,
  ) {
    const trigger = Option.getOrUndefined(decodeTrigger(card.trigger_json));
    const { prKey, headSha, transition } = trigger ?? {};
    if (prKey === undefined || headSha === undefined || transition === undefined) {
      return undefined;
    }
    const shell = yield* projections.getThreadShell(threadId);
    const snapshot =
      (shell?.pullRequests ?? []).find((link) => threadPullRequestKeyOf(link) === prKey)
        ?.snapshot ?? null;
    const holds =
      snapshot !== null &&
      squirePullRequestRevision(snapshot) === headSha &&
      squirePullRequestStates(snapshot).some((state) => state === transition);
    return holds ? undefined : "the pull request changed";
  });

  /** Undefined when the action may dispatch now. Runs inside the policy lock. */
  const revalidate = Effect.fn("SquireActions.revalidate")(function* (
    card: CardRow,
    intent: SquireActionIntent,
    verb: SquireActionVerb,
  ) {
    // SquireControl and SquireRooms re-validate Squire-store actions under their own policy lock.
    if (isStoreExecution(intent)) return undefined;
    const row = yield* repository.getSquire(card.owner_squire_id);
    if (Option.isNone(row) || row.value.lifecycle === "deleting") {
      return toOutdated("the Squire was deleted");
    }
    const squire = policySquireOf(row.value);
    // A Lead-raised item acts at the lower of the Lead's and the owner's levels.
    const raiser =
      card.squire_id === card.owner_squire_id
        ? Option.none()
        : yield* repository.getSquire(card.squire_id);
    const lead =
      Option.isSome(raiser) && raiser.value.role === "lead"
        ? { lead: policySquireOf(raiser.value) }
        : {};
    const now = yield* nowIso;
    const budgetRows = yield* budgetRowsOf(squire.id, now);
    if (intent.type === "steer") {
      // Settled or archived work has nothing to steer; the card goes, not back to open.
      const shell = yield* projections.getThreadShell(intent.threadId);
      if (shell !== null && (shell.settledAt !== null || shell.archivedAt !== null)) {
        return toOutdated(
          shell.archivedAt !== null ? "the thread was archived" : "the thread was settled",
        );
      }
      const target = (yield* scope.isTracked(squire.id, intent.threadId))
        ? yield* scope.targetOf(intent.threadId)
        : Option.none();
      if (Option.isNone(target)) return toOpen("the thread is no longer in scope");
      const broken = yield* squirePreconditionBroken(
        projections,
        intent.threadId,
        intent.precondition,
      );
      if (broken !== undefined) return toOutdated(broken);
      const moved = yield* pullRequestMoved(card, intent.threadId);
      if (moved !== undefined) return toOutdated(moved);
      const input: squirePolicy.SquirePolicyInput = {
        actionClass: "steer",
        squire,
        rules: yield* rulesOf(squire.id),
        target: target.value,
        trackers: yield* trackersFor(intent.threadId),
        budgetRows,
        origin: card.origin,
        steerKind: intent.steerKind,
        now,
        ...lead,
      };
      if (verb === "accept") return acceptRefusal(input);
      const decision = squirePolicy.decide(input);
      if (decision.level === "auto") return undefined;
      return refusalOf(decision, () =>
        squireBudgetCaption({
          actionClass: "steer",
          budgets: squire.budgets,
          threadId: intent.threadId,
          budgetRows,
          now,
        }),
      );
    }
    const projectId = intent.launch.projectId;
    const inScope = yield* scope.ruleTargetInScope({
      squireId: squire.id,
      targetKind: "project",
      targetId: projectId,
    });
    const stave = yield* containers.ofProject(projectId);
    if (
      !inScope &&
      !(
        stave.status === "known" &&
        ((yield* scope.ruleTargetInScope({
          squireId: squire.id,
          targetKind: "staveSpace",
          targetId: stave.spaceId ?? "",
        })) ||
          (yield* scope.ruleTargetInScope({
            squireId: squire.id,
            targetKind: "staveSaga",
            targetId: stave.sagaId ?? "",
          })))
      )
    ) {
      return toOpen("the project is no longer in scope");
    }
    const input: squirePolicy.SquirePolicyInput = {
      actionClass: "createThread",
      squire,
      rules: yield* rulesOf(squire.id),
      target: {
        threadId: null,
        projectId,
        staveSpaceId: stave.status === "known" ? stave.spaceId : null,
        staveSagaId: stave.status === "known" ? stave.sagaId : null,
      },
      trackers: [],
      budgetRows,
      origin: card.origin,
      now,
      ...lead,
    };
    if (verb === "accept") return acceptRefusal(input);
    const decision = squirePolicy.decide(input);
    if (decision.level === "auto") return undefined;
    return refusalOf(decision, () =>
      squireBudgetCaption({
        actionClass: "createThread",
        budgets: squire.budgets,
        threadId: null,
        budgetRows,
        now,
      }),
    );
  });

  // ── Dispatch ──

  const sendSteer = Effect.fn("SquireActions.sendSteer")(function* (
    card: CardRow,
    intent: SquireSteerIntent,
    verb: SquireActionVerb,
  ) {
    const shell = yield* projections.getThreadShell(intent.threadId);
    const squire = yield* repository.getSquire(card.owner_squire_id);
    const sender = Option.getOrNull(Option.map(squire, (row) => row.home_thread_id));
    if (shell === null) return yield* Effect.fail("The thread no longer exists.");
    yield* threads.sendToThread({
      projectId: shell.projectId,
      commandId: CommandId.make(card.command_id!),
      threadId: intent.threadId,
      messageId: squireActionMessageId(card.id, card.attempt),
      ...(verb === "execute" && sender !== null ? { senderThreadId: sender } : {}),
      text: intent.text,
      attachments: [],
      // Never `steer`/`restart`, so no interrupt-restart on drivers without active steering.
      mode: intent.dispatchMode,
      createdBy: verb === "execute" ? "agent" : "user",
      creationSource: "server",
    });
  }, withSquireDispatchOrigin);

  /** Re-calls `launch` for a create whose message is missing; a refusal archives the empty thread. */
  const relaunch = Effect.fn("SquireActions.relaunch")(function* (
    card: CardRow,
    intent: SquireThreadCreateIntent,
    verb: SquireActionVerb,
  ) {
    if (Option.isNone(launcher)) return;
    const launched = yield* launcher.value
      .launch(intent.launch)
      .pipe(withSquireDispatchOrigin, Effect.result);
    const outcome = yield* outcomeOf(card, intent);
    if (outcome.status === "accepted") return yield* finalize(card, intent, verb);
    if (outcome.status === "rejected") {
      yield* launcher.value.archiveEmpty(intent.launch);
      yield* reopen(card, [card.status], outcome.reason, { push: false });
      return;
    }
    if (Result.isFailure(launched) && launched.failure._tag === "SquireLaunchRefused") {
      yield* launcher.value.archiveEmpty(intent.launch);
      yield* reopen(card, [card.status], launched.failure.reason, { push: false });
    }
  });

  /** Dispatches and settles the attempt from its receipt. Returns the user-facing error, if any. */
  const dispatchAndSettle = Effect.fn("SquireActions.dispatchAndSettle")(function* (
    card: CardRow,
    intent: SquireActionIntent,
    verb: SquireActionVerb,
  ) {
    if (isStoreExecution(intent)) return yield* runStore(card, intent, verb);
    let failure: string | undefined;
    if (intent.type === "steer") {
      const sent = yield* sendSteer(card, intent, verb).pipe(Effect.result);
      if (Result.isFailure(sent)) failure = messageOf(sent.failure);
    } else {
      if (Option.isNone(launcher)) {
        return "Thread creation is not available on this server.";
      }
      const launched = yield* launcher.value
        .launch(intent.launch)
        .pipe(withSquireDispatchOrigin, Effect.result);
      if (Result.isFailure(launched)) {
        if (launched.failure._tag === "SquireLaunchRefused") {
          const outcome = yield* outcomeOf(card, intent);
          if (outcome.status === "accepted") {
            yield* finalize(card, intent, verb);
            return undefined;
          }
          if (outcome.status === "partial") yield* launcher.value.archiveEmpty(intent.launch);
          yield* reopen(card, [card.status], launched.failure.reason, {
            push: verb === "execute",
          });
          return launched.failure.reason;
        }
        failure = messageOf(launched.failure);
      }
    }
    // A dispatch error is an unknown outcome: the projection read runs after the commit.
    const outcome = yield* outcomeOf(card, intent);
    switch (outcome.status) {
      case "accepted":
        yield* finalize(card, intent, verb);
        return undefined;
      case "rejected":
        yield* reopen(card, [card.status], outcome.reason, { push: verb === "execute" });
        return outcome.reason;
      case "partial":
        if (intent.type === "thread-create") yield* relaunch(card, intent, verb);
        return undefined;
      case "absent": {
        // The hook's refusal or a newer state since: the trigger no longer holds.
        if (intent.type === "steer") {
          const broken = yield* squirePreconditionBroken(
            projections,
            intent.threadId,
            intent.precondition,
          );
          if (broken !== undefined) {
            yield* outdate(card, [card.status], broken);
            return `Not sent: ${broken}.`;
          }
        }
        const reason = failure ?? "The action did not run.";
        // An accept answers the user now; a held execution keeps its timer
        // and retries until it is overdue.
        if (verb === "accept") yield* reopen(card, [card.status], reason, { push: false });
        else
          yield* Effect.logWarning("Squire held action did not dispatch; retrying", {
            cardId: card.id,
            reason,
          });
        return reason;
      }
    }
  });

  const messageOf = (cause: unknown) =>
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "The dispatch failed.";

  /**
   * A Squire-store action: `SquireControl.apply` commits it with its
   * `action.executed` row and takes the policy lock itself, so the caller
   * holds only the owner and target locks. Returns the user-facing error.
   */
  const runStore = Effect.fn("SquireActions.runStore")(function* (
    card: CardRow,
    intent: StoreExecution,
    verb: SquireActionVerb,
  ) {
    if (isRoomOpenIntent(intent) ? Option.isNone(rooms) : Option.isNone(control)) {
      const reason = "Lead actions are not available on this server.";
      // A hold without its executor waits; the overdue limit turns it into a card.
      if (verb === "execute") return reason;
      yield* reopen(card, [card.status], reason, { push: false });
      return reason;
    }
    let current = card;
    if (verb === "execute" && card.status === "held") {
      const executing = yield* repository.updateCard({
        id: card.id,
        fromStatuses: ["held"],
        patch: { status: "executing" },
        updatedAt: yield* nowIso,
      });
      if (Option.isNone(executing)) return undefined;
      current = executing.value;
    }
    const options = { executionKey: current.command_id!, now: yield* nowIso, verb };
    // `applyOpen` gates a Lead room open on Manage Squires under the policy lock.
    const outcome = isRoomOpenIntent(intent)
      ? yield* Option.getOrThrow(rooms).applyOpen(intent, options)
      : yield* Option.getOrThrow(control).apply(intent, options);
    if (outcome.ok) {
      yield* finalize(current, intent, verb);
      return undefined;
    }
    yield* outcome.to === "outdated"
      ? outdate(current, [current.status], outcome.reason)
      : reopen(current, [current.status], outcome.reason, { push: verb === "execute" }).pipe(
          Effect.asVoid,
        );
    return outcome.reason;
  });

  // ── Held execution ──

  const executeOne = Effect.fn("SquireActions.executeOne")(function* (cardId: SquireCardId) {
    const found = yield* repository.getCard(cardId);
    if (Option.isNone(found)) return;
    const first = found.value;
    const intent = intentOf(first);
    yield* withOwner(
      first.owner_squire_id,
      withTarget(
        targetKey(first, intent),
        Effect.gen(function* () {
          yield* reconcileFor(first.owner_squire_id, targetKey(first, intent));
          const current = yield* repository.getCard(cardId);
          if (Option.isNone(current)) return;
          const card = current.value;
          if (card.status !== "held" && card.status !== "executing") return;
          const stored = intentOf(card);
          if (Option.isNone(stored) || card.command_id === null) {
            return yield* reopen(card, [card.status], "the held action has no intent", {
              push: true,
            });
          }
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const due = card.executes_at === null ? now : Date.parse(card.executes_at);
          if (due > now) return;
          if (now - due > SQUIRE_OVERDUE_MS) {
            // Never executed late; outdated when the trigger went obsolete meanwhile.
            const broken =
              stored.value.type === "steer"
                ? yield* squirePreconditionBroken(
                    projections,
                    stored.value.threadId,
                    stored.value.precondition,
                  )
                : undefined;
            return yield* broken === undefined
              ? reopen(card, [card.status], "the hold was overdue", { push: true }).pipe(
                  Effect.asVoid,
                )
              : outdate(card, [card.status], broken);
          }
          if (isStoreExecution(stored.value)) {
            yield* runStore(card, stored.value, "execute");
            return;
          }
          yield* withPolicyLock(
            Effect.gen(function* () {
              const refusal = yield* revalidate(card, stored.value, "execute");
              if (refusal !== undefined) return yield* refuseTo(card, [card.status], refusal);
              const executing = yield* repository.updateCard({
                id: card.id,
                fromStatuses: [card.status],
                patch: { status: "executing" },
                updatedAt: yield* nowIso,
              });
              if (Option.isNone(executing)) return;
              yield* dispatchAndSettle(executing.value, stored.value, "execute");
            }),
          );
        }),
      ),
    );
  });

  const executeDue: SquireActions["Service"]["executeDue"] = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const cards = yield* repository.listCards({ statuses: ["held", "executing"] });
    for (const card of cards) {
      if (card.executes_at !== null && Date.parse(card.executes_at) > now) continue;
      yield* executeOne(card.id).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire held action failed; the next tick retries", {
            cardId: card.id,
            cause,
          }),
        ),
      );
    }
  }).pipe(orSquireError("run held actions"), Effect.withSpan("SquireActions.executeDue"));

  const nextDueAt: SquireActions["Service"]["nextDueAt"] = repository
    .listCards({ statuses: ["held", "executing"] })
    .pipe(
      Effect.map((cards) =>
        cards.reduce<Option.Option<DateTime.Utc>>((earliest, card) => {
          if (card.executes_at === null) return earliest;
          const at = DateTime.makeUnsafe(card.executes_at);
          return Option.isNone(earliest) || DateTime.isLessThan(at, earliest.value)
            ? Option.some(at)
            : earliest;
        }, Option.none()),
      ),
      orSquireError("read held actions"),
    );

  const reconcileStartup: SquireActions["Service"]["reconcileStartup"] = Effect.gen(function* () {
    const unfinished = yield* repository.listCards({ statuses: ["accepting", "executing"] });
    for (const card of unfinished) {
      const intent = intentOf(card);
      yield* withOwner(
        card.owner_squire_id,
        withTarget(
          targetKey(card, intent),
          Effect.gen(function* () {
            const current = yield* repository.getCard(card.id);
            if (Option.isNone(current) || current.value.status !== card.status) return;
            yield* reconcileOne(current.value);
            // An accept a crash interrupted before its dispatch: the user's
            // intent (with their edited text) still stands, re-validated.
            const after = yield* repository.getCard(card.id);
            if (Option.isSome(after) && after.value.status === "accepting") {
              const stored = intentOf(after.value);
              if (Option.isSome(stored)) yield* admitAccept(after.value, stored.value);
            }
          }),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire startup reconcile failed for a card", {
            cardId: card.id,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    orSquireError("reconcile Squire actions"),
    Effect.withSpan("SquireActions.reconcileStartup"),
  );

  // ── Accept ──

  /** Steps 4-6 of an accept whose intent is stored; the caller holds the owner and target locks. */
  const admitAccept = (card: CardRow, intent: SquireActionIntent) =>
    isStoreExecution(intent)
      ? runStore(card, intent, "accept")
      : withPolicyLock(
          Effect.gen(function* () {
            const refusal = yield* revalidate(card, intent, "accept");
            if (refusal !== undefined) {
              yield* refusal.to === "outdated"
                ? outdate(card, ["accepting"], refusal.reason)
                : reopen(card, ["accepting"], refusal.reason, { push: false }).pipe(Effect.asVoid);
              return refusal.reason;
            }
            return yield* dispatchAndSettle(card, intent, "accept");
          }),
        );

  /** The accept's intent: the user's final text, the target as it is now. */
  const acceptIntent = Effect.fn("SquireActions.acceptIntent")(function* (
    card: CardRow,
    text: string | undefined,
    attempt: number,
  ) {
    const decoded = decodePayload(card.payload_json);
    const payload =
      Option.isSome(decoded) && !isUnknownUnionMember(decoded.value) ? decoded.value : null;
    if (payload?.type === "steer") {
      const threadId = payload.threadId;
      return built({
        type: "steer",
        threadId,
        text: (text ?? payload.steer).trim(),
        steerKind: payload.steerKind,
        dispatchMode: yield* steerDispatchMode(projections, threadId),
        precondition: yield* captureSquirePrecondition(projections, threadId),
      });
    }
    if (payload?.type === "thread-proposal") {
      if (Option.isNone(launcher))
        return notBuilt("Thread creation is not available on this server.");
      // The new thread's Squire is the owner; the Lead creates no threads.
      const squire = yield* repository.getSquire(card.owner_squire_id);
      if (Option.isNone(squire)) return notBuilt("The Squire was deleted.");
      const launch = yield* launcher.value
        .intentFor({
          card,
          squire: squire.value,
          proposal: payload,
          text: text ?? payload.firstPrompt,
          verb: "accept",
          attempt,
        })
        .pipe(Effect.result);
      if (Result.isFailure(launch)) {
        return notBuilt(
          launch.failure._tag === "SquireLaunchRefused"
            ? launch.failure.reason
            : "Could not prepare the thread. Try again.",
        );
      }
      return built({ type: "thread-create", launch: launch.success, precondition: {} });
    }
    if (payload?.type === "control") return built(SquireControl.controlIntentOf(card, payload));
    if (payload?.type === "room-proposal") {
      const proposal =
        payload.proposalId === null
          ? Option.none()
          : yield* repository.getEventByKey({
              squireId: card.squire_id,
              kind: "room-proposed",
              threadId: null,
              stateKey: payload.proposalId,
            });
      return built({
        type: "room-open",
        leadId: card.squire_id,
        members: payload.members,
        includesLead: payload.includesLead,
        topic: payload.topic,
        about: payload.about,
        reason: card.why,
        proposalId: payload.proposalId,
        proposalEventId: Option.getOrNull(Option.map(proposal, (row) => row.id)),
      });
    }
    if (payload?.type === "squire-proposal") {
      const lead = yield* repository.getSquire(card.squire_id);
      if (Option.isNone(lead)) return notBuilt("The Lead no longer exists.");
      const instance = lead.value.provider_instance_id;
      if (instance === null) return notBuilt("Choose a provider for the Lead first.");
      // The proposed Squire runs on the Lead's provider, with default events and budgets.
      const model =
        lead.value.model_selection_json === null
          ? undefined
          : Option.getOrUndefined(decodeModelJson(lead.value.model_selection_json));
      const fields = decodeCreateFields({
        homeProjectId: card.project_id ?? lead.value.home_project_id,
        providerInstanceId: instance,
        ...(model === undefined ? {} : { modelSelection: model }),
        name: payload.name,
        brief: payload.brief,
        grants: payload.grants,
        events: {},
        permissions: {
          steer: payload.permissions.steer,
          createThread: payload.permissions.createThread,
          notify: payload.permissions.notify,
        },
        budgets: {},
        companion: payload.companion,
      });
      if (Option.isNone(fields)) return notBuilt("This proposal cannot be accepted.");
      return built({
        type: "squire-create",
        input: fields.value,
        requestId: squireProposalRequestId(card.id, attempt),
      });
    }
    return notBuilt("This item cannot be accepted.");
  });

  /** An open card whose trigger is already obsolete is outdated, even if the reactor lags. */
  const triggerObsolete = Effect.fn("SquireActions.triggerObsolete")(function* (card: CardRow) {
    if (card.target_thread_id === null) return undefined;
    const trigger = Option.getOrUndefined(decodeTrigger(card.trigger_json));
    const shell = yield* projections.getThreadShell(card.target_thread_id);
    if (shell === null) return "the thread no longer exists";
    if (
      trigger?.runId !== undefined &&
      shell.latestRunId !== null &&
      trigger.runId !== shell.latestRunId
    ) {
      return "a newer turn started in the thread";
    }
    return undefined;
  });

  const result = (
    card: CardRow,
    error?: { readonly code: SquireError["code"]; readonly message: string },
  ): ItemResult => ({
    cardId: card.id,
    status: card.status,
    error: error ?? null,
  });

  /**
   * The newest `action.accepted` row of this request for the card: the
   * attempt it allocated and, once it settled, the result it returned.
   */
  const acceptedFor = (cardId: SquireCardId, requestId: string) =>
    repository
      .listCardLog({ cardId, kinds: [ACCEPTED] })
      .pipe(
        Effect.map((rows) =>
          rows
            .flatMap((row) => Option.toArray(decodeAccepted(row.data_json)))
            .findLast((logged) => logged.requestId === requestId),
        ),
      );

  /**
   * The same request retried replays its result and never allocates a new
   * attempt: after a rejection reopened the card, a new attempt would send
   * whatever the card holds now.
   */
  const acceptOne = Effect.fn("SquireActions.acceptOne")(function* (
    cardId: SquireCardId,
    text: string | undefined,
    requestId: string,
  ) {
    const found = yield* repository.getCard(cardId);
    if (Option.isNone(found))
      return yield* new SquireError({
        code: "not_found",
        message: "This item no longer exists.",
      });
    const first = found.value;
    const intent = intentOf(first);
    return yield* withOwner(
      first.owner_squire_id,
      withTarget(
        targetKey(first, intent),
        Effect.gen(function* () {
          yield* reconcileFor(first.owner_squire_id, targetKey(first, intent));
          let card = Option.getOrThrow(yield* repository.getCard(cardId));
          const earlier = yield* acceptedFor(card.id, requestId);
          if (earlier?.result !== undefined) {
            return {
              cardId: card.id,
              status: earlier.result.status,
              error: earlier.result.error,
            };
          }
          // Settled without its result row (a crash, then the startup reconcile).
          if (
            earlier !== undefined &&
            !(card.status === "accepting" && card.attempt === earlier.attempt)
          ) {
            return result(card);
          }
          switch (card.status) {
            case "outdated":
              return result(card, { code: "outdated", message: "This item is outdated." });
            case "dismissed":
              return result(card, {
                code: "invalid_request",
                message: "This item was dismissed.",
              });
            case "resolved":
            case "executed":
            case "executing":
              // An identical retry, or the hold is already running.
              return result(card);
            case "accepting":
              // A retry of the same accept: the stored attempt and intent.
              break;
            case "held":
            case "open": {
              if (card.kind !== "steer" && card.kind !== "proposal") {
                const now = yield* nowIso;
                const resolved = yield* repository.updateCard({
                  id: card.id,
                  fromStatuses: [card.status],
                  patch: { status: "resolved", resolution: "accepted" },
                  updatedAt: now,
                });
                return result(Option.getOrElse(resolved, () => card));
              }
              const obsolete = card.status === "open" ? yield* triggerObsolete(card) : undefined;
              if (obsolete !== undefined) {
                yield* outdate(card, ["open"], obsolete);
                return result(
                  { ...card, status: "outdated" },
                  { code: "outdated", message: `This item is outdated: ${obsolete}.` },
                );
              }
              // A new attempt: a rejected receipt replays forever, so a retry
              // after a rejection needs its own command id.
              const attempt = card.attempt + 1;
              const prepared = yield* acceptIntent(card, text, attempt);
              if (!prepared.ok) {
                return result(card, { code: "invalid_request", message: prepared.reason });
              }
              const acceptedAt = yield* nowIso;
              const written = yield* repository.transaction(
                Effect.gen(function* () {
                  const accepting = yield* repository.updateCard({
                    id: card.id,
                    fromStatuses: [card.status],
                    patch: {
                      status: "accepting",
                      attempt,
                      command_id: squireActionCommandId("accept", card.id, attempt),
                      intent_json: encodeSquireActionIntent(prepared.intent),
                      executes_at: null,
                    },
                    updatedAt: acceptedAt,
                  });
                  if (Option.isSome(accepting)) {
                    yield* logRow(accepting.value, ACCEPTED, { requestId, attempt }, acceptedAt);
                  }
                  return accepting;
                }),
              );
              if (Option.isNone(written)) {
                return result(card, {
                  code: "outdated",
                  message: "This item changed meanwhile.",
                });
              }
              card = written.value;
              break;
            }
            default:
              return result(card, {
                code: "invalid_request",
                message: "This item cannot be accepted.",
              });
          }
          const stored = intentOf(card);
          if (Option.isNone(stored)) {
            return result(card, {
              code: "invalid_request",
              message: "This item cannot be accepted.",
            });
          }
          const failure = yield* admitAccept(card, stored.value);
          const after = Option.getOrElse(yield* repository.getCard(cardId), () => card);
          const settled: ItemResult =
            after.status === "resolved"
              ? Option.match(
                  Option.isSome(rules) ? yield* rules.value.offerFor(after) : Option.none(),
                  {
                    onNone: () => result(after),
                    onSome: (ruleOffer) => ({ ...result(after), ruleOffer }),
                  },
                )
              : result(
                  after,
                  failure === undefined
                    ? undefined
                    : {
                        code: after.status === "outdated" ? "outdated" : "not_available",
                        message: failure,
                      },
                );
          yield* logRow(
            after,
            ACCEPTED,
            {
              requestId,
              attempt: card.attempt,
              result: { status: settled.status, error: settled.error },
            },
            yield* nowIso,
          );
          return settled;
        }),
      ),
    );
  });

  const dismissOne = Effect.fn("SquireActions.dismissOne")(function* (cardId: SquireCardId) {
    const found = yield* repository.getCard(cardId);
    if (Option.isNone(found))
      return yield* new SquireError({
        code: "not_found",
        message: "This item no longer exists.",
      });
    const card = found.value;
    if (card.status === "dismissed") return result(card);
    const now = yield* nowIso;
    const lead = yield* repository.transaction(
      Effect.gen(function* () {
        const moved = yield* repository.updateCard({
          id: card.id,
          fromStatuses: ["open", "held"],
          patch: { status: "dismissed", resolution: "dismissed", executes_at: null },
          updatedAt: now,
        });
        if (Option.isNone(moved)) return { moved, lead: Option.none<SquireId>() };
        if (card.status === "held") {
          yield* logRow(
            moved.value,
            "action.cancelled",
            { reason: "dismissed", to: "dismissed" },
            now,
          );
        }
        return { moved, lead: yield* writeLeadItemsResolved(repository, [moved.value], now) };
      }),
    );
    yield* wakeLead(lead.lead);
    return Option.match(lead.moved, {
      onNone: () =>
        result(card, {
          code: "invalid_request",
          message: "This item can no longer be dismissed.",
        }),
      onSome: (moved) => result(moved),
    });
  });

  /** Undo turns the hold into a recommendation card; nothing is charged or pushed. */
  const undoOne = Effect.fn("SquireActions.undoOne")(function* (cardId: SquireCardId) {
    const found = yield* repository.getCard(cardId);
    if (Option.isNone(found))
      return yield* new SquireError({
        code: "not_found",
        message: "This item no longer exists.",
      });
    const card = found.value;
    if (card.status !== "held") {
      return result(card, {
        code:
          card.status === "executing" || card.status === "executed"
            ? "invalid_request"
            : "outdated",
        message:
          card.status === "open"
            ? "This action was already undone."
            : "This action can no longer be undone.",
      });
    }
    const opened = yield* reopen(card, ["held"], "undone", { push: false, undone: true });
    if (Option.isNone(opened)) {
      const now = Option.getOrElse(yield* repository.getCard(cardId), () => card);
      return result(now, {
        code: "invalid_request",
        message: "This action can no longer be undone.",
      });
    }
    const offer = Option.isSome(rules)
      ? yield* rules.value.askFirstOfferFor(opened.value)
      : Option.none();
    return Option.match(offer, {
      onNone: () => result(opened.value),
      onSome: (ruleOffer) => ({ ...result(opened.value), ruleOffer }),
    });
  });

  const answerOne = (card: CardRow, input: SquireActionsActInput) =>
    Option.isNone(items)
      ? Effect.succeed(
          result(card, {
            code: "not_available",
            message: "Answering is not available on this server.",
          }),
        )
      : input.answer === undefined
        ? Effect.succeed(
            result(card, { code: "invalid_request", message: "Choose an answer first." }),
          )
        : items.value.answer({ cardId: card.id, requestId: input.requestId, answer: input.answer });

  /** The inactivity check's FYI, whose accept is Keep and dismiss is Pause. */
  const isInactivityCheck = (card: CardRow) =>
    card.kind === "fyi" &&
    Option.exists(
      decodePayload(card.payload_json),
      (payload) =>
        !isUnknownUnionMember(payload) && payload.type === "fyi" && payload.source === "inactivity",
    );

  const answerInactivity = Effect.fn("SquireActions.answerInactivity")(function* (
    card: CardRow,
    keep: boolean,
  ) {
    if (Option.isNone(triggers)) {
      return result(card, {
        code: "not_available",
        message: "Squire triggers are not available on this server.",
      });
    }
    yield* triggers.value.answerInactivity({ keep });
    return result(Option.getOrElse(yield* repository.getCard(card.id), () => card));
  });

  const act: SquireActions["Service"]["act"] = Effect.fn("SquireActions.act")(function* (input) {
    const results: Array<ItemResult> = [];
    for (const cardId of input.cardIds) {
      const found = yield* repository.getCard(cardId);
      if (Option.isNone(found)) {
        results.push({
          cardId,
          status: "dismissed",
          error: { code: "not_found", message: "This item no longer exists." },
        });
        continue;
      }
      const card = found.value;
      // A refusal of one card is that card's result; the others still run.
      const asItem = <E, R>(effect: Effect.Effect<ItemResult, E, R>) =>
        effect.pipe(
          Effect.catchIf(isSquireError, (error) =>
            Effect.succeed(result(card, { code: error.code, message: error.message })),
          ),
        );
      if (input.action !== "undo" && isInactivityCheck(card)) {
        results.push(yield* answerInactivity(card, input.action === "accept").pipe(asItem));
      } else if (input.action === "dismiss") results.push(yield* dismissOne(cardId).pipe(asItem));
      else if (input.action === "undo") results.push(yield* undoOne(cardId).pipe(asItem));
      else if (card.kind === "question") results.push(yield* answerOne(card, input).pipe(asItem));
      // Accept-all applies the edited text only to a single card.
      else
        results.push(
          yield* acceptOne(
            cardId,
            input.cardIds.length === 1 ? input.text : undefined,
            input.requestId,
          ).pipe(asItem),
        );
    }
    yield* touchUserActivity(repository, yield* nowIso);
    return { results };
  }, orSquireError("act on the items"));

  return SquireActions.of({ executeDue, nextDueAt, act, reconcileStartup });
});

export const layer = Layer.effect(SquireActions, make).pipe(
  Layer.provide(CommandReceiptStore.layerFromApplicationReceipts),
);
