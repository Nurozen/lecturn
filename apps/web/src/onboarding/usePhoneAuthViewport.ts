function attachPhoneAuthViewport(element: HTMLDivElement | null) {
  const viewport = window.visualViewport;
  if (!element || !viewport) return;
  const update = () => {
    // Root chrome may already reserve a safe-area inset. Do not count it twice.
    const top = Math.max(0, element.getBoundingClientRect().top - viewport.offsetTop);
    element.style.height = `${Math.max(0, viewport.height - top)}px`;
    const focused = document.activeElement;
    if (
      (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) &&
      element.contains(focused)
    ) {
      focused.scrollIntoView({ block: "nearest" });
    }
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    element.style.removeProperty("height");
  };
}

function skipPhoneAuthViewport() {}

/**
 * Android's keyboard can shrink the visual viewport without changing dvh.
 * Module-level refs keep one identity per `enabled`: the compiler leaves a hook
 * that calls no hooks unmemoized, and a new ref each render would reattach.
 */
export function usePhoneAuthViewport(enabled: boolean) {
  return enabled ? attachPhoneAuthViewport : skipPhoneAuthViewport;
}
