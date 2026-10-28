import { withoutApprovalCardRows } from "@lecturn/client-runtime/state/app-tool-approval-placement";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import type { PendingApproval, TimelineEntry } from "../../session-logic";

type ShownApproval = Pick<PendingApproval, "requestId" | "connectedAppTool">;

const turnItemOf = (entry: TimelineEntry) =>
  entry.kind === "work" ? entry.entry.structuredPayload : undefined;

/**
 * The embed's timeline beside its approval card: the narrow pane has no room to ask anything
 * twice, so a provider's waiting approval row leaves too.
 */
export function withoutPendingApprovalRows(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<ShownApproval>,
): ReadonlyArray<TimelineEntry> {
  return withoutApprovalCardRows(entries, approvals, turnItemOf, { hideProviderApprovals: true });
}

/** Full Lecturn follows the rule mobile's thread feed shares (`withoutApprovalCardRows`). */
export function useComposerCardTimelineEntries(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<ShownApproval>,
): ReadonlyArray<TimelineEntry> {
  const embedded = useEmbedPresentation() !== null;
  return embedded
    ? withoutPendingApprovalRows(entries, approvals)
    : withoutApprovalCardRows(entries, approvals, turnItemOf);
}
