import { hasAppToolApproval } from "@lecturn/client-runtime/state/thread-requests";

import type { PendingApproval } from "../../session-logic";

export const APP_TOOL_APPROVAL_SEND_BLOCK_REASON = "Approve or decline the app tool above to send.";
/** The card on top is another approval, so "above" would point at the wrong one. */
export const QUEUED_APP_TOOL_APPROVAL_SEND_BLOCK_REASON =
  "Answer this approval and the app tool waiting behind it to send.";

/**
 * Provider approvals take over the composer; an app tool approval sits above
 * a live composer, so the draft, chips and model, effort and
 * access controls stay usable while the user decides.
 */
export function approvalReplacesComposer(approval: PendingApproval | null): boolean {
  return approval !== null && approval.connectedAppTool === undefined;
}

/**
 * A send declines every shown approval, so any app tool among them blocks it, whatever order they
 * arrived in. `shownApprovals` leaves out what the typing guard holds, which a send leaves pending.
 */
export function approvalSendBlockReason(
  activeApproval: PendingApproval | null,
  shownApprovals: ReadonlyArray<PendingApproval>,
): string | null {
  if (activeApproval?.connectedAppTool) return APP_TOOL_APPROVAL_SEND_BLOCK_REASON;
  return hasAppToolApproval(shownApprovals) ? QUEUED_APP_TOOL_APPROVAL_SEND_BLOCK_REASON : null;
}

export type AppApprovalPart = "card" | "icon" | "more";

/** Test ids for the app approval card's parts; provider approvals get none. */
export function appApprovalTestId(
  approval: PendingApproval | null,
  part: AppApprovalPart,
): `app-approval-${AppApprovalPart}` | undefined {
  return approval?.connectedAppTool ? `app-approval-${part}` : undefined;
}

/**
 * The reason line under "Approve <tool>". Static gates carry no reason, so they
 * get no line rather than a filler.
 */
export function appApprovalReasonLine(approval: PendingApproval): string | null {
  return approval.connectedAppTool?.reason?.trim() || null;
}
