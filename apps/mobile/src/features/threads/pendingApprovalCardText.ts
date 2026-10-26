import { appToolApprovalLabel } from "@lecturn/shared/appToolPresentation";

import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardText {
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string | null;
  /** An app's reason is its own words about the call, set apart from Lecturn's copy. */
  readonly monoDetail: boolean;
}

/**
 * A connected app's gated tool waits on this answer, not the provider, so the
 * card names the app and the tool, and gives the app's reason in place of the
 * generic prompt.
 */
export function pendingApprovalCardText(
  approval: Pick<PendingApproval, "appName" | "requestKind" | "detail" | "connectedAppTool">,
): PendingApprovalCardText {
  const appTool = approval.connectedAppTool;
  if (appTool === undefined) {
    return {
      eyebrow: "Approval needed",
      title: approval.appName ?? approval.requestKind,
      detail: approval.detail ?? null,
      monoDetail: false,
    };
  }
  return {
    eyebrow: `${appTool.appName} · Approval needed`,
    title: appToolApprovalLabel(appTool),
    detail: appTool.reason?.trim() || null,
    monoDetail: true,
  };
}
