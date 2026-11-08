import {
  squireQuietRunIds,
  squireUpdateGroups,
  type SquireApprovalEntry,
  type SquireUpdateItemRole,
} from "@lecturn/client-runtime/state/squire";
import { isLiveSubagentTurnItem } from "@lecturn/client-runtime/state/subagentRuntime";
import {
  threadUnreadBoundary,
  type ThreadUnreadWindow,
} from "@lecturn/client-runtime/state/thread-visits";
import type { RunId, SquireCardRow } from "@lecturn/contracts";

import type { ThreadFeedActivity, ThreadFeedEntry } from "../../lib/threadActivity";
import type { SquireApprovalFeedEntry, ThreadFeedRow } from "./pending-thread-feed";

type ThreadFeedActivityItem = ThreadFeedActivity["projectedItem"]["item"];

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
      return null;
    default:
      return entry.runId;
  }
}

/** A failure the user should see; a retrying error or a usage-limit warning is neither, as on web. */
function isRuntimeError(item: ThreadFeedActivityItem): boolean {
  if (item.type !== "error" || item.retry !== undefined) return false;
  return item.failure.class !== "usage_limit" || item.status === "completed";
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
          activity.workEntry.questionAnswer !== undefined ||
          isRuntimeError(item) ||
          ((item.type === "approval_request" ||
            item.type === "user_input_request" ||
            item.type === "secret_request") &&
            activity.lifecycleStatus === "inProgress")
        );
      })
        ? "keep"
        : "update";
    case "message":
      // A chat reads as its messages, so what a Squire says never hides inside a span.
      if (entry.message.streaming || entry.message.role === "assistant") return "keep";
      // A queued or local message carries no actor; only the user writes those.
      return (entry.message.createdBy ?? "user") === "user" ? "user" : "update";
    case "run-fold":
    case "work-toggle":
      return "update";
    default:
      return "keep";
  }
}

/**
 * In a Squire's home thread, leaves out each span of quiet wakes and what their turns did short
 * of speaking. Assistant text ends a span, so a span has nothing to show and gets no row.
 */
export function groupSquireUpdates<T extends ThreadFeedEntry>(
  rows: ReadonlyArray<T>,
  activeRunId: RunId | null,
): ReadonlyArray<T> {
  const groups = squireUpdateGroups(
    rows,
    (entry) => squireUpdateRole(entry, activeRunId),
    (entry) => squireWakeEventKinds(entry) ?? NO_EVENT_KINDS,
  );
  if (groups.length === 0) return rows;
  const result: T[] = [];
  let index = 0;
  for (const group of groups) {
    result.push(...rows.slice(index, group.start));
    index = group.end;
  }
  result.push(...rows.slice(index));
  return result;
}

type SquireQuietItem = ThreadFeedActivity | Extract<ThreadFeedEntry, { readonly type: "message" }>;

function squireQuietSignal(item: SquireQuietItem) {
  if ("message" in item) {
    const { message } = item;
    return message.role === "user" && (message.createdBy ?? "user") === "user"
      ? { runId: message.runId, userMessage: true }
      : null;
  }
  const tool = item.projectedItem.item;
  return tool.type === "dynamic_tool" ? { runId: item.runId, toolName: tool.toolName } : null;
}

/** Runs whose text never reaches the chat; the rule is shared with web. */
export function squireChatQuietRunIds(feed: ReadonlyArray<ThreadFeedEntry>): ReadonlySet<RunId> {
  const items = feed.flatMap((entry): ReadonlyArray<SquireQuietItem> => {
    if (entry.type === "activity-group") return entry.activities;
    return entry.type === "message" ? [entry] : [];
  });
  return squireQuietRunIds(items, squireQuietSignal);
}

function isQuietText(entry: ThreadFeedEntry, quietRunIds: ReadonlySet<RunId>): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    entry.message.runId !== null &&
    quietRunIds.has(entry.message.runId)
  );
}

export function hideSquireQuietText<T extends ThreadFeedEntry>(
  rows: ReadonlyArray<T>,
  quietRunIds: ReadonlySet<RunId>,
): ReadonlyArray<T> {
  if (quietRunIds.size === 0) return rows;
  return rows.filter((entry) => !isQuietText(entry, quietRunIds));
}

/**
 * Places a Squire's approvals among the chat's rows by when they were raised. While earlier
 * history is unloaded, a closed row older than the first row waits for it, so it never sits
 * above messages that came before it; one still waiting on the user shows regardless. The
 * working row stays last.
 */
export function mergeSquireApprovals(
  rows: ReadonlyArray<ThreadFeedRow>,
  approvals: ReadonlyArray<SquireApprovalEntry<SquireCardRow>>,
  hasMoreHistory: boolean,
): ReadonlyArray<ThreadFeedRow> {
  if (approvals.length === 0) return rows;
  const oldest = rows[0]?.createdAt ?? null;
  const shown =
    hasMoreHistory && oldest !== null
      ? approvals.filter((approval) => approval.phase !== "closed" || approval.createdAt >= oldest)
      : approvals;
  if (shown.length === 0) return rows;
  const result: ThreadFeedRow[] = [];
  let next = 0;
  const place = (before: string | null) => {
    for (; next < shown.length; next += 1) {
      const entry = shown[next]!;
      if (before !== null && entry.createdAt >= before) return;
      const row: SquireApprovalFeedEntry = {
        type: "squire-approval",
        id: `squire-approval:${entry.row.id}`,
        createdAt: entry.createdAt,
        entry,
      };
      result.push(row);
    }
  };
  for (const row of rows) {
    place(row.type === "thinking" ? null : row.createdAt);
    result.push(row);
  }
  place(null);
  return result;
}

export interface ThreadUnreadAnchor {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * The message the "New" divider sits above for this open, or null. Walks back only as far as
 * the visit mark, so a long thread costs what is unread, and skips text the chat hides.
 */
export function threadUnreadAnchor(
  feed: ReadonlyArray<ThreadFeedEntry>,
  window: ThreadUnreadWindow | null,
  quietRunIds: ReadonlySet<RunId>,
): ThreadUnreadAnchor | null {
  if (window === null || window.lastVisitedAt === null) return null;
  const visitedMs = Date.parse(window.lastVisitedAt);
  if (Number.isNaN(visitedMs)) return null;
  const unread: Array<Extract<ThreadFeedEntry, { readonly type: "message" }>["message"]> = [];
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index]!;
    if (entry.type !== "message") continue;
    if (Date.parse(entry.createdAt) <= visitedMs) break;
    if (!isQuietText(entry, quietRunIds)) unread.push(entry.message);
  }
  unread.reverse();
  const id = threadUnreadBoundary(unread, window);
  if (id === null) return null;
  const anchor = unread.find((message) => message.id === id);
  return anchor === undefined ? null : { id: anchor.id, createdAt: anchor.createdAt };
}

/** The anchor's row, or the next one in time when a fold hides it. */
export function insertUnreadDivider(
  rows: ReadonlyArray<ThreadFeedRow>,
  anchor: ThreadUnreadAnchor | null,
): ReadonlyArray<ThreadFeedRow> {
  if (anchor === null) return rows;
  let index = rows.findIndex((row) => row.id === anchor.id);
  if (index === -1) {
    index = rows.findIndex((row) => row.type !== "thinking" && row.createdAt >= anchor.createdAt);
  }
  if (index === -1) return rows;
  return [
    ...rows.slice(0, index),
    { type: "unread-divider", id: "unread-divider", createdAt: anchor.createdAt },
    ...rows.slice(index),
  ];
}
