import type { MenuAction } from "@react-native-menu/menu";
import type { OrchestrationLatestTurn, OrchestrationSessionStatus } from "@t3tools/contracts";

export type ThreadForkUnavailableReason =
  | "disconnected"
  | "server-unsupported"
  | "provider-unsupported"
  | "turn-in-progress"
  | "no-completed-turn";

export type ThreadForkAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: ThreadForkUnavailableReason };

/**
 * Whether a fork-at-latest-turn can dispatch right now. Forking needs a live
 * connection (cached capabilities lie while offline), a server that advertises
 * the capability, a provider whose conversation history can be forked
 * natively, and a completed latest turn to cut the history at — a running or
 * never-run thread has no fork point.
 */
export function resolveThreadForkAvailability(input: {
  readonly serverSupportsForking: boolean;
  readonly providerConversationFork: string | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state"> | null;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly connected: boolean;
}): ThreadForkAvailability {
  if (!input.connected) {
    return { available: false, reason: "disconnected" };
  }
  if (!input.serverSupportsForking) {
    return { available: false, reason: "server-unsupported" };
  }
  if (input.providerConversationFork !== "native") {
    return { available: false, reason: "provider-unsupported" };
  }
  if (input.latestTurn?.state === "running" || input.sessionStatus === "starting") {
    return { available: false, reason: "turn-in-progress" };
  }
  if (input.latestTurn === null || input.latestTurn.state !== "completed") {
    return { available: false, reason: "no-completed-turn" };
  }
  return { available: true };
}

/**
 * Row/long-press menu entry for forking. Hidden entirely when the environment
 * or provider cannot fork (`supported` false); rendered disabled while a fork
 * is dispatching or the thread has no completed latest turn to fork from.
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
