/**
 * What goes with a thread that left a Squire's scope (untrack, rescope, a
 * deleted grant target, a Squire delete): its queued events are dropped and
 * its open or held cards outdated, in the caller's transaction. Otherwise the
 * Squire is still sent a thread the user removed, and its cards can only fail
 * an accept as out of scope.
 */
import type { SquireId, ThreadId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { writeLeadItemsResolved } from "./squireLeadItems.ts";
import type * as SquireRepository from "./SquireRepository.ts";
import type * as SquireScope from "./SquireScope.ts";

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

  const dropped = yield* Effect.filter(events, (row) => gone(row.thread_id!));
  yield* repository.setEventStatus({
    ids: dropped.map((row) => row.id),
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
