interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
  pauseWhenUnfocused: boolean;
}

export interface VisibleAnimationOptions {
  /** Also pause while the window does not have focus. */
  readonly pauseWhenUnfocused?: boolean;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;
let focusObserved = 0;
let blurRecheck: ReturnType<typeof setTimeout> | null = null;

function updateAnimation(animation: ObservedAnimation) {
  const running =
    animation.intersecting &&
    document.visibilityState === "visible" &&
    !reducedMotion?.matches &&
    (!animation.pauseWhenUnfocused || document.hasFocus());
  animation.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  animation.element.style.setProperty(
    "--visible-animation-will-change",
    running ? "transform" : "auto",
  );
}

function updateAnimations() {
  for (const animation of animations.values()) updateAnimation(animation);
}

// Focus moving into an iframe or webview blurs the window while the document still has
// focus, and hasFocus() can lag the event, so settle the answer again after the event.
function handleBlur() {
  updateAnimations();
  if (blurRecheck !== null) clearTimeout(blurRecheck);
  blurRecheck = setTimeout(() => {
    blurRecheck = null;
    updateAnimations();
  }, 0);
}

function startFocusTracking() {
  focusObserved += 1;
  if (focusObserved > 1) return;
  window.addEventListener("focus", updateAnimations);
  window.addEventListener("blur", handleBlur);
}

function stopFocusTracking() {
  focusObserved -= 1;
  if (focusObserved > 0) return;
  window.removeEventListener("focus", updateAnimations);
  window.removeEventListener("blur", handleBlur);
  if (blurRecheck !== null) clearTimeout(blurRecheck);
  blurRecheck = null;
}

export function observeVisibleAnimation(
  element: HTMLElement | SVGElement | null,
  options?: VisibleAnimationOptions,
) {
  if (element === null) return;
  element.style.setProperty("--visible-animation-state", "paused");
  element.style.setProperty("--visible-animation-will-change", "auto");
  if (typeof IntersectionObserver === "undefined") return;

  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", updateAnimations);
    document.addEventListener("visibilitychange", updateAnimations);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (!animation) continue;
        animation.intersecting = entry.isIntersecting;
        updateAnimation(animation);
      }
    });
  }

  const pauseWhenUnfocused = options?.pauseWhenUnfocused === true;
  const previous = animations.get(element);
  if (previous?.pauseWhenUnfocused) stopFocusTracking();
  const animation = { element, intersecting: false, pauseWhenUnfocused };
  animations.set(element, animation);
  if (pauseWhenUnfocused) startFocusTracking();
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    if (animation.pauseWhenUnfocused) stopFocusTracking();
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    if (animations.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAnimations);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAnimations);
    }
  };
}
