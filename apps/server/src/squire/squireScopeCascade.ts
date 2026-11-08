/**
 * A thread that left a Squire's scope has its queued events dropped and its open or held cards outdated, in the
 * caller's transaction. Otherwise the Squire is still sent a thread the user removed.
 */
import type { SquireId, ThreadId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { writeLeadItemsResolved } from "./squireLeadItems.ts";
import type * as SquireRepository from "./SquireRepository.ts";
import type * as SquireScope from "./SquireScope.ts";
import { isSummaryBearing, squireEventToggle, squireEventTogglesOf } from "./squireEvents.ts";

/**
 * What `leaving` had queued about a thread goes to whoever owns that event now, so a pause, an
 * exclusion, or a delete does not lose it. Thread events only: anything else was addressed to
 * this Squire. Returns the rows it moved; the caller drops the rest, in its transaction.
 */
const handOverQueuedEvents = Effect.fn("squireScopeCascade.handOverQueuedEvents")(function* (
  repository: SquireRepository.SquireRepository["Service"],
  scope: SquireScope.SquireScope["Service"],
  input: {
    readonly leaving: SquireId;
    readonly rows: ReadonlyArray<SquireRepository.SquireEventRow>;
  },
) {
  const squires = new Map((yield* repository.listSquires).map((row) => [row.id, row]));
  const moved = new Set<number>();
  for (const row of input.rows) {
    const { kind, thread_id: threadId } = row;
    if (threadId === null || !isSummaryBearing(kind)) continue;
    const toggle = squireEventToggle(kind);
    const owner = yield* scope.ownerOf(threadId, (id) => {
      const squire = squires.get(id);
      return id !== input.leaving && squire !== undefined && squireEventTogglesOf(squire)[toggle];
    });
    if (Option.isSome(owner)) {
      if (yield* repository.reassignQueuedEvent({ id: row.id, squireId: owner.value })) {
        moved.add(row.id);
      }
    }
  }
  return moved;
});

/** A pause: what the Squire had queued goes to the next owner, and the rest is dropped. */
export const handOverOrDropQueuedEvents = Effect.fn(
  "squireScopeCascade.handOverOrDropQueuedEvents",
)(function* (
  repository: SquireRepository.SquireRepository["Service"],
  scope: SquireScope.SquireScope["Service"],
  squireId: SquireId,
) {
  const rows = yield* repository.listEventsByStatus({
    squireId,
    statuses: ["deferred", "pending"],
  });
  yield* handOverQueuedEvents(repository, scope, { leaving: squireId, rows });
  yield* repository.dropQueuedEvents(squireId);
});

/**
 * Run inside the transaction that changed the scope, so scope reads see its
 * grant writes; wake the returned Lead once it commits. `all` retires every
 * thread's rows, for a Squire being deleted.
 */
export const retireOutOfScope = Effect.fn("squireScopeCascade.retireOutOfScope")(function* (
  repository: SquireRepository.SquireRepository["Service"],
  scope: SquireScope.SquireScope["Service"],
  input: { readonly squireId: SquireId; readonly now: string; readonly all?: boolean },
) {
  const { squireId, now } = input;
  const all = input.all === true;
  const squire = yield* repository.getSquire(squireId);
  // The Lead has no scope of its own: its cards on a Squire's thread go with that Squire's scope.
  if (Option.isNone(squire) || (squire.value.role === "lead" && !all)) {
    return Option.none<SquireId>();
  }
  const events = (yield* repository.listEventsByStatus({
    squireId,
    statuses: ["deferred", "pending"],
  })).filter((row) => row.thread_id !== null);
  const statuses = ["open", "held"] as const;
  const cards = new Map<string, SquireRepository.SquireCardRow>();
  for (const card of [
    ...(yield* repository.listCards({ squireId, statuses })),
    ...(yield* repository.listCards({ ownerSquireId: squireId, statuses })),
  ]) {
    if (card.target_thread_id !== null) cards.set(card.id, card);
  }

  const verdicts = new Map<ThreadId, boolean>();
  const gone = Effect.fn("squireScopeCascade.gone")(function* (threadId: ThreadId) {
    if (all) return true;
    const known = verdicts.get(threadId);
    if (known !== undefined) return known;
    const left = !(yield* scope.ruleTargetInScope({
      squireId,
      targetKind: "thread",
      targetId: threadId,
    }));
    verdicts.set(threadId, left);
    return left;
  });

  const left = yield* Effect.filter(events, (row) => gone(row.thread_id!));
  const handedOver = yield* handOverQueuedEvents(repository, scope, {
    leaving: squireId,
    rows: left,
  });
  yield* repository.setEventStatus({
    ids: left.filter((row) => !handedOver.has(row.id)).map((row) => row.id),
    fromStatuses: ["deferred", "pending"],
    status: "dropped",
  });
  const moved: Array<SquireRepository.SquireCardRow> = [];
  for (const card of cards.values()) {
    if (!(yield* gone(card.target_thread_id!))) continue;
    const outdated = yield* repository.updateCard({
      id: card.id,
      fromStatuses: statuses,
      patch: { status: "outdated", resolution: "outdated", executes_at: null },
      updatedAt: now,
    });
    if (Option.isSome(outdated)) moved.push(outdated.value);
  }
  return yield* writeLeadItemsResolved(repository, moved, now);
});
