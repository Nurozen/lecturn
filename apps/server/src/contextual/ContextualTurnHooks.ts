/**
 * Contextual on the V2 orchestrator: a Lecturn orchestration-hook contribution.
 *
 * - beforeTurnStart (runtime only, once per start attempt): admit the run,
 *   prepare or resume its cited-context packet, defer the start while a
 *   conflict awaits review (no effect slot is held; re-attempted on the next
 *   Contextual change or a short poll), bind the packet to the dispatch and
 *   return it as provider-only context placed before the user text. Every V2
 *   adapter receives it in the turn input, so no adapter-level dispatch hook
 *   is needed. A canceled turn settles the run as cancelled, not failed.
 * - onRunTerminal: record the delivery receipt from the orchestrator's own
 *   provider-turn record (accepted / rejected / unknown) and finish the run's
 *   admission row; a run interrupted before dispatch cancels its preparation;
 *   a rollback invalidates preparations of removed messages.
 * - onThreadLifecycle: initialize thread settings, inherit fork/import
 *   origin, and clean up on delete.
 * - aroundCommand: apply thread.create's `contextual` option after commit and
 *   clean up project deletions.
 * - a live application-event tail (from boot, never a replay) records native
 *   compaction as a new context epoch.
 *
 * None of these fire on a projection rebuild (the V1 runtime-only rule).
 */
import {
  type MessageId,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  type ProviderContextualEvidence,
  type RunId,
  type ThreadId,
  TurnId,
} from "@lecturn/contracts";
import { Cause, Context, DateTime, Effect, Layer, Option, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  LecturnHookRejectedError,
  type LecturnOrchestrationHooksContribution,
  type LecturnRunTerminalNotice,
  type LecturnThreadLifecycleNotice,
  type LecturnTurnStartDecision,
  type LecturnTurnStartInput,
} from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { prepareContextualDispatch } from "../provider/ContextualDispatch.ts";
import { v2Messages } from "../threadDecisions/V2ProjectionSources.ts";
import { ContextualLifecycle } from "./ContextualLifecycle.ts";
import { ContextualNotifications } from "./ContextualNotifications.ts";
import { ContextualRepository } from "./ContextualRepository.ts";
import { ContextualService } from "./ContextualService.ts";
import {
  ContextualSettings,
  applyContextualOrigin,
  contextualNow,
  initializeContextualThread,
} from "./ContextualSettings.ts";
import { ContextualTurnCoordinator } from "./ContextualTurnCoordinator.ts";
import { ContextualTurnQueue, type ContextualQueuedTurn } from "./ContextualTurnQueue.ts";

/**
 * A held turn (conflict awaiting review) defers its start: the run stays
 * "starting" and holds no orchestrator effect slot. The start is re-attempted
 * on any Contextual change (resolution publishes) or after this interval.
 * There is no hold limit: like V1, the turn waits until the user reviews,
 * cancels the turn, or stops the run.
 */
const HOLD_RETRY_MS = 5_000;
const RECENT_CONTEXT_MESSAGES = 12;
const isRejected = Schema.is(LecturnHookRejectedError);

interface InFlightRun {
  readonly threadId: ThreadId;
  readonly evidence: ProviderContextualEvidence | undefined;
  readonly prefix: string | undefined;
}

/** Every Contextual refusal withdraws the turn; it is cancelled, never failed. */
const cancelTurn = (cause?: unknown) =>
  new LecturnHookRejectedError({
    hook: "beforeTurnStart",
    contribution: "contextual",
    reason: "The turn was canceled before it started.",
    disposition: "cancelled",
    ...(cause === undefined ? {} : { cause }),
  });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* ContextualTurnQueue;
  const coordinator = yield* ContextualTurnCoordinator;
  const lifecycle = yield* ContextualLifecycle;
  const settings = yield* ContextualSettings;
  const service = yield* ContextualService;
  const repository = yield* ContextualRepository;
  const notifications = yield* Effect.serviceOption(ContextualNotifications);
  const inFlight = new Map<RunId, InFlightRun>();

  const recentContext = Effect.fn("Contextual.recentContext")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const rows = yield* sql<{ message_id: string; role: string; text: string }>`
      SELECT message_id, role, text FROM ${v2Messages(sql)} m
      WHERE thread_id=${threadId} AND role IN ('user','assistant') AND is_streaming=0
      ORDER BY created_at, message_id`;
    const index = rows.findIndex((row) => row.message_id === messageId);
    return (index < 0 ? rows : rows.slice(0, index))
      .slice(-RECENT_CONTEXT_MESSAGES)
      .map((row) => `${row.role}: ${row.text}`)
      .join("\n\n");
  });

  /** Completes on the next Contextual change (conflict resolution publishes). */
  const nextChange = Option.map(notifications, (shared) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* shared.subscribe;
        yield* Stream.fromSubscription(subscription).pipe(Stream.take(1), Stream.runDrain);
      }),
    ),
  );
  const hold = (runId: RunId): LecturnTurnStartDecision => ({
    defer: {
      retryAfterMs: HOLD_RETRY_MS,
      reason: `Contextual conflict awaits review (run ${runId}).`,
      ...(Option.isSome(nextChange) ? { wake: nextChange.value } : {}),
    },
  });

  /**
   * One pass per start attempt: prepare (or resume) the run's packet, defer
   * while a conflict awaits review, then bind it to this dispatch.
   */
  const decide = Effect.fn("Contextual.decideTurn")(function* (
    input: LecturnTurnStartInput,
    queued: ContextualQueuedTurn,
  ) {
    const { thread, run, message } = input;
    const task = {
      threadId: thread.id,
      submissionId: run.id,
      messageId: message.id,
      providerInstanceId: run.providerInstanceId,
      newestMessage: message.text,
      // Only a first preparation reads the task; re-attempts resume by id.
      recentContext:
        queued.preparationId === null ? yield* recentContext(thread.id, message.id) : "",
    };
    const decision = yield* coordinator.prepare(queued, task);
    if (decision.action !== "send") {
      if (decision.action === "hold") return hold(run.id);
      yield* queue.finish(run.id, "canceled");
      return yield* cancelTurn();
    }
    const current = yield* queue.get(run.id);
    if (current === null) return yield* cancelTurn();
    const begun = yield* Effect.result(coordinator.begin(current, decision));
    if (begun._tag === "Success") return { send: begun.success };
    // A hold or cancel committed while the packet was being prepared fences the dispatch.
    if ((yield* queue.get(run.id)) === null) return yield* cancelTurn();
    if (
      decision.preparation !== null &&
      (yield* repository.get(decision.preparation.id).pipe(
        Effect.map((preparation) => preparation.state === "awaiting-conflict-review"),
        Effect.orElseSucceed(() => false),
      ))
    )
      return hold(run.id);
    yield* lifecycle.cancelQueuedTurns({
      threadId: thread.id,
      runId: run.id,
      at: yield* contextualNow,
    });
    return yield* cancelTurn(begun.failure);
  });

  const beforeTurnStart = (input: LecturnTurnStartInput) =>
    Effect.gen(function* () {
      if (input.compaction) return;
      const { thread, run, message } = input;
      // Retries of one run reuse the dispatch bound by the first attempt.
      const cached = inFlight.get(run.id);
      if (cached) return cached.prefix === undefined ? {} : { contextPrefix: cached.prefix };
      // A deferred run whose row was canceled meanwhile (stop, delete, cancel) stays canceled.
      const prior = yield* sql<{
        state: string;
      }>`SELECT state FROM contextual_turn_queue WHERE event_id=${run.id}`;
      if (prior[0]?.state === "canceled") return yield* cancelTurn();
      const intent =
        yield* sql`SELECT 1 FROM contextual_thread_settings WHERE thread_id=${thread.id} AND enabled=1
        UNION ALL SELECT 1 FROM contextual_turn_queue WHERE event_id=${run.id} AND state NOT IN ('done','canceled','unknown') LIMIT 1`;
      if (!intent[0]) {
        // Pin "no Contextual" for this run: a later restart of it (steering)
        // must not start holding after Contextual is enabled mid-run.
        inFlight.set(run.id, { threadId: thread.id, evidence: undefined, prefix: undefined });
        return;
      }
      // Terminal notices are live only; settle rows a restart left behind first.
      yield* queue.reconcile(thread.id);
      const queued = yield* queue.admit({
        threadId: thread.id,
        runId: run.id,
        messageId: message.id,
      });
      if (queued === null) return;
      if (queued.state === "dispatching") {
        // A previous process bound this run's packet but never started it;
        // startup recovery recorded that delivery as unknown. Fail open.
        inFlight.set(run.id, { threadId: thread.id, evidence: undefined, prefix: undefined });
        return;
      }
      const decided = yield* decide(input, queued);
      if (!("send" in decided)) return decided;
      const evidence = decided.send;
      const prefix =
        evidence === undefined
          ? undefined
          : prepareContextualDispatch(
              { threadId: thread.id, contextualEvidence: evidence },
              "fresh",
              run.providerInstanceId,
            ).text;
      inFlight.set(run.id, { threadId: thread.id, evidence, prefix });
      return prefix === undefined ? {} : { contextPrefix: prefix };
    }).pipe(
      Effect.catchCause((cause) => {
        // A run.interrupt cancels the start effect; never turn that into a send.
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const failure = Cause.findErrorOption(cause);
        if (Option.isSome(failure) && isRejected(failure.value)) return Effect.fail(failure.value);
        // Optional context never blocks a turn: storage/evaluation failures fail open.
        return Effect.logWarning("Contextual turn preparation failed; sending without context", {
          threadId: input.thread.id,
          runId: input.run.id,
          cause,
        }).pipe(Effect.as({}));
      }),
    );

  const providerTurnFor = (runId: RunId) =>
    sql<{ provider_turn_id: string; native_id: string | null; status: string }>`
      SELECT pt.provider_turn_id, json_extract(pt.payload_json,'$.nativeTurnRef.nativeId') AS native_id, pt.status
      FROM orchestration_v2_projection_run_attempts a
      JOIN orchestration_v2_projection_provider_turns pt ON pt.run_attempt_id = a.attempt_id
      WHERE a.run_id=${runId} ORDER BY a.attempt_ordinal DESC, pt.ordinal DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );

  const onRunTerminal = (notice: LecturnRunTerminalNotice) =>
    Effect.gen(function* () {
      const at = yield* contextualNow;
      if (notice.status === "rolled_back") {
        inFlight.delete(notice.runId);
        yield* lifecycle.applyThreadRemoval({ threadId: notice.threadId, kind: "rolled-back", at });
        return;
      }
      const entry = inFlight.get(notice.runId);
      inFlight.delete(notice.runId);
      const queued = yield* queue.get(notice.runId);
      if (queued === null) return;
      if (queued.state !== "dispatching") {
        // Interrupted, failed or deleted before its packet was bound: V1 session-stop semantics.
        yield* lifecycle.cancelQueuedTurns({ threadId: notice.threadId, runId: notice.runId, at });
        return;
      }
      if (entry?.evidence === undefined) {
        yield* queue.finish(
          notice.runId,
          notice.reconciled || entry === undefined ? "unknown" : "done",
        );
        return;
      }
      const turn = yield* providerTurnFor(notice.runId);
      const accepted =
        turn !== null &&
        (turn.native_id !== null || ["running", "completed", "interrupted"].includes(turn.status));
      const acceptance = notice.reconciled
        ? "unknown"
        : accepted
          ? "accepted"
          : turn === null
            ? "rejected"
            : "unknown";
      const dispatch = prepareContextualDispatch(
        { threadId: notice.threadId, contextualEvidence: entry.evidence },
        "fresh",
        entry.evidence.providerInstanceId,
      );
      const receipt = yield* dispatch.receipt(
        acceptance,
        acceptance === "accepted" && turn ? TurnId.make(turn.provider_turn_id) : null,
        acceptance === "accepted" && turn
          ? (turn.native_id ?? `v2-provider-turn:${turn.provider_turn_id}`)
          : null,
      );
      if (receipt) yield* coordinator.observe(receipt);
      yield* queue.finish(notice.runId, acceptance === "unknown" ? "unknown" : "done");
    });

  const onThreadLifecycle = (notice: LecturnThreadLifecycleNotice) =>
    Effect.gen(function* () {
      switch (notice.kind) {
        case "created":
          yield* initializeContextualThread(sql, notice);
          return;
        case "forked":
          yield* initializeContextualThread(sql, {
            threadId: notice.threadId,
            projectId: notice.projectId,
          });
          yield* applyContextualOrigin(sql, {
            threadId: notice.threadId,
            projectId: notice.projectId,
            parentThreadId: notice.sourceThreadId,
          });
          yield* lifecycle.applyFork({
            parentThreadId: notice.sourceThreadId,
            threadId: notice.threadId,
          });
          return;
        case "imported":
          yield* initializeContextualThread(sql, {
            threadId: notice.threadId,
            projectId: notice.projectId,
          });
          yield* applyContextualOrigin(sql, {
            threadId: notice.threadId,
            projectId: notice.projectId,
          });
          return;
        case "deleted":
          yield* lifecycle.applyThreadRemoval({
            threadId: notice.threadId,
            kind: "deleted",
            at: yield* contextualNow,
          });
          return;
        default:
          return;
      }
    });

  /** thread.create's Lecturn `contextual` option (launchThread forwards it). */
  const applyCreateOption = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      if (command.type !== "thread.create" || !("contextual" in command) || !command.contextual)
        return;
      const current = yield* settings.thread(command.threadId);
      yield* service.updateThreadSettings({
        threadId: command.threadId,
        expectedRevision: current.revision,
        enabled: command.contextual.enabled,
        sourceIds: [...command.contextual.sourceIds],
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to apply the new thread's Contextual choice", { cause }),
      ),
    );
  const applyProjectDeletion = (projectId: ProjectId) =>
    Effect.gen(function* () {
      yield* lifecycle.applyProjectDeleted({ projectId, at: yield* contextualNow });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Contextual project cleanup failed", { projectId, cause }),
      ),
    );

  const contribution: LecturnOrchestrationHooksContribution = {
    name: "contextual",
    aroundCommand: (input, commit) =>
      commit.pipe(
        Effect.tap(() =>
          input.scope === "thread"
            ? applyCreateOption(input.command)
            : input.command.type === "project.delete"
              ? applyProjectDeletion(input.command.projectId)
              : Effect.void,
        ),
      ),
    beforeTurnStart,
    onRunTerminal: (notice) => onRunTerminal(notice).pipe(Effect.ignoreCause({ log: true })),
    onThreadLifecycle: (notice) =>
      onThreadLifecycle(notice).pipe(Effect.ignoreCause({ log: true })),
  };

  /** Restart reconciliation: uncertain dispatches become unknown receipts, stale rows finish. */
  const recover = Effect.gen(function* () {
    yield* coordinator.recover();
    yield* queue.reconcile(undefined);
  });

  const observeCompactions = Effect.gen(function* () {
    const events = yield* OrchestrationEventStore;
    const from = yield* events.latestApplicationSequence;
    yield* events.streamApplicationEvents({ afterSequence: from }).pipe(
      Stream.runForEach((stored) => {
        if ("aggregateKind" in stored) return Effect.void;
        const event = stored.event;
        if (
          event.type !== "turn-item.updated" ||
          event.payload.type !== "compaction" ||
          event.payload.status !== "completed"
        )
          return Effect.void;
        return lifecycle
          .observeCompaction({
            threadId: event.threadId,
            boundaryKey: `v2:${event.payload.id}`,
            at: DateTime.formatIso(event.occurredAt),
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }),
    );
  });

  return { contribution, recover, observeCompactions, beforeTurnStart, onRunTerminal };
});

export class ContextualTurnHooks extends Context.Service<
  ContextualTurnHooks,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualTurnHooks") {}
export const layer = Layer.effect(ContextualTurnHooks, make);
