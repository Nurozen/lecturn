import type { SquireIndicatorStateName } from "@lecturn/client-runtime/state/squireIndicator";

import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import {
  LEAD_CREST_FILL,
  LEAD_CREST_PATHS,
  LEAD_CREST_STROKE,
  LEAD_CREST_STROKE_WIDTH,
  LEAD_CREST_VIEWBOX,
} from "./companion/leadCrest";
import type { CompanionPalette, RigAppearance, RigHood } from "./companion/types";
import { SquireMark } from "./SquireMark";
import { SQUIRE_PALETTE_TINT } from "./squirePaletteTint";

// Head-and-shoulders stills of the rig itself per appearance, hood, and palette, so each
// Squire's face carries its cloth color, not only its ring. Emitted as files: inlined, all
// twenty would ride in the sidebar's chunk whichever few are on screen.
const PORTRAITS = import.meta.glob<string>("../../assets/squire/portraits/*.webp", {
  eager: true,
  import: "default",
  query: "?no-inline",
});

function portraitSource(appearance: RigAppearance, hood: RigHood, palette: CompanionPalette) {
  return PORTRAITS[`../../assets/squire/portraits/${appearance}-${hood}-${palette}.webp`];
}

/**
 * The working arc, in hundredths of the ring: a solid head and, behind it, a fainter and thinner
 * tail, so the arc tapers into the direction it came from. Head, tail, and the head's round caps
 * stay under half the ring; near full closure the arc would read as waiting's solid ring.
 */
const SQUIRE_ARC_HEAD = 34;
const SQUIRE_ARC_TAIL = 12;

// Below this the portrait face is unreadable, so the indicator becomes the mark (spec P16.4).
const MIN_PORTRAIT_SIZE = 22;

const observeWorkingArc = (element: HTMLElement | null) =>
  observeVisibleAnimation(element, { pauseWhenUnfocused: true });

export interface SquireIndicatorProps {
  readonly state: SquireIndicatorStateName;
  readonly palette: CompanionPalette;
  readonly presence?: "figure" | "emblem" | undefined;
  readonly appearance: RigAppearance;
  readonly hood: RigHood;
  readonly isLead?: boolean | undefined;
  readonly size: number;
  readonly label: string;
  readonly className?: string | undefined;
}

/**
 * D42 encoding, readable from one still: idle is partly desaturated and slightly dim with a faint
 * ring (muted, not disabled: some cloth color stays); working is full color with a tapered arc,
 * under half the ring, travelling it; waiting is full color with a solid ring.
 */
export function SquireIndicator(props: SquireIndicatorProps) {
  const { state, palette, presence, appearance, hood, isLead, size, label, className } = props;
  if (presence === "emblem" || size < MIN_PORTRAIT_SIZE) {
    return (
      <SquireMark
        state={state}
        palette={palette}
        isLead={isLead}
        size={size}
        label={label}
        className={className}
      />
    );
  }
  const working = state === "working";
  const dimmed = state === "idle" || state === "needs_provider";
  const tint = isLead ? "gold" : palette;
  return (
    <span
      role="img"
      aria-label={label}
      data-squire-state={state}
      className={cn("relative inline-block shrink-0", SQUIRE_PALETTE_TINT[tint], className)}
      style={{ width: size, height: size }}
    >
      <img
        src={portraitSource(appearance, hood, tint)}
        alt=""
        draggable={false}
        data-slot="squire-portrait"
        className={cn(
          "absolute top-[11%] left-[11%] size-[78%] rounded-full object-cover",
          dimmed && "opacity-80 grayscale-60",
        )}
      />
      {/* opacity-100 on each svg: hosts such as Toggle fade svgs without an opacity class,
          which would dim the state this indicator encodes (a working chip read as idle). */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="absolute inset-0 size-full opacity-100"
      >
        <circle
          cx="12"
          cy="12"
          r="11"
          strokeWidth={1.5}
          data-slot="squire-ring"
          className={cn("stroke-(--squire-ring)", state !== "waiting" && "opacity-25")}
        />
      </svg>
      {working ? (
        <span
          ref={observeWorkingArc}
          data-slot="squire-arc"
          className="squire-indicator-arc absolute inset-0"
        >
          {/* The ring's path runs clockwise from 3 o'clock, the way the arc turns, so the tail
              takes the start of the path and the head leads from just past it. Both strokes are
              static; only the span rotates. */}
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-full opacity-100">
            <circle
              cx="12"
              cy="12"
              r="11"
              strokeWidth={1.2}
              pathLength={100}
              strokeDasharray={`${SQUIRE_ARC_TAIL} ${100 - SQUIRE_ARC_TAIL}`}
              data-slot="squire-arc-tail"
              className="stroke-(--squire-ring) opacity-40"
            />
            <circle
              cx="12"
              cy="12"
              r="11"
              strokeWidth={1.8}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${SQUIRE_ARC_HEAD} ${100 - SQUIRE_ARC_HEAD}`}
              strokeDashoffset={-SQUIRE_ARC_TAIL}
              data-slot="squire-arc-head"
              className="stroke-(--squire-ring)"
            />
          </svg>
        </span>
      ) : null}
      {isLead ? <LeadCrest dimmed={dimmed} /> : null}
    </span>
  );
}

// The crest is part of the still: idle dims it with the portrait, so a gold badge never reads
// as a Squire waiting on the user.
function LeadCrest({ dimmed }: { readonly dimmed: boolean }) {
  return (
    <svg
      viewBox={`0 0 ${LEAD_CREST_VIEWBOX} ${LEAD_CREST_VIEWBOX}`}
      fill={LEAD_CREST_FILL}
      stroke={LEAD_CREST_STROKE}
      strokeWidth={LEAD_CREST_STROKE_WIDTH}
      strokeLinejoin="round"
      aria-hidden="true"
      data-slot="squire-crest"
      className={cn(
        "absolute -right-[6%] -bottom-[6%] size-[42%]",
        dimmed ? "opacity-80 grayscale-60" : "opacity-100",
      )}
    >
      {LEAD_CREST_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
