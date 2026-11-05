import { RunId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { groupSquireUpdates } from "./ThreadFeed.logic";

const run = (id: string) => RunId.make(id);

function activity(
  id: string,
  runId: string,
  item: Record<string, unknown>,
  lifecycleStatus = "completed",
): ThreadFeedEntry {
  return {
    type: "activity-group",
    id,
    createdAt: "2026-11-05T00:00:00.000Z",
    runId: run(runId),
    activities: [{ id, lifecycleStatus, projectedItem: { item } }],
  } as unknown as ThreadFeedEntry;
}

const wake = (id: string, runId: string, eventKinds: ReadonlyArray<string>) =>
  activity(id, runId, {
    type: "notification",
    status: "completed",
    source: { kind: "squire", squireId: "squire-1", eventCount: 1, eventKinds },
  });

function message(
  id: string,
  runId: string,
  role: "user" | "assistant",
  createdBy?: "user" | "agent",
): ThreadFeedEntry {
  return {
    type: "message",
    id,
    createdAt: "2026-11-05T00:00:00.000Z",
    message: { id, role, runId: run(runId), streaming: false, createdBy },
  } as unknown as ThreadFeedEntry;
}

const ids = (rows: ReadonlyArray<ThreadFeedEntry>) => rows.map((row) => row.id);

describe("groupSquireUpdates", () => {
  const feed = [
    message("ask", "r0", "user", "user"),
    message("answer", "r0", "assistant"),
    wake("wake-1", "r1", ["pr-failed"]),
    activity("tool-1", "r1", { type: "command_execution", status: "completed" }),
    message("reply-1", "r1", "assistant"),
    wake("wake-2", "r2", ["pr-failed", "turn-completed"]),
    message("server-note", "r2", "user", "agent"),
    message("reply-2", "r2", "assistant"),
    message("follow-up", "r3", "user", "user"),
    wake("wake-3", "r4", ["message"]),
    message("reply-3", "r4", "assistant"),
  ];

  it("folds consecutive wakes and their output behind one collapsed row", () => {
    const rows = groupSquireUpdates(feed, null, new Set());
    expect(ids(rows)).toEqual([
      "ask",
      "answer",
      "squire-updates:wake-1",
      "follow-up",
      "wake-3",
      "reply-3",
    ]);
    expect(rows[2]).toMatchObject({
      type: "squire-updates",
      label: "2 Squire updates · pr failed, turn completed",
      expanded: false,
    });
  });

  it("shows the run's rows under the summary row once expanded", () => {
    const rows = groupSquireUpdates(feed, null, new Set(["squire-updates:wake-1"]));
    expect(ids(rows)).toEqual([
      "ask",
      "answer",
      "squire-updates:wake-1",
      ...ids(feed.slice(2, 8)),
      "follow-up",
      "wake-3",
      "reply-3",
    ]);
  });

  it("keeps a wake still being worked visible, along with the wake it would have joined", () => {
    expect(groupSquireUpdates(feed.slice(0, 8), run("r2"), new Set())).toEqual(feed.slice(0, 8));
  });

  it("leaves a pending question visible and ends the run there", () => {
    const question = activity(
      "question",
      "r1",
      { type: "user_input_request", status: "pending" },
      "inProgress",
    );
    const rows = groupSquireUpdates(
      [...feed.slice(2, 5), question, ...feed.slice(5)],
      null,
      new Set(),
    );
    expect(ids(rows)).toEqual(ids([...feed.slice(2, 5), question, ...feed.slice(5)]));
  });

  it("never folds the newest wake, so its reply stays in view", () => {
    const latest = feed.slice(0, 8);
    expect(groupSquireUpdates(latest, null, new Set())).toBe(latest);
  });

  it("returns the feed untouched when no two wakes run together", () => {
    const lone = [wake("wake-1", "r1", []), message("reply-1", "r1", "assistant")];
    expect(groupSquireUpdates(lone, null, new Set())).toBe(lone);
  });
});
