import { useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform } from "react-native";

// All glass surfaces share one native subscription, including recycled list rows.
let opaque = true;
let generation = 0;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const current = ++generation;
    let transparency = true;
    let contrast = true;
    let transparencyChanged = false;
    let contrastChanged = false;
    const publish = () => {
      if (current !== generation) return;
      const next = transparency || contrast;
      if (opaque === next) return;
      opaque = next;
      listeners.forEach((notify) => notify());
    };
    const transparencySubscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (value) => {
        transparencyChanged = true;
        transparency = value;
        publish();
      },
    );
    const contrastSubscription = AccessibilityInfo.addEventListener(
      Platform.OS === "ios" ? "darkerSystemColorsChanged" : "highTextContrastChanged",
      (value) => {
        contrastChanged = true;
        contrast = value;
        publish();
      },
    );
    void (
      Platform.OS === "ios"
        ? AccessibilityInfo.isReduceTransparencyEnabled()
        : Promise.resolve(false)
    )
      .then((value) => {
        if (!transparencyChanged) transparency = value;
        publish();
      })
      .catch(() => {});
    void (
      Platform.OS === "ios"
        ? AccessibilityInfo.isDarkerSystemColorsEnabled()
        : AccessibilityInfo.isHighTextContrastEnabled()
    )
      .then((value) => {
        if (!contrastChanged) contrast = value;
        publish();
      })
      .catch(() => {});
    stop = () => {
      transparencySubscription.remove();
      contrastSubscription.remove();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = undefined;
      generation++;
      opaque = true;
    }
  };
}

export const glassAccessibilityStore = { subscribe, getSnapshot: () => opaque };

/** Solid material until preferences are known, and whenever contrast/transparency requires it. */
export function useGlassAccessibility() {
  return useSyncExternalStore(
    glassAccessibilityStore.subscribe,
    glassAccessibilityStore.getSnapshot,
    () => true,
  );
}
