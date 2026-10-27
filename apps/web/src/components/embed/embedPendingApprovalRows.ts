import { claimHeldAppToolCalls } from "@lecturn/client-runtime/state/app-tool-approval-placement";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import type { PendingApproval, TimelineEntry } from "../../session-logic";

type ShownApproval = Pick<PendingApproval, "requestId" | "connectedAppTool">;

const turnItemOf = (entry: TimelineEntry) =>
  entry.kind === "work" ? entry.entry.structuredPayload : undefined;

function heldAppToolCallIds(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<ShownApproval>,
): ReadonlySet<string> {
  const appApprovals = approvals.flatMap((approval) =>
    approval.connectedAppTool === undefined
      ? []
      : [
          {
            requestId: approval.requestId,
            toolName: approval.connectedAppTool.toolName,
            pending: true,
          },
        ],
  );
  return new Set(
    claimHeldAppToolCalls(entries, appApprovals, turnItemOf).map(
      (held) => entries[held.callIndex]!.id,
    ),
  );
}

/**
 * Drops the timeline row of each approval still waiting for an answer, and the running row of the
 * app tool call it holds, since the composer's approval card already asks it. Once answered the
 * approval comes back as the resolved record and the call's row returns with it.
 */
export function withoutPendingApprovalRows(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<ShownApproval>,
): ReadonlyArray<TimelineEntry> {
  if (approvals.length === 0) return entries;
  const pending = new Set<string>(approvals.map((approval) => approval.requestId));
  const heldCalls = heldAppToolCallIds(entries, approvals);
  const kept = entries.filter((entry) => {
    if (entry.kind !== "work") return true;
    if (heldCalls.has(entry.id)) return false;
    const item = entry.entry.structuredPayload;
    return item?.type !== "approval_request" || !pending.has(item.requestId);
  });
  return kept.length === entries.length ? entries : kept;
}

/**
 * The timeline beside the composer's approval card. A waiting app approval's own row repeats the
 * card word for word, and the call it holds is not running but waiting on the card, so both stay
 * out until it is answered, in full Lecturn as in the embed. Full Lecturn keeps a provider's own
 * waiting approval row, whose card shows the command under a generic title; the embed's narrow
 * pane has no room for either twice.
 */
export function useComposerCardTimelineEntries(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<ShownApproval>,
): ReadonlyArray<TimelineEntry> {
  const embedded = useEmbedPresentation() !== null;
  return withoutPendingApprovalRows(
    entries,
    embedded ? approvals : approvals.filter((approval) => approval.connectedAppTool !== undefined),
  );
}
