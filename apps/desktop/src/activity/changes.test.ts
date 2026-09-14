import type { DesktopActivityRow } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import { activityChanges, ActivityChangeTracker } from "./changes.ts";

const row = (patch: Partial<DesktopActivityRow> = {}): DesktopActivityRow => ({
  id: "thread-1",
  environmentId: "local",
  projectId: "project",
  threadId: "thread",
  title: "Fix the tests",
  subtitle: "Model",
  status: "Idle",
  actions: [],
  ...patch,
});
const pr = (checks: DesktopActivityRow["checks"], patch: Partial<DesktopActivityRow> = {}) =>
  row({ id: "pr-1", watchId: "watch-1", status: "Watching", checks: checks ?? [], ...patch });

describe("semantic activity changes", () => {
  it("never alerts on initial baseline but alerts on new active work after an observed empty panel", () => {
    const running = row({ status: "Working" });
    expect(activityChanges(undefined, [running])).toBeUndefined();
    expect(activityChanges(null, [running])).toBeUndefined();
    expect(activityChanges([], [running])).toMatchObject({ rowId: running.id, state: "active" });
    expect(activityChanges([], [row(), row({ id: "settled", status: "Settled" })])).toBeUndefined();
  });
  it("ignores streamed prose, metadata, actions, ordering and removal", () => {
    const first = row({ status: "Working" });
    const second = row({ id: "second" });
    expect(
      activityChanges(
        [first, second],
        [
          second,
          {
            ...first,
            excerpt: "New streamed words",
            detail: "Updated just now",
            projectLabel: "Renamed",
            subtitle: "New model",
            actions: [{ id: "open", label: "Open" }],
          },
        ],
      ),
    ).toBeUndefined();
    expect(activityChanges([first, second], [second])).toBeUndefined();
  });
  it("ignores entering and leaving temporary send/update states", () => {
    for (const status of ["Sending instruction…", "Updating watch…", "Pending…"]) {
      const temporary = row({ status, visualState: "active" });
      expect(activityChanges([row()], [temporary])).toBeUndefined();
      expect(activityChanges([temporary], [row()])).toBeUndefined();
    }
  });
  it("surfaces action failures and input requests after a temporary acknowledgement", () => {
    const sending = row({ status: "Sending instruction…", visualState: "active" });
    expect(activityChanges([sending], [row({ status: "Action failed" })])).toMatchObject({
      rowId: "thread-1",
      state: "failed",
    });
    expect(activityChanges([sending], [row({ status: "Needs input" })])).toMatchObject({
      rowId: "thread-1",
      state: "attention",
    });
    // Existing failing CI may keep the aggregate red during send; the failed
    // handoff still needs a new alert once the temporary sending state ends.
    expect(
      activityChanges(
        [{ ...sending, visualState: "failed" }],
        [row({ status: "Action failed", visualState: "failed" })],
      ),
    ).toMatchObject({ state: "failed" });
  });
  it("detects semantic state from explicit state or shared fallback", () => {
    expect(
      activityChanges([row({ status: "Working" })], [row({ status: "Needs approval" })]),
    ).toMatchObject({ state: "attention" });
    expect(
      activityChanges([row({ visualState: "active" })], [row({ visualState: "complete" })]),
    ).toMatchObject({ state: "complete" });
  });
  it("announces a job completion even while other jobs keep the PR active", () => {
    const before = pr([
      { name: "Web", status: "pending" },
      { name: "Server", status: "pending" },
    ]);
    const after = pr([
      { name: "Server", status: "pending" },
      { name: "Web", status: "success" },
    ]);
    expect(activityChanges([before], [after])).toEqual({
      rowId: "pr-1",
      state: "complete",
      label: "Web passed",
    });
  });
  it("compares duplicated job names as multisets and ignores description or order changes", () => {
    const before = pr([
      { name: "Tests", status: "pending" },
      { name: "Tests", status: "success" },
    ]);
    const after = pr([
      { name: "Tests", status: "success", description: "Updated" },
      { name: "Tests", status: "pending" },
    ]);
    expect(activityChanges([before], [after])).toBeUndefined();
  });
  it("does not announce catch-up completions and does not call cancellation a success", () => {
    expect(
      activityChanges([pr([])], [pr([{ name: "Old job", status: "success" }])]),
    ).toBeUndefined();
    expect(
      activityChanges(
        [pr([{ name: "Tests", status: "pending" }])],
        [pr([{ name: "Tests", status: "cancelled" }])],
      ),
    ).toEqual({ rowId: "pr-1", state: "idle", label: "Tests cancelled" });
  });
  it("selects one urgent change ahead of completed jobs or newly active work", () => {
    const before = pr([
      { name: "Web", status: "pending" },
      { name: "Server", status: "pending" },
    ]);
    const after = pr([
      { name: "Web", status: "success" },
      { name: "Server", status: "failure" },
    ]);
    expect(activityChanges([before], [row({ status: "Working" }), after])).toMatchObject({
      rowId: "pr-1",
      state: "failed",
    });
    expect(activityChanges([before, row()], [after, row({ status: "Needs input" })])).toMatchObject(
      { rowId: "thread-1", state: "attention" },
    );
  });
});

describe("user-origin activity correlation", () => {
  const promptAt = "2026-09-14T18:00:00.000Z";
  it("suppresses a delayed start once, then allows completion and autonomous resumption", () => {
    const tracker = new ActivityChangeTracker();
    tracker.update([row()]);
    expect(tracker.update([row({ userPromptAt: promptAt })])).toBeUndefined();
    expect(tracker.update([row({ userPromptAt: promptAt, status: "Starting" })])).toBeUndefined();
    expect(tracker.update([row({ userPromptAt: promptAt, status: "Working" })])).toBeUndefined();
    expect(tracker.update([row({ userPromptAt: promptAt, status: "Idle" })])).toMatchObject({
      state: "idle",
    });
    expect(tracker.update([row({ userPromptAt: promptAt, status: "Working" })])).toMatchObject({
      state: "active",
    });
  });
  it("suppresses direct prompt additions while leaving unrelated automatic activity observable", () => {
    const tracker = new ActivityChangeTracker();
    tracker.update([]);
    expect(tracker.update([row({ userPromptAt: promptAt, status: "Working" })])).toBeUndefined();
    expect(
      tracker.update([
        row({ userPromptAt: promptAt, status: "Working" }),
        row({ id: "automatic", threadId: "other", status: "Working" }),
      ]),
    ).toMatchObject({ rowId: "automatic", state: "active" });
  });
  it("seeds old prompt tokens at startup rather than suppressing future automatic starts", () => {
    const tracker = new ActivityChangeTracker();
    tracker.update([row({ userPromptAt: promptAt })]);
    expect(tracker.update([row({ userPromptAt: promptAt, status: "Working" })])).toMatchObject({
      state: "active",
    });
  });
  it("suppresses manual settle/stop but preserves later failures and completion", () => {
    const tracker = new ActivityChangeTracker();
    tracker.update([row({ status: "Working" })]);
    expect(tracker.update([row({ status: "Stopped", userStopped: true })])).toBeUndefined();
    expect(
      tracker.update([row({ status: "Settled", userStopped: true, userSettled: true })]),
    ).toBeUndefined();
    expect(
      tracker.update([row({ status: "Action failed", userStopped: true, userSettled: true })]),
    ).toMatchObject({ state: "failed" });
    expect(
      tracker.update([row({ status: "Completed", userStopped: true, userSettled: true })]),
    ).toMatchObject({ state: "complete" });
  });
  it("preserves PR check changes during a correlated user prompt", () => {
    const tracker = new ActivityChangeTracker();
    const before = pr([{ name: "Tests", status: "pending" }]);
    tracker.update([row(), before]);
    expect(
      tracker.update([
        row({ userPromptAt: promptAt, status: "Working" }),
        pr([{ name: "Tests", status: "success" }], { userPromptAt: promptAt }),
      ]),
    ).toMatchObject({ rowId: "pr-1", state: "complete", label: "Tests passed" });
  });
  it("does not hide approval or failure after a prompt without a visible active phase", () => {
    const tracker = new ActivityChangeTracker();
    tracker.update([row()]);
    tracker.update([row({ userPromptAt: promptAt })]);
    expect(
      tracker.update([row({ userPromptAt: promptAt, status: "Needs approval" })]),
    ).toMatchObject({ state: "attention" });
    expect(tracker.update([row({ userPromptAt: promptAt, status: "Working" })])).toMatchObject({
      state: "active",
    });
  });
});

describe("explicit local activity intents", () => {
  it("waits past same-state intent publication and consumes the matching stop transition once", () => {
    const tracker = new ActivityChangeTracker();
    const action = { id: "stop-1", kind: "stop" as const, at: 1_000 };
    tracker.update([row({ status: "Working" })], 900);
    expect(tracker.update([row({ status: "Working", userAction: action })], 1_000)).toBeUndefined();
    expect(tracker.update([row({ status: "Idle", userAction: action })], 1_100)).toBeUndefined();
    expect(tracker.update([row({ status: "Working", userAction: action })], 1_200)).toMatchObject({
      state: "active",
    });
    expect(tracker.update([row({ status: "Idle", userAction: action })], 1_300)).toMatchObject({
      state: "idle",
    });
  });
  it("suppresses both thread and manager PR visual outcomes while retaining CI changes", () => {
    const tracker = new ActivityChangeTracker();
    tracker.update([row(), pr([], { status: "Idle" })], 900);
    const action = { id: "start-1", kind: "start" as const, at: 1_000 };
    expect(
      tracker.update(
        [
          row({ status: "Working", userAction: action }),
          pr([], { status: "Working", userAction: action }),
        ],
        1_000,
      ),
    ).toBeUndefined();
    expect(
      tracker.update(
        [
          row({ status: "Working", userAction: action }),
          pr([{ name: "Tests", status: "failure" }], { status: "Working", userAction: action }),
        ],
        1_100,
      ),
    ).toMatchObject({ state: "failed" });
  });
  it("expires unmatched intents without muting failures or other threads", () => {
    const tracker = new ActivityChangeTracker();
    const action = { id: "start-1", kind: "start" as const, at: 1_000 };
    tracker.update([row()], 900);
    tracker.update([row({ userAction: action })], 1_000);
    expect(tracker.update([row({ status: "Working", userAction: action })], 31_001)).toMatchObject({
      state: "active",
    });
    const stop = { id: "stop-1", kind: "stop" as const, at: 32_000 };
    expect(
      tracker.update([row({ status: "Action failed", userAction: stop })], 32_000),
    ).toMatchObject({ state: "failed" });
  });
  it("matches settle and unsettle outcomes without suppressing later automatic completion", () => {
    const tracker = new ActivityChangeTracker();
    tracker.update([row()], 900);
    const settle = { id: "settle", kind: "settle" as const, at: 1_000 };
    expect(tracker.update([row({ status: "Settled", userAction: settle })], 1_000)).toBeUndefined();
    const unsettle = { id: "unsettle", kind: "unsettle" as const, at: 1_100 };
    expect(tracker.update([row({ status: "Idle", userAction: unsettle })], 1_100)).toBeUndefined();
    expect(
      tracker.update([row({ status: "Completed", userAction: unsettle })], 1_200),
    ).toMatchObject({ state: "complete" });
  });
});

it("does not reopen an old blocker after sending its answer, but surfaces new blockers and failed sends", () => {
  const tracker = new ActivityChangeTracker();
  const start = { id: "answer", kind: "start" as const, at: 1_000 };
  tracker.update([row({ status: "Needs input" })], 900);
  expect(
    tracker.update([row({ status: "Sending instruction…", userAction: start })], 1_000),
  ).toBeUndefined();
  expect(
    tracker.update([row({ status: "Needs input", userAction: start })], 1_100),
  ).toBeUndefined();
  expect(tracker.update([row({ status: "Working", userAction: start })], 1_200)).toBeUndefined();
  expect(tracker.update([row({ status: "Needs input", userAction: start })], 1_300)).toMatchObject({
    state: "attention",
  });
  const retry = { id: "retry", kind: "start" as const, at: 2_000 };
  tracker.update([row({ status: "Sending instruction…", userAction: retry })], 2_000);
  expect(
    tracker.update(
      [row({ status: "Action failed", visualState: "attention", userAction: retry })],
      2_100,
    ),
  ).toMatchObject({ state: "attention" });
});

it("clears a cancelled producer intent instead of muting unrelated later work", () => {
  const tracker = new ActivityChangeTracker();
  tracker.update([row()], 900);
  tracker.update([row({ userAction: { id: "failed-submit", kind: "start", at: 1_000 } })], 1_000);
  tracker.update([row()], 1_100);
  expect(tracker.update([row({ status: "Working" })], 1_200)).toMatchObject({ state: "active" });
});
