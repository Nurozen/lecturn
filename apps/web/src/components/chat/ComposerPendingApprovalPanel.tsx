import type { ConnectedAppToolApprovalInfo } from "@lecturn/contracts";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

const NOT_RESUMABLE_DETAIL = "Provider process is gone — interrupt or restart the run to respond.";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  if (approval.connectedAppTool) {
    return (
      <ConnectedAppToolApproval
        approval={approval}
        tool={approval.connectedAppTool}
        pendingCount={pendingCount}
        className={className}
      />
    );
  }
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : approval.requestKind === "permission"
            ? "App permission approval"
            : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "permission"
            ? "Permission request"
            : "File change";

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      <Detail
        aria-label={detailAriaLabel}
        className={cn(
          "block max-h-20 w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
          approval.requestKind === "mcp-elicitation"
            ? "whitespace-pre-wrap font-sans wrap-break-word"
            : "whitespace-pre font-mono",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.responseCapability === "not_resumable"
          ? NOT_RESUMABLE_DETAIL
          : approval.detail || fallbackLabel}
      </Detail>
    </span>
  );
});

/**
 * One line with the tool, and the app's reason under it across the whole
 * banner. Its parts are placed on the banner row's grid
 * (`data-app-tool-approval`, ComposerBanner), so the actions stay beside the
 * tool in a narrow embedded pane instead of wrapping below it.
 */
function ConnectedAppToolApproval({
  approval,
  tool,
  pendingCount,
  className,
}: {
  approval: PendingApproval;
  tool: ConnectedAppToolApprovalInfo;
  pendingCount: number;
  className: string | undefined;
}) {
  const label = `Approve ${tool.toolName}`;
  const reason = tool.reason?.trim();
  return (
    <span
      aria-label={label}
      className={cn("contents", className)}
      data-app-tool-approval="true"
      role="group"
    >
      <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-2 self-center text-xs">
        <span className="min-w-0 truncate font-medium text-warning">{label}</span>
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums">
            1/{pendingCount}
          </span>
        ) : null}
      </span>
      <span
        aria-label="Reason"
        className={cn(
          "col-span-full row-start-2 block min-w-0 truncate text-2xs text-muted-foreground",
          reason ? "font-mono" : "font-sans",
        )}
      >
        {approval.responseCapability === "not_resumable"
          ? NOT_RESUMABLE_DETAIL
          : reason || tool.appName}
      </span>
    </span>
  );
}
