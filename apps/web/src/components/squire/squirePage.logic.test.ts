import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import {
  RunId,
  SquireCardId,
  SquireId,
  SquireSnapshot,
  type SquireActionLogKind,
  type SquireRule,
  type ThreadId,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  nextSquireViewSearch,
  SQUIRE_ACTIVITY_KINDS,
  squireActivityLabel,
  squireBudgetBanner,
  squireConversationHint,
  squireConversationLayout,
  squireConversationPane,
  squireExpandedConversationPx,
  squireLeadStateLine,
  squireHeaderStateLine,
  squireUnshownHolds,
  squireHoldCountdown,
  squireMiniComposerDraft,
  squireHoldRuleLabel,
  squireHoldText,
  squirePageState,
  squireRecentEntries,
  squireRecentRowText,
  squireRecentFromSnapshot,
  squireRecentLabel,
  squireSwitchDescription,
  SQUIRE_INBOX_MIN_PX,
  squireViewBreakpoint,
  squireViewLayout,
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

  it("gives only the Lead a team strip, without itself", () => {
    const leadPage = squirePageState(true, state, lead.squire.id);
    const releasePage = squirePageState(true, state, release.squire.id);
    expect(leadPage.status === "ready" && leadPage.team.map((e) => e.squire.id)).toEqual([
      release.squire.id,
    ]);
    expect(releasePage.status === "ready" && releasePage.team).toEqual([]);
  });
});

describe("squireViewLayout", () => {
  it("offers the inbox at 1440x900, where the main width is about 1184 px", () => {
    expect(squireViewLayout(1184, false)).toEqual({
      inboxOffered: true,
      companionPanel: "shown",
      queueLayout: "list",
    });
  });

  it("collapses the companion panel while the inbox is open", () => {
    expect(squireViewLayout(1184, true)).toEqual({
      inboxOffered: true,
      companionPanel: "collapsed",
      queueLayout: "inbox",
    });
  });

  it("shows the panel from exactly 1100 px", () => {
    expect(squireViewLayout(1100, false).companionPanel).toBe("shown");
    expect(squireViewLayout(1099, false).companionPanel).toBe("collapsed");
  });

  it("offers the inbox at a 1280 px window, where the main is about 1024 px", () => {
    expect(squireViewLayout(1024, false)).toEqual({
      inboxOffered: true,
      companionPanel: "collapsed",
      queueLayout: "list",
    });
    expect(squireViewLayout(1024, true).queueLayout).toBe("inbox");
    expect(squireViewLayout(SQUIRE_INBOX_MIN_PX, true).queueLayout).toBe("inbox");
  });

  it("below the inbox width keeps the list even with the inbox toggled", () => {
    expect(squireViewLayout(SQUIRE_INBOX_MIN_PX - 1, false)).toEqual({
      inboxOffered: false,
      companionPanel: "collapsed",
      queueLayout: "list",
    });
    expect(squireViewLayout(800, true).queueLayout).toBe("list");
  });

  it("changes breakpoint only when a width crosses the inbox or the panel width", () => {
    expect(squireViewBreakpoint(700)).toBe(squireViewBreakpoint(959));
    expect(squireViewBreakpoint(960)).toBe(squireViewBreakpoint(1099));
    expect(squireViewBreakpoint(1100)).toBe(squireViewBreakpoint(1600));
    expect(new Set([959, 960, 1100].map(squireViewBreakpoint)).size).toBe(3);
  });
});

describe("nextSquireViewSearch", () => {
  const item = SquireCardId.make("card-1");
  const squire = SquireId.make("release");

  it("keeps the bare route for the all chip, no item, and no team filter", () => {
    expect(
      nextSquireViewSearch(
        { filter: "steer", item, squire },
        { chip: "all", item: null, squire: null },
      ),
    ).toEqual({});
  });

  it("changes only the patched keys", () => {
    expect(nextSquireViewSearch({ filter: "fyi", squire }, { item })).toEqual({
      item,
      filter: "fyi",
      squire,
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

describe("squireConversationLayout", () => {
  const thread = squireConversationPane(entry("release").squire);

  it("is one slim line while collapsed, so the queue gets the view", () => {
    expect(squireConversationLayout(thread, true)).toEqual({ kind: "slim" });
  });

  it("expanded at 1440x900 under a long queue, leaves a tall card most of the window", () => {
    const layout = squireConversationLayout(thread, false);
    if (layout.kind !== "expanded") throw new Error("expected expanded");
    // 900 px tall less the 52 px top bar.
    const view = 848;
    const pane = squireExpandedConversationPx(layout, view, 1200);
    expect(view - pane).toBe(360);
    // Under the pane's toggle row and the composer, the timeline keeps over 300 px for a card.
    expect(pane - 32 - 140).toBeGreaterThan(300);
    // A tall window caps the queue at its share, so the pane grows with the window.
    expect(squireExpandedConversationPx(layout, 1400, 1200)).toBe(840);
  });

  it("gives the pane everything a short queue leaves", () => {
    const layout = squireConversationLayout(thread, false);
    if (layout.kind !== "expanded") throw new Error("expected expanded");
    expect(squireExpandedConversationPx(layout, 848, 220)).toBe(628);
  });

  it("gives way to the queue first in a short window", () => {
    const layout = squireConversationLayout(thread, false);
    if (layout.kind !== "expanded") throw new Error("expected expanded");
    expect(squireExpandedConversationPx(layout, 500, 1200)).toBe(140);
    expect(squireExpandedConversationPx(layout, 300, 1200)).toBe(0);
  });

  it("shows the provider prompt or nothing when there is no home thread", () => {
    const lead = entry("lead", { role: "lead", lifecycle: "needs_provider", homeThreadId: null });
    expect(squireConversationLayout(squireConversationPane(lead.squire), true)).toEqual({
      kind: "prompt",
    });
    const creating = entry("x", { lifecycle: "creating", homeThreadId: null });
    expect(squireConversationLayout(squireConversationPane(creating.squire), false)).toEqual({
      kind: "none",
    });
  });

  it("hints at what the collapsed conversation holds", () => {
    expect(squireConversationHint({ visibleItemCount: 12 }, false)).toBe("12 entries");
    expect(squireConversationHint(null, false)).toBe("No messages yet");
    expect(squireConversationHint({ visibleItemCount: 12 }, true)).toBe("Working…");
  });
});

describe("squireLeadStateLine", () => {
  const lead = (state: "idle" | "waiting" | "working", openDecisionCount: number) => ({
    squire: { role: "lead" as const, status: "active" as const, lifecycle: "ready" as const },
    indicator: { state, badge: null, workingLabel: false },
    openDecisionCount,
    heldCount: 0,
  });

  it("counts the team's open decisions with the Lead's own, as the Lead view lists them", () => {
    expect(
      squireLeadStateLine(lead("waiting", 1), [{ openDecisionCount: 2 }, { openDecisionCount: 0 }]),
    ).toBe("Waiting on you · 3 need a decision");
    expect(squireLeadStateLine(lead("idle", 0), [{ openDecisionCount: 1 }])).toBe(
      "Waiting on you · 1 needs a decision",
    );
    expect(squireLeadStateLine(lead("working", 0), [{ openDecisionCount: 2 }])).toBe(
      "Working · 2 need a decision",
    );
  });

  it("counts a Lead-raised item on a Squire's thread once, though both badges show it", () => {
    expect(
      squireLeadStateLine(lead("waiting", 1), [
        { openDecisionCount: 3, leadRaisedDecisionCount: 1 },
      ]),
    ).toBe("Waiting on you · 3 need a decision");
  });

  it("reads the Lead's own state when nothing waits", () => {
    expect(squireLeadStateLine(lead("idle", 0), [{ openDecisionCount: 0 }])).toBe("Idle");
    expect(squireLeadStateLine(lead("working", 0), [])).toBe("Working");
  });
});

describe("squireHeaderStateLine", () => {
  const input = (
    role: "lead" | "squire",
    state: "idle" | "waiting" | "working",
    openDecisionCount: number,
    heldCount = 0,
  ) => ({
    squire: { role, status: "active" as const, lifecycle: "ready" as const },
    indicator: { state, badge: null, workingLabel: false },
    openDecisionCount,
    heldCount,
  });

  it("counts the queue's decision rows, not the own-items badge count", () => {
    // Release's badge counts 1 (its own); its queue also lists the Lead's overlap, and a hold.
    expect(
      squireHeaderStateLine(input("squire", "waiting", 1, 1), { decisions: 2, held: 1 }, null),
    ).toBe("Waiting on you · 2 need a decision");
    expect(
      squireHeaderStateLine(input("squire", "waiting", 0, 1), { decisions: 0, held: 1 }, null),
    ).toBe("Waiting on you · 1 action held");
  });

  it("falls back to the snapshot until the queue loads", () => {
    expect(squireHeaderStateLine(input("squire", "waiting", 1), null, null)).toBe(
      "Waiting on you · 1 needs a decision",
    );
    expect(
      squireHeaderStateLine(input("lead", "waiting", 1), null, [{ openDecisionCount: 2 }]),
    ).toBe("Waiting on you · 3 need a decision");
  });

  it("counts the Lead's combined queue once, not again with its team", () => {
    expect(
      squireHeaderStateLine(input("lead", "working", 0), { decisions: 4, held: 0 }, [
        { openDecisionCount: 3 },
      ]),
    ).toBe("Working · 4 need a decision");
  });
});

describe("squireUnshownHolds", () => {
  const held = [{ cardId: "a" }, { cardId: "b" }];

  it("shows a banner for every hold until the queue loads, then only those without a row", () => {
    expect(squireUnshownHolds(held, null)).toEqual(held);
    expect(squireUnshownHolds(held, new Set(["a"]))).toEqual([{ cardId: "b" }]);
    expect(squireUnshownHolds(held, new Set(["a", "b"]))).toEqual([]);
  });
});

describe("squireMiniComposerDraft", () => {
  it("hands nothing over for blank text, so Send stays disabled", () => {
    expect(squireMiniComposerDraft("", null)).toBeNull();
    expect(squireMiniComposerDraft("   \n ", "kept draft")).toBeNull();
  });

  it("becomes the draft when the thread has none", () => {
    expect(squireMiniComposerDraft("  ship it  ", null)).toBe("ship it");
    expect(squireMiniComposerDraft("ship it", "  \n")).toBe("ship it");
  });

  it("keeps an existing draft and continues after it", () => {
    expect(squireMiniComposerDraft("and the docs", "Update the changelog\n")).toBe(
      "Update the changelog\n\nand the docs",
    );
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
