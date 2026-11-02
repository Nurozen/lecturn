import type { SquireIndicatorStateName } from "@lecturn/client-runtime/state/squireIndicator";

import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import type { CompanionPalette } from "./companion/types";
import { SQUIRE_PALETTE_TINT } from "./squirePaletteTint";

// Paths come from assets/squire/threadkeeper-small.svg, the source of truth.
const STRAND = "M16 4C9 2 5 6 7 9C9 12 19 11 19 16C19 20 14 22 9 20";
const THREAD = "M4.5 12C4.5 16 11 15.5 14 17C17 19 13 21 9 20";
const STAR =
  "M16 1.5C16.3 3.4 16.6 3.7 18.5 4C16.6 4.3 16.3 4.6 16 6.5C15.7 4.6 15.4 4.3 13.5 4C15.4 3.7 15.7 3.4 16 1.5Z";

const observeWorkingTrace = (element: SVGElement | null) =>
  observeVisibleAnimation(element, { pauseWhenUnfocused: true });

export interface SquireMarkProps {
  readonly state: SquireIndicatorStateName;
  readonly palette: CompanionPalette;
  readonly isLead?: boolean | undefined;
  readonly size: number;
  readonly label: string;
  readonly className?: string | undefined;
}

/** The Threadkeeper mark form of the indicator, used below 22 px and for emblem presence. */
export function SquireMark({ state, palette, isLead, size, label, className }: SquireMarkProps) {
  const working = state === "working";
  const waiting = state === "waiting";
  const dimmed = state === "idle" || state === "needs_provider";
  // Waiting draws strand and thread in the one ring color: a two-tone mark at this size reads
  // as a dash, which is working's look.
  const strandStroke = waiting ? "stroke-(--squire-ring)" : "stroke-(--squire-strand)";
  const threadStroke = waiting ? "stroke-(--squire-ring)" : "stroke-(--squire-thread)";
  return (
    <span
      role="img"
      aria-label={label}
      data-squire-state={state}
      className={cn(
        "inline-block shrink-0",
        SQUIRE_PALETTE_TINT[isLead ? "gold" : palette],
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        // An explicit opacity either way: hosts such as Toggle fade svgs that have none.
        className={cn("block size-full", dimmed ? "opacity-50 grayscale" : "opacity-100")}
      >
        {/* While working the base recedes to a faint rest, so the bold full-color dash alone
            carries the still at 16 px. */}
        <g data-slot="squire-mark-base" className={cn(working && "opacity-25")}>
          <g strokeLinecap="round" strokeLinejoin="round" strokeWidth={waiting ? 1.6 : 1.25}>
            <path d={STRAND} className={strandStroke} />
            <path d={THREAD} className={threadStroke} />
          </g>
          <g className={waiting ? "fill-(--squire-ring)" : "fill-(--squire-thread)"}>
            <circle cx="4.5" cy="12" r="1" />
            <circle cx="9" cy="20" r="1" />
            <path d={STAR} />
          </g>
        </g>
        {working ? (
          <path
            ref={observeWorkingTrace}
            d={STRAND}
            pathLength={100}
            strokeDasharray="64 36"
            strokeWidth={2.75}
            strokeLinecap="round"
            data-slot="squire-mark-trace"
            // The saturated palette tone: the pale comet tone read as faint on dark surfaces.
            className="squire-mark-trace stroke-(--squire-ring) light:stroke-(--squire-trace)"
          />
        ) : null}
      </svg>
    </span>
  );
}
