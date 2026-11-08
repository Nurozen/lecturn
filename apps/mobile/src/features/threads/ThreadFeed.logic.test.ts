import { RunId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  groupSquireUpdates,
  hideSquireQuietText,
  insertUnreadDivider,
  mergeSquireApprovals,
  squireQuietRunIds,
  threadUnreadAnchor,
} from "./ThreadFeed.logic";

const run = (id: string) => RunId.make(id);

function activity(
  id: string,
  runId: string,
  item: Record<string, unknown>,
  lifecycleStatus = "completed",
  workEntry: Record<string, unknown> = {},
): ThreadFeedEntry {
  return {
    type: "activity-group",
    id,
    createdAt: "2026-11-05T00:00:00.000Z",
    runId: run(runId),
    activities: [{ id, lifecycleStatus, workEntry, projectedItem: { item } }],
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
    message: {
      id,
      role,
      runId: run(runId),
      streaming: false,
      createdBy,
      createdAt: "2026-11-05T00:00:00.000Z",
    },
  } as unknown as ThreadFeedEntry;
}

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

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

  it("drops quiet spans and keeps every message a Squire wrote", () => {
    expect(ids(groupSquireUpdates(feed, null))).toEqual([
      "ask",
      "answer",
      "reply-1",
      "reply-2",
      "follow-up",
      "reply-3",
    ]);
  });

  it("drops a lone quiet wake, with no row in its place", () => {
    const quiet = [message("ask", "r0", "user", "user"), wake("wake-1", "r1", [])];
    expect(ids(groupSquireUpdates(quiet, null))).toEqual(["ask"]);
  });

  it("keeps a wake still being worked visible", () => {
    expect(ids(groupSquireUpdates(feed.slice(0, 8), run("r2")))).toEqual([
      "ask",
      "answer",
      "reply-1",
      "wake-2",
      "server-note",
      "reply-2",
    ]);
  });

  it("leaves a pending question visible and ends the span there", () => {
    const question = activity(
      "question",
      "r1",
      { type: "user_input_request", status: "pending" },
      "inProgress",
    );
    expect(ids(groupSquireUpdates([...feed.slice(2, 4), question], null))).toEqual(["question"]);
  });

  it("keeps a failed run's error and an answered question out of the span", () => {
    const span = (row: ThreadFeedEntry) => [wake("wake-1", "r1", []), row];
    const failure = { class: "provider" };
    const failed = activity("failed", "r1", { type: "error", status: "failed", failure });
    expect(ids(groupSquireUpdates(span(failed), null))).toEqual(["failed"]);
    const answered = activity("answered", "r1", { type: "user_input_request" }, "completed", {
      questionAnswer: { requestId: "request-1" },
    });
    expect(ids(groupSquireUpdates(span(answered), null))).toEqual(["answered"]);
  });

  it("folds a retrying error and a usage-limit warning, as web does", () => {
    const span = (row: ThreadFeedEntry) => [wake("wake-1", "r1", []), row];
    const retrying = activity("retrying", "r1", {
      type: "error",
      status: "running",
      failure: { class: "provider" },
      retry: { attempt: 1 },
    });
    expect(ids(groupSquireUpdates(span(retrying), null))).toEqual([]);
    const limited = activity("limited", "r1", {
      type: "error",
      status: "failed",
      failure: { class: "usage_limit" },
    });
    expect(ids(groupSquireUpdates(span(limited), null))).toEqual([]);
  });

  it("returns the feed untouched when no wake is in it", () => {
    const plain = [message("ask", "r0", "user", "user"), message("reply", "r0", "assistant")];
    expect(groupSquireUpdates(plain, null)).toBe(plain);
  });
});

describe("runs that stayed quiet", () => {
  const quietTool = activity("quiet", "r1", {
    type: "dynamic_tool",
    status: "completed",
    toolName: "mcp__lecturn__squire_stay_quiet",
  });

  it("hides that run's text, and only that run's", () => {
    const feed = [
      message("said", "r0", "assistant"),
      quietTool,
      message("hushed", "r1", "assistant"),
    ];
    const quiet = squireQuietRunIds(feed);
    expect([...quiet]).toEqual([run("r1")]);
    expect(ids(hideSquireQuietText(feed, quiet))).toEqual(["said", "quiet"]);
  });

  it("returns the rows untouched when no run stayed quiet", () => {
    const feed = [message("said", "r0", "assistant")];
    expect(hideSquireQuietText(feed, squireQuietRunIds(feed))).toBe(feed);
  });
});

const at = (seconds: number) => `2026-11-05T00:00:${String(seconds).padStart(2, "0")}.000Z`;

function timed(entry: ThreadFeedEntry, seconds: number): ThreadFeedEntry {
  const createdAt = at(seconds);
  return entry.type === "message"
    ? { ...entry, createdAt, message: { ...entry.message, createdAt } }
    : { ...entry, createdAt };
}

function approval(id: string, seconds: number, phase = "closed") {
  return { row: { id }, createdAt: at(seconds), phase } as unknown as Parameters<
    typeof mergeSquireApprovals
  >[1][number];
}

describe("mergeSquireApprovals", () => {
  const rows = [
    timed(message("a", "r0", "assistant"), 10),
    timed(message("b", "r0", "assistant"), 30),
  ];

  it("places each approval where it was raised", () => {
    expect(ids(mergeSquireApprovals(rows, [approval("x", 20)], false))).toEqual([
      "a",
      "squire-approval:x",
      "b",
    ]);
    expect(ids(mergeSquireApprovals(rows, [approval("late", 40)], false))).toEqual([
      "a",
      "b",
      "squire-approval:late",
    ]);
  });

  it("keeps the working row last", () => {
    const thinking = {
      type: "thinking",
      id: "t",
      createdAt: at(5),
      runId: null,
    } as ThreadFeedEntry;
    expect(ids(mergeSquireApprovals([...rows, thinking], [approval("x", 40)], false))).toEqual([
      "a",
      "b",
      "squire-approval:x",
      "t",
    ]);
  });

  it("shows a row still waiting on the user even before its history loads", () => {
    expect(ids(mergeSquireApprovals(rows, [approval("open", 5, "open")], true))).toEqual([
      "squire-approval:open",
      "a",
      "b",
    ]);
    expect(ids(mergeSquireApprovals(rows, [approval("sending", 5, "sending")], true))).toEqual([
      "squire-approval:sending",
      "a",
      "b",
    ]);
  });

  it("holds a closed approval older than the loaded history until it loads", () => {
    expect(ids(mergeSquireApprovals(rows, [approval("old", 5)], true))).toEqual(["a", "b"]);
    expect(ids(mergeSquireApprovals(rows, [approval("old", 5)], false))).toEqual([
      "squire-approval:old",
      "a",
      "b",
    ]);
  });

  it("returns the rows untouched with no approvals", () => {
    expect(mergeSquireApprovals(rows, [], false)).toBe(rows);
  });
});

describe("the unread divider", () => {
  const feed = [
    timed(message("seen", "r0", "assistant"), 10),
    timed(message("mine", "r1", "user", "user"), 20),
    timed(message("first-new", "r1", "assistant"), 30),
    timed(message("second-new", "r1", "assistant"), 40),
  ];
  const window = { lastVisitedAt: at(15), openedThrough: at(50) };
  const none = new Set<ReturnType<typeof run>>();

  it("anchors to the first non-user message since the last view", () => {
    expect(threadUnreadAnchor(feed, window, none)).toEqual({ id: "first-new", createdAt: at(30) });
  });

  it("skips text a quiet run hid", () => {
    expect(threadUnreadAnchor(feed, window, new Set([run("r1")]))).toBeNull();
  });

  it("shows nothing on a first visit or an old server", () => {
    expect(threadUnreadAnchor(feed, null, none)).toBeNull();
    expect(threadUnreadAnchor(feed, { ...window, lastVisitedAt: null }, none)).toBeNull();
  });

  it("does not move for messages that arrive during this open", () => {
    expect(threadUnreadAnchor(feed, { ...window, openedThrough: at(25) }, none)).toBeNull();
  });

  it("sits above the anchor's row, or the next row when a fold hides it", () => {
    const anchor = { id: "first-new", createdAt: at(30) };
    expect(ids(insertUnreadDivider(feed, anchor))).toEqual([
      "seen",
      "mine",
      "unread-divider",
      "first-new",
      "second-new",
    ]);
    const folded = feed.filter((row) => row.id !== "first-new");
    expect(ids(insertUnreadDivider(folded, anchor))).toEqual([
      "seen",
      "mine",
      "unread-divider",
      "second-new",
    ]);
    expect(insertUnreadDivider(feed, null)).toBe(feed);
  });
});
