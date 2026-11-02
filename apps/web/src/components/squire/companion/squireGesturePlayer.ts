// Gestures from the snapshot's `recentActivity` (plan A7, spec P16.3), played by the mounted
// panel figure. Each unseen entry plays once, in order; `greet` plays on the first open of a
// Squire's view in the session.
import { squireSnapshotGestures } from "@lecturn/client-runtime/state/squire";
import type { SquireId, SquireSnapshot } from "@lecturn/contracts";
import { useEffect, useRef, type RefObject } from "react";

import type { CompanionGesture, GestureResult } from "./types";

export interface SquireGestureTarget {
  play(name: CompanionGesture): Promise<GestureResult>;
}

// The last activity sequence seen per Squire for this page session, so a remount or a
// reconnect's fresh snapshot never replays a gesture. Absent: the view has not opened yet.
const lastSeenBySquire = new Map<SquireId, number>();

/** The gestures this snapshot adds, in order, marking them seen. */
export function takeSquireGestures(
  squireId: SquireId,
  recentActivity: SquireSnapshot["recentActivity"],
  /** The Lead greets when its onboarding proposals appear instead, so it would greet twice. */
  firstOpenGreet = true,
): ReadonlyArray<CompanionGesture> {
  const seen = lastSeenBySquire.get(squireId);
  const result = squireSnapshotGestures(
    seen ?? null,
    recentActivity,
    seen === undefined && firstOpenGreet,
  );
  // A first open with no activity still sets a baseline, so the first new entry plays.
  lastSeenBySquire.set(squireId, result.lastSeenSequence ?? -1);
  return result.gestures;
}

export function resetSquireGesturesForTests() {
  lastSeenBySquire.clear();
}

/** Plays one gesture at a time; a gesture refused while paused (yielded, unfocused) is dropped. */
export function useSquireGesturePlayer(
  squireId: SquireId,
  recentActivity: SquireSnapshot["recentActivity"],
  target: RefObject<SquireGestureTarget | null>,
  firstOpenGreet = true,
) {
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    for (const name of takeSquireGestures(squireId, recentActivity, firstOpenGreet)) {
      queue.current = queue.current.then(() => target.current?.play(name)).catch(() => undefined);
    }
  }, [firstOpenGreet, recentActivity, squireId, target]);
}
