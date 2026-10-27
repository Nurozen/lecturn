import { isAppToolSource } from "@lecturn/shared/appToolPresentation";
import { lecturnMcpToolName } from "@lecturn/shared/lecturnMcpToolName";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import type { PendingApproval, TimelineEntry } from "../../session-logic";

type ShownApproval = Pick<PendingApproval, "requestId" | "connectedAppTool">;
type WorkTimelineEntry = Extract<TimelineEntry, { kind: "work" }>;

const isWork = (entry: TimelineEntry): entry is WorkTimelineEntry => entry.kind === "work";

/** The app tool a running row is calling, as the approval names it (`rw_simulate`). */
function runningAppToolName(entry: WorkTimelineEntry): string | undefined {
  const item = entry.entry.structuredPayload;
  if (
    entry.entry.toolLifecycleStatus !== "inProgress" ||
    item?.type !== "dynamic_tool" ||
    !isAppToolSource(item.toolSource) ||
    item.toolName === null
  ) {
    return undefined;
  }
  return lecturnMcpToolName(item.toolName) ?? item.toolName;
}

/**
 * The row of the call each app approval is holding. The request names only the tool, so each
 * approval claims an unclaimed running call of that tool in its own run: the latest before its row,
 * else the first after it. The gate gives the approval the thread's next free ordinal when it
 * raises it, and a provider numbers its rows ahead of their commit, so a call whose row has not
 * committed yet can sort after the approval that holds it.
 */
function heldAppToolCallIds(
  entries: ReadonlyArray<TimelineEntry>,
  approvals: ReadonlyArray<ShownApproval>,
): ReadonlySet<string> {
  const held = new Set<string>();
  for (const approval of approvals) {
    const toolName = approval.connectedAppTool?.toolName;
    if (toolName === undefined) continue;
    const approvalIndex = entries.findIndex(
      (entry) =>
        isWork(entry) &&
        entry.entry.structuredPayload?.type === "approval_request" &&
        entry.entry.structuredPayload.requestId === approval.requestId,
    );
    const approvalEntry = approvalIndex >= 0 ? entries[approvalIndex] : undefined;
    const runId = approvalEntry && isWork(approvalEntry) ? approvalEntry.entry.runId : undefined;
    const isHeldCall = (entry: TimelineEntry) =>
      isWork(entry) &&
      !held.has(entry.id) &&
      (runId == null || entry.entry.runId === runId) &&
      runningAppToolName(entry) === toolName;
    const end = approvalIndex >= 0 ? approvalIndex : entries.length;
    let call: TimelineEntry | undefined;
    for (let index = end - 1; index >= 0 && call === undefined; index -= 1) {
      if (isHeldCall(entries[index]!)) call = entries[index];
    }
    for (let index = end + 1; index < entries.length && call === undefined; index += 1) {
      if (isHeldCall(entries[index]!)) call = entries[index];
    }
    if (call !== undefined) held.add(call.id);
  }
  return held;
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
