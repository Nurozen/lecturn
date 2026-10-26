import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@lecturn/contracts";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  moreTestId?: string | undefined;
  /** The embed's composer keeps its send arrow while the card asks, so the menu offers the stop. */
  onStopTurn?: (() => void) | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  moreTestId,
  onStopTurn,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const embedded = useEmbedPresentation() !== null;
  const stopTurn = embedded ? onStopTurn : undefined;
  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const button = (
          <Button
            key={option.decision}
            // The embed pane is narrow: compact buttons leave the tool's name room to show whole.
            size={embedded ? "micro" : "xs"}
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={disabled || isResponding || !canRespond}
            aria-description={option.warning}
            onClick={() => {
              if (!disabled && !isResponding) {
                void onRespondToApproval(requestId, option.decision);
              }
            }}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 || stopTurn !== undefined ? (
        <Menu>
          <MenuTrigger
            disabled={disabled || isResponding}
            render={
              <Button
                size={embedded ? "icon-micro" : "icon-xs"}
                variant="outline"
                aria-label="More approval options"
                data-testid={moreTestId}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled && !isResponding)
                      void onRespondToApproval(requestId, option.decision);
                  }}
                  variant="ghost"
                  className="mb-1 last:mb-0"
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
            {stopTurn !== undefined ? (
              <MenuItem
                disabled={disabled}
                onClick={() => {
                  if (!disabled) stopTurn();
                }}
                variant="ghost"
                className="mb-1 last:mb-0"
              >
                Stop turn
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});
