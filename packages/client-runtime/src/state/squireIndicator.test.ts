import { ProviderInstanceId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squireFigureState,
  squireGestureEvents,
  squireIndicatorState,
  type SquireActivityEntry,
} from "./squireIndicator.ts";

function homeShell(status: "running" | "completed" | null, pending: { approval?: boolean } = {}) {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: pending.approval ?? false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: null,
    runtime:
      status === null
        ? null
        : {
            status,
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
  };
}

describe("squireIndicatorState", () => {
  it("works while the home thread has a turn in progress, ahead of open items", () => {
    expect(squireIndicatorState(homeShell("running"), 3, 1)).toEqual({
      state: "working",
      badge: null,
      workingLabel: true,
    });
  });

  it("waits on open decision items, badging only the items", () => {
    expect(squireIndicatorState(homeShell("completed"), 2, 1)).toEqual({
      state: "waiting",
      badge: 2,
      workingLabel: false,
    });
    expect(squireIndicatorState(homeShell("completed"), 0, 1)).toEqual({
      state: "waiting",
      badge: null,
      workingLabel: false,
    });
  });

  it("is idle with nothing running or open, including before the home thread loads", () => {
    const idle = { state: "idle", badge: null, workingLabel: false };
    expect(squireIndicatorState(homeShell("completed"), 0, 0)).toEqual(idle);
    expect(squireIndicatorState(homeShell(null), 0, 0)).toEqual(idle);
    expect(squireIndicatorState(null, 0, 0)).toEqual(idle);
  });

  it("does not call a run blocked on the user working", () => {
    expect(squireIndicatorState(homeShell("running", { approval: true }), 1, 0).state).toBe(
      "waiting",
    );
  });

  it("shows needs_provider over every other state", () => {
    expect(squireIndicatorState(null, 4, 2, "needs_provider")).toEqual({
      state: "needs_provider",
      badge: null,
      workingLabel: false,
    });
    expect(squireIndicatorState(homeShell("running"), 0, 0, "ready").state).toBe("working");
  });
});

describe("squireFigureState", () => {
  it("maps indicator states to figure states", () => {
    expect(squireFigureState("working")).toBe("thinking");
    expect(squireFigureState("waiting")).toBe("attentive");
    expect(squireFigureState("idle")).toBe("idle");
    expect(squireFigureState("needs_provider")).toBe("idle");
  });
});

describe("squireGestureEvents", () => {
  const entry = (sequence: number, kind: string): SquireActivityEntry => ({ sequence, kind });

  it("maps each trigger kind to its gesture and ignores other kinds", () => {
    const log = [
      entry(1, "squire_created"),
      entry(2, "batch_started"),
      entry(3, "voice_note_received"),
      entry(4, "item_accepted"),
      entry(5, "proposed_thread_created"),
      entry(6, "proposed_squire_created"),
      entry(7, "hold_started"),
      entry(8, "item_dismissed"),
    ];
    expect(squireGestureEvents(0, log, false)).toEqual({
      gestures: ["greet", "ponder", "listen", "nod", "flourish", "flourish", "glance"],
      lastSeenSequence: 8,
    });
  });

  it("plays unseen entries in sequence order and each only once", () => {
    const log = [entry(12, "hold_started"), entry(11, "item_accepted"), entry(10, "batch_started")];
    const first = squireGestureEvents(10, log, false);
    expect(first).toEqual({ gestures: ["nod", "glance"], lastSeenSequence: 12 });

    const again = squireGestureEvents(first.lastSeenSequence, log, false);
    expect(again).toEqual({ gestures: [], lastSeenSequence: 12 });

    const next = squireGestureEvents(12, [...log, entry(13, "voice_note_received")], false);
    expect(next.gestures).toEqual(["listen"]);
  });

  it("skips entries at or below the last seen sequence after a reconnect", () => {
    const resent = [entry(4, "item_accepted"), entry(5, "batch_started"), entry(6, "hold_started")];
    expect(squireGestureEvents(5, resent, false)).toEqual({
      gestures: ["glance"],
      lastSeenSequence: 6,
    });
  });

  it("treats the log as history when nothing has been seen yet", () => {
    expect(squireGestureEvents(null, [entry(3, "item_accepted")], false)).toEqual({
      gestures: [],
      lastSeenSequence: 3,
    });
    expect(squireGestureEvents(null, [], false)).toEqual({ gestures: [], lastSeenSequence: null });
  });

  it("greets once on the session's first open, folding in a creation greet", () => {
    expect(squireGestureEvents(null, [entry(1, "squire_created")], true).gestures).toEqual([
      "greet",
    ]);
    expect(
      squireGestureEvents(0, [entry(1, "squire_created"), entry(2, "batch_started")], true)
        .gestures,
    ).toEqual(["greet", "ponder"]);
    expect(squireGestureEvents(2, [entry(1, "squire_created")], false).gestures).toEqual([]);
  });
});
