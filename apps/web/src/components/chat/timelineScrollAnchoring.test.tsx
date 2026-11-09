import { MessageId, RunId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  observeTimelineRun,
  resolveTimelineOpeningPosition,
  TIMELINE_REVEAL_TOP_GAP_PX,
  timelineNewestAppCardRowId,
} from "./timelineScrollAnchoring";

describe("observeTimelineRun", () => {
  const existing = {
    threadKey: "environment:thread",
    hydrated: true,
    runId: RunId.make("existing-run"),
    queued: false,
    messageId: MessageId.make("existing-message"),
  };
  const next = {
    ...existing,
    runId: RunId.make("new-run"),
    messageId: MessageId.make("new-message"),
  };

  it("does not mistake delayed hydration for a newly started turn", () => {
    const loading = { ...existing, hydrated: false, runId: null, messageId: null };
    const opened = observeTimelineRun(null, loading);
    const stillLoading = observeTimelineRun(opened.observation, loading);
    const hydrated = observeTimelineRun(stillLoading.observation, existing);
    expect(hydrated.anchorMessageId).toBeNull();
    expect(observeTimelineRun(hydrated.observation, next).anchorMessageId).toBe(next.messageId);
  });

  it("keeps the end position while a stale cached run is replaced during synchronization", () => {
    const cached = observeTimelineRun(null, { ...existing, hydrated: false });
    const synchronizing = observeTimelineRun(cached.observation, { ...next, hydrated: false });
    expect(synchronizing.anchorMessageId).toBeNull();
    const live = observeTimelineRun(synchronizing.observation, next);
    expect(live.anchorMessageId).toBeNull();
    expect(
      observeTimelineRun(live.observation, {
        ...next,
        runId: RunId.make("later-run"),
        messageId: MessageId.make("later-message"),
      }).anchorMessageId,
    ).toBe("later-message");
  });

  it("waits for a new run's user message and frames it only once", () => {
    const opened = observeTimelineRun(null, existing);
    const waiting = observeTimelineRun(opened.observation, { ...next, messageId: null });
    expect(waiting.anchorMessageId).toBeNull();
    const ready = observeTimelineRun(waiting.observation, next);
    expect(ready.anchorMessageId).toBe(next.messageId);
    expect(observeTimelineRun(ready.observation, next).anchorMessageId).toBeNull();
  });

  it("does not reset the baseline during a temporary loss of projection data", () => {
    const opened = observeTimelineRun(null, existing);
    const reconnecting = observeTimelineRun(opened.observation, {
      ...existing,
      hydrated: false,
      runId: null,
    });
    expect(observeTimelineRun(reconnecting.observation, existing).anchorMessageId).toBeNull();
  });

  it("waits for a queued run to start before framing it", () => {
    const opened = observeTimelineRun(null, { ...existing, queued: true });
    expect(opened.anchorMessageId).toBeNull();
    expect(observeTimelineRun(opened.observation, existing).anchorMessageId).toBe(
      existing.messageId,
    );
  });
});

describe("opening at the newest MCP App card (Lecturn)", () => {
  it("finds the card only when it is the newest content row", () => {
    const card = { id: "item-1:app-card", kind: "mcp-app" };
    expect(timelineNewestAppCardRowId([{ id: "m1", kind: "message" }, card])).toBe(card.id);
    expect(timelineNewestAppCardRowId([card, { id: "meta", kind: "assistant-meta" }])).toBe(
      card.id,
    );
    expect(timelineNewestAppCardRowId([card, { id: "m2", kind: "message" }])).toBeNull();
    expect(timelineNewestAppCardRowId([])).toBeNull();
  });

  it("opens at the card's top as a user-scrolled position, so follow does not pull it back", () => {
    const opening = resolveTimelineOpeningPosition(undefined, "item-1:app-card");
    expect(opening).toMatchObject({
      rowId: "item-1:app-card",
      atEnd: false,
      offsetWithinRow: -TIMELINE_REVEAL_TOP_GAP_PX,
    });
    // Same object across renders, so the opening scroll is not restarted.
    expect(resolveTimelineOpeningPosition(undefined, "item-1:app-card")).toBe(opening);
    const atEnd = { rowId: "m1", offsetWithinRow: 0, scrollOffset: 900, atEnd: true };
    expect(resolveTimelineOpeningPosition(atEnd, "item-1:app-card")).toBe(opening);
  });

  it("keeps a remembered reading position, and the end when there is no card", () => {
    const reading = { rowId: "m1", offsetWithinRow: 40, scrollOffset: 300, atEnd: false };
    expect(resolveTimelineOpeningPosition(reading, "item-1:app-card")).toBe(reading);
    expect(resolveTimelineOpeningPosition(undefined, null)).toBeUndefined();
    const atEnd = { rowId: "m1", offsetWithinRow: 0, scrollOffset: 900, atEnd: true };
    expect(resolveTimelineOpeningPosition(atEnd, null)).toBe(atEnd);
  });
});
