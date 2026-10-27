import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import {
  resolveThreadListV2Status,
  threadHasUnseenCompletion,
  type ThreadListV2Status,
} from "./threadListV2";

export interface ThreadStatusLabel {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly className: string;
  readonly iconTintClassName: string;
}

const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, ThreadStatusLabel>> = {
  approval: {
    label: "Approval",
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: "Input",
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  working: {
    label: "Working",
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  waiting: {
    label: "Waiting",
    icon: "circle.dashed.inset.filled",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
  failed: {
    label: "Failed",
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  limited: {
    label: "Limited",
    icon: "exclamationmark.circle",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
};

const DONE_STATUS_LABEL: ThreadStatusLabel = {
  label: "Done",
  icon: "checkmark.circle",
  className: "text-adaptive-emerald-700-300",
  iconTintClassName: "accent-adaptive-emerald-700-300",
};

/** What a thread row announces about its thread; a finished run counts until the user opens it. */
export function resolveThreadStatusLabel(
  thread: EnvironmentThreadShell,
): ThreadStatusLabel | undefined {
  const status = resolveThreadListV2Status(thread);
  const label = STATUS_LABEL_BY_STATUS[status];
  if (status === "working" && label !== undefined && thread.goal?.status === "active") {
    return { ...label, label: "Goal" };
  }
  if (label !== undefined) return label;
  return status === "ready" && threadHasUnseenCompletion(thread) ? DONE_STATUS_LABEL : undefined;
}

/**
 * The badge a thread row draws in place of its age. Working rows carry no badge: their activity
 * already shows, as the active border in the thread list and the gold dot in the Apps tab.
 */
export function resolveThreadStatusBadge(
  thread: EnvironmentThreadShell,
): ThreadStatusLabel | undefined {
  return resolveThreadListV2Status(thread) === "working"
    ? undefined
    : resolveThreadStatusLabel(thread);
}
