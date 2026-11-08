/**
 * The Lead's item-raised and item-resolved rows. A decision item
 * a Squire raises wakes the Lead when it is raised and when it leaves
 * open/held, except by expiring; FYI items and the Lead's own items never do.
 */
import type { SquireEvent, SquireId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as SquireRepository from "./SquireRepository.ts";

export type LeadItemTransition = "raised" | "resolved";

export type LeadItemCard = Pick<
  SquireRepository.SquireCardRow,
  "id" | "squire_id" | "kind" | "title" | "target_thread_id" | "status" | "resolution"
>;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const eventOf = (transition: LeadItemTransition, card: LeadItemCard): SquireEvent => {
  const fields = {
    cardId: card.id,
    squireId: card.squire_id,
    cardKind: card.kind,
    title: card.title,
    targetThreadId: card.target_thread_id,
  };
  return transition === "raised"
    ? { type: "item-raised", ...fields }
    : { type: "item-resolved", ...fields, resolution: card.resolution?.trim() || card.status };
};

/**
 * For `resolved`, pass the card as it is after the transition. Call it inside the transaction that commits the
 * card's change and wake the returned Lead once it commits.
 * None when there is no active Lead, the card is FYI or the Lead's own, or the row already exists (a retry).
 */
export const writeLeadItemEvent = Effect.fn("squireLeadItems.writeLeadItemEvent")(function* (
  repository: SquireRepository.SquireRepository["Service"],
  input: {
    readonly transition: LeadItemTransition;
    readonly card: LeadItemCard;
    readonly now: string;
  },
) {
  const { transition, card, now } = input;
  if (card.kind === "fyi") return Option.none<SquireId>();
  const lead = yield* repository.getLead;
  if (Option.isNone(lead) || lead.value.status !== "active") return Option.none<SquireId>();
  if (card.squire_id === lead.value.id) return Option.none<SquireId>();
  const inserted = yield* repository.insertTriggerEvent({
    squire_id: lead.value.id,
    thread_id: null,
    kind: `item-${transition}`,
    state_key: `${card.id}:${transition}`,
    payload_json: encodeJson(eventOf(transition, card)),
    status: "pending",
    defer_reason: null,
    not_before: now,
    batch_id: null,
    created_at: now,
  });
  return Option.as(inserted, lead.value.id);
});

/** The item-resolved rows for cards that just left open/held; the Lead to wake, if any. */
export const writeLeadItemsResolved = Effect.fn("squireLeadItems.writeLeadItemsResolved")(
  function* (
    repository: SquireRepository.SquireRepository["Service"],
    cards: Iterable<LeadItemCard>,
    now: string,
  ) {
    let woken = Option.none<SquireId>();
    for (const card of cards) {
      const lead = yield* writeLeadItemEvent(repository, { transition: "resolved", card, now });
      if (Option.isSome(lead)) woken = lead;
    }
    return woken;
  },
);
