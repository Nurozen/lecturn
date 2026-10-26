import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import type { PendingApproval, TimelineEntry } from "../../session-logic";

/**
 * Drops the timeline row of each approval still waiting for an answer. The composer's approval
 * card already asks it, and the narrow pane has no room to ask twice; once answered the row is no
 * longer pending and comes back as the resolved record.
 */
export function withoutPendingApprovalRows(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<Pick<PendingApproval, "requestId">>,
): ReadonlyArray<TimelineEntry> {
  if (approvals.length === 0) return entries;
  const pending = new Set<string>(approvals.map((approval) => approval.requestId));
  const kept = entries.filter((entry) => {
    if (entry.kind !== "work") return true;
    const item = entry.entry.structuredPayload;
    return item?.type !== "approval_request" || !pending.has(item.requestId);
  });
  return kept.length === entries.length ? entries : kept;
}

/** The embed's timeline; full Lecturn keeps the pending row beside its composer card. */
export function useEmbedTimelineEntries(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<Pick<PendingApproval, "requestId">>,
): ReadonlyArray<TimelineEntry> {
  const embedded = useEmbedPresentation() !== null;
  return embedded ? withoutPendingApprovalRows(entries, approvals) : entries;
}
