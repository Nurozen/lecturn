import { stableStringify } from "@lecturn/shared/relaySigning";
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@lecturn/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";

export function isTerminalPhase(state: RelayAgentActivityState): boolean {
  return state.phase === "completed" || state.phase === "failed";
}

// Rows are only removed when their environment publishes a terminal state. An
// environment that dies mid-run (machine off, process killed) never does, so
// without an age cutoff its threads inflate activeCount forever. Actively
// running phases expire quickly; waiting phases can legitimately sit for hours
// while a user ignores an approval prompt, so they get a longer window. The
// underlying database row is left in place: a late publish for the thread
// refreshes updatedAt and the row becomes visible again.
const RUNNING_AGENT_ACTIVITY_ROW_TTL_MS = 2 * 60 * 60 * 1_000;
const WAITING_AGENT_ACTIVITY_ROW_TTL_MS = 24 * 60 * 60 * 1_000;

export function isExpiredAgentActivityState(
  state: RelayAgentActivityState,
  nowMs: number,
): boolean {
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return true;
  }
  const ttlMs =
    state.phase === "running" || state.phase === "starting"
      ? RUNNING_AGENT_ACTIVITY_ROW_TTL_MS
      : WAITING_AGENT_ACTIVITY_ROW_TTL_MS;
  return nowMs - updatedAtMs > ttlMs;
}

const MAX_SUMMARY_TEXT_LENGTH = 120;
const MAX_STATUS_TEXT_LENGTH = 40;
const MAX_DEEP_LINK_LENGTH = 512;
// The Live Activity banner (lock screen / Notification Center) renders up to
// five rows; the expanded Dynamic Island shows the top three of these.
export const MAX_ACTIVITY_ROWS = 5;

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength - 3).trimEnd() + "...";
}

function sanitizeDeepLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/";
  }
  return truncateText(trimmed, MAX_DEEP_LINK_LENGTH);
}

export function sanitizeAgentActivityAggregateRow(
  row: RelayAgentActivityAggregateRow,
): RelayAgentActivityAggregateRow {
  return {
    ...row,
    projectTitle: truncateText(row.projectTitle, MAX_SUMMARY_TEXT_LENGTH),
    threadTitle: truncateText(row.threadTitle, MAX_SUMMARY_TEXT_LENGTH),
    modelTitle: truncateText(row.modelTitle, MAX_SUMMARY_TEXT_LENGTH),
    status: truncateText(row.status, MAX_STATUS_TEXT_LENGTH),
    deepLink: sanitizeDeepLink(row.deepLink),
    ...(row.pullRequest
      ? {
          pullRequest: {
            ...row.pullRequest,
            repository: truncateText(row.pullRequest.repository, 80),
            watchId: truncateText(row.pullRequest.watchId, 80),
            projectId: truncateText(row.pullRequest.projectId, 80),
          },
        }
      : {}),
  };
}

export function sanitizeAgentActivityAggregateState(
  aggregate: RelayAgentActivityAggregateState,
): RelayAgentActivityAggregateState {
  const sanitized = {
    ...aggregate,
    title: truncateText(aggregate.title, MAX_SUMMARY_TEXT_LENGTH),
    subtitle: truncateText(aggregate.subtitle, MAX_SUMMARY_TEXT_LENGTH),
    activities: aggregate.activities
      .slice(0, MAX_ACTIVITY_ROWS)
      .map(sanitizeAgentActivityAggregateRow),
  };
  // ActivityKit's 4 KB envelope includes APS metadata and attributes. Keep
  // content below 3.2 KB including UTF-8 expansion; activeCount stays truthful
  // when only the first cards fit.
  while (
    sanitized.activities.length > 0 &&
    new TextEncoder().encode(stableStringify(sanitized)).byteLength > 3_200
  ) {
    sanitized.activities.pop();
  }
  return sanitized;
}

export function sanitizeApnsNotificationPayload(
  notification: ApnsNotificationPayload,
): ApnsNotificationPayload {
  return {
    ...notification,
    title: truncateText(notification.title, MAX_SUMMARY_TEXT_LENGTH),
    body: truncateText(notification.body, MAX_SUMMARY_TEXT_LENGTH),
    deepLink: sanitizeDeepLink(notification.deepLink),
  };
}

function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      // Matches the web sidebar's pill wording (Sidebar.logic.ts) so the same
      // thread reads the same across surfaces.
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

export function statusForAgentActivity(state: RelayAgentActivityState): string {
  return state.pullRequest
    ? state.pullRequest.stale
      ? "Stale"
      : state.pullRequest.state !== "open"
        ? state.pullRequest.state
        : `CI ${state.pullRequest.checks}`
    : statusForPhase(state.phase);
}
