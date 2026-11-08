import {
  squireRoomUnread,
  squireStateLine,
  type SquireEnvironmentState,
  type SquireIndicatorState,
  type SquireSidebarState,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId, SquireRoomId, SquireRoomRow } from "@lecturn/contracts";

import { squireRoomPortraits, squireRoomSeenAt } from "./squireRooms.logic";

export interface HomeSquireLeadListItem {
  readonly type: "squire-lead";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  /** Set only when more than one environment shows Squires. */
  readonly environmentLabel: string | null;
  /** Its Squires and rooms fold under it; with none there is nothing to fold. */
  readonly expandable: boolean;
  readonly collapsed: boolean;
  readonly depth?: number;
}

export interface HomeSquireListItem {
  readonly type: "squire";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly depth?: number;
}

export interface HomeSquireRoomListItem {
  readonly type: "squire-room";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly roomId: SquireRoomId;
  readonly topic: string;
  /** Up to three member portraits, in member order, then the "+N" count. */
  readonly portraits: ReadonlyArray<SquireId>;
  readonly overflow: number;
  readonly unread: boolean;
  readonly depth?: number;
}

/**
 * Structure only: each row reads its own snapshot entry, so a count or state change re-renders
 * that row and never rebuilds or re-renders the list.
 */
export type HomeSquireItem = HomeSquireLeadListItem | HomeSquireListItem | HomeSquireRoomListItem;

export function isHomeSquireItem(item: { readonly type: string }): item is HomeSquireItem {
  return item.type === "squire-lead" || item.type === "squire" || item.type === "squire-room";
}

// Same order as the web sidebar's `squireLeadBlock`.
const byName = (a: SquireSnapshotEntry, b: SquireSnapshotEntry) =>
  a.squire.name.localeCompare(b.squire.name, undefined, { sensitivity: "base" }) ||
  a.squire.createdAt.localeCompare(b.squire.createdAt) ||
  a.squire.id.localeCompare(b.squire.id);

// Rooms are conversations, so the one that moved last comes first; quiet rooms follow by topic.
const byActivity = (a: SquireRoomRow, b: SquireRoomRow) =>
  (b.lastPostAt ?? "").localeCompare(a.lastPostAt ?? "") ||
  a.topic.localeCompare(b.topic, undefined, { sensitivity: "base" }) ||
  a.id.localeCompare(b.id);

/**
 * The Lead's fold persists beside the project groups' (`collapsedProjectGroups`), so the key is
 * scoped to the environment and that Lead; a new Lead in the environment starts open.
 */
export function squireLeadFoldKey(environmentId: EnvironmentId, leadId: SquireId): string {
  return `squire-lead:${environmentId}:${leadId}`;
}

function environmentItems(
  environmentId: EnvironmentId,
  state: SquireEnvironmentState,
  environmentLabel: string | null,
  seen: ReadonlyMap<string, string>,
  collapsedKeys: ReadonlySet<string>,
): HomeSquireItem[] {
  const lead =
    state.lead === null
      ? null
      : (state.squires.find((entry) => entry.squire.id === state.lead) ?? null);
  const squires = state.squires
    .filter((entry) => entry.squire.id !== state.lead && entry.squire.role !== "lead")
    .sort(byName);
  const rooms = state.rooms.filter((room) => room.status === "open").sort(byActivity);
  // Until ensure creates the Lead there is nothing to nest under.
  const depth = lead === null ? 0 : 1;
  const leadKey = lead === null ? null : squireLeadFoldKey(environmentId, lead.squire.id);
  const expandable = squires.length > 0 || rooms.length > 0;
  const collapsed = expandable && leadKey !== null && collapsedKeys.has(leadKey);
  const leadItems: HomeSquireItem[] =
    lead === null || leadKey === null
      ? []
      : [
          {
            type: "squire-lead",
            key: leadKey,
            environmentId,
            squireId: lead.squire.id,
            environmentLabel,
            expandable,
            collapsed,
            depth: 0,
          },
        ];
  if (collapsed) return leadItems;
  return [
    ...leadItems,
    ...squires.map((entry): HomeSquireListItem => ({
      type: "squire",
      key: `squire:${environmentId}:${entry.squire.id}`,
      environmentId,
      squireId: entry.squire.id,
      depth,
    })),
    ...rooms.map((room): HomeSquireRoomListItem => ({
      type: "squire-room",
      key: `squire-room:${environmentId}:${room.id}`,
      environmentId,
      roomId: room.id,
      topic: room.topic,
      ...squireRoomPortraits(room.members),
      // The row's `unread` already means "the user is a member"; muting hides it.
      unread: squireRoomUnread(room, squireRoomSeenAt(seen, environmentId, room.id)),
      depth,
    })),
  ];
}

const NO_SEEN: ReadonlyMap<string, string> = new Map();
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The home list's Squires section: one Lead group per environment that has Squires,
 * in the list's environment order. Environments without the capability have no state, so old
 * servers contribute nothing. Hidden during search, like the web group.
 */
export function buildSquireHomeItems(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly states: ReadonlyMap<EnvironmentId, SquireEnvironmentState>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly searching: boolean;
  /** This client's last shown `lastPostAt` per room (`withSquireRoomSeen`). */
  readonly roomSeen?: ReadonlyMap<string, string>;
  /** Persisted fold keys (`squireLeadFoldKey`) whose Lead groups are folded. */
  readonly collapsedKeys?: ReadonlySet<string>;
}): HomeSquireItem[] {
  if (input.searching) return [];
  const shown = input.environments.flatMap((environment) => {
    if (
      input.selectedEnvironmentId !== null &&
      environment.environmentId !== input.selectedEnvironmentId
    ) {
      return [];
    }
    const state = input.states.get(environment.environmentId);
    if (state === undefined || (state.squires.length === 0 && state.rooms.length === 0)) return [];
    return [{ ...environment, state }];
  });
  const labeled = shown.length > 1;
  return shown.flatMap((environment) =>
    environmentItems(
      environment.environmentId,
      environment.state,
      labeled ? environment.label : null,
      input.roomSeen ?? NO_SEEN,
      input.collapsedKeys ?? NO_KEYS,
    ),
  );
}

export function homeSquireItemsAreEqual(previous: HomeSquireItem, item: HomeSquireItem): boolean {
  if (previous.key !== item.key || previous.depth !== item.depth) return false;
  switch (item.type) {
    case "squire-lead":
      return (
        previous.type === "squire-lead" &&
        previous.environmentLabel === item.environmentLabel &&
        previous.expandable === item.expandable &&
        previous.collapsed === item.collapsed
      );
    case "squire":
      return previous.type === "squire";
    case "squire-room":
      return (
        previous.type === "squire-room" &&
        previous.topic === item.topic &&
        previous.unread === item.unread &&
        previous.overflow === item.overflow &&
        previous.portraits.join() === item.portraits.join()
      );
  }
}

export type SquireHomeRowTrailing = SquireSidebarState;

/**
 * Every open decision in the Lead's group, once (web `squireLeadAggregateCount`): a Lead-raised
 * item on a Squire's thread shows on both badges, so each Squire adds only what it raised.
 */
export function squireHomeLeadAggregateCount(state: SquireEnvironmentState | null): number {
  if (state === null) return 0;
  return state.squires.reduce((sum, entry) => {
    if (entry.squire.id === state.lead) return sum + entry.openDecisionCount;
    // Same membership as the group's rows: a stray second Lead is not listed, so not counted.
    if (entry.squire.role === "lead") return sum;
    return sum + Math.max(0, entry.openDecisionCount - (entry.leadRaisedDecisionCount ?? 0));
  }, 0);
}

/** A folded Lead stands for the rows it hides, so any decision among them reads as its state. */
export function squireHomeLeadTrailing(
  state: SquireSidebarState,
  aggregate: number,
  collapsed: boolean,
): SquireHomeRowTrailing {
  return collapsed && aggregate > 0 ? "needs-you" : state;
}

/** A not-ready Squire's line under its name, e.g. "Choose a provider for the Lead". */
export function squireHomeRowStatusLine(
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

/** Read aloud, since the row's state is otherwise only a mark. */
export function squireHomeRowLabel(
  name: string,
  state: SquireHomeRowTrailing,
  indicator: Pick<SquireIndicatorState, "state">,
): string {
  switch (state) {
    case "needs-you":
      return `${name}, needs you`;
    case "working":
      return `${name}, working`;
    case "unread":
      return `${name}, new messages`;
    case "none":
      return indicator.state === "needs_provider" ? `${name}, needs a provider` : name;
  }
}
