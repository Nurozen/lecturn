import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import {
  RunId,
  SquireId,
  SquireSnapshot,
  type SquireActionLogKind,
  type SquireRule,
  type ThreadId,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SQUIRE_ACTIVITY_KINDS,
  squireActivityLabel,
  squireBudgetBanner,
  squireConversationPane,
  squireHoldCountdown,
  squireHoldRuleLabel,
  squireHoldText,
  squirePageState,
  squireRecentEntries,
  squireRecentRowText,
  squireRecentFromSnapshot,
  squireRecentLabel,
  squireSwitchDescription,
} from "./squirePage.logic";

const at = "2026-11-01T10:00:00.000Z";
const decodeSnapshot = Schema.decodeUnknownSync(SquireSnapshot);

const entry = (
  id: string,
  overrides: {
    role?: "lead" | "squire";
    lifecycle?: string;
    homeThreadId?: string | null;
    budget?: { steersLeft: number; threadsLeft: number; recommendingUntil?: string };
  } = {},
): SquireSnapshotEntry => ({
  ...decodeSnapshot({
    squire: {
      id,
      role: overrides.role ?? "squire",
      name: id,
      lifecycle: overrides.lifecycle ?? "ready",
      status: "active",
      homeProjectId: "project-a",
      homeThreadId: overrides.homeThreadId === undefined ? `thread-${id}` : overrides.homeThreadId,
      providerInstanceId: null,
      modelSelection: null,
      summaryModelSelection: null,
      brief: "",
      grants: [],
      undoWindowSeconds: 10,
      digest: null,
      sweep: null,
      onboardedAt: null,
      automationPausedAt: null,
      revision: 0,
      createdAt: at,
      updatedAt: at,
    },
    openDecisionCount: 0,
    countsByKind: { steer: 0, question: 0, overlap: 0, proposal: 0, fyi: 0 },
    held: [],
    budget: overrides.budget ?? { steersLeft: 7, threadsLeft: 3 },
    conflicts: [],
    trackedCount: 2,
    containerNames: [],
    recentActivity: [],
    itemsRevision: 0,
    decisionRevision: 0,
  }),
  receivedAt: 0,
});

describe("squirePageState", () => {
  const lead = entry("lead", { role: "lead" });
  const release = entry("release");
  const state = { lead: lead.squire.id, squires: [lead, release], rooms: [] };

  it("waits for the server config and the snapshot instead of reading as unavailable", () => {
    expect(squirePageState(null, null, release.squire.id).status).toBe("loading");
    expect(squirePageState(true, null, release.squire.id).status).toBe("loading");
  });

  it("is unavailable with the capability off or for an unknown Squire", () => {
    expect(squirePageState(false, state, release.squire.id).status).toBe("unavailable");
    expect(squirePageState(true, state, SquireId.make("gone")).status).toBe("unavailable");
  });

  it("marks the Lead", () => {
    expect(squirePageState(true, state, lead.squire.id)).toMatchObject({
      status: "ready",
      isLead: true,
    });
    expect(squirePageState(true, state, release.squire.id)).toMatchObject({
      status: "ready",
      isLead: false,
    });
  });
});

describe("Activity", () => {
  it("lists only outcomes without a home-thread row", () => {
    expect([...SQUIRE_ACTIVITY_KINDS].sort()).toEqual(
      [
        "action.cancelled",
        "action.executed",
        "action.undone",
        "notification.delivery",
        "room.closed",
        "room.opened",
        "room.proposed",
        "room.reopened",
        "room.rerouted",
        "room.routed",
        "room.routing-fallback",
        "trigger.rate-limited",
        "trigger.received",
        "trigger.rejected",
      ].sort(),
    );
  });

  it("leaves out what the thread already shows as its own rows", () => {
    const threadRows: ReadonlyArray<SquireActionLogKind> = [
      "event.received",
      "tool.called",
      "card.created",
      "action.held",
      "message.sent",
      "unknown",
    ];
    for (const kind of threadRows) expect(SQUIRE_ACTIVITY_KINDS).not.toContain(kind);
  });

  it("names executed actions by what they did and room kinds by their area", () => {
    expect(squireActivityLabel({ kind: "action.executed", data: { action: "steer" } })).toBe(
      "Sent a steer",
    );
    expect(
      squireActivityLabel({
        kind: "action.cancelled",
        data: { reason: "user_turn", to: "outdated" },
      }),
    ).toBe("Held action outdated");
    expect(
      squireActivityLabel({ kind: "notification.delivery", data: { outcome: "no_transport" } }),
    ).toBe("Notification: no transport");
    expect(squireActivityLabel({ kind: "room.routing-fallback", data: {} })).toBe(
      "Room routing fallback",
    );
  });
});

describe("Recent list labels", () => {
  const noNames = { threadTitle: null, cardTitle: null };

  it("says what the Squire did, naming the thread or card when known", () => {
    const steer = { kind: "action.executed", data: { action: "steer" } } as const;
    expect(squireRecentLabel(steer, { threadTitle: "Fix invoice rounding", cardTitle: null })).toBe(
      "Sent a steer to Fix invoice rounding",
    );
    expect(squireRecentLabel(steer, noNames)).toBe("Sent a steer");
    const raised = { kind: "card.created", data: { kind: "question" } } as const;
    expect(squireRecentLabel(raised, { threadTitle: null, cardTitle: "Ship offline-only?" })).toBe(
      "Raised: Ship offline-only?",
    );
    expect(squireRecentLabel(raised, noNames)).toBe("Raised a question");
    expect(squireRecentLabel({ kind: "card.created", data: { kind: "proposal" } }, noNames)).toBe(
      "Proposed a thread",
    );
    const squireProposal = {
      kind: "card.created",
      data: { kind: "proposal", proposal: "squire" },
    } as const;
    expect(
      squireRecentLabel(squireProposal, { threadTitle: null, cardTitle: "New Squire: Release" }),
    ).toBe("Proposed a Squire: Release");
    expect(squireRecentLabel(squireProposal, noNames)).toBe("Proposed a Squire");
    expect(
      squireRecentLabel(
        { kind: "card.created", data: { kind: "proposal", proposal: "squire", name: "Research" } },
        noNames,
      ),
    ).toBe("Proposed a Squire: Research");
    expect(
      squireRecentLabel(
        { kind: "card.created", data: { kind: "proposal", room: "open" } },
        { threadTitle: null, cardTitle: "Open a room" },
      ),
    ).toBe("Proposed a room");
    expect(
      squireRecentLabel({ kind: "card.created", data: { kind: "fyi", source: "notify" } }, noNames),
    ).toBe("Notified you");
    expect(squireRecentLabel({ kind: "event.received", data: { batchId: "b" } }, noNames)).toBe(
      "Event batch received",
    );
    expect(squireRecentLabel({ kind: "quiet.recorded", data: {} }, noNames)).toBe("Stayed quiet");
    const read = { kind: "tool.called", data: { tool: "squire_get_summary" } } as const;
    expect(squireRecentLabel(read, { threadTitle: "Fix invoice rounding", cardTitle: null })).toBe(
      "Looked at Fix invoice rounding",
    );
    expect(squireRecentLabel(read, noNames)).toBe("Looked at a thread");
  });

  it("hides rows that only accompany another row", () => {
    for (const kind of ["decision.recorded", "notification.pushed", "unknown"] as const) {
      expect(squireRecentLabel({ kind, data: {} }, noNames)).toBeNull();
    }
    // The steer's own card or execution row says what the call did; list lookups name nothing.
    for (const tool of ["squire_send_steer", "squire_list_items", "squire_list_tracked"]) {
      expect(squireRecentLabel({ kind: "tool.called", data: { tool } }, noNames)).toBeNull();
    }
  });
});

describe("Recent list rows", () => {
  const log = (
    id: number,
    kind: SquireActionLogKind,
    data: Record<string, unknown> = {},
    runId: string | null = null,
  ) => ({
    id,
    kind,
    data,
    threadId: null,
    cardId: null,
    runId: runId === null ? null : RunId.make(runId),
    createdAt: `2026-11-01T10:${String(id).padStart(2, "0")}:00.000Z`,
  });

  it("lists outcomes newest first, one row per batch and per turn's thread reads", () => {
    const rows = squireRecentEntries(
      [
        log(1, "event.received", { batchId: "b1" }),
        log(2, "event.received", { batchId: "b1" }),
        log(3, "tool.called", { tool: "squire_recommend_steer" }, "run-1"),
        log(4, "decision.recorded", {}, "run-1"),
        log(5, "card.created", { kind: "steer" }, "run-1"),
        log(6, "notification.pushed", { source: "card" }, "run-1"),
        log(7, "tool.called", { tool: "squire_get_summary" }, "run-2"),
        log(8, "tool.called", { tool: "squire_get_detail" }, "run-2"),
        log(9, "tool.called", { tool: "squire_list_items" }, "run-3"),
      ],
      10,
    );
    expect(rows.map((row) => [row.key, row.kind])).toEqual([
      ["8", "tool.called"],
      ["5", "card.created"],
      ["2", "event.received"],
    ]);
    expect(squireRecentEntries([])).toEqual([]);
  });

  it("folds identical consecutive actions into one row with a count", () => {
    const steer = (id: number, threadId: string) => ({
      ...log(id, "action.executed", { action: "steer" }),
      threadId: threadId as ThreadId,
    });
    const rows = squireRecentEntries([
      steer(1, "fix"),
      steer(2, "fix"),
      steer(3, "other"),
      steer(4, "fix"),
    ]);
    expect(rows.map((row) => [row.key, row.count ?? 1])).toEqual([
      ["4", 1],
      ["3", 1],
      ["2", 2],
    ]);
    expect(squireRecentRowText("Sent a steer to Fix invoice rounding", 2)).toBe(
      "Sent a steer to Fix invoice rounding ×2",
    );
    expect(squireRecentRowText("Stayed quiet", undefined)).toBe("Stayed quiet");
  });

  it("caps the list after folding", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...log(index + 1, "quiet.recorded"),
      threadId: `thread-${index}` as ThreadId,
    }));
    expect(squireRecentEntries(many).map((row) => row.key)).toEqual(["9", "8", "7", "6"]);
  });

  it("falls back to the snapshot's kinds, one row per batch", () => {
    const rows = squireRecentFromSnapshot([
      { sequence: 1, kind: "event.received", at, gesture: "ponder" },
      { sequence: 2, kind: "event.received", at },
      { sequence: 3, kind: "decision.recorded", at },
      { sequence: 4, kind: "card.created", at },
    ]);
    expect(
      rows.map((row) => [row.key, squireRecentLabel(row, { threadTitle: null, cardTitle: null })]),
    ).toEqual([
      ["4", "Raised a card"],
      ["1", "Event batch received"],
    ]);
  });
});

describe("hold countdown", () => {
  it("counts whole seconds from local receipt and re-renders on each second boundary", () => {
    expect(squireHoldCountdown(1_000, 10_000, 1_000)).toEqual({
      seconds: 10,
      nextChangeInMs: 1_000,
    });
    expect(squireHoldCountdown(1_000, 10_000, 2_500)).toEqual({ seconds: 9, nextChangeInMs: 500 });
  });

  it("stops ticking once the hold runs out", () => {
    expect(squireHoldCountdown(1_000, 10_000, 11_000)).toEqual({
      seconds: 0,
      nextChangeInMs: null,
    });
    expect(squireHoldCountdown(1_000, 10_000, 60_000).nextChangeInMs).toBeNull();
  });

  it("never shows more than the server's remaining time when the local clock is behind", () => {
    expect(squireHoldCountdown(5_000, 4_000, 0).seconds).toBe(4);
  });

  it("says what the hold will do and when", () => {
    expect(squireHoldText("steer", "Fix CI", 8)).toBe("Sending a steer to Fix CI in 8s");
    expect(squireHoldText("proposal", "ignored", 0)).toBe("Creating a thread now");
  });
});

describe("squireBudgetBanner", () => {
  const formatTime = (iso: string) => `T(${iso})`;
  const until = "2026-11-01T15:40:00.000Z";

  it("is absent while every budget has room", () => {
    expect(squireBudgetBanner(entry("release"), formatTime)).toBeNull();
  });

  it("names the time recommending ends and the budget that ran out", () => {
    expect(
      squireBudgetBanner(
        entry("release", { budget: { steersLeft: 0, threadsLeft: 2, recommendingUntil: until } }),
        formatTime,
      ),
    ).toEqual({
      text: `Budget reached, recommending only until T(${until})`,
      detail: "0 of 10 steers left today",
    });
  });

  it("shows for an exhausted budget even before the server sends the time", () => {
    expect(
      squireBudgetBanner(
        entry("release", { budget: { steersLeft: 3, threadsLeft: 0 } }),
        formatTime,
      ),
    ).toEqual({ text: "Budget reached, recommending only", detail: "0 of 3 threads left today" });
  });
});

describe("squireConversationPane", () => {
  it("mounts the home thread when there is one", () => {
    expect(squireConversationPane(entry("release").squire)).toEqual({
      kind: "thread",
      threadId: "thread-release",
    });
  });

  it("shows the Lead's provider prompt in needs_provider", () => {
    const lead = entry("lead", { role: "lead", lifecycle: "needs_provider", homeThreadId: null });
    expect(squireConversationPane(lead.squire)).toMatchObject({
      kind: "needs_provider",
      title: "Choose a provider for the Lead",
    });
    expect(squireConversationPane(lead.squire, false)).toMatchObject({
      title: "No supported provider",
    });
  });

  it("waits quietly while a home thread is still being created", () => {
    expect(
      squireConversationPane(entry("x", { lifecycle: "creating", homeThreadId: null }).squire),
    ).toEqual({ kind: "pending" });
  });
});

describe("squireHoldRuleLabel", () => {
  const release = SquireId.make("release");
  const rule = {
    id: "rule-1",
    squireId: release,
    effect: "allow",
    actionClass: "steer",
    targetKind: "thread",
    targetId: "thread-1",
    steerKind: "fix-failing-check",
    status: "active",
    matchCount: 1,
    lastMatchedAt: null,
    createdAt: "2026-11-01T10:00:00.000Z",
  } as unknown as SquireRule;
  const names = {
    squireName: () => "Release",
    targetName: () => "Fix invoice rounding",
  };
  const card = (ruleId: string | null) =>
    ({ origin: "event", routedTaskId: null, ruleId, squireId: release }) as Parameters<
      typeof squireHoldRuleLabel
    >[0];

  it("names the rule that started a hold, as the notch does", () => {
    expect(squireHoldRuleLabel(card("rule-1"), [rule], names)).toMatch(/^Auto by rule: Release/);
  });

  it("says nothing for a hold no rule started, or while the card or rules load", () => {
    expect(squireHoldRuleLabel(card(null), [rule], names)).toBeNull();
    expect(squireHoldRuleLabel(null, [rule], names)).toBeNull();
    expect(squireHoldRuleLabel(card("rule-1"), [], names)).toBeNull();
  });
});

describe("squireSwitchDescription", () => {
  it("says when the saved switch has not reached a server that reads it at start", () => {
    const live = false;
    expect(squireSwitchDescription({ saved: true, running: true, live })).toMatch(/^On\./);
    expect(squireSwitchDescription({ saved: false, running: false, live })).toMatch(/^Off\./);
    expect(squireSwitchDescription({ saved: true, running: false, live })).toMatch(
      /^Saved as on\. Squires start when .* restarts/,
    );
    expect(squireSwitchDescription({ saved: false, running: true, live })).toMatch(
      /^Saved as off\. Squires keep running until .* restarts/,
    );
  });

  it("never mentions a restart when the server applies the switch live", () => {
    const live = true;
    for (const saved of [true, false]) {
      for (const running of [true, false]) {
        expect(squireSwitchDescription({ saved, running, live })).not.toMatch(/restart/);
      }
    }
    expect(squireSwitchDescription({ saved: true, running: false, live })).toBe("Turning on…");
    expect(squireSwitchDescription({ saved: false, running: true, live })).toBe("Turning off…");
  });
});
