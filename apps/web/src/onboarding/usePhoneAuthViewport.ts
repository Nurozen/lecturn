import { useLayoutEffect, useRef } from "react";

/** Android's keyboard can shrink the visual viewport without changing dvh. */
export function usePhoneAuthViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!enabled || !element || !viewport) return;
    const update = () => {
      element.style.height = `${viewport.height}px`;
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement && element.contains(focused)) {
        focused.scrollIntoView({ block: "nearest" });
      }
    };
    update();
    viewport.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      element.style.removeProperty("height");
    };
  }, [enabled]);
  return ref;
}
