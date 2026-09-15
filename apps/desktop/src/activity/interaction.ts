import { activityVisualState } from "@lecturn/client-runtime/state/activityContext";
import type { DesktopActivityRow, DesktopActivitySnapshot } from "@lecturn/contracts";

export type ActivityMode = "collapsed" | "peek" | "micro" | "expanded";
export type ActivityInteraction =
  | "hover-enter"
  | "hover-leave"
  | "toggle"
  | "expand"
  | "dismiss"
  | "micro-open"
  | "micro-interact";

/** Hover never dismisses a panel the user explicitly opened. */
export function nextActivityMode(mode: ActivityMode, event: ActivityInteraction): ActivityMode {
  switch (event) {
    case "hover-enter":
      return mode === "collapsed" ? "peek" : mode;
    case "hover-leave":
      return mode === "peek" || mode === "micro" ? "collapsed" : mode;
    case "micro-open":
      return mode === "expanded" ? mode : "micro";
    case "micro-interact":
      return mode;
    case "toggle":
      return mode === "expanded" ? "collapsed" : "expanded";
    case "expand":
      return "expanded";
    case "dismiss":
      return "collapsed";
  }
}

function priority(row: DesktopActivityRow): number {
  const state = row.visualState ?? activityVisualState(row);
  if (state === "attention") return 0;
  if (state === "failed") return 1;
  if (state === "offline") return 2;
  if (state === "active") return row.checks?.some((check) => check.status === "pending") ? 3 : 4;
  return 5;
}

/** Stable ties preserve the client's recent-interaction order. */
export function activityPeekRows(rows: readonly DesktopActivityRow[]): DesktopActivityRow[] {
  return rows.toSorted((a, b) => priority(a) - priority(b)).slice(0, 3);
}

/** Keep pointer/keyboard targets still while their content refreshes. Deletions win immediately. */
export function reconcilePeekRows(
  rows: readonly DesktopActivityRow[],
  previousIds: readonly string[],
  frozen: boolean,
): DesktopActivityRow[] {
  if (!frozen) return activityPeekRows(rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return previousIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** PR checks remain useful even while their managing conversation is on screen. */
export function isViewedActivityThread(
  row: DesktopActivityRow,
  viewedThread: DesktopActivitySnapshot["viewedThread"],
): boolean {
  return Boolean(
    !row.watchId &&
    viewedThread &&
    row.environmentId === viewedThread.environmentId &&
    row.threadId === viewedThread.threadId,
  );
}
