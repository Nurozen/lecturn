import type { ContributionCard } from "@lecturn/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { GateVerdict } from "../gateState";
import { GOLD, NodeTypeIcon, VERDICT_KEY, VERDICT_LABEL } from "./gateVisuals";

/** Right column: every review card with its verdict, then the auto and silent tiers. */
export function GateSide({
  review,
  auto,
  silentCount,
  verdicts,
  cursor,
  interactive,
  onJump,
  onPull,
}: {
  review: ReadonlyArray<ContributionCard>;
  auto: ReadonlyArray<ContributionCard>;
  silentCount: number;
  verdicts: ReadonlyMap<string, GateVerdict>;
  cursor: number | null;
  interactive: boolean;
  onJump: (index: number) => void;
  onPull: (nodeId: string) => void;
}) {
  const [autoOpen, setAutoOpen] = useState(false);
  const decided = review.filter((card) => verdicts.has(card.nodeId)).length;
  return (
    <aside
      aria-label="Tiers"
      className="min-h-0 overflow-y-auto border-l bg-[color-mix(in_srgb,var(--secondary)_50%,var(--background))] max-lg:hidden"
    >
      <section className="border-b">
        <SideHeading swatch={GOLD} label="Review">
          <span className="ml-auto font-display font-normal text-[15px] tabular-nums">
            {decided} / {review.length}
          </span>
        </SideHeading>
        {review.length > 0 ? (
          <ul className="px-2 pb-2.5">
            {review.map((card, index) => {
              const decidedVerdict = verdicts.get(card.nodeId);
              return (
                <li key={card.nodeId}>
                  <button
                    type="button"
                    disabled={!interactive}
                    aria-current={cursor === index ? "true" : undefined}
                    aria-label={`${card.nodeId}${decidedVerdict ? `, ${VERDICT_LABEL[decidedVerdict.verdict]}` : ", undecided"}`}
                    onClick={() => onJump(index)}
                    className={cn(
                      "grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent",
                      cursor === index &&
                        "bg-card shadow-[0_0_0_1px_var(--color-border)] hover:bg-card",
                    )}
                  >
                    <NodeTypeIcon type={card.type} />
                    <span className="truncate font-mono text-[11.5px]">{card.nodeId}</span>
                    <span className="font-mono font-semibold text-[10px] text-muted-foreground">
                      {decidedVerdict ? VERDICT_KEY[decidedVerdict.verdict] : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 pb-3 text-muted-foreground text-xs">Nothing needs a verdict.</p>
        )}
      </section>

      <section className="border-b">
        <button
          type="button"
          aria-expanded={autoOpen}
          onClick={() => setAutoOpen((open) => !open)}
          className="flex w-full items-center gap-2 px-3.5 py-2.5 font-semibold text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              autoOpen && "rotate-90",
            )}
          />
          <span aria-hidden className="size-2 rounded-[2px] bg-success" />
          Lands on its own
          <span className="ml-auto font-display font-normal text-[15px] tabular-nums">
            {auto.length}
          </span>
        </button>
        {autoOpen ? (
          <div className="px-2 pb-2.5">
            <p className="px-2 pb-1.5 text-muted-foreground text-xs">
              Clean adds and additive updates. Pull any into review.
            </p>
            <ul>
              {auto.map((card) => (
                <li
                  key={card.nodeId}
                  className="group grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent/60"
                >
                  <NodeTypeIcon type={card.type} />
                  <span className="truncate font-mono text-[11.5px]">{card.nodeId}</span>
                  <Button
                    size="micro"
                    variant="ghost-muted"
                    disabled={!interactive}
                    onClick={() => onPull(card.nodeId)}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    pull into review
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="border-b pb-2.5">
        <SideHeading
          swatch="color-mix(in srgb, var(--color-muted-foreground) 35%, transparent)"
          label="Silent, unchanged"
        >
          <span className="ml-auto font-display font-normal text-[15px] tabular-nums">
            {silentCount}
          </span>
        </SideHeading>
        <p className="-mt-1 px-3.5 text-muted-foreground text-xs">
          Unchanged since the last contribution. Nothing to do.
        </p>
      </section>
    </aside>
  );
}

function SideHeading({
  swatch,
  label,
  children,
}: {
  swatch: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5 font-semibold text-xs">
      <span aria-hidden className="size-2 rounded-[2px]" style={{ background: swatch }} />
      {label}
      {children}
    </div>
  );
}
