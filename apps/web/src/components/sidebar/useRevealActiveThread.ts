import { useEffect } from "react";

/** Route navigation keeps the selected thread above the footer and below sticky account bars. */
export function useRevealActiveThread(row: HTMLElement | null, active: boolean) {
  useEffect(() => {
    if (!row || !active) return;
    // Wait for the enclosing account and project lists to finish this commit.
    const frame = requestAnimationFrame(() => {
      row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, row]);
}
