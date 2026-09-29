import type {
  ContributionCard,
  ContributionFlag,
  MemoryNodeType,
  MemoryVerdict,
} from "@lecturn/contracts";
import {
  BookMarkedIcon,
  BoxIcon,
  ComponentIcon,
  LayersIcon,
  LightbulbIcon,
  PackageIcon,
  SignpostIcon,
  SquareFunctionIcon,
  type LucideIcon,
} from "lucide-react";
import type * as React from "react";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";
import { wordDiff, type WordDiffToken } from "../wordDiff";

/* Shared visual vocabulary for the Contribution Gate. */

export const GOLD = "var(--lecturn-thread-gold)";
export const goldMix = (percent: number, base = "var(--card)") =>
  `color-mix(in srgb, ${GOLD} ${percent}%, ${base})`;

export const VERDICT_KEYS: ReadonlyArray<readonly [key: string, verdict: MemoryVerdict]> = [
  ["A", "accept"],
  ["E", "edit"],
  ["M", "merge"],
  ["D", "distinct"],
  ["S", "skip"],
];
export const VERDICT_KEY: Record<MemoryVerdict, string> = {
  accept: "A",
  edit: "E",
  merge: "M",
  distinct: "D",
  skip: "S",
};
export const VERDICT_LABEL: Record<MemoryVerdict, string> = {
  accept: "Accept",
  edit: "Edit and accept",
  merge: "Merge",
  distinct: "Keep both",
  skip: "Skip",
};

/** Dot and badge color per verdict: landing verdicts green, merge blue, keep-both gold, skip grey. */
export const VERDICT_TONE: Record<MemoryVerdict, string> = {
  accept: "bg-success",
  edit: "bg-success",
  merge: "bg-info",
  distinct: "bg-(--lecturn-thread-gold)",
  skip: "bg-muted-foreground/55",
};

const TYPE_ICON: Record<MemoryNodeType, LucideIcon> = {
  function: SquareFunctionIcon,
  module: PackageIcon,
  class: BoxIcon,
  interface: ComponentIcon,
  concept: LightbulbIcon,
  decision: SignpostIcon,
  reference: BookMarkedIcon,
  composite: LayersIcon,
};

export function NodeTypeIcon({ type, className }: { type: MemoryNodeType; className?: string }) {
  const Icon = TYPE_ICON[type];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

export const OP_CLASS: Record<ContributionCard["op"], string> = {
  add: "bg-success/12 text-success-foreground",
  update: "bg-info/12 text-info-foreground",
  supersede: "bg-destructive/12 text-destructive-foreground",
  noop: "bg-muted text-muted-foreground",
};

export const FLAG_CLASS: Record<ContributionFlag["kind"], string> = {
  "secret-suspect": "bg-destructive/10 text-destructive-foreground dark:bg-destructive/18",
  "destructive-diff": "bg-destructive/10 text-destructive-foreground dark:bg-destructive/18",
  "standard-fail": "bg-destructive/10 text-destructive-foreground dark:bg-destructive/18",
  "duplicate-suspect": "bg-warning/12 text-warning-foreground dark:bg-warning/18",
  "standard-uncertain": "bg-warning/12 text-warning-foreground dark:bg-warning/18",
  heuristic: "bg-info/10 text-info-foreground dark:bg-info/18",
};

/** Physical key cap: raised bottom edge, mono glyph. */
export function KeyCap({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <Kbd
      className={cn(
        "rounded-[5px] border border-b-2 border-input bg-card font-mono font-semibold text-[10.5px] text-foreground leading-none",
        className,
      )}
      {...props}
    />
  );
}

/** Uppercase section label used across card pages. */
export function Eyebrow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.09em]",
        className,
      )}
      {...props}
    />
  );
}

/** Inline word diff: removed words struck in the error tone, added words on green. */
export function WordDiffText({ before, after }: { before: string; after: string }) {
  const tokens: Array<WordDiffToken & { key: string; lead: string }> = [];
  let offset = 0;
  for (const token of wordDiff(before, after)) {
    tokens.push({ ...token, key: `${token.type}:${offset}`, lead: offset === 0 ? "" : " " });
    offset += token.text.length + 1;
  }
  return (
    <>
      {tokens.map((token) => {
        if (token.type === "equal")
          return (
            <span key={token.key}>
              {token.lead}
              {token.text}
            </span>
          );
        return (
          <span key={token.key}>
            {token.lead}
            {token.type === "delete" ? (
              <del className="rounded-[3px] bg-destructive/14 px-0.5 text-destructive-foreground decoration-destructive/60">
                {token.text}
              </del>
            ) : (
              <ins className="rounded-[3px] bg-success/18 px-0.5 text-foreground no-underline">
                {token.text}
              </ins>
            )}
          </span>
        );
      })}
    </>
  );
}

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
