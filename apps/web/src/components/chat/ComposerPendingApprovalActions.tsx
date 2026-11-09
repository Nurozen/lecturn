import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@lecturn/contracts";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  presentation?: "composer" | "inline";
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
  presentation = "composer",
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
  // A host theme's --input can sit within a few levels of its warning-tinted card, so an outline
  // drawn from it vanishes there at any width; the warning outline is Lecturn's own color.
  const outlineVariant = embedded ? "warning-outline" : "outline";
  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const buttonProps = {
          disabled: disabled || isResponding || !canRespond,
          "aria-description": option.warning,
          onClick: () => {
            if (!disabled && !isResponding && canRespond) {
              void onRespondToApproval(requestId, option.decision);
            }
          },
        };
        const content = (
          <>
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className={presentation === "inline" ? "whitespace-normal" : "max-w-40 truncate"}>
              {option.label}
            </span>
          </>
        );
        const button =
          presentation === "inline" ? (
            <InlineButton
              key={option.decision}
              {...buttonProps}
              tone={option.decision === "accept" ? "default" : "muted"}
            >
              {content}
            </InlineButton>
          ) : (
            <Button
              key={option.decision}
              {...buttonProps}
              // The embed pane is narrow: compact buttons leave the tool's name room to show whole.
              size={embedded ? "micro" : "xs"}
              variant={option.decision === "accept" ? "default" : outlineVariant}
            >
              {content}
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
            // Stop turn stays reachable when the provider process is gone.
            disabled={disabled || isResponding || (!canRespond && stopTurn === undefined)}
            render={
              presentation === "inline" ? (
                <InlineButton
                  tone="muted"
                  aria-label="More approval options"
                  data-testid={moreTestId}
                />
              ) : (
                <Button
                  size={embedded ? "icon-micro" : "icon-xs"}
                  variant={outlineVariant}
                  aria-label="More approval options"
                  data-testid={moreTestId}
                />
              )
            }
          >
            {presentation === "inline" ? "More" : <EllipsisIcon />}
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding || !canRespond}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled && !isResponding && canRespond)
                      void onRespondToApproval(requestId, option.decision);
                  }}
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
