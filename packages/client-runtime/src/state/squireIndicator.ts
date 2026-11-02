import { isThreadWorking } from "./threadInbox.ts";

// Local until plan step 1.2 adds the Squire record and its activity log to
// @lecturn/contracts; switch to those types then.
export type SquireLifecycle = "creating" | "ready" | "rehoming" | "deleting" | "needs_provider";

export type SquireGestureTrigger =
  | "squire_created"
  | "batch_started"
  | "voice_note_received"
  | "item_accepted"
  | "proposed_thread_created"
  | "proposed_squire_created"
  | "hold_started";

export interface SquireActivityEntry {
  readonly sequence: number;
  // Other log kinds exist and play no gesture.
  readonly kind: SquireGestureTrigger | (string & {});
}

export type SquireIndicatorStateName = "working" | "waiting" | "idle" | "needs_provider";
export type SquireFigureState = "thinking" | "attentive" | "idle";
export type SquireGesture = "greet" | "ponder" | "listen" | "nod" | "flourish" | "glance";

export interface SquireIndicatorState {
  readonly state: SquireIndicatorStateName;
  /** Open decision items shown beside the name; held actions are not items. */
  readonly badge: number | null;
  /** "working" takes the badge's place while the Squire works. */
  readonly workingLabel: boolean;
}

type HomeThreadShell = Parameters<typeof isThreadWorking>[0];

// A Lead caller passes only the items and holds the Lead itself raised (plan D50).
export function squireIndicatorState(
  homeShell: HomeThreadShell | null,
  openDecisionCount: number,
  heldCount: number,
  lifecycle?: SquireLifecycle,
): SquireIndicatorState {
  if (lifecycle === "needs_provider") {
    return { state: "needs_provider", badge: null, workingLabel: false };
  }
  if (homeShell !== null && isThreadWorking(homeShell)) {
    return { state: "working", badge: null, workingLabel: true };
  }
  if (openDecisionCount > 0 || heldCount > 0) {
    return {
      state: "waiting",
      badge: openDecisionCount > 0 ? openDecisionCount : null,
      workingLabel: false,
    };
  }
  return { state: "idle", badge: null, workingLabel: false };
}

export function squireFigureState(state: SquireIndicatorStateName): SquireFigureState {
  if (state === "working") return "thinking";
  if (state === "waiting") return "attentive";
  return "idle";
}

const GESTURE_BY_TRIGGER: Readonly<Record<SquireGestureTrigger, SquireGesture>> = {
  squire_created: "greet",
  batch_started: "ponder",
  voice_note_received: "listen",
  item_accepted: "nod",
  proposed_thread_created: "flourish",
  proposed_squire_created: "flourish",
  hold_started: "glance",
};

function triggerGesture(kind: string): SquireGesture | undefined {
  return Object.hasOwn(GESTURE_BY_TRIGGER, kind)
    ? GESTURE_BY_TRIGGER[kind as SquireGestureTrigger]
    : undefined;
}

/**
 * `lastSeenSequence` null means this client has not observed the Squire yet: the log it
 * receives is history, so it only sets the baseline and nothing replays.
 */
export function squireGestureEvents(
  lastSeenSequence: number | null,
  recentActivity: ReadonlyArray<SquireActivityEntry>,
  sessionFirstOpen: boolean,
): { readonly gestures: ReadonlyArray<SquireGesture>; readonly lastSeenSequence: number | null } {
  let latest = lastSeenSequence;
  for (const entry of recentActivity) {
    if (latest === null || entry.sequence > latest) latest = entry.sequence;
  }

  const gestures: SquireGesture[] = sessionFirstOpen ? ["greet"] : [];
  if (lastSeenSequence !== null) {
    const unseen = recentActivity
      .filter((entry) => entry.sequence > lastSeenSequence)
      .sort((a, b) => a.sequence - b.sequence);
    for (const entry of unseen) {
      const gesture = triggerGesture(entry.kind);
      // A creation seen on the session's first open already got its greet.
      if (gesture === undefined || (sessionFirstOpen && gesture === "greet")) continue;
      gestures.push(gesture);
    }
  }
  return { gestures, lastSeenSequence: latest };
}
