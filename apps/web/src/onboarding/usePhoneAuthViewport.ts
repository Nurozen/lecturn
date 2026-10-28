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
 * Module-level ref callbacks keep one identity per `enabled`, so a re-render
 * never detaches and reattaches the viewport listeners.
 */
export function phoneAuthViewportRef(enabled: boolean) {
  return enabled ? attachPhoneAuthViewport : skipPhoneAuthViewport;
}
