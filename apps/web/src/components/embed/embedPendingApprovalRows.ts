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
 * app tool call it holds. The composer's approval card already asks it, and the narrow pane has no
 * room to ask twice; once answered the approval comes back as the resolved record and the call's
 * row returns with it.
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

/** The embed's timeline; full Lecturn keeps the pending row beside its composer card. */
export function useEmbedTimelineEntries(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<ShownApproval>,
): ReadonlyArray<TimelineEntry> {
  const embedded = useEmbedPresentation() !== null;
  return embedded ? withoutPendingApprovalRows(entries, approvals) : entries;
}

/**
 * In the embed a turn waiting on the composer card's answer shows no live rows; full Lecturn keeps
 * them and its working row says it is waiting.
 */
export function useEmbedTimelineWaitingOnUser(awaitingUser: boolean): boolean {
  return useEmbedPresentation() !== null && awaitingUser;
}
