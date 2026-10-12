import { useLayoutEffect, useRef } from "react";

/** Keep the mobile workspace above the IME, including WebViews whose svh/dvh stay stale. */
export function useWorkspaceViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const viewport = window.visualViewport;
    const update = () => {
      // Pinch zoom should pan the existing layout, not resize the composer.
      if (viewport && viewport.scale !== 1) return;
      const top = Math.max(0, element.getBoundingClientRect().top - (viewport?.offsetTop ?? 0));
      element.style.setProperty(
        "--workspace-viewport-height",
        `${Math.max(0, (viewport?.height ?? window.innerHeight) - top)}px`,
      );
    };
    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      element.style.removeProperty("--workspace-viewport-height");
    };
  }, [enabled]);
  return ref;
}
