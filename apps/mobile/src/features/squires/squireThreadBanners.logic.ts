import { holdRemaining, type SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { SquireCardId, SquireCardKind, SquireCardRow, ThreadId } from "@lecturn/contracts";

export interface SquireHoldBannerState {
  readonly cardId: SquireCardId;
  readonly kind: SquireCardKind;
  readonly targetThreadId: ThreadId | null;
  /** Whole seconds left; 0 once the hold has run out and the action is executing. */
  readonly seconds: number;
}

export type SquireComposerBannerState =
  | { readonly kind: "none" }
  | {
      readonly kind: "banners";
      readonly holds: ReadonlyArray<SquireHoldBannerState>;
      readonly budget: { readonly text: string; readonly detail: string | null } | null;
    };

/** Shown while a budget is spent; a zero allowance is a choice, not an exhausted budget. */
function squireBudgetLine(
  entry: Pick<SquireSnapshotEntry, "budget" | "squire">,
  formatTime: (iso: string) => string,
): { readonly text: string; readonly detail: string | null } | null {
  const { budget } = entry;
  const { steersPerDay, threadsPerDay } = entry.squire.budgets;
  const spent = [
    steersPerDay > 0 && budget.steersLeft === 0 ? `0 of ${steersPerDay} steers left today` : null,
    threadsPerDay > 0 && budget.threadsLeft === 0
      ? `0 of ${threadsPerDay} threads left today`
      : null,
  ].filter((line) => line !== null);
  if (budget.recommendingUntil === undefined && spent.length === 0) return null;
  return {
    text:
      budget.recommendingUntil === undefined
        ? "Budget reached, recommending only"
        : `Budget reached, recommending only until ${formatTime(budget.recommendingUntil)}`,
    detail: spent.length === 0 ? null : spent.join(" · "),
  };
}

/** Holds and the budget notice above the home thread's composer. */
export function squireComposerBannerState(
  entry: Pick<SquireSnapshotEntry, "budget" | "squire" | "held" | "receivedAt"> | null,
  now: number,
  formatTime: (iso: string) => string,
): SquireComposerBannerState {
  if (entry === null) return { kind: "none" };
  const budget = squireBudgetLine(entry, formatTime);
  if (entry.held.length === 0 && budget === null) return { kind: "none" };
  return {
    kind: "banners",
    holds: entry.held.map((hold) => ({
      cardId: hold.cardId,
      kind: hold.kind,
      targetThreadId: hold.targetThreadId,
      seconds: Math.ceil(holdRemaining(entry.receivedAt, hold.executesInMs, now) / 1000),
    })),
    budget,
  };
}

export function squireHoldText(
  kind: SquireCardKind,
  targetTitle: string | null,
  seconds: number,
): string {
  const action =
    kind === "steer"
      ? targetTitle === null
        ? "Sending a steer"
        : `Sending a steer to ${targetTitle}`
      : kind === "proposal"
        ? "Creating a thread"
        : "Acting";
  return seconds > 0 ? `${action} in ${seconds}s` : `${action} now`;
}

export interface TrackedThreadBannerState {
  readonly text: string;
  /** The item the banner opens: the oldest open decision on this thread. */
  readonly cardId: SquireCardId;
}

/** "Release · 1 needs a decision" for a tracking Squire's open decisions on this thread. */
export function trackedThreadBanner(
  rows: ReadonlyArray<Pick<SquireCardRow, "id" | "status" | "targetThreadId" | "createdAt">>,
  threadId: string,
  squireName: string,
): TrackedThreadBannerState | null {
  const open = rows
    .filter((row) => row.status === "open" && row.targetThreadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = open[0];
  if (first === undefined) return null;
  return {
    text: `${squireName} · ${open.length} ${open.length === 1 ? "needs" : "need"} a decision`,
    cardId: first.id,
  };
}
