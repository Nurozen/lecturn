import {
  squireUpdateGroupLabel,
  squireUpdateGroups,
  type SquireUpdateItemRole,
} from "@lecturn/client-runtime/state/squire";
import { isLiveSubagentTurnItem } from "@lecturn/client-runtime/state/subagentRuntime";
import type { RunId } from "@lecturn/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

type SquireUpdatesRow = Extract<ThreadFeedEntry, { readonly type: "squire-updates" }>;

const NO_EVENT_KINDS: ReadonlyArray<string> = [];

function squireWakeEventKinds(entry: ThreadFeedEntry): ReadonlyArray<string> | null {
  if (entry.type !== "activity-group") return null;
  for (const activity of entry.activities) {
    const item = activity.projectedItem.item;
    if (item.type === "notification" && item.source.kind === "squire") {
      return item.source.eventKinds ?? NO_EVENT_KINDS;
    }
  }
  return null;
}

function rowRunId(entry: ThreadFeedEntry): RunId | null {
  switch (entry.type) {
    case "message":
      return entry.message.runId;
    case "import-divider":
    case "squire-updates":
      return null;
    default:
      return entry.runId;
  }
}

export function squireUpdateRole(
  entry: ThreadFeedEntry,
  activeRunId: RunId | null,
): SquireUpdateItemRole {
  // A wake's notification is its run's first input, so a wake still being worked stays out too.
  if (activeRunId !== null && rowRunId(entry) === activeRunId) return "keep";
  switch (entry.type) {
    case "activity-group":
      if (squireWakeEventKinds(entry) !== null) return "wake";
      return entry.activities.some((activity) => {
        const item = activity.projectedItem.item;
        return (
          isLiveSubagentTurnItem(item) ||
          ((item.type === "approval_request" ||
            item.type === "user_input_request" ||
            item.type === "secret_request") &&
            activity.lifecycleStatus === "inProgress")
        );
      })
        ? "keep"
        : "update";
    case "message":
      if (entry.message.streaming) return "keep";
      // A queued or local message carries no actor; only the user writes those.
      return entry.message.role === "user" && (entry.message.createdBy ?? "user") === "user"
        ? "user"
        : "update";
    case "run-fold":
    case "work-toggle":
      return "update";
    default:
      return "keep";
  }
}

const squireUpdatesRows = new WeakMap<ThreadFeedEntry, SquireUpdatesRow>();

/**
 * In a Squire's home thread, folds each run of consecutive Squire wakes (and what their turns
 * produced) behind one summary row keyed by the run's first row, so it keeps its place and its
 * expansion as later wakes join. A collapsed run's rows are left out of the list entirely.
 */
export function groupSquireUpdates<T extends ThreadFeedEntry>(
  rows: ReadonlyArray<T>,
  activeRunId: RunId | null,
  expandedGroupIds: ReadonlySet<string>,
): ReadonlyArray<T | SquireUpdatesRow> {
  const groups = squireUpdateGroups(
    rows,
    (entry) => squireUpdateRole(entry, activeRunId),
    (entry) => squireWakeEventKinds(entry) ?? NO_EVENT_KINDS,
  );
  if (groups.length === 0) return rows;
  const result: Array<T | SquireUpdatesRow> = [];
  let index = 0;
  for (const group of groups) {
    result.push(...rows.slice(index, group.start));
    const first = rows[group.start]!;
    const id = `squire-updates:${first.id}`;
    const label = squireUpdateGroupLabel(group);
    const expanded = expandedGroupIds.has(id);
    let row = squireUpdatesRows.get(first);
    if (row?.label !== label || row.expanded !== expanded) {
      row = { type: "squire-updates", id, createdAt: first.createdAt, label, expanded };
      squireUpdatesRows.set(first, row);
    }
    result.push(row);
    if (expanded) result.push(...rows.slice(group.start, group.end));
    index = group.end;
  }
  result.push(...rows.slice(index));
  return result;
}
