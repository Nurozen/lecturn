import {
  buildSagaProjectTree,
  derivePhysicalProjectKey,
  type SagaProjectIndexEntry,
} from "@t3tools/client-runtime/state/project-grouping";
import type { StaveSagaMemberStatus } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

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
  readonly type: "thread";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly isLast: boolean;
}

export interface HomePendingTaskListItem {
  readonly type: "pending-task";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly isLast: boolean;
}

export interface HomeShowMoreListItem {
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

  const groupsByKey = new Map(input.groups.map((group) => [group.key, group]));
  const tree = buildSagaProjectTree(
    input.groups.map((group) => ({
      key: group.key,
      label: group.title,
      representative: group.representative,
      members: group.projects.map((project) => ({
        physicalProjectKey: derivePhysicalProjectKey(project),
        project,
      })),
      memberProjectRefs: group.projects.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
      })),
    })),
    input.sagaIndex ?? [],
  );
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
        key: `thread:${thread.environmentId}:${thread.id}`,
        thread,
        isLast: threadIndex === visibleThreads.length - 1 && !hasShowMoreRow,
      });
    }

    if (hasShowMoreRow) {
      items.push({
        type: "show-more",
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
