import type { ScopedThreadRef } from "@lecturn/contracts";
import { type ComponentProps, useLayoutEffect } from "react";
import { useAndroidChatPublisher } from "../../hooks/useAndroidChatBridge";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { PendingApproval, TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useThreadVisibleTurnItems } from "../../state/entities";
import {
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
} from "../ChatView.logic";
import { useComposerCardTimelineEntries } from "../embed/embedPendingApprovalRows";
import { MessagesTimeline } from "./MessagesTimeline";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * delta re-renders the timeline without re-rendering ChatView.
 */
export function ThreadTimeline({
  threadDetailRef,
  entriesInput,
  draftEntries,
  activeThreadKey,
  syncing,
  detailLoading,
  composerCardApprovals,
  androidChatScope,
  androidChatThread,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries"> & {
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  threadDetailRef: ScopedThreadRef | null;
  entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  /** A local draft's optimistic rows; null for a server thread. */
  draftEntries: ReadonlyArray<TimelineEntry> | null;
  activeThreadKey: string | null;
  syncing: boolean;
  detailLoading: boolean;
  /** Approvals the composer card asks, whose timeline rows leave so nothing is asked twice. */
  composerCardApprovals: ReadonlyArray<PendingApproval>;
  androidChatScope: string;
  /** Null until the Android widget may show this thread. */
  androidChatThread: { readonly id: string; readonly title: string } | null;
}) {
  const visibleTurnItems = useThreadVisibleTurnItems(threadDetailRef);
  const serverEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems,
  });
  const entries = draftEntries ?? serverEntries;
  const displayedEntries = resolveThreadSwitchTimeline({
    loading: entries.length === 0 && syncing,
    activeThreadKey,
    nextEntries: entries,
    rememberedForActive: peekRememberedThreadTimeline<typeof entries>(activeThreadKey),
  });
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- stores the committed ready timeline in the module-level cache used during thread switches
  useLayoutEffect(() => {
    if (detailLoading || entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
      return;
    }
    rememberReadyThreadTimeline({ threadKey: activeThreadKey, entries });
  }, [activeThreadKey, detailLoading, entries]);
  useAndroidChatPublisher({
    scope: androidChatScope,
    // Only the Android host reads the messages; nothing else pays for them per text delta.
    thread:
      androidChatThread === null || window.symbaHost === undefined
        ? null
        : {
            ...androidChatThread,
            messages: entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
          },
  });
  const shownEntries = useComposerCardTimelineEntries(displayedEntries, composerCardApprovals);
  return (
    <MessagesTimeline
      {...timelineProps}
      detailLoading={detailLoading}
      timelineEntries={shownEntries}
    />
  );
}
