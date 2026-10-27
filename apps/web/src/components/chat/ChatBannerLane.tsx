import type { ScopedThreadRef } from "@lecturn/contracts";
import type { ReactNode } from "react";

import { useAppClosedThreadBannerShown } from "../apps/AppClosedThreadBanner";

/**
 * Thread banners float over the top of the timeline, which is where an app thread's closed or
 * revoked notice heads it. There they take their own space instead, so neither hides the other.
 */
export function ChatBannerLane({
  threadRef,
  children,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const appNoticeHeadsTimeline = useAppClosedThreadBannerShown(threadRef);
  return (
    <div
      className={
        appNoticeHeadsTimeline
          ? "chat-banner-lane pointer-events-none flex flex-col ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
          : "chat-banner-lane pointer-events-none absolute top-0 z-20 flex flex-col"
      }
    >
      {children}
    </div>
  );
}
