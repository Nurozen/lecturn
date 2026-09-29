import { ChevronRightIcon, LockIcon, XIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { Button } from "~/components/ui/button";
import { GOLD, goldMix } from "./gateVisuals";

export interface GateTierCounts {
  readonly silent: number;
  readonly auto: number;
  readonly review: number;
}

/** Gate header: den to warren route, the headline in the display serif, and
    the stacked tier bar. Tier segments grow and shrink once per change. */
export function GateHeader({
  denName,
  destinations,
  headline,
  headlineId,
  counts,
  onClose,
  closeLabel,
}: {
  denName: string;
  destinations: ReadonlyArray<string>;
  headline: string;
  headlineId: string;
  counts: GateTierCounts | null;
  onClose: () => void;
  closeLabel: string;
}) {
  const total = counts ? counts.silent + counts.auto + counts.review : 0;
  return (
    <header
      className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-6 gap-y-3 border-b px-6 pt-4 pb-3.5 md:grid-cols-[minmax(0,1fr)_minmax(240px,380px)_auto]"
      style={{
        background: `radial-gradient(700px 160px at 18% -60px, color-mix(in srgb, ${GOLD} 11%, transparent), transparent)`,
      }}
    >
      <div className="min-w-0">
        <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <span
            aria-hidden
            className="size-[7px] shrink-0 rounded-full"
            style={{ background: GOLD, boxShadow: `0 0 0 2px ${goldMix(25, "transparent")}` }}
          />
          <span className="truncate font-mono">den/{denName}</span>
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
          <LockIcon aria-hidden className="size-3 shrink-0" />
          <span className="font-mono">warren</span>
          {destinations.length > 0 ? (
            <span
              className="ml-1 inline-flex h-5 min-w-0 items-center truncate rounded-full border px-2 font-mono text-[11px] text-foreground"
              style={{ borderColor: goldMix(45, "var(--border)"), background: goldMix(8) }}
            >
              {destinations.length === 1
                ? destinations[0]
                : `${destinations.slice(0, 3).join(", ")}${destinations.length > 3 ? ` +${destinations.length - 3}` : ""}`}
            </span>
          ) : null}
        </div>
        <h2
          id={headlineId}
          aria-live="polite"
          className="truncate font-display text-[25px] leading-tight tracking-[-0.02em] max-md:text-[21px]"
        >
          {headline}
        </h2>
      </div>
      {counts && total > 0 ? (
        <div className="max-md:hidden">
          <div
            role="img"
            aria-label={`Tiers: ${counts.silent} silent, ${counts.auto} auto, ${counts.review} review`}
            className="flex h-3 gap-0.5 overflow-hidden rounded-md"
          >
            <TierSegment grow={counts.silent} className="bg-muted-foreground/30" />
            <TierSegment grow={counts.auto} className="bg-success" />
            <TierSegment grow={counts.review} style={{ background: GOLD }} />
          </div>
          <div className="mt-1.5 flex gap-4 text-[11.5px] text-muted-foreground">
            <TierLegend n={counts.silent} label="silent" className="bg-muted-foreground/30" />
            <TierLegend n={counts.auto} label="auto" className="bg-success" />
            <TierLegend n={counts.review} label="review" style={{ background: GOLD }} />
          </div>
        </div>
      ) : (
        <div className="max-md:hidden" />
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={closeLabel}
        className="self-start"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </header>
  );
}

function TierSegment({
  grow,
  className,
  style,
}: {
  grow: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <i
      className={`block h-full transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none ${className ?? ""}`}
      style={{ ...style, flexGrow: grow, flexBasis: 0, display: grow === 0 ? "none" : undefined }}
    />
  );
}

function TierLegend({
  n,
  label,
  className,
  style,
}: {
  n: number;
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className="flex items-baseline">
      <i
        aria-hidden
        className={`mr-1.5 inline-block size-2 self-center rounded-[2px] ${className ?? ""}`}
        style={style}
      />
      <b className="mr-1 font-display font-normal text-base text-foreground tabular-nums">{n}</b>
      {label}
    </span>
  );
}
