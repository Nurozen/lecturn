import {
  squireStateLine,
  type SquireEnvironmentState,
  type SquireIndicatorState,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireCardId,
  SquireCardKind,
  SquireCardRow,
  SquireId,
} from "@lecturn/contracts";

import type { RelativeTimeState } from "../../../timestampFormat";

// ── Lead block ────────────────────────────────────────────────

export interface SquireLeadBlock {
  /** Null until `squire.lead.ensure` creates the Lead ("No Lead yet"). */
  readonly lead: SquireSnapshotEntry | null;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  /** P19.8: open rooms nest under the Lead after its Squires. */
  readonly rooms: SquireEnvironmentState["rooms"];
}

const byName = (a: SquireSnapshotEntry, b: SquireSnapshotEntry) =>
  a.squire.name.localeCompare(b.squire.name, undefined, { sensitivity: "base" }) ||
  a.squire.createdAt.localeCompare(b.squire.createdAt) ||
  a.squire.id.localeCompare(b.squire.id);

/**
 * The Lead first, its Squires under it by name. Name, not creation time, because rows are
 * found by reading them and every other sidebar list the user scans by name sorts that way;
 * renames are rare, so rows seldom move.
 */
export function squireLeadBlock(state: SquireEnvironmentState): SquireLeadBlock {
  const lead =
    state.lead === null
      ? null
      : (state.squires.find((entry) => entry.squire.id === state.lead) ?? null);
  return {
    lead,
    squires: state.squires
      .filter((entry) => entry.squire.id !== state.lead && entry.squire.role !== "lead")
      .toSorted(byName),
    rooms: state.rooms.filter((room) => room.status === "open"),
  };
}

// ── Row trailing ──────────────────────────────────────────────

export type SquireRowTrailing =
  | { readonly kind: "working" }
  | { readonly kind: "badge"; readonly count: number }
  | { readonly kind: "none" };

/** P1.2: the count badge, or "working" in its place while the Squire works. */
export function squireRowTrailing(indicator: SquireIndicatorState): SquireRowTrailing {
  if (indicator.workingLabel) return { kind: "working" };
  if (indicator.badge !== null && indicator.badge > 0) {
    return { kind: "badge", count: indicator.badge };
  }
  return { kind: "none" };
}

/**
 * The line a row shows under its name while the Squire is not ready, e.g. "Choose a provider
 * for the Lead" (D7). This client cannot tell when no provider supports Squires, so it never
 * says "No supported provider"; the view's picker does.
 */
export function squireRowStatusLine(
  entry: Pick<SquireSnapshotEntry, "squire" | "openDecisionCount" | "held">,
  indicator: SquireIndicatorState,
): string | null {
  const lifecycle = entry.squire.lifecycle;
  if (lifecycle === "ready" || lifecycle === "unknown") return null;
  return squireStateLine({
    squire: entry.squire,
    indicator,
    openDecisionCount: entry.openDecisionCount,
    heldCount: entry.held.length,
  });
}

/** Read aloud and in tooltips, since the indicator's state is otherwise only color and ring. */
export function squireRowLabel(name: string, indicator: SquireIndicatorState): string {
  switch (indicator.state) {
    case "working":
      return `${name}, working`;
    case "waiting":
      return indicator.badge === null
        ? `${name}, waiting on you`
        : `${name}, ${indicator.badge} ${indicator.badge === 1 ? "needs" : "need"} a decision`;
    case "needs_provider":
      return `${name}, needs a provider`;
    case "idle":
      return name;
  }
}

// ── Decision child rows ───────────────────────────────────────

export const SQUIRE_CHILD_ROW_CAP = 5;

/** The queued statuses a view lists under "Needs a decision"; held items have their own group. */
const AWAITING_DECISION: ReadonlySet<SquireCardRow["status"]> = new Set([
  "open",
  "accepting",
  "executing",
]);

/**
 * The decision items a row's badge counts, which are its view's "Needs a decision" rows: not FYI,
 * not held, still queued. A Squire's list is what it raised or owns, Lead-raised items on its
 * threads included; the Lead's is its combined queue, so it keeps only what the Lead raised (D50).
 */
export function squireChildRows<Row extends Pick<SquireCardRow, "kind" | "status" | "squireId">>(
  items: ReadonlyArray<Row>,
  target: {
    readonly squireId: SquireId;
    readonly leadId: SquireId | null;
    readonly openDecisionCount: number;
    /** Lead-raised items the count includes for a Squire; they list under the Lead instead. */
    readonly leadRaisedDecisionCount?: number;
  },
  cap = SQUIRE_CHILD_ROW_CAP,
): { readonly rows: ReadonlyArray<Row>; readonly moreCount: number } {
  const isLead = target.squireId === target.leadId;
  // Each item is one child row, under its raiser: a Lead-raised overlap on Release's thread
  // lists under the Lead, though Release's badge counts it.
  const counted = items.filter(
    (item) =>
      item.kind !== "fyi" &&
      AWAITING_DECISION.has(item.status) &&
      (isLead ? item.squireId === target.squireId : item.squireId !== target.leadId),
  );
  const rows = counted.slice(0, cap);
  // The list is one page; the snapshot count covers what the page left out.
  const ownCount = isLead
    ? target.openDecisionCount
    : target.openDecisionCount - (target.leadRaisedDecisionCount ?? 0);
  const total = Math.max(counted.length, ownCount);
  return { rows, moreCount: total - rows.length };
}

/**
 * The Lead badge tooltip's view of its team: what each Squire raised itself. A Squire's badge
 * also counts the Lead's items on its threads, which the Lead's own count already holds.
 */
export function squireTeamRaisedCounts<
  Entry extends Pick<SquireSnapshotEntry, "openDecisionCount" | "leadRaisedDecisionCount">,
>(squires: ReadonlyArray<Entry>): ReadonlyArray<Entry> {
  return squires.map((entry) =>
    entry.leadRaisedDecisionCount === undefined
      ? entry
      : {
          ...entry,
          openDecisionCount: Math.max(0, entry.openDecisionCount - entry.leadRaisedDecisionCount),
        },
  );
}

export type SquireKindDotTone = "info" | "warning" | "destructive" | "success";

/** One tone per decision kind, so a glance tells a steer from a question; FYI is never a row. */
export const SQUIRE_KIND_DOT: Readonly<
  Record<
    Exclude<SquireCardKind, "fyi">,
    { readonly tone: SquireKindDotTone; readonly label: string }
  >
> = {
  steer: { tone: "info", label: "Action" },
  question: { tone: "warning", label: "Question" },
  overlap: { tone: "destructive", label: "Overlap" },
  proposal: { tone: "success", label: "Proposal" },
};

export function squireKindDot(kind: SquireCardKind) {
  return kind === "fyi" ? null : SQUIRE_KIND_DOT[kind];
}

/** A child row's compact age: "now", "5m", "3h", "2d". */
export function squireChildAgeText(relative: RelativeTimeState): string {
  if (relative.status !== "relative") return "";
  return relative.suffix === null ? "now" : relative.value;
}

// ── Fold state ────────────────────────────────────────────────

export type SquireFoldTarget =
  | { readonly kind: "group" }
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId }
  | { readonly kind: "lead"; readonly environmentId: EnvironmentId }
  | { readonly kind: "squire"; readonly environmentId: EnvironmentId; readonly squireId: SquireId };

export function squireFoldKey(target: SquireFoldTarget): string {
  switch (target.kind) {
    case "group":
      return "group";
    case "environment":
      return `environment:${target.environmentId}`;
    case "lead":
      return `lead:${target.environmentId}`;
    case "squire":
      return `squire:${target.environmentId}:${target.squireId}`;
  }
}

/**
 * Only explicit choices persist. The group, each environment, and each Lead start open so every
 * badge is in view; a Squire's child rows start folded because each open Squire runs its own
 * items query, and the badge already says how many wait.
 */
export function isSquireFoldCollapsed(
  collapsedByKey: Readonly<Record<string, boolean>>,
  target: SquireFoldTarget,
): boolean {
  return collapsedByKey[squireFoldKey(target)] ?? target.kind === "squire";
}

/**
 * The Lead row folds its own decision items and its Squires (later its rooms too), so it has
 * something to fold whenever either exists.
 */
export function squireLeadFold(
  collapsedByKey: Readonly<Record<string, boolean>>,
  environmentId: EnvironmentId,
  block: SquireLeadBlock,
): { readonly expandable: boolean; readonly expanded: boolean } {
  const expandable =
    block.squires.length > 0 || block.rooms.length > 0 || (block.lead?.openDecisionCount ?? 0) > 0;
  return {
    expandable,
    expanded: expandable && !isSquireFoldCollapsed(collapsedByKey, { kind: "lead", environmentId }),
  };
}

/**
 * The Lead's own items sit in its fold beside its Squires, at the same depth, so they carry a
 * label there that sets them apart from the Squire rows below. Alone in the fold they need none.
 */
export function squireLeadItemsLabel(block: SquireLeadBlock): string | null {
  return block.squires.length > 0 || block.rooms.length > 0 ? "Needs a decision" : null;
}

/**
 * Every open decision item in the block, once: a Lead-raised item on a Squire's thread shows on
 * both badges, so the Squires add only what they raised.
 */
export function squireLeadAggregateCount(block: SquireLeadBlock): number {
  return squireTeamRaisedCounts(block.squires).reduce(
    (sum, entry) => sum + entry.openDecisionCount,
    block.lead?.openDecisionCount ?? 0,
  );
}

/**
 * A folded Lead stands for the rows it hides, so it shows the block's total in place of its own
 * count, ahead of "working", because the hidden badges would otherwise go unseen.
 */
export function squireLeadTrailing(
  indicator: SquireIndicatorState,
  block: SquireLeadBlock,
  folded: boolean,
): SquireRowTrailing {
  const aggregate = squireLeadAggregateCount(block);
  if (folded && aggregate > 0) return { kind: "badge", count: aggregate };
  return squireRowTrailing(indicator);
}

/** A row folds open only when it has decision items to list. */
export function isSquireRowExpanded(
  collapsedByKey: Readonly<Record<string, boolean>>,
  target: Extract<SquireFoldTarget, { kind: "squire" }>,
  openDecisionCount: number,
): boolean {
  return openDecisionCount > 0 && !isSquireFoldCollapsed(collapsedByKey, target);
}

// ── Visibility and selection ──────────────────────────────────

/** D37: hidden during thread search, and absent where no environment offers Squires. */
export function isSquiresGroupVisible(input: {
  readonly isSearching: boolean;
  readonly environmentCount: number;
}): boolean {
  return !input.isSearching && input.environmentCount > 0;
}

/** Environment labels only disambiguate, so one environment shows none (D37). */
export function showSquireEnvironmentLabels(environmentCount: number): boolean {
  return environmentCount > 1;
}

export interface SquireRouteSelection {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly item: SquireCardId | null;
}

/** The route row is active; its child row is selected only on that Squire's own view. */
export function squireRowSelection(
  route: SquireRouteSelection | null,
  environmentId: EnvironmentId,
  squireId: SquireId,
): { readonly active: boolean; readonly selectedItem: SquireCardId | null } {
  const active = route?.environmentId === environmentId && route.squireId === squireId;
  return { active, selectedItem: active ? (route?.item ?? null) : null };
}

const ROUTE_KEY_SEPARATOR = "\n";

/** A string the route selector can return, so the group re-renders only when it changes. */
export function squireRouteKey(
  match: {
    readonly params: { readonly environmentId: string; readonly squireId: string };
    readonly search: { readonly item?: string | undefined };
  } | null,
): string {
  if (match === null) return "";
  return [match.params.environmentId, match.params.squireId, match.search.item ?? ""].join(
    ROUTE_KEY_SEPARATOR,
  );
}

export function parseSquireRouteKey(key: string): SquireRouteSelection | null {
  if (key === "") return null;
  const [environmentId, squireId, item] = key.split(ROUTE_KEY_SEPARATOR);
  if (!environmentId || !squireId) return null;
  return {
    environmentId: environmentId as EnvironmentId,
    squireId: squireId as SquireId,
    item: item ? (item as SquireCardId) : null,
  };
}
