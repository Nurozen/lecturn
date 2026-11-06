import type { MessageId, RunId } from "@lecturn/contracts";

export interface TimelineRunObservation {
  readonly threadKey: string | null;
  readonly hydrated: boolean;
  readonly runId: RunId | null;
}

export function observeTimelineRun(
  previous: TimelineRunObservation | null,
  input: TimelineRunObservation & {
    readonly queued: boolean;
    readonly messageId: MessageId | null;
  },
): { observation: TimelineRunObservation; anchorMessageId: MessageId | null } {
  const observation = {
    threadKey: input.threadKey,
    hydrated: input.hydrated,
    runId: input.queued ? null : input.runId,
  };
  if (previous?.threadKey !== input.threadKey || !previous.hydrated) {
    return { observation, anchorMessageId: null };
  }
  if (
    !input.hydrated ||
    input.runId === null ||
    input.queued ||
    previous.runId === input.runId ||
    input.messageId === null
  ) {
    return { observation: previous, anchorMessageId: null };
  }
  return { observation, anchorMessageId: input.messageId };
}
import type { RunAttemptId } from "@lecturn/contracts";

// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * The list's own content length includes the composer inset spacer, so this
 * measures from the last row instead. Unknown row positions or an unmeasured
 * viewport counts as fitting.
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  input: { readonly composerInset: number; readonly anchorOffset: number },
): boolean {
  if (!state || !state.data || state.data.length === 0) {
    return false;
  }
  const scrollLength = state.scrollLength;
  if (typeof scrollLength !== "number" || !Number.isFinite(scrollLength) || scrollLength <= 0) {
    return false;
  }
  const lastIndex = state.data.length - 1;
  // Overflow can use an unmeasured tail's lower bound; anchored-turn metrics need its height.
  const lastTop = state.positionAtIndex(lastIndex);
  const lastBottom =
    getRowBottom(state, lastIndex) ??
    (typeof lastTop === "number" && Number.isFinite(lastTop) ? lastTop + 1 : null);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}

export interface RememberedTimelinePosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
  readonly atEnd: boolean;
  readonly disclosures?: {
    readonly runs: ReadonlySet<RunId>;
    readonly workGroups: ReadonlySet<string>;
    readonly attempts: ReadonlySet<RunAttemptId>;
    readonly workGroupState: {
      scrollPositions: Map<string, { readonly entryId: string; readonly offset: number }>;
      expandedEntries: Set<string>;
    };
  };
}

const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();

export function readTimelinePosition(threadKey: string) {
  return rememberedTimelinePositions.get(threadKey);
}

export function rememberTimelinePosition(
  threadKey: string,
  position: RememberedTimelinePosition,
  liveFollowEnabled: boolean,
) {
  rememberedTimelinePositions.delete(threadKey);
  rememberedTimelinePositions.set(threadKey, {
    ...position,
    atEnd: liveFollowEnabled || position.atEnd,
  });
  if (rememberedTimelinePositions.size > 100) {
    const oldest = rememberedTimelinePositions.keys().next().value;
    if (oldest !== undefined) rememberedTimelinePositions.delete(oldest);
  }
}

// Lecturn: rows that close a turn without content of their own.
const TRAILING_ROW_KINDS: ReadonlySet<string> = new Set(["assistant-meta", "working", "thinking"]);

/** The newest content row's id when it is an MCP App card, else null. */
export function timelineNewestAppCardRowId(
  rows: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
): string | null {
  const newest = rows.findLast((row) => !TRAILING_ROW_KINDS.has(row.kind));
  return newest?.kind === "mcp-app" ? newest.id : null;
}

/** Below the timeline's top fade. */
export const TIMELINE_REVEAL_TOP_GAP_PX = 12;

let revealedPosition: RememberedTimelinePosition | undefined;

/**
 * Lecturn: where a newly opened timeline lands. A remembered reading position always wins;
 * otherwise `revealRowId`'s top, just below the fade, as a reading position (not at the end), so
 * the opening scroll treats it as user-scrolled and live follow does not pull it back to the end.
 * One entry is cached so a re-render keeps the same object and the opening scroll is not redone.
 */
export function resolveTimelineOpeningPosition(
  remembered: RememberedTimelinePosition | undefined,
  revealRowId: string | null,
): RememberedTimelinePosition | undefined {
  if (remembered?.atEnd === false || revealRowId === null) return remembered;
  if (revealedPosition?.rowId !== revealRowId) {
    revealedPosition = {
      rowId: revealRowId,
      offsetWithinRow: -TIMELINE_REVEAL_TOP_GAP_PX,
      scrollOffset: 0,
      atEnd: false,
    };
  }
  return revealedPosition;
}
