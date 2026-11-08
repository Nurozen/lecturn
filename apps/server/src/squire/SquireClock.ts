/**
 * One fiber sleeps until the earliest row, trigger, or hold comes due and re-arms on every repository change,
 * so nothing polls. The 5 s scheduler source is the backstop for a missed wake and runs the daily prunes.
 */
import type { SquireError, SquireId } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SquireActions from "./SquireActions.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireDigest from "./SquireDigest.ts";
import * as SquirePresence from "./SquirePresence.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireJevRouter from "./SquireJevRouter.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import * as SquireRoomTools from "./SquireRoomTools.ts";
import * as SquireSweep from "./SquireSweep.ts";
import * as SquireTriggers from "./SquireTriggers.ts";
import * as SquireWorkspace from "./SquireWorkspace.ts";

export type SquireClockError = PersistenceSqlError | SquireReactor.SquireReactorError | SquireError;

export class SquireClock extends Context.Service<
  SquireClock,
  {
    /** The arming loop; never returns. Forked at startup, which re-arms from the table. */
    readonly start: Effect.Effect<never>;
    /** Runs due holds, promotes due rows, fires due schedule slots, and wakes every Squire with pending rows. */
    readonly runDue: Effect.Effect<void, SquireClockError>;
    /** The scheduler backstop: `runDue`, then the prunes once a day. */
    readonly sweep: Effect.Effect<void, SquireClockError>;
  }
>()("lecturn/squire/SquireClock") {}

/** Finished rows keep their key, so a recurring absolute PR state stays deduped. */
const SQUIRE_PAYLOAD_RETENTION = Duration.days(30);
/**
 * Delivered and dropped rows other than PR keys. Their keys are run, request,
 * slot, delivery, or message ids that never recur once the reactor cursor and
 * the trigger slots have moved past them, and the delivered home-thread
 * message is the durable record. Unfinished rows are never pruned.
 */
const SQUIRE_EVENT_RETENTION = Duration.days(30);
/**
 * Settled cards, by when they settled. Nothing acts on them again; card ids
 * that encode a generation skip ids still taken. Dismissals that stop an
 * overlap or a finding being raised again are kept (SquireRepository).
 */
const SQUIRE_CARD_RETENTION = Duration.days(30);
/**
 * Longer than the cards, since the log is the exportable record. Replay keys
 * (tool calls, executions) only matter within a turn; rows of a card that
 * still exists stay with it.
 */
const SQUIRE_ACTION_LOG_RETENTION = Duration.days(90);
/** Budgets count rolling windows of at most a day; a week past that is slack. */
const SQUIRE_BUDGET_USAGE_RETENTION = Duration.days(1 + 7);
/**
 * A room closed this long ago left the snapshot weeks earlier (SquireReadModel)
 * and takes no posts until reopened; read cursors stay valid because post ids
 * are never reused.
 */
const SQUIRE_CLOSED_ROOM_POST_RETENTION = Duration.days(30);
const PRUNE_EVERY = Duration.days(1);
/** A row that stays due after `runDue` (it cannot move yet) is retried at the backstop's pace. */
const STUCK_RETRY = Duration.seconds(5);
/** Checkpoint refs kept per scratch repo; home threads offer no rollback, so older ones only cost space. */
export const SQUIRE_SCRATCH_REFS_KEPT = 200;

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const reactor = yield* SquireReactor.SquireReactor;
  const triggers = yield* SquireTriggers.SquireTriggers;
  const delivery = yield* SquireDelivery.SquireDelivery;
  const workspace = yield* SquireWorkspace.SquireWorkspace;
  const vcs = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scheduler = yield* Scheduler.Scheduler;
  const lastPrune = yield* Ref.make<Option.Option<DateTime.Utc>>(Option.none());
  const actions = yield* Effect.serviceOption(SquireActions.SquireActions);
  const presence = yield* Effect.serviceOption(SquirePresence.SquirePresence);
  const digest = yield* Effect.serviceOption(SquireDigest.SquireDigest);
  const findWork = yield* Effect.serviceOption(SquireSweep.SquireSweep);
  const rooms = yield* Effect.serviceOption(SquireRooms.SquireRooms);
  const roomTools = yield* Effect.serviceOption(SquireRoomTools.SquireRoomTools);
  const jev = yield* Effect.serviceOption(SquireJevRouter.SquireJevRouting);

  const runDue: SquireClock["Service"]["runDue"] = Effect.gen(function* () {
    if (Option.isSome(actions)) yield* actions.value.executeDue;
    if (Option.isSome(presence)) yield* presence.value.escalateDue;
    const now = yield* DateTime.now;
    yield* reactor.promoteDue(now);
    yield* triggers.fireDueSlots(now);
    if (Option.isSome(digest)) yield* digest.value.due(now);
    if (Option.isSome(findWork)) yield* findWork.value.due(now);
    // Before the wake below, so a Jev timeout's released Lead row is delivered now.
    if (Option.isSome(jev)) yield* jev.value.timeoutDue(now);
    if (Option.isSome(rooms)) yield* rooms.value.due(now);
    if (Option.isSome(roomTools)) yield* roomTools.value.expireProposals(now);
    // A summary-bearing row may already be pending; waking an idle or busy Squire is a no-op.
    const pending = yield* repository.listSquiresWithPendingEvents;
    yield* Effect.forEach(pending, (squireId: SquireId) => delivery.wake(squireId), {
      discard: true,
    });
  }).pipe(Effect.withSpan("SquireClock.runDue"));

  const nextDueAt = Effect.gen(function* () {
    const deferred = Option.flatMap(yield* repository.earliestDeferredAt, (iso) =>
      DateTime.make(iso),
    );
    const slot = yield* triggers.earliestSlotAt;
    const held = Option.isSome(actions) ? yield* actions.value.nextDueAt : Option.none();
    const escalation = Option.isSome(presence)
      ? yield* presence.value.nextEscalationAt
      : Option.none();
    const now = yield* DateTime.now;
    const digestAt = Option.isSome(digest) ? yield* digest.value.nextDueAt(now) : Option.none();
    const sweepAt = Option.isSome(findWork) ? yield* findWork.value.nextDueAt(now) : Option.none();
    const jevAt = Option.isSome(jev) ? yield* jev.value.nextDeadlineAt : Option.none();
    const roomAt = Option.isSome(rooms) ? yield* rooms.value.nextDueAt : Option.none();
    const proposalAt = Option.isSome(roomTools)
      ? yield* roomTools.value.nextExpiryAt
      : Option.none();
    return [deferred, slot, held, escalation, digestAt, sweepAt, jevAt, roomAt, proposalAt].reduce<
      Option.Option<DateTime.Utc>
    >(
      (earliest, at) =>
        Option.isNone(at)
          ? earliest
          : Option.isNone(earliest)
            ? at
            : Option.some(DateTime.min(earliest.value, at.value)),
      Option.none(),
    );
  });

  const start: SquireClock["Service"]["start"] = Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* repository.subscribeChanges;
      const changed = Stream.runHead(changes);
      const step = Effect.gen(function* () {
        yield* runDue;
        const next = yield* nextDueAt;
        const now = yield* DateTime.now;
        const sleep = Option.match(next, {
          onNone: () => Effect.never,
          onSome: (at) => {
            const wait = DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now);
            return Effect.sleep(wait > 0 ? Duration.millis(wait) : STUCK_RETRY);
          },
        });
        // An insert or update anywhere may move the earliest due time: re-arm.
        yield* Effect.raceFirst(sleep, changed);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire clock step failed", { cause }).pipe(
            Effect.andThen(Effect.sleep(STUCK_RETRY)),
          ),
        ),
      );
      return yield* Effect.forever(step);
    }),
  );

  const pruneScratchRefs = Effect.gen(function* () {
    for (const squire of yield* repository.listSquires) {
      const dir = yield* workspace.pathFor(squire.id);
      if (!(yield* fileSystem.exists(path.join(dir, ".git")))) continue;
      const git = (args: ReadonlyArray<string>, stdin?: string) =>
        vcs.run({
          operation: "SquireClock.pruneScratchRefs",
          command: "git",
          cwd: dir,
          args,
          ...(stdin === undefined ? {} : { stdin }),
          timeoutMs: 30_000,
        });
      const listed = yield* git([
        "for-each-ref",
        "--sort=-creatordate",
        "--format=%(refname)",
        "refs/lecturn/",
      ]);
      const stale = listed.stdout
        .split("\n")
        .filter((ref) => ref.length > 0)
        .slice(SQUIRE_SCRATCH_REFS_KEPT);
      if (stale.length === 0) continue;
      yield* git(["update-ref", "--stdin"], stale.map((ref) => `delete ${ref}\n`).join(""));
    }
  }).pipe(
    // Only disk space is at stake, so a failure waits for the next day.
    Effect.catchCause((cause) => Effect.logWarning("Squire scratch ref prune failed", { cause })),
  );

  const sweep: SquireClock["Service"]["sweep"] = Effect.gen(function* () {
    yield* runDue;
    const now = yield* DateTime.now;
    // A finding's outcome row needs no exact time, so the backstop writes it.
    if (Option.isSome(findWork)) yield* findWork.value.recordOutcomes(now);
    // Days-long windows, so the 5 s backstop is fine-grained enough; no arming.
    yield* triggers.checkInactivity(now);
    const last = yield* Ref.get(lastPrune);
    if (
      Option.isSome(last) &&
      DateTime.toEpochMillis(now) - DateTime.toEpochMillis(last.value) <
        Duration.toMillis(PRUNE_EVERY)
    ) {
      return;
    }
    yield* Ref.set(lastPrune, Option.some(now));
    const before = (retention: Duration.Duration) =>
      DateTime.formatIso(DateTime.subtractDuration(now, retention));
    yield* repository.pruneEventPayloads({ before: before(SQUIRE_PAYLOAD_RETENTION) });
    yield* repository.pruneHistory({
      eventsBefore: before(SQUIRE_EVENT_RETENTION),
      cardsBefore: before(SQUIRE_CARD_RETENTION),
      actionLogBefore: before(SQUIRE_ACTION_LOG_RETENTION),
      budgetUsageBefore: before(SQUIRE_BUDGET_USAGE_RETENTION),
      closedRoomPostsBefore: before(SQUIRE_CLOSED_ROOM_POST_RETENTION),
    });
    yield* pruneScratchRefs;
  }).pipe(Effect.withSpan("SquireClock.sweep"));

  yield* scheduler.register("squire", sweep);

  return SquireClock.of({ start, runDue, sweep });
});

export const layer = Layer.effect(SquireClock, make);
