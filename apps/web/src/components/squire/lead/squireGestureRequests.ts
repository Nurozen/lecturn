import type { SquireId } from "@lecturn/contracts";
import { useEffect, type RefObject } from "react";

import type { CompanionGesture, GestureResult } from "../companion/types";

type Listener = (gesture: CompanionGesture) => void;

const listeners = new Map<SquireId, Set<Listener>>();

/**
 * Asks whichever figure of this Squire is mounted (the companion panel's or the onboarding's)
 * to play a gesture that has no server activity behind it, such as the Lead's greet when its
 * proposals appear. Dropped when no figure is mounted.
 */
export function requestSquireGesture(squireId: SquireId, gesture: CompanionGesture) {
  for (const listener of listeners.get(squireId) ?? []) listener(gesture);
}

/** Plays requested gestures on a mounted figure. */
export function useSquireGestureRequests(
  squireId: SquireId,
  target: RefObject<{ play(name: CompanionGesture): Promise<GestureResult> } | null>,
) {
  useEffect(() => {
    const listener: Listener = (gesture) => {
      void target.current?.play(gesture);
    };
    const set = listeners.get(squireId) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(squireId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && listeners.get(squireId) === set) listeners.delete(squireId);
    };
  }, [squireId, target]);
}
