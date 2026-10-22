/**
 * Contextual on the V2 orchestrator: a Lecturn orchestration-hook contribution.
 *
 * - beforeTurnStart (runtime only, once per start attempt): admit the run,
 *   prepare or resume its cited-context packet, hold while a conflict awaits
 *   review, bind the packet to the dispatch and return it as provider-only
 *   context placed before the user text. Every V2 adapter receives it in the
 *   turn input, so no adapter-level dispatch hook is needed.
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
import { Cause, Clock, Context, DateTime, Effect, Layer, Option, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  LecturnHookRejectedError,
  type LecturnOrchestrationHooksContribution,
  type LecturnRunTerminalNotice,
  type LecturnThreadLifecycleNotice,
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
import {
  ContextualTurnCoordinator,
  type ContextualTurnDecision,
} from "./ContextualTurnCoordinator.ts";
import { ContextualTurnQueue, type ContextualQueuedTurn } from "./ContextualTurnQueue.ts";

/** A held turn re-checks its preparation at least this often. */
const HOLD_POLL = "2 seconds";
/**
 * A conflict review holds the run's start effect (and one orchestrator effect
 * slot). Past this bound the turn is sent without optional context, the same
 * fail-open rule V1 applied to an unavailable preparation.
 */
const CONTEXTUAL_HOLD_LIMIT_MS = 30 * 60_000;
const RECENT_CONTEXT_MESSAGES = 12;
const isRejected = Schema.is(LecturnHookRejectedError);

interface InFlightRun {
  readonly threadId: ThreadId;
  readonly evidence: ProviderContextualEvidence | undefined;
  readonly prefix: string | undefined;
}

const reject = (reason: string, cause?: unknown) =>
  new LecturnHookRejectedError({
    hook: "beforeTurnStart",
    contribution: "contextual",
    reason,
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

  /** Wakes on any Contextual change (conflict resolution publishes) or the poll. */
  const awaitChange = Option.match(notifications, {
    onNone: () => Effect.sleep(HOLD_POLL),
    onSome: (shared) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* shared.subscribe;
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.take(1),
            Stream.runDrain,
            Effect.timeoutOption(HOLD_POLL),
          );
        }),
      ),
  });

  const decide = Effect.fn("Contextual.decideTurn")(function* (
    input: LecturnTurnStartInput,
    initial: ContextualQueuedTurn,
  ) {
    const { thread, run, message } = input;
    const task = {
      threadId: thread.id,
      submissionId: run.id,
      messageId: message.id,
      providerInstanceId: run.providerInstanceId,
      newestMessage: message.text,
      recentContext: yield* recentContext(thread.id, message.id),
    };
    const holdUntil = (yield* Clock.currentTimeMillis) + CONTEXTUAL_HOLD_LIMIT_MS;
    let queued = initial;
    while (true) {
      const prepared = yield* coordinator.prepare(queued, task);
      const timedOut = prepared.action === "hold" && (yield* Clock.currentTimeMillis) >= holdUntil;
      if (timedOut)
        yield* Effect.logWarning("Contextual conflict review timed out; sending without context", {
          threadId: thread.id,
          runId: run.id,
        });
      const decision: ContextualTurnDecision = timedOut
        ? { action: "send", preparation: null, packet: null }
        : prepared;
      if (decision.action !== "send") {
        if (decision.action === "hold") {
          yield* awaitChange;
          const next = yield* queue.get(run.id);
          if (next === null) return yield* reject("The turn was canceled before it started.");
          queued = next;
          continue;
        }
        yield* queue.finish(run.id, "canceled");
        return yield* reject("The turn was canceled before it started.");
      }
      const current = yield* queue.get(run.id);
      if (current === null) return yield* reject("The turn was canceled before it started.");
      const begun = yield* Effect.result(coordinator.begin(current, decision));
      if (begun._tag === "Success") return begun.success;
      // A hold or cancel committed while the packet was being prepared fences the dispatch.
      const latest = yield* queue.get(run.id);
      if (latest === null) return yield* reject("The turn was canceled before it started.");
      queued = latest;
      if (
        decision.preparation !== null &&
        (yield* repository.get(decision.preparation.id).pipe(
          Effect.map((preparation) => preparation.state === "awaiting-conflict-review"),
          Effect.orElseSucceed(() => false),
        ))
      ) {
        yield* awaitChange;
        continue;
      }
      yield* lifecycle.cancelQueuedTurns({
        threadId: thread.id,
        runId: run.id,
        at: yield* contextualNow,
      });
      return yield* reject("The turn was canceled before it started.", begun.failure);
    }
  });

  const beforeTurnStart = (input: LecturnTurnStartInput) =>
    Effect.gen(function* () {
      if (input.compaction) return;
      const { thread, run, message } = input;
      // Retries of one run reuse the dispatch bound by the first attempt.
      const cached = inFlight.get(run.id);
      if (cached) return cached.prefix === undefined ? {} : { contextPrefix: cached.prefix };
      const intent =
        yield* sql`SELECT 1 FROM contextual_thread_settings WHERE thread_id=${thread.id} AND enabled=1
        UNION ALL SELECT 1 FROM contextual_turn_queue WHERE event_id=${run.id} AND state NOT IN ('done','canceled','unknown') LIMIT 1`;
      if (!intent[0]) return;
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
      const evidence = yield* decide(input, queued);
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
