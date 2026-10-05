import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import { useCallback, useMemo, useState } from "react";

import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import {
  buildSegmentEnvironmentFilters,
  buildSidebarSegmentViews,
  changeSegmentShelf,
  NO_ACCOUNT_SEGMENT_ID,
  NO_SEGMENT_SHELVES,
  NO_SEGMENTS_COLLAPSED,
  reorderIdsWithinSegment,
  resetSegmentSettledPages,
  SEGMENT_COLLAPSED_KEY,
  SegmentCollapsedSchema,
  segmentIdOfEnvironment,
  toggleSegmentCollapsed,
  type SegmentSagaNode,
  type SidebarListScope,
  type SidebarSegmentation,
  type SidebarSegmentView,
} from "./sidebarSegments.logic";

export type SidebarThreadListScope<Node> = SidebarListScope<EnvironmentThreadShell, Node>;
export type SidebarThreadSegmentView<Node> = SidebarSegmentView<EnvironmentThreadShell, Node>;

/** What a list's shelf headers and "Show more" call. */
export interface SidebarShelfActions {
  readonly toggleSnoozedShelf: () => void;
  readonly toggleSettledShelf: () => void;
  readonly showMoreSettled: () => void;
}

export interface SidebarSegmentsView<Node> {
  /** null while the sidebar is one list. */
  readonly segments: ReadonlyArray<SidebarThreadSegmentView<Node>> | null;
  /** The one list's scope. Its row order is the sidebar's own `orderedThreads`. */
  readonly unsegmented: Omit<SidebarThreadListScope<Node>, "orderedThreads"> & SidebarShelfActions;
  readonly nestSagaProjects: boolean;
  /** How many settled rows "Show more" adds. */
  readonly settledPageCount: number;
  readonly toggleSegment: (segmentId: string) => void;
  /** A segment's shelves open, close, and page on their own. */
  readonly shelfActionsOf: (segmentId: string) => SidebarShelfActions;
}

type SidebarSegmentsInput<Node> = Omit<SidebarThreadListScope<Node>, "orderedThreads"> &
  SidebarShelfActions & {
    readonly segmentation: SidebarSegmentation | null;
    readonly projects: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
    readonly nestedSettledThreads: ReadonlyArray<EnvironmentThreadShell>;
    readonly nestSagaProjects: boolean;
    readonly collapsedProjectKeys: ReadonlySet<string>;
    readonly settledVisibleCount: number;
    readonly settledPageCount: number;
    readonly routeThreadKey: string | null;
  };

type UseSidebarSegments = <Node extends SegmentSagaNode>(
  input: SidebarSegmentsInput<Node>,
) => SidebarSegmentsView<Node>;

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** `reorderIdsWithinSegment` over the sidebar's scoped thread keys. */
export function pinnedReorderKeysWithinSegment(
  segments: ReadonlyArray<{
    readonly pinnedThreads: ReadonlyArray<EnvironmentThreadShell>;
  }> | null,
  orderedKeys: ReadonlyArray<string>,
  movedKey: string,
): ReadonlyArray<string> {
  return reorderIdsWithinSegment({
    segments,
    orderedIds: orderedKeys,
    movedId: movedKey,
    idOf: threadKeyOf,
  });
}

const statusOf = (thread: EnvironmentThreadShell) => resolveThreadStatusPill({ thread });

const useAccountSidebarSegments: UseSidebarSegments = <Node extends SegmentSagaNode>(
  input: SidebarSegmentsInput<Node>,
): SidebarSegmentsView<Node> => {
  const [collapsedSegmentIds, setCollapsedSegmentIds] = useLocalStorage(
    SEGMENT_COLLAPSED_KEY,
    NO_SEGMENTS_COLLAPSED,
    SegmentCollapsedSchema,
  );
  const toggleSegment = useCallback(
    (segmentId: string) =>
      setCollapsedSegmentIds((collapsed) => toggleSegmentCollapsed(collapsed, segmentId)),
    [setCollapsedSegmentIds],
  );
  const {
    segmentation,
    projects,
    pinnedThreads,
    activeThreads,
    snoozedThreads,
    settledThreads,
    nestedSettledThreads,
    scopedSagaTree,
    scopedProjectKeys,
    nestSagaProjects,
    collapsedProjectKeys,
    settledVisibleCount,
    settledPageCount,
    snoozedShelfExpanded,
    settledShelfExpanded,
    routeThreadKey,
  } = input;

  const [shelves, setShelves] = useState(NO_SEGMENT_SHELVES);
  // A project scope flip starts every segment's settled tail over, as it does the one list's.
  const [lastScope, setLastScope] = useState(scopedProjectKeys);
  if (lastScope !== scopedProjectKeys) {
    setLastScope(scopedProjectKeys);
    setShelves(resetSegmentSettledPages);
  }
  const shelfActionsOf = useCallback(
    (segmentId: string): SidebarShelfActions => ({
      toggleSnoozedShelf: () =>
        setShelves((current) =>
          changeSegmentShelf(current, segmentId, (shelf) => ({
            ...shelf,
            snoozedExpanded: !(shelf.snoozedExpanded ?? snoozedShelfExpanded),
          })),
        ),
      toggleSettledShelf: () =>
        setShelves((current) =>
          changeSegmentShelf(current, segmentId, (shelf) => ({
            ...shelf,
            settledExpanded: !(shelf.settledExpanded ?? settledShelfExpanded),
          })),
        ),
      showMoreSettled: () =>
        setShelves((current) =>
          changeSegmentShelf(current, segmentId, (shelf) => ({
            ...shelf,
            settledVisibleCount:
              (shelf.settledVisibleCount ?? settledVisibleCount) + settledPageCount,
          })),
        ),
    }),
    [settledPageCount, settledShelfExpanded, settledVisibleCount, snoozedShelfExpanded],
  );

  const environmentFilters = useMemo(
    () => (segmentation === null ? null : buildSegmentEnvironmentFilters(segmentation)),
    [segmentation],
  );
  // A boolean, so typing in a draft never re-renders the sidebar through here.
  const hasNoAccountDrafts = useComposerDraftStore(
    (store) =>
      segmentation !== null &&
      Object.entries(store.draftThreadsByThreadKey).some(
        ([draftKey, session]) =>
          session.promotedTo == null &&
          segmentIdOfEnvironment(segmentation, session.environmentId) === NO_ACCOUNT_SEGMENT_ID &&
          composerDraftHasUserContent(store.draftsByThreadKey[draftKey]),
      ),
  );
  const segments = useMemo(
    () =>
      segmentation === null || environmentFilters === null
        ? null
        : buildSidebarSegmentViews({
            segmentation,
            collapsedSegmentIds,
            projects,
            pinnedThreads,
            activeThreads,
            snoozedThreads,
            settledThreads,
            nestedSettledThreads,
            scopedSagaTree,
            scopedProjectKeys,
            environmentFilters,
            hasNoAccountDrafts,
            nestSagaProjects,
            collapsedProjectKeys,
            settledVisibleCount,
            snoozedShelfExpanded,
            settledShelfExpanded,
            shelves,
            isRouteThread: (thread) => threadKeyOf(thread) === routeThreadKey,
            statusOf,
          }),
    [
      activeThreads,
      collapsedProjectKeys,
      collapsedSegmentIds,
      environmentFilters,
      hasNoAccountDrafts,
      nestSagaProjects,
      nestedSettledThreads,
      pinnedThreads,
      projects,
      routeThreadKey,
      scopedProjectKeys,
      scopedSagaTree,
      segmentation,
      settledShelfExpanded,
      settledThreads,
      settledVisibleCount,
      shelves,
      snoozedShelfExpanded,
      snoozedThreads,
    ],
  );
  return {
    segments,
    unsegmented: input,
    nestSagaProjects,
    settledPageCount,
    toggleSegment,
    shelfActionsOf,
  };
};

/**
 * Splits the sidebar's already partitioned lists by account. It narrows what
 * the sidebar computed once and starts no timers of its own.
 */
export const useSidebarSegments: UseSidebarSegments = useAccountSidebarSegments;
