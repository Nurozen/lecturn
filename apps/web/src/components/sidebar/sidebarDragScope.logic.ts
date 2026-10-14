import { scopeThreadRef, scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import {
  applySidebarThreadDrop,
  sortSettledThreadsForSidebar,
  type SidebarListItem,
  type SidebarSection,
} from "../Sidebar.logic";

export type SidebarLists = Readonly<Record<SidebarSection, readonly EnvironmentThreadShell[]>>;
export interface SidebarDropHold {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
}
const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function buildScopedSidebarItems(
  lists: SidebarLists,
  input: {
    snoozedExpanded: boolean;
    settledExpanded: boolean;
    settledLimit: number;
    routeThreadKey: string | null;
    retainCurrentSettled?: boolean;
  },
): SidebarListItem[] {
  const items: SidebarListItem[] = [];
  const marker = (marker: Extract<SidebarListItem, { kind: "marker" }>["marker"]) =>
    items.push({ kind: "marker", marker });
  const rows = (section: SidebarSection, visible: readonly EnvironmentThreadShell[]) => {
    for (const thread of visible) items.push({ kind: "thread", key: keyOf(thread), section });
  };
  marker("pinned-header");
  rows("pinned", lists.pinned);
  marker("pinned-divider");
  rows("active", lists.active);
  if (!lists.active.length) marker("active-placeholder");
  if (lists.snoozed.length) {
    marker("snoozed-header");
    rows(
      "snoozed",
      lists.snoozed.filter(
        (thread) => input.snoozedExpanded || keyOf(thread) === input.routeThreadKey,
      ),
    );
  }
  marker("settled-header");
  const settled = lists.settled.filter(
    (thread, index) =>
      (input.settledExpanded && index < input.settledLimit) ||
      ((input.settledExpanded || input.retainCurrentSettled !== false) &&
        keyOf(thread) === input.routeThreadKey),
  );
  rows("settled", settled);
  if (!settled.length) marker("settled-placeholder");
  return items;
}

export function projectSidebarDrop(
  lists: SidebarLists,
  hold: SidebarDropHold | null,
): SidebarLists {
  if (!hold) return lists;
  const source = Object.values(lists)
    .flat()
    .find((thread) => keyOf(thread) === hold.key);
  if (!source) return lists;
  const result = {
    pinned: [] as EnvironmentThreadShell[],
    active: [] as EnvironmentThreadShell[],
    snoozed: [] as EnvironmentThreadShell[],
    settled: [] as EnvironmentThreadShell[],
  };
  for (const section of Object.keys(result) as SidebarSection[]) {
    result[section] = lists[section]
      .filter((thread) => keyOf(thread) !== hold.key)
      .map((thread) => {
        const assigned =
          section === hold.section ? hold.assignedKeys.get(keyOf(thread)) : undefined;
        return assigned
          ? {
              ...thread,
              ...(section === "pinned" ? { pinOrderKey: assigned } : { activeOrderKey: assigned }),
            }
          : thread;
      });
  }
  const moved = applySidebarThreadDrop(
    source,
    hold.section,
    hold.occurredAt,
    hold.assignedKeys.get(hold.key),
  );
  result[hold.section].push(
    hold.clearsSnooze
      ? moved
      : { ...moved, snoozedAt: source.snoozedAt, snoozedUntil: source.snoozedUntil },
  );
  if (hold.order) {
    const ranks = new Map(hold.order.map((key, index) => [key, index]));
    result[hold.section].sort(
      (a, b) => (ranks.get(keyOf(a)) ?? Infinity) - (ranks.get(keyOf(b)) ?? Infinity),
    );
  } else result.settled = sortSettledThreadsForSidebar(result.settled);
  return result;
}

/** Release only against this scope's canonical members and all assigned keys. */
export function sidebarDropConfirmed(lists: SidebarLists, hold: SidebarDropHold): boolean {
  const sourceSection = (Object.keys(lists) as SidebarSection[]).find((section) =>
    lists[section].some((thread) => keyOf(thread) === hold.key),
  );
  if (!sourceSection || (sourceSection !== hold.sourceSection && sourceSection !== hold.section))
    return true;
  if (sourceSection !== hold.section) return false;
  const source = lists[sourceSection].find((thread) => keyOf(thread) === hold.key)!;
  if (hold.clearsSnooze && source.snoozedUntil != null) return false;
  if (!hold.order) return source.pinnedAt == null;
  const members = lists[hold.section];
  if (
    members.length !== hold.order.length ||
    members.some((thread) => !hold.order!.includes(keyOf(thread)))
  )
    return true;
  const keys = new Map(
    members.map((thread) => [
      keyOf(thread),
      (hold.section === "pinned" ? thread.pinOrderKey : thread.activeOrderKey) ?? null,
    ]),
  );
  if (
    members.some(
      (thread) =>
        keys.get(keyOf(thread)) !== (hold.keysAtDrop.get(keyOf(thread)) ?? null) &&
        keys.get(keyOf(thread)) !== hold.assignedKeys.get(keyOf(thread)),
    )
  )
    return true;
  return [...hold.assignedKeys].every(([key, value]) => keys.get(key) === value);
}
