import type {
  DecisionRelationship,
  ThreadDecisionListInput,
  ThreadDecisionSourceWindowResult,
} from "@lecturn/contracts";

export { decisionStatusLabel } from "@lecturn/client-runtime/state/threadDecisions";
export function reconcileVisibleDecisions<A extends { readonly id: string }>(
  previous: readonly A[],
  incoming: readonly A[],
) {
  const ids = new Set(previous.map((note) => note.id));
  const byId = new Map(incoming.map((note) => [note.id, note]));
  const newCount = incoming.filter((note) => !ids.has(note.id)).length;
  return {
    // A new first-page row can push an existing card across the page boundary.
    // Keep its identity until the user accepts the refreshed result set.
    visible: previous
      .filter((note) => newCount > 0 || byId.has(note.id))
      .map((note) => byId.get(note.id) ?? note),
    newCount,
  };
}
export function decisionSourceHighlight(
  source: ThreadDecisionSourceWindowResult,
  messageId: string,
) {
  if (
    source.outcome !== "exact" ||
    source.messageId !== messageId ||
    source.start === null ||
    source.end === null
  )
    return null;
  const message = source.messages.find((message) => message.id === messageId);
  if (
    !message ||
    source.start < 0 ||
    source.end > message.text.length ||
    source.end <= source.start
  )
    return null;
  return {
    before: message.text.slice(0, source.start),
    quote: message.text.slice(source.start, source.end),
    after: message.text.slice(source.end),
  };
}
export function decisionFilterKey(input: ThreadDecisionListInput) {
  return JSON.stringify([
    input.projectId,
    input.threadId ?? null,
    input.search ?? "",
    input.reviewState ?? null,
    input.lifecycle ?? "current",
    input.cursor ?? null,
  ]);
}

/** The same relationship is attached to both cards; describe it from this endpoint. */
export function decisionRelationshipLabel(
  noteId: string,
  relation: Pick<DecisionRelationship, "predecessorId" | "successorId" | "state">,
) {
  const predecessor = noteId === relation.predecessorId;
  if (relation.state === "proposed")
    return predecessor
      ? "A newer decision may replace this one. Approval is required."
      : "May replace an earlier decision. Approval is required.";
  return predecessor ? "Replaced by a newer decision." : "Replaces an earlier decision.";
}
