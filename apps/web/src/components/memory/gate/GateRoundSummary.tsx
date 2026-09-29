import type { ContributionCard } from "@lecturn/contracts";
import { Undo2Icon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { GateVerdict } from "../gateState";
import { Eyebrow, KeyCap, NodeTypeIcon, plural, VERDICT_LABEL } from "./gateVisuals";

/** End of the round: every verdict at a glance with a way back to each card. Nothing is written yet. */
export function GateRoundSummary({
  review,
  verdicts,
  landCount,
  canUndo,
  landing,
  onJump,
  onUndo,
  onLand,
}: {
  review: ReadonlyArray<ContributionCard>;
  verdicts: ReadonlyMap<string, GateVerdict>;
  landCount: number;
  canUndo: boolean;
  landing: boolean;
  onJump: (index: number) => void;
  onUndo: () => void;
  onLand: () => void;
}) {
  const skipped = review.filter((card) => verdicts.get(card.nodeId)?.verdict === "skip").length;
  return (
    <div className="w-full rounded-[14px] border bg-card px-6 pt-5 pb-4 shadow-sm">
      <Eyebrow>Round complete</Eyebrow>
      <h3 className="mt-1 font-display text-[23px] leading-tight tracking-[-0.01em]">
        {review.length === 0
          ? "Nothing needs you"
          : `${review.length} of ${review.length} ${plural(review.length, "card")} decided`}
      </h3>
      <p className="mt-1 text-muted-foreground text-sm">
        {landCount} {plural(landCount, "node")} will land in the warren.
        {skipped > 0 ? ` ${skipped} ${skipped === 1 ? "stays" : "stay"} in the den.` : ""} Nothing
        has been written yet.
      </p>
      {review.length > 0 ? (
        <table className="mt-3 w-full border-collapse text-[13px]">
          <tbody>
            {review.map((card, index) => {
              const decided = verdicts.get(card.nodeId);
              return (
                <tr key={card.nodeId} className="border-t">
                  <td className="w-5 py-2">
                    <NodeTypeIcon type={card.type} />
                  </td>
                  <td className="max-w-0 truncate py-2 pr-3 font-mono text-xs">{card.nodeId}</td>
                  <td className="w-32 py-2">
                    {decided ? (
                      <span
                        className={cn(
                          "inline-flex h-5 items-center rounded-full px-2 text-[11px]",
                          decided.verdict === "skip"
                            ? "bg-muted text-muted-foreground"
                            : "bg-success/12 text-success-foreground",
                        )}
                      >
                        {VERDICT_LABEL[decided.verdict]}
                      </span>
                    ) : null}
                  </td>
                  <td className="w-16 py-2 text-right">
                    <Button size="micro" variant="link" onClick={() => onJump(index)}>
                      change
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        {canUndo ? (
          <Button size="sm" variant="ghost" onClick={onUndo}>
            <Undo2Icon />
            Undo last <KeyCap>U</KeyCap>
          </Button>
        ) : null}
        <span className="grow" />
        <Button disabled={landing} onClick={onLand}>
          Land {landCount} {plural(landCount, "node")}
          <KeyCap className="border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground">
            ⏎
          </KeyCap>
        </Button>
      </div>
    </div>
  );
}
