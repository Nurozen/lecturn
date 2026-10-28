import type { ConnectedAppToolApprovalInfo } from "@lecturn/contracts";
import { appToolApprovalLabel } from "@lecturn/shared/appToolPresentation";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { appApprovalReasonLine } from "./composerApprovalState";

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
 * The tool with the app's reason under it, as one item of the banner row
 * (`data-app-tool-approval`, ComposerBanner): the actions sit beside it while
 * the tool's whole name fits next to them, and otherwise wrap below the reason.
 * The reason is prose the app wrote for the user, not a command, so it reads as
 * text and wraps to a second line before truncating. It takes no width of its
 * own, so a long one never pushes the actions down. The embed keeps
 * the actions on the title's row, so there the reason takes a line of its own
 * under both (embedComposer.css) and the title truncates only once the compact
 * actions leave it no room.
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
  const label = appToolApprovalLabel(tool);
  const reason = appApprovalReasonLine(approval);
  const notResumable = approval.responseCapability === "not_resumable";
  const embedded = useEmbedPresentation() !== null;
  return (
    <span
      aria-label={label}
      className={cn("flex min-w-0 grow flex-col gap-0.5", embedded && "basis-0", className)}
      data-app-tool-approval="true"
      role="group"
    >
      <span className="flex min-w-0 items-center gap-2 text-xs">
        <span
          className={cn(
            "min-w-0 font-medium text-warning",
            embedded ? "truncate" : "wrap-anywhere",
          )}
          data-testid="app-approval-title"
        >
          {label}
        </span>
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums">
            1/{pendingCount}
          </span>
        ) : null}
      </span>
      {notResumable ? (
        <span
          className="block w-0 min-w-full truncate text-2xs text-muted-foreground"
          data-app-approval-detail
        >
          {NOT_RESUMABLE_DETAIL}
        </span>
      ) : reason ? (
        <span
          aria-label="Reason"
          className="w-0 min-w-full font-sans text-xs wrap-break-word text-muted-foreground line-clamp-2"
          data-app-approval-detail
          data-testid="app-approval-reason"
        >
          {reason}
        </span>
      ) : null}
    </span>
  );
}
