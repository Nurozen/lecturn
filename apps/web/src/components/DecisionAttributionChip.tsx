import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { DecisionAttribution } from "@lecturn/contracts";
const labels = {
  "user-directed": "User directed",
  "user-accepted": "User accepted",
  "agent-chosen": "Agent chosen",
} as const;
const descriptions = {
  "user-directed": "The user explicitly chose this course of action.",
  "user-accepted": "The user explicitly accepted an agent proposal.",
  "agent-chosen": "The agent chose this course of action; user acceptance is not established.",
} as const;
export function DecisionAttributionChip({
  attribution,
}: {
  readonly attribution: DecisionAttribution;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className="inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-foreground"
      >
        {labels[attribution]}
      </TooltipTrigger>
      <TooltipPopup>{descriptions[attribution]}</TooltipPopup>
    </Tooltip>
  );
}
