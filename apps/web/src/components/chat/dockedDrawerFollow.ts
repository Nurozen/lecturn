import { useEffectEvent, useLayoutEffect, useRef } from "react";

// The approval, question or plan drawer ChatComposer docks above its input.
const DOCKED_DRAWER_SELECTOR = '[data-chat-composer-top-drawer="true"]';

function dockedDrawerHeight(overlay: HTMLElement | null): number {
  let height = 0;
  for (const drawer of overlay?.querySelectorAll<HTMLElement>(DOCKED_DRAWER_SELECTOR) ?? []) {
    height += drawer.getBoundingClientRect().height;
  }
  return height;
}

function shouldFollowDockedDrawer(input: {
  readonly previousHeight: number;
  readonly height: number;
  readonly followingEnd: boolean;
}): boolean {
  return input.followingEnd && input.height - input.previousHeight > 0.5;
}

/**
 * The timeline ignores composer inset changes so typing never scrolls, but a docked drawer
 * covers the newest rows and stops later growth from following. So a timeline following
 * its end re-pins when a drawer docks or grows, after the grown inset commits.
 */
export function useFollowEndWhenDrawerDocks(input: {
  readonly readOverlay: () => HTMLElement | null;
  readonly inset: number;
  readonly isFollowingEnd: () => boolean;
  readonly scrollToEnd: () => void;
}) {
  const previousHeightRef = useRef(0);
  const measure = useEffectEvent(() => {
    const height = dockedDrawerHeight(input.readOverlay());
    const follow = shouldFollowDockedDrawer({
      previousHeight: previousHeightRef.current,
      height,
      followingEnd: input.isFollowingEnd(),
    });
    previousHeightRef.current = height;
    if (follow) input.scrollToEnd();
  });
  const { inset } = input;
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- measures the drawer's DOM height before paint when the docked inset changes so the timeline can follow the end
  useLayoutEffect(() => {
    if (inset > 0) measure();
  }, [inset]);
}
