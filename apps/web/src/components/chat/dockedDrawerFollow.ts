import { useEffectEvent, useLayoutEffect, useRef } from "react";

// The approval, question or plan drawer ChatComposer docks above its input.
const DOCKED_DRAWER_SELECTOR = '[data-chat-composer-top-drawer="true"]';

export function dockedDrawerHeight(overlay: HTMLElement | null): number {
  let height = 0;
  for (const drawer of overlay?.querySelectorAll<HTMLElement>(DOCKED_DRAWER_SELECTOR) ?? []) {
    height += drawer.getBoundingClientRect().height;
  }
  return height;
}

export function shouldFollowDockedDrawer(input: {
  readonly previousHeight: number;
  readonly height: number;
  readonly followingEnd: boolean;
}): boolean {
  return input.followingEnd && input.height - input.previousHeight > 0.5;
}

/**
 * The timeline deliberately ignores composer inset changes (its footer layout
 * does not re-pin the end), so typing never moves what is on screen. A drawer
 * docking above the composer is different: it covers the newest rows, which
 * are what the drawer asks about, and once the end is off screen later row
 * growth stops following too. So a timeline that was following its end
 * re-pins when a drawer docks or grows. Runs after the grown inset commits,
 * so the end it scrolls to already clears the drawer.
 */
export function useFollowEndWhenDrawerDocks(input: {
  readonly overlay: HTMLElement | null;
  readonly inset: number;
  readonly isFollowingEnd: () => boolean;
  readonly scrollToEnd: () => void;
}) {
  const previousHeightRef = useRef(0);
  const measure = useEffectEvent((overlay: HTMLElement | null) => {
    const height = dockedDrawerHeight(overlay);
    const follow = shouldFollowDockedDrawer({
      previousHeight: previousHeightRef.current,
      height,
      followingEnd: input.isFollowingEnd(),
    });
    previousHeightRef.current = height;
    if (follow) input.scrollToEnd();
  });
  const { overlay, inset } = input;
  useLayoutEffect(() => {
    if (inset > 0) measure(overlay);
  }, [overlay, inset]);
}
