import type { MemoryReceipt } from "@lecturn/contracts";
import { GitCommitHorizontalIcon, RotateCcwIcon, Undo2Icon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { Eyebrow, GOLD, plural } from "./gateVisuals";

const COUNT_LABELS = [
  ["added", "added"],
  ["updated", "updated"],
  ["superseded", "superseded"],
  ["merged", "merged"],
  ["distinct", "kept both"],
  ["skipped", "skipped, in den"],
] as const;

/** What a land changed, the receipt id shown like a commit, and the way back. */
export function GateReceipt({
  receipt,
  busy,
  error,
  onRevert,
  onLandAgain,
}: {
  receipt: MemoryReceipt;
  busy: boolean;
  error: string | null;
  onRevert: () => void;
  onLandAgain: () => void;
}) {
  const landed = receipt.landedNodeIds.length;
  const reverted = receipt.reverted;
  const grown = [...receipt.territoriesGrown].sort((a, b) => b.count - a.count);
  const maxGrown = Math.max(1, ...grown.map((territory) => territory.count));
  return (
    <div className="grid w-full max-w-[960px] overflow-hidden rounded-[14px] border bg-card shadow-sm md:grid-cols-[minmax(0,1fr)_340px]">
      <div className="px-6 pt-5 pb-5">
        <Eyebrow>Receipt</Eyebrow>
        <h3 className="mt-1 font-display text-[28px] leading-tight tracking-[-0.02em]">
          {reverted
            ? "Contribution reverted"
            : `${landed} ${plural(landed, "node")} landed in the warren`}
        </h3>
        <div
          key={reverted ? "reverted" : receipt.id}
          aria-hidden
          className={cn(
            "mt-2.5 mb-4 h-px origin-left",
            reverted
              ? "opacity-25"
              : "animate-[lecturn-thread-arrive_650ms_ease-out_both] opacity-80 motion-reduce:animate-none",
          )}
          style={{
            background: `linear-gradient(90deg, var(--lecturn-thread-line), ${GOLD} 30%, var(--lecturn-thread-tip) 50%, ${GOLD} 70%, transparent)`,
            boxShadow: reverted ? undefined : "0 0 6px 1px var(--lecturn-thread-glow)",
          }}
        />
        <dl className="grid grid-cols-3 overflow-hidden rounded-lg border sm:grid-cols-6">
          {COUNT_LABELS.map(([key, label]) => (
            <div
              key={key}
              className="flex flex-col-reverse border-l px-3 py-2.5 first:border-l-0 max-sm:[&:nth-child(4)]:border-l-0"
            >
              <dt className="mt-1 text-[11px] text-muted-foreground">{label}</dt>
              <dd
                className={cn(
                  "font-display text-[26px] leading-none tabular-nums",
                  reverted && key !== "skipped" && "text-muted-foreground line-through",
                )}
              >
                {receipt.counts[key]}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-3.5 flex items-center gap-3 rounded-lg border px-3 py-2.5 text-[12.5px]">
          <GitCommitHorizontalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 grow">
            <div>
              {reverted ? "Reverted" : "Landed"}{" "}
              <code
                className="font-mono font-semibold"
                style={{ color: "var(--lecturn-thread-name)" }}
              >
                {receipt.id}
              </code>{" "}
              <span className="text-muted-foreground">
                {new Date(receipt.at).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <div className="text-muted-foreground text-xs">
              {reverted
                ? `All ${landed} ${plural(landed, "node")} are back in the den. The warren is as it was.`
                : `${landed} ${plural(landed, "node")} in the warren, ${receipt.counts.skipped} kept in the den.`}
            </div>
          </div>
          {reverted ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onLandAgain}>
              <RotateCcwIcon />
              Land again
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={onRevert}>
              <Undo2Icon />
              Revert
            </Button>
          )}
        </div>
        {error ? <p className="mt-2 text-destructive-foreground text-xs">{error}</p> : null}
      </div>
      <div className="border-t bg-[color-mix(in_srgb,var(--background)_55%,var(--card))] px-5 pt-5 pb-5 md:border-t-0 md:border-l">
        <Eyebrow className="mb-3">Territories that grew</Eyebrow>
        {grown.length > 0 ? (
          <ul className="flex flex-col gap-2.5">
            {grown.map((territory) => (
              <li key={territory.territoryId} className="text-[13px]">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate font-display text-[14px]">
                    {territory.territoryId}
                  </span>
                  <span
                    className={cn(
                      "ml-auto font-mono text-[11px] tabular-nums",
                      reverted ? "text-muted-foreground" : undefined,
                    )}
                    style={reverted ? undefined : { color: "var(--lecturn-thread-name)" }}
                  >
                    {reverted ? "+0" : `+${territory.count}`}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(territory.count / maxGrown) * 100}%`,
                      background: reverted ? "transparent" : GOLD,
                      border: reverted ? "1px dashed var(--color-muted-foreground)" : undefined,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">
            No territory grew. Everything was skipped.
          </p>
        )}
        <p className="mt-4 text-muted-foreground text-xs">
          {reverted
            ? "Dashed bars show where the nodes were."
            : "Close the Gate to see them lit on the map."}
        </p>
      </div>
    </div>
  );
}
