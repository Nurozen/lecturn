import type { PendingApproval } from "../../session-logic";

export const APP_TOOL_APPROVAL_SEND_BLOCK_REASON = "Approve or decline the app tool above to send.";

/**
 * Provider approvals take over the composer; an app tool approval sits above
 * a live composer, so the draft, chips and model, effort and
 * access controls stay usable while the user decides.
 */
export function approvalReplacesComposer(approval: PendingApproval | null): boolean {
  return approval !== null && approval.connectedAppTool === undefined;
}

export function approvalSendBlockReason(approval: PendingApproval | null): string | null {
  return approval?.connectedAppTool ? APP_TOOL_APPROVAL_SEND_BLOCK_REASON : null;
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
