import type { MenuAction } from "@react-native-menu/menu";
import type { ThreadRunSummary, ThreadRuntimeSummary } from "@lecturn/client-runtime/state/shell";

export type ThreadForkUnavailableReason =
  | "disconnected"
  | "server-unsupported"
  | "turn-in-progress"
  | "no-completed-turn";

export type ThreadForkAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: ThreadForkUnavailableReason };

const IN_PROGRESS_RUN_STATUSES: ReadonlySet<ThreadRuntimeSummary["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Whether a fork-at-latest-run can dispatch right now. Forking needs a live
 * connection (cached capabilities lie while offline), a server that advertises
 * the capability, and a completed latest run to cut the history at — a running
 * or never-run thread has no fork point. The provider does not gate: V2 forks
 * natively when it can and otherwise carries the transcript as portable
 * context (presentation `conversationFork` only describes the native path).
 */
export function resolveThreadForkAvailability(input: {
  readonly serverSupportsForking: boolean;
  readonly latestRun: Pick<ThreadRunSummary, "status"> | null;
  readonly runtimeStatus: ThreadRuntimeSummary["status"] | null;
  readonly connected: boolean;
}): ThreadForkAvailability {
  if (!input.connected) {
    return { available: false, reason: "disconnected" };
  }
  if (!input.serverSupportsForking) {
    return { available: false, reason: "server-unsupported" };
  }
  if (
    (input.latestRun !== null && IN_PROGRESS_RUN_STATUSES.has(input.latestRun.status)) ||
    (input.runtimeStatus !== null && IN_PROGRESS_RUN_STATUSES.has(input.runtimeStatus))
  ) {
    return { available: false, reason: "turn-in-progress" };
  }
  if (input.latestRun === null || input.latestRun.status !== "completed") {
    return { available: false, reason: "no-completed-turn" };
  }
  return { available: true };
}

/**
 * Row/long-press menu entry for forking. Hidden entirely when the environment
 * cannot fork (`supported` false); rendered disabled while a fork
 * is dispatching or the thread has no completed latest run to fork from.
 */
export function buildThreadForkMenuItems(input: {
  readonly supported: boolean;
  readonly inFlight: boolean;
  readonly canForkNow: boolean;
}): MenuAction[] {
  if (!input.supported) return [];

  const disabled = input.inFlight || !input.canForkNow;
  return [
    {
      id: "fork-thread",
      title: input.inFlight ? "Forking…" : "Fork thread",
      image: "arrow.triangle.branch",
      ...(disabled ? { attributes: { disabled: true } } : {}),
    },
  ];
}
