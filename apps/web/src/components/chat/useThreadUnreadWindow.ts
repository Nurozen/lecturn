import type { ThreadUnreadWindow } from "@lecturn/client-runtime/state/thread-visits";
import { useState } from "react";

import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";

/**
 * The thread's unread window for this open, captured in render because
 * ThreadVisitWatermark's effect marks the thread read right after the first commit. The state
 * is keyed by thread, as one ChatView stays mounted across threads.
 */
export function useThreadUnreadWindow(
  threadKey: string,
  shell: {
    readonly updatedAt: string;
    readonly lastVisitedAt?: string | null | undefined;
  } | null,
): ThreadUnreadWindow | null {
  const localLastVisitedAt = useUiStateStore((store) => store.threadLastVisitedAtById[threadKey]);
  const [captured, setCaptured] = useState<{
    readonly threadKey: string;
    readonly window: ThreadUnreadWindow;
  } | null>(null);
  if (shell !== null && captured?.threadKey !== threadKey) {
    const window = {
      lastVisitedAt: resolveThreadLastVisitedAt(shell.lastVisitedAt, localLastVisitedAt) ?? null,
      openedThrough: shell.updatedAt,
    };
    setCaptured({ threadKey, window });
    return window;
  }
  return captured?.threadKey === threadKey ? captured.window : null;
}
