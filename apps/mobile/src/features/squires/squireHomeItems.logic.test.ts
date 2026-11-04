import {
  squireEntryIndicator,
  type SquireEnvironmentState,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId, SquireRoomId, SquireRoomRow } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSquireHomeItems,
  homeSquireItemsAreEqual,
  squireHomeLeadAggregateCount,
  squireHomeLeadTrailing,
  squireLeadFoldKey,
  squireHomeRowLabel,
  squireHomeRowStatusLine,
  squireHomeRowTrailing,
} from "./squireHomeItems.logic";
import { withSquireRoomSeen } from "./squireRooms.logic";

const MAC = "env-mac" as EnvironmentId;
const BOX = "env-box" as EnvironmentId;
const OLD = "env-old" as EnvironmentId;
const LEAD = "lead" as SquireId;

function entry(
  id: string,
  overrides: {
    readonly name?: string;
    readonly role?: "lead" | "squire";
    readonly lifecycle?: SquireSnapshotEntry["squire"]["lifecycle"];
    readonly openDecisionCount?: number;
    readonly leadRaisedDecisionCount?: number;
    readonly fyi?: number;
    readonly homeThreadId?: string | null;
  } = {},
): SquireSnapshotEntry {
  return {
    squire: {
      id,
      name: overrides.name ?? id,
      role: overrides.role ?? "squire",
      lifecycle: overrides.lifecycle ?? "ready",
      status: "active",
      homeThreadId: overrides.homeThreadId ?? null,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    openDecisionCount: overrides.openDecisionCount ?? 0,
    ...(overrides.leadRaisedDecisionCount === undefined
      ? {}
      : { leadRaisedDecisionCount: overrides.leadRaisedDecisionCount }),
    countsByKind: { steer: 0, question: 0, overlap: 0, proposal: 0, fyi: overrides.fyi ?? 0 },
    held: [],
  } as unknown as SquireSnapshotEntry;
}

function room(
  id: string,
  topic: string,
  overrides: Partial<
    Pick<SquireRoomRow, "status" | "lastPostAt" | "unread" | "muted" | "members">
  > = {},
): SquireRoomRow {
  return {
    id: id as SquireRoomId,
    topic,
    status: overrides.status ?? "open",
    muted: overrides.muted ?? false,
    members: overrides.members ?? [],
    includesLead: true,
    unread: overrides.unread ?? false,
    lastPostAt: overrides.lastPostAt ?? null,
  } as SquireRoomRow;
}

const team: SquireEnvironmentState = {
  lead: LEAD,
  squires: [
    entry("release", { name: "release" }),
    entry(LEAD, { name: "Lead", role: "lead" }),
    entry("docs", { name: "Docs" }),
  ],
  rooms: [
    room("r-old", "Rollout", { lastPostAt: "2026-10-30T10:00:00.000Z" }),
    room("r-closed", "Retro", { status: "closed", lastPostAt: "2026-10-31T12:00:00.000Z" }),
    room("r-new", "Flaky CI", { lastPostAt: "2026-10-31T09:00:00.000Z", unread: true }),
  ],
};

const environments = [
  { environmentId: MAC, label: "Mac mini" },
  { environmentId: BOX, label: "Build box" },
  { environmentId: OLD, label: "Old server" },
];

const build = (
  states: ReadonlyMap<EnvironmentId, SquireEnvironmentState>,
  options: {
    readonly selectedEnvironmentId?: EnvironmentId | null;
    readonly searching?: boolean;
    readonly roomSeen?: ReadonlyMap<string, string>;
    readonly collapsedKeys?: ReadonlySet<string>;
  } = {},
) =>
  buildSquireHomeItems({
    environments,
    states,
    selectedEnvironmentId: options.selectedEnvironmentId ?? null,
    searching: options.searching ?? false,
    ...(options.roomSeen === undefined ? {} : { roomSeen: options.roomSeen }),
    ...(options.collapsedKeys === undefined ? {} : { collapsedKeys: options.collapsedKeys }),
  });

const roomItems = (rooms: ReadonlyArray<SquireRoomRow>, roomSeen?: ReadonlyMap<string, string>) =>
  build(new Map([[MAC, { ...team, rooms }]]), roomSeen === undefined ? {} : { roomSeen }).flatMap(
    (item) => (item.type === "squire-room" ? [item] : []),
  );

describe("buildSquireHomeItems", () => {
  it("lists the Lead, its Squires by name, then its open rooms by latest post", () => {
    const items = build(new Map([[MAC, team]]));
    expect(items.map((item) => [item.type, item.key, item.depth])).toEqual([
      ["squire-lead", `squire-lead:${MAC}:lead`, 0],
      ["squire", `squire:${MAC}:docs`, 1],
      ["squire", `squire:${MAC}:release`, 1],
      ["squire-room", `squire-room:${MAC}:r-new`, 1],
      ["squire-room", `squire-room:${MAC}:r-old`, 1],
    ]);
    expect(items.find((item) => item.type === "squire-room")).toMatchObject({
      topic: "Flaky CI",
      unread: true,
    });
  });

  it("orders open rooms by latest post, quiet rooms last by topic", () => {
    const items = roomItems([
      room("r-quiet-b", "Zeta"),
      room("r-2", "Two", { lastPostAt: "2026-10-31T09:00:00.000Z" }),
      room("r-quiet-a", "alpha"),
      room("r-1", "One", { lastPostAt: "2026-10-31T11:00:00.000Z" }),
      room("r-closed", "Closed", { status: "closed", lastPostAt: "2026-11-01T00:00:00.000Z" }),
    ]);
    expect(items.map((item) => item.topic)).toEqual(["One", "Two", "alpha", "Zeta"]);
  });

  it("dots a room only when the user is a member, it is not muted, and its newest post is unseen", () => {
    const at = "2026-10-31T09:00:00.000Z";
    const unread = (overrides: Parameters<typeof room>[2], seen?: ReadonlyMap<string, string>) =>
      roomItems([room("r", "Room", { lastPostAt: at, ...overrides })], seen)[0]!.unread;
    expect(unread({ unread: true })).toBe(true);
    // The server sets `unread` only for a member, so a room the user is not in never dots.
    expect(unread({ unread: false })).toBe(false);
    expect(unread({ unread: true, muted: true })).toBe(false);
    const seen = withSquireRoomSeen(new Map(), MAC, "r" as SquireRoomId, at);
    expect(unread({ unread: true }, seen)).toBe(false);
    expect(unread({ unread: true, lastPostAt: "2026-10-31T09:05:00.000Z" }, seen)).toBe(true);
  });

  it("stacks up to three member portraits, then counts the rest", () => {
    const members = ["a", "b", "c", "d", "e"] as SquireId[];
    expect(roomItems([room("r", "Room", { members })])[0]).toMatchObject({
      portraits: ["a", "b", "c"],
      overflow: 2,
    });
    expect(roomItems([room("r", "Room", { members: members.slice(0, 2) })])[0]).toMatchObject({
      portraits: ["a", "b"],
      overflow: 0,
    });
  });

  it("labels Lead groups with the environment only when more than one shows", () => {
    const one = build(new Map([[MAC, team]]));
    expect(one[0]).toMatchObject({ type: "squire-lead", environmentLabel: null });

    const two = build(
      new Map([
        [
          BOX,
          {
            lead: "box-lead" as SquireId,
            squires: [entry("box-lead", { role: "lead" })],
            rooms: [],
          },
        ],
        [MAC, team],
      ]),
    );
    // Environment order follows the list's, not the states map.
    expect(
      two.filter((item) => item.type === "squire-lead").map((item) => item.environmentLabel),
    ).toEqual(["Mac mini", "Build box"]);
  });

  it("shows only the filtered environment, unlabeled", () => {
    const states = new Map([
      [MAC, team],
      [
        BOX,
        { lead: "box-lead" as SquireId, squires: [entry("box-lead", { role: "lead" })], rooms: [] },
      ],
    ]);
    const items = build(states, { selectedEnvironmentId: BOX });
    expect(items.map((item) => item.key)).toEqual([`squire-lead:${BOX}:box-lead`]);
    expect(items[0]).toMatchObject({ environmentLabel: null });
  });

  it("is empty when no environment supports Squires, or while searching", () => {
    // Environments without the capability never get a state.
    expect(build(new Map())).toEqual([]);
    expect(build(new Map([[MAC, { lead: null, squires: [], rooms: [] }]]))).toEqual([]);
    expect(build(new Map([[MAC, team]]), { searching: true })).toEqual([]);
  });

  it("lists Squires at the top level until the Lead exists", () => {
    const items = build(new Map([[MAC, { lead: null, squires: [entry("docs")], rooms: [] }]]));
    expect(items.map((item) => [item.type, item.depth])).toEqual([["squire", 0]]);
  });

  it("compares rebuilt items by structure", () => {
    const [first] = build(new Map([[MAC, team]]));
    const [again] = build(new Map([[MAC, { ...team, squires: [...team.squires] }]]));
    expect(homeSquireItemsAreEqual(first!, again!)).toBe(true);
    const roomBefore = build(new Map([[MAC, team]])).at(-1)!;
    const roomAfter = build(
      new Map([[MAC, { ...team, rooms: [room("r-old", "Rollout", { unread: true })] }]]),
    ).at(-1)!;
    expect(homeSquireItemsAreEqual(roomBefore, roomAfter)).toBe(false);
    const membersAfter = build(
      new Map([
        [MAC, { ...team, rooms: [room("r-old", "Rollout", { members: ["a" as SquireId] })] }],
      ]),
    ).at(-1)!;
    expect(homeSquireItemsAreEqual(roomBefore, membersAfter)).toBe(false);
  });
});

describe("Lead fold", () => {
  const boxTeam: SquireEnvironmentState = {
    lead: "box-lead" as SquireId,
    squires: [entry("box-lead", { role: "lead" }), entry("box-docs")],
    rooms: [],
  };
  const both = new Map([
    [MAC, team],
    [BOX, boxTeam],
  ]);

  it("keys each Lead's fold by environment and Lead", () => {
    expect(squireLeadFoldKey(MAC, LEAD)).toBe(`squire-lead:${MAC}:lead`);
    expect(squireLeadFoldKey(BOX, LEAD)).not.toBe(squireLeadFoldKey(MAC, LEAD));
    // A replacement Lead in the same environment starts open.
    expect(squireLeadFoldKey(MAC, "lead-2" as SquireId)).not.toBe(squireLeadFoldKey(MAC, LEAD));
  });

  it("hides only the folded Lead's Squires and rooms, keeping its row", () => {
    const items = build(both, { collapsedKeys: new Set([squireLeadFoldKey(MAC, LEAD)]) });
    expect(items.map((item) => item.key)).toEqual([
      `squire-lead:${MAC}:lead`,
      `squire-lead:${BOX}:box-lead`,
      `squire:${BOX}:box-docs`,
    ]);
    expect(items[0]).toMatchObject({ expandable: true, collapsed: true });
    expect(items[1]).toMatchObject({ expandable: true, collapsed: false });
  });

  it("keeps the open order unchanged, and ignores keys from other environments or Leads", () => {
    const open = build(both);
    const unrelated = build(both, {
      collapsedKeys: new Set([squireLeadFoldKey(MAC, "old-lead" as SquireId), "project:x"]),
    });
    expect(unrelated.map((item) => item.key)).toEqual(open.map((item) => item.key));
    expect(open.map((item) => item.key)).toEqual([
      `squire-lead:${MAC}:lead`,
      `squire:${MAC}:docs`,
      `squire:${MAC}:release`,
      `squire-room:${MAC}:r-new`,
      `squire-room:${MAC}:r-old`,
      `squire-lead:${BOX}:box-lead`,
      `squire:${BOX}:box-docs`,
    ]);
  });

  it("does not fold a Lead with nothing under it", () => {
    const alone = new Map([
      [MAC, { lead: LEAD, squires: [entry(LEAD, { role: "lead" })], rooms: [] }],
    ]);
    const [lead] = build(alone, { collapsedKeys: new Set([squireLeadFoldKey(MAC, LEAD)]) });
    expect(lead).toMatchObject({ expandable: false, collapsed: false });
  });

  it("rebuilds the list on a fold change only", () => {
    const [open] = build(both);
    const [folded] = build(both, { collapsedKeys: new Set([squireLeadFoldKey(MAC, LEAD)]) });
    expect(homeSquireItemsAreEqual(open!, folded!)).toBe(false);
    const counted = new Map([
      [MAC, { ...team, squires: [...team.squires, entry("ops", { openDecisionCount: 3 })] }],
    ]);
    // A count change re-renders only the Lead row, which reads the total itself.
    const [before] = build(new Map([[MAC, team]]));
    expect(homeSquireItemsAreEqual(before!, build(counted)[0]!)).toBe(true);
  });

  it("totals the group's open decisions once, Lead-raised items counted on the Lead", () => {
    const state: SquireEnvironmentState = {
      lead: LEAD,
      squires: [
        entry(LEAD, { role: "lead", openDecisionCount: 2 }),
        // One of docs' three is the Lead's, already in the Lead's two.
        entry("docs", { openDecisionCount: 3, leadRaisedDecisionCount: 1 }),
        entry("release", { openDecisionCount: 1 }),
        entry("stale", { openDecisionCount: 1, leadRaisedDecisionCount: 4 }),
        entry("fyi-only", { fyi: 5 }),
      ],
      rooms: [],
    };
    expect(squireHomeLeadAggregateCount(state)).toBe(5);
    expect(squireHomeLeadAggregateCount(null)).toBe(0);
  });

  it("shows the group's total while folded, ahead of working, and the Lead's own state open", () => {
    const working = squireEntryIndicator(entry(LEAD, { role: "lead", homeThreadId: "t-1" }), {
      runtime: { status: "running", activeRunId: "run-1" },
      latestRun: { runId: "run-1", status: "running" },
    } as unknown as Parameters<typeof squireEntryIndicator>[1]);
    expect(squireHomeLeadTrailing(working, 4, true)).toEqual({ kind: "badge", count: 4 });
    expect(squireHomeLeadTrailing(working, 4, false)).toEqual({ kind: "working" });
    expect(squireHomeLeadTrailing(working, 0, true)).toEqual({ kind: "working" });
    expect(squireHomeRowLabel("Lead", working, { kind: "badge", count: 4 })).toBe(
      "Lead, 4 need a decision",
    );
  });
});

describe("row trailing and status", () => {
  const workingShell = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: { status: "running", activeRunId: "run-1" },
    latestRun: { runId: "run-1", status: "running" },
    interactionMode: "default",
    hasActionableProposedPlan: false,
  } as unknown as Parameters<typeof squireEntryIndicator>[1];

  it("badges open decisions only, with FYI never counted", () => {
    const fyiOnly = squireEntryIndicator(entry("docs", { fyi: 4 }), null);
    expect(squireHomeRowTrailing(fyiOnly)).toEqual({ kind: "none" });
    const waiting = squireEntryIndicator(entry("docs", { openDecisionCount: 2, fyi: 4 }), null);
    expect(squireHomeRowTrailing(waiting)).toEqual({ kind: "badge", count: 2 });
    expect(squireHomeRowLabel("Docs", waiting)).toBe("Docs, 2 need a decision");
  });

  it("shows working in the badge's place while the home thread runs", () => {
    const working = squireEntryIndicator(
      entry("docs", { openDecisionCount: 2, homeThreadId: "t-1" }),
      workingShell,
    );
    expect(squireHomeRowTrailing(working)).toEqual({ kind: "working" });
    expect(squireHomeRowLabel("Docs", working)).toBe("Docs, working");
  });

  it("asks for a provider while the Lead has none, and is silent once ready", () => {
    const lead = entry(LEAD, { role: "lead", lifecycle: "needs_provider" });
    const indicator = squireEntryIndicator(lead, null);
    expect(squireHomeRowStatusLine(lead, indicator)).toBe("Choose a provider for the Lead");
    expect(squireHomeRowTrailing(indicator)).toEqual({ kind: "none" });
    const ready = entry(LEAD, { role: "lead" });
    expect(squireHomeRowStatusLine(ready, squireEntryIndicator(ready, null))).toBeNull();
  });
});
