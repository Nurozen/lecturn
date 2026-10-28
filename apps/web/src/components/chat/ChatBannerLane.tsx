import { useLayoutEffect, useRef, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";

/**
 * Thread banners float over the top of the timeline, where an app thread's closed or revoked
 * notice heads it, so the notice reserves the published lane height above itself. The space is
 * reserved inside the list rather than taken from it because the list re-pins to the end when it
 * resizes with the reader within a screen of the end, which would scroll the notice away.
 */
export function ChatBannerLane({ children }: { readonly children: ReactNode }) {
  const laneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const lane = laneRef.current;
    const canvas = lane?.parentElement;
    if (!lane || !canvas) return;
    const publish = () =>
      canvas.style.setProperty("--chat-banner-lane-height", `${lane.offsetHeight}px`);
    publish();
    const stop = observeResize(lane, publish);
    return () => {
      stop();
      canvas.style.removeProperty("--chat-banner-lane-height");
    };
  }, []);
  return (
    <div
      ref={laneRef}
      className="chat-banner-lane pointer-events-none absolute top-0 z-20 flex flex-col"
    >
      {children}
    </div>
  );
}
