import {
  squireStateLine,
  type SquireEnvironmentState,
  type SquireIndicatorState,
  type SquireSidebarState,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId } from "@lecturn/contracts";

import type { RelativeTimeState } from "../../../timestampFormat";

// ── Lead block ────────────────────────────────────────────────

export interface SquireLeadBlock {
  /** Null until `squire.lead.ensure` creates the Lead ("No Lead yet"). */
  readonly lead: SquireSnapshotEntry | null;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  /** Open rooms nest under the Lead after its Squires. */
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
  | { readonly kind: "needs-you"; readonly count: number }
  | { readonly kind: "unread" }
  | { readonly kind: "none" };

/** The row's one state: how many decisions wait, that it works, or that it wrote since a visit. */
export function squireRowTrailing(
  state: SquireSidebarState,
  openDecisionCount: number,
): SquireRowTrailing {
  switch (state) {
    case "needs-you":
      return { kind: "needs-you", count: openDecisionCount };
    case "working":
      return { kind: "working" };
    case "unread":
      return { kind: "unread" };
    case "none":
      return { kind: "none" };
  }
}

/**
 * The line a row shows under its name while the Squire is not ready, e.g. "Choose a provider
 * for the Lead". This client cannot tell when no provider supports Squires, so it never
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
export function squireRowLabel(
  name: string,
  indicator: SquireIndicatorState,
  state: SquireSidebarState,
): string {
  if (state === "unread") return `${name}, unread messages`;
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

/** A row's compact age: "now", "5m", "3h", "2d". */
export function squireChildAgeText(relative: RelativeTimeState): string {
  if (relative.status !== "relative") return "";
  return relative.suffix === null ? "now" : relative.value;
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

// ── Fold state ────────────────────────────────────────────────

export type SquireFoldTarget =
  | { readonly kind: "group" }
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId }
  | { readonly kind: "lead"; readonly environmentId: EnvironmentId };

export function squireFoldKey(target: SquireFoldTarget): string {
  switch (target.kind) {
    case "group":
      return "group";
    case "environment":
      return `environment:${target.environmentId}`;
    case "lead":
      return `lead:${target.environmentId}`;
  }
}

/** Only explicit choices persist. The group, each environment, and each Lead start open. */
export function isSquireFoldCollapsed(
  collapsedByKey: Readonly<Record<string, boolean>>,
  target: SquireFoldTarget,
): boolean {
  return collapsedByKey[squireFoldKey(target)] ?? false;
}

/** The Lead row folds its Squires and rooms, so it has something to fold whenever either exists. */
export function squireLeadFold(
  collapsedByKey: Readonly<Record<string, boolean>>,
  environmentId: EnvironmentId,
  block: SquireLeadBlock,
): { readonly expandable: boolean; readonly expanded: boolean } {
  const expandable = block.squires.length > 0 || block.rooms.length > 0;
  return {
    expandable,
    expanded: expandable && !isSquireFoldCollapsed(collapsedByKey, { kind: "lead", environmentId }),
  };
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
 * state, because the hidden badges would otherwise go unseen.
 */
export function squireLeadTrailing(
  state: SquireSidebarState,
  block: SquireLeadBlock,
  folded: boolean,
): SquireRowTrailing {
  const aggregate = squireLeadAggregateCount(block);
  if (folded && aggregate > 0) return { kind: "needs-you", count: aggregate };
  return squireRowTrailing(state, block.lead?.openDecisionCount ?? 0);
}

// ── Visibility and selection ──────────────────────────────────

/** Hidden during thread search, and absent where no environment offers Squires. */
export function isSquiresGroupVisible(input: {
  readonly isSearching: boolean;
  readonly environmentCount: number;
}): boolean {
  return !input.isSearching && input.environmentCount > 0;
}

/** Environment labels only disambiguate, so one environment shows none. */
export function showSquireEnvironmentLabels(environmentCount: number): boolean {
  return environmentCount > 1;
}

export interface SquireRouteSelection {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
}

export function squireRowSelected(
  route: SquireRouteSelection | null,
  environmentId: EnvironmentId,
  squireId: SquireId,
): boolean {
  return route?.environmentId === environmentId && route.squireId === squireId;
}

const ROUTE_KEY_SEPARATOR = "\n";

/** A string the route selector can return, so the group re-renders only when it changes. */
export function squireRouteKey(
  match: { readonly params: { readonly environmentId: string; readonly squireId: string } } | null,
): string {
  if (match === null) return "";
  return [match.params.environmentId, match.params.squireId].join(ROUTE_KEY_SEPARATOR);
}

export function parseSquireRouteKey(key: string): SquireRouteSelection | null {
  if (key === "") return null;
  const [environmentId, squireId] = key.split(ROUTE_KEY_SEPARATOR);
  if (!environmentId || !squireId) return null;
  return {
    environmentId: environmentId as EnvironmentId,
    squireId: squireId as SquireId,
  };
}
