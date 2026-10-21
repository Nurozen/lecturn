import {
  accountForEnvironment,
  accountAttention,
  type AccountSectionContext,
} from "./accountSections";
import type { MobileConnectAccount } from "../cloud/knownAccounts";
import {
  buildSagaProjectTree,
  derivePhysicalProjectKey,
  type SagaProjectIndexEntry,
  type SagaProjectTreeNode,
} from "@lecturn/client-runtime/state/project-grouping";
import { buildPhysicalSagaProjectGroups } from "@lecturn/client-runtime/state/sagaWorkbench";
import type { ThreadListV2ListItem } from "../threads/threadListV2";
import type { StaveSagaMemberStatus } from "@lecturn/contracts";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";

import type { HomeThreadGroup } from "./homeThreadList";

/** Threads shown per project before the "Show more" affordance appears. */
export const HOME_INITIAL_VISIBLE_THREADS = 6;
/** Additional threads revealed per "Show more" tap. */
export const HOME_SHOW_MORE_STEP = 10;

export interface HomeGroupDisplayState {
  readonly collapsed: boolean;
  /** How many threads are currently revealed (clamped to the group size). */
  readonly visibleCount: number;
}

export const DEFAULT_GROUP_DISPLAY_STATE: HomeGroupDisplayState = {
  collapsed: false,
  visibleCount: HOME_INITIAL_VISIBLE_THREADS,
};

export interface HomeHeaderListItem {
  readonly type: "header";
  readonly key: string;
  readonly group: HomeThreadGroup;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
  readonly depth?: number;
  readonly memberStatus?: StaveSagaMemberStatus | null;
}

export interface HomeAccountHeaderListItem {
  readonly type: "account-header";
  readonly key: string;
  readonly account: MobileConnectAccount | null;
  readonly attention: string;
  readonly collapsed: boolean;
  readonly depth?: number;
}
/** Hierarchy chrome rows the home list and iPad sidebar build over the v2 thread rows. */
export type HomeListItem = HomeAccountHeaderListItem | HomeHeaderListItem;

export type HomeGroupDisplayAction = "toggle-collapsed" | "show-more" | "show-less";

export function nextGroupDisplayState(
  current: HomeGroupDisplayState,
  action: HomeGroupDisplayAction,
): HomeGroupDisplayState {
  switch (action) {
    case "toggle-collapsed":
      return { ...current, collapsed: !current.collapsed };
    case "show-more":
      return { ...current, visibleCount: current.visibleCount + HOME_SHOW_MORE_STEP };
    case "show-less":
      return { ...current, visibleCount: HOME_INITIAL_VISIBLE_THREADS };
  }
}

/**
 * Structural equality for list items. Item objects are rebuilt on every
 * collapse/show-more toggle; without this the lists would consider every
 * mounted row changed and re-render all of them (each carrying a swipeable +
 * a vcs-status subscription). Group/thread references are stable across
 * toggles.
 */
export function homeListItemsAreEqual(previous: HomeListItem, item: HomeListItem): boolean {
  if (previous.depth !== item.depth) return false;
  switch (item.type) {
    case "account-header":
      return (
        previous.type === "account-header" &&
        previous.key === item.key &&
        previous.account?.label === item.account?.label &&
        previous.account?.preset === item.account?.preset &&
        previous.account?.signedIn === item.account?.signedIn &&
        previous.attention === item.attention &&
        previous.collapsed === item.collapsed
      );
    case "header":
      return (
        previous.type === "header" &&
        previous.group === item.group &&
        previous.collapsed === item.collapsed &&
        previous.isFirst === item.isFirst &&
        previous.depth === item.depth &&
        previous.memberStatus === item.memberStatus
      );
  }
}

/** Split only physical saga members; keep the original thread and pending-task objects. */
export function hierarchyGroups(
  groups: ReadonlyArray<HomeThreadGroup>,
  index: ReadonlyArray<SagaProjectIndexEntry>,
) {
  const sourceByProject = new Map(
    groups.flatMap((group) =>
      group.projects.map(
        (project) => [JSON.stringify([project.environmentId, project.id]), group] as const,
      ),
    ),
  );
  const physical = buildPhysicalSagaProjectGroups(
    groups.map((group) => ({
      key: group.key,
      label: group.title,
      representative: group.representative,
      members: group.projects.map((project) => ({
        physicalProjectKey: derivePhysicalProjectKey(project),
        project,
      })),
      memberProjectRefs:
        group.projectRefs ??
        group.projects.map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        })),
    })),
    index,
  );
  return physical.map((group): HomeThreadGroup => {
    const source = sourceByProject.get(
      JSON.stringify([group.representative.environmentId, group.representative.id]),
    )!;
    if (group.key === source.key && group.members.length === source.projects.length) return source;
    const refs = new Set(
      group.memberProjectRefs.map((ref) => JSON.stringify([ref.environmentId, ref.projectId])),
    );
    const belongs = (thread: EnvironmentThreadShell) =>
      refs.has(JSON.stringify([thread.environmentId, thread.projectId]));
    return {
      ...source,
      key: group.key,
      title: group.label,
      representative: group.representative,
      projects: group.members.map((member) => member.project),
      projectRefs: group.memberProjectRefs,
      threads: source.threads.filter(belongs),
      recentThreads: source.recentThreads.filter(belongs),
      pendingTasks: source.pendingTasks.filter((task) =>
        refs.has(JSON.stringify([task.environmentId, task.projectId])),
      ),
      newThreadTarget: source.newThreadTarget === null ? null : group.representative,
    };
  });
}

function homeHierarchy(input: {
  readonly groups: ReadonlyArray<HomeThreadGroup>;
  readonly sagaIndex?: ReadonlyArray<SagaProjectIndexEntry>;
}) {
  const groups = hierarchyGroups(input.groups, input.sagaIndex ?? []);
  const groupsByKey = new Map(groups.map((group) => [group.key, group]));
  const tree = buildSagaProjectTree(
    groups.map((group) => ({
      key: group.key,
      label: group.title,
      representative: group.representative,
      members: group.projects.map((project) => ({
        physicalProjectKey: derivePhysicalProjectKey(project),
        project,
      })),
      memberProjectRefs:
        group.projectRefs ??
        group.projects.map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        })),
    })),
    input.sagaIndex ?? [],
  );
  return { groupsByKey, tree };
}

export type HomeHierarchyV2Item = (
  | ThreadListV2ListItem
  | HomeHeaderListItem
  | HomeAccountHeaderListItem
) & {
  readonly depth?: number;
  readonly settledBranch?: boolean;
};

/** Keep each project and saga in one tree; settled history belongs to its owning project. */
export function buildHomeHierarchyV2Items(input: {
  readonly accountSections?: AccountSectionContext | undefined;
  readonly groups: ReadonlyArray<HomeThreadGroup>;
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly sagaIndex?: ReadonlyArray<SagaProjectIndexEntry>;
  readonly displayStates: ReadonlyMap<string, HomeGroupDisplayState>;
  readonly searching?: boolean;
  readonly selectedThreadKey?: string | null;
}): HomeHierarchyV2Item[] {
  if (input.accountSections) {
    const context = input.accountSections;
    const sections = [...context.accounts, null].flatMap((account): HomeHierarchyV2Item[] => {
      const accountId = account?.accountId ?? null;
      const groups = input.groups.filter(
        (group) => accountForEnvironment(context, group.representative.environmentId) === accountId,
      );
      const items = input.items.filter((item) => {
        const environmentId =
          item.type === "v2-thread"
            ? item.item.thread.environmentId
            : item.type === "v2-pending"
              ? item.pendingTask.environmentId
              : undefined;
        return (
          environmentId !== undefined && accountForEnvironment(context, environmentId) === accountId
        );
      });
      if (!account && groups.length === 0 && items.length === 0) return [];
      const header = makeAccountHeader(account, groups, input.displayStates, input.searching);
      return [
        header,
        ...(header.collapsed
          ? []
          : buildHomeHierarchyV2Items({ ...input, accountSections: undefined, groups, items })),
      ];
    });
    // Shelf expansion is a device preference; retain its control while rows remain account-scoped.
    return [...input.items.filter((item) => item.type === "v2-snoozed-shelf"), ...sections];
  }
  const { groupsByKey, tree } = homeHierarchy(input);
  const groupByProject = new Map(
    [...groupsByKey.values()].flatMap((group) =>
      (
        group.projectRefs ??
        group.projects.map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        }))
      ).map((ref) => [JSON.stringify([ref.environmentId, ref.projectId]), group.key] as const),
    ),
  );
  const result: HomeHierarchyV2Item[] = input.items.filter(
    (row) => row.type === "v2-snoozed-shelf",
  );
  const rows = input.items.filter(
    (row) => row.type !== "v2-settled-shelf" && row.type !== "v2-snoozed-shelf",
  );
  const rowsByGroup = new Map<string, ThreadListV2ListItem[]>();
  const ungrouped: ThreadListV2ListItem[] = [];
  for (const row of rows) {
    const ref =
      row.type === "v2-thread"
        ? [row.item.thread.environmentId, row.item.thread.projectId]
        : row.type === "v2-pending"
          ? [row.pendingTask.environmentId, row.pendingTask.projectId]
          : null;
    const key = ref === null ? undefined : groupByProject.get(JSON.stringify(ref));
    if (key === undefined) {
      ungrouped.push(row);
      continue;
    }
    const owned = rowsByGroup.get(key) ?? [];
    owned.push(row);
    rowsByGroup.set(key, owned);
  }
  const visible = (node: SagaProjectTreeNode): boolean =>
    rowsByGroup.has(node.group.key) ||
    (!input.searching && !!node.group.representative.stave) ||
    node.children.some(visible);
  const containsSelection = (node: SagaProjectTreeNode): boolean =>
    (rowsByGroup.get(node.group.key) ?? []).some(
      (row) =>
        row.type === "v2-thread" &&
        `${row.item.thread.environmentId}:${row.item.thread.id}` === input.selectedThreadKey,
    ) || node.children.some(containsSelection);
  const visit = (node: SagaProjectTreeNode, depth: number) => {
    if (!visible(node)) return;
    const group = groupsByKey.get(node.group.key)!;
    const collapsed =
      !!input.displayStates.get(group.key)?.collapsed &&
      !input.searching &&
      !containsSelection(node);
    result.push({
      type: "header",
      key: `v2-active-header:${group.key}`,
      group,
      collapsed,
      isFirst: result.length === 0,
      depth,
      memberStatus: node.memberStatus,
    });
    if (collapsed) return;
    const owned = rowsByGroup.get(group.key) ?? [];
    // Preserve the partition's queue promotion, snooze priority, and capability gating.
    const isSettled = (row: ThreadListV2ListItem) =>
      row.type === "v2-thread" && row.item.variant === "slim" && !row.item.snoozed;
    const settled = owned.filter(isSettled);
    for (const row of owned) {
      if (!isSettled(row)) result.push({ ...row, depth: depth + 1 });
    }
    if (settled.length > 0) {
      const groupKey = `settled:${group.key}`;
      const expanded =
        input.searching === true ||
        input.displayStates.get(groupKey)?.collapsed === false ||
        settled.some(
          (row) =>
            row.type === "v2-thread" &&
            `${row.item.thread.environmentId}:${row.item.thread.id}` === input.selectedThreadKey,
        );
      result.push({
        type: "v2-settled-shelf",
        key: groupKey,
        groupKey,
        count: settled.length,
        expanded,
        // Per-project shelves toggle through display state, not the device shelf preference.
        disabled: false,
        depth: depth + 1,
        settledBranch: true,
      });
      if (expanded)
        for (const row of settled) result.push({ ...row, depth: depth + 2, settledBranch: true });
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const node of tree) visit(node, 0);
  result.push(...ungrouped);

  return result;
}

function makeAccountHeader(
  account: MobileConnectAccount | null,
  groups: ReadonlyArray<HomeThreadGroup>,
  states: ReadonlyMap<string, HomeGroupDisplayState>,
  searching?: boolean,
): HomeAccountHeaderListItem {
  const key = `connect-account:${account?.accountId ?? "direct"}`;
  return {
    type: "account-header",
    key,
    account,
    attention: accountAttention(groups.flatMap((group) => group.threads)),
    collapsed: !searching && !!states.get(key)?.collapsed,
  };
}
