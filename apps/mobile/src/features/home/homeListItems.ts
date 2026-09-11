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

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
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

export interface HomeThreadListItem {
  readonly depth?: number;
  readonly type: "thread";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly isLast: boolean;
}

export interface HomePendingTaskListItem {
  readonly depth?: number;
  readonly type: "pending-task";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly isLast: boolean;
}

export interface HomeShowMoreListItem {
  readonly depth?: number;
  readonly type: "show-more";
  readonly key: string;
  readonly groupKey: string;
  /** Threads still hidden. 0 means the group is fully expanded. */
  readonly hiddenCount: number;
  /** Whether more than the initial count is revealed, so "Show less" applies. */
  readonly canShowLess: boolean;
}

export type HomeListItem =
  | HomeHeaderListItem
  | HomePendingTaskListItem
  | HomeThreadListItem
  | HomeShowMoreListItem;

export interface HomeListLayout {
  readonly items: ReadonlyArray<HomeListItem>;
  readonly stickyHeaderIndices: ReadonlyArray<number>;
}

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
    case "header":
      return (
        previous.type === "header" &&
        previous.group === item.group &&
        previous.collapsed === item.collapsed &&
        previous.isFirst === item.isFirst &&
        previous.depth === item.depth &&
        previous.memberStatus === item.memberStatus
      );
    case "pending-task":
      return (
        previous.type === "pending-task" &&
        previous.pendingTask === item.pendingTask &&
        previous.isLast === item.isLast
      );
    case "thread":
      return (
        previous.type === "thread" &&
        previous.thread === item.thread &&
        previous.isLast === item.isLast
      );
    case "show-more":
      return (
        previous.type === "show-more" &&
        previous.groupKey === item.groupKey &&
        previous.hiddenCount === item.hiddenCount &&
        previous.canShowLess === item.canShowLess
      );
  }
}

/** Split only physical saga members; keep the original thread and pending-task objects. */
function hierarchyGroups(
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
        refs.has(JSON.stringify([task.message.environmentId, task.creation.projectId])),
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

export function buildHomeListLayout(input: {
  readonly groups: ReadonlyArray<HomeThreadGroup>;
  readonly displayStates: ReadonlyMap<string, HomeGroupDisplayState>;
  /**
   * When searching, pagination is suspended so every match stays visible.
   */
  readonly showAllThreads?: boolean;
  readonly sagaIndex?: ReadonlyArray<SagaProjectIndexEntry>;
}): HomeListLayout {
  const items: HomeListItem[] = [];
  const stickyHeaderIndices: number[] = [];

  const { groupsByKey, tree } = homeHierarchy(input);
  const ordered = tree.flatMap((node) => {
    const collapsed = input.displayStates.get(node.group.key)?.collapsed && !input.showAllThreads;
    return [
      { group: groupsByKey.get(node.group.key)!, depth: 0, memberStatus: node.memberStatus },
      ...(collapsed
        ? []
        : node.children.map((child) => ({
            group: groupsByKey.get(child.group.key)!,
            depth: 1,
            memberStatus: child.memberStatus,
          }))),
    ];
  });
  for (const [groupIndex, { group, depth, memberStatus }] of ordered.entries()) {
    const display = input.displayStates.get(group.key) ?? DEFAULT_GROUP_DISPLAY_STATE;
    const collapsed = display.collapsed && input.showAllThreads !== true;

    stickyHeaderIndices.push(items.length);
    items.push({
      type: "header",
      key: `header:${group.key}`,
      group,
      collapsed,
      isFirst: groupIndex === 0,
      depth,
      memberStatus,
    });

    if (collapsed) {
      continue;
    }

    const totalCount = group.threads.length;
    // Default to the group's recent-activity window (last few days, or a small
    // fallback for stale projects), capped at the initial page size. Until the
    // user taps "Show more", older threads stay hidden to save vertical space;
    // "Show less" resets visibleCount to the initial constant, which lands back
    // here at the recency baseline.
    const baselineCount = Math.min(
      group.recentThreads.length,
      HOME_INITIAL_VISIBLE_THREADS,
      totalCount,
    );
    const visibleCount = input.showAllThreads
      ? totalCount
      : Math.min(
          display.visibleCount > HOME_INITIAL_VISIBLE_THREADS
            ? display.visibleCount
            : baselineCount,
          totalCount,
        );
    const visibleThreads = group.threads.slice(0, visibleCount);
    const hiddenCount = totalCount - visibleCount;
    const hasShowMoreRow = !input.showAllThreads && totalCount > baselineCount;

    // Pending (unsent) tasks lead the group and are never paginated away.
    for (const [pendingIndex, pendingTask] of group.pendingTasks.entries()) {
      items.push({
        type: "pending-task",
        depth: depth + 1,
        key: `pending-task:${pendingTask.message.messageId}`,
        pendingTask,
        isLast:
          pendingIndex === group.pendingTasks.length - 1 &&
          visibleThreads.length === 0 &&
          !hasShowMoreRow,
      });
    }

    for (const [threadIndex, thread] of visibleThreads.entries()) {
      items.push({
        type: "thread",
        depth: depth + 1,
        key: `thread:${thread.environmentId}:${thread.id}`,
        thread,
        isLast: threadIndex === visibleThreads.length - 1 && !hasShowMoreRow,
      });
    }

    if (hasShowMoreRow) {
      items.push({
        type: "show-more",
        depth: depth + 1,
        key: `show-more:${group.key}`,
        groupKey: group.key,
        hiddenCount,
        // Compare against the group's own baseline, not the global page size:
        // stale projects start below HOME_INITIAL_VISIBLE_THREADS, and "Show
        // less" must be offered as soon as anything beyond the baseline shows.
        canShowLess: visibleCount > baselineCount,
      });
    }
  }

  return { items, stickyHeaderIndices };
}

export type HomeHierarchyV2Item = (ThreadListV2ListItem | HomeHeaderListItem) & {
  readonly depth?: number;
};

/** Preserve V2 partitioning and row objects while giving each shelf the same Projects hierarchy. */
export function buildHomeHierarchyV2Items(input: {
  readonly groups: ReadonlyArray<HomeThreadGroup>;
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly sagaIndex?: ReadonlyArray<SagaProjectIndexEntry>;
  readonly displayStates: ReadonlyMap<string, HomeGroupDisplayState>;
  readonly searching?: boolean;
  readonly selectedThreadKey?: string | null;
}): HomeHierarchyV2Item[] {
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
  const result: HomeHierarchyV2Item[] = [];
  let section = "active";
  let rows: ThreadListV2ListItem[] = [];
  const flush = () => {
    const rowsByGroup = new Map<string, ThreadListV2ListItem[]>();
    const ungrouped: ThreadListV2ListItem[] = [];
    for (const row of rows) {
      const ref =
        row.type === "v2-thread"
          ? [row.item.thread.environmentId, row.item.thread.projectId]
          : row.type === "v2-pending"
            ? [row.pendingTask.message.environmentId, row.pendingTask.creation.projectId]
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
      (section === "active" && !input.searching && !!node.group.representative.stave) ||
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
        key: `v2-${section}-header:${group.key}`,
        group,
        collapsed,
        isFirst: result.length === 0,
        depth,
        memberStatus: node.memberStatus,
      });
      if (collapsed) return;
      for (const row of rowsByGroup.get(group.key) ?? []) result.push({ ...row, depth: depth + 1 });
      for (const child of node.children) visit(child, depth + 1);
    };
    for (const node of tree) visit(node, 0);
    result.push(...ungrouped);
    rows = [];
  };
  for (const item of input.items) {
    if (item.type === "v2-snoozed-shelf" || item.type === "v2-settled-shelf") {
      flush();
      result.push(item);
      section = item.type;
    } else rows.push(item);
  }
  flush();
  return result;
}
