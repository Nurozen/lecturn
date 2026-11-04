import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireCardId,
  SquireCardKind,
  SquireCardStatus,
  SquireId,
} from "@lecturn/contracts";
import { SquireRoomId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isSquireFoldCollapsed,
  isSquireRowExpanded,
  isSquiresGroupVisible,
  parseSquireRouteKey,
  showSquireEnvironmentLabels,
  squireChildAgeText,
  squireChildRows,
  squireFoldKey,
  squireKindDot,
  squireLeadAggregateCount,
  squireLeadBlock,
  squireLeadFold,
  squireLeadItemsLabel,
  squireLeadTrailing,
  squireRouteKey,
  squireRowLabel,
  squireRowSelection,
  squireRowStatusLine,
  squireRowTrailing,
  squireTeamRaisedCounts,
} from "./squireSidebar.logic";

const ENV = "env-1" as EnvironmentId;
const OTHER_ENV = "env-2" as EnvironmentId;
const LEAD = "lead" as SquireId;
const RELEASE = "release" as SquireId;
const DOCS = "docs" as SquireId;

function entry(
  id: SquireId,
  overrides: {
    readonly name?: string;
    readonly role?: "lead" | "squire";
    readonly lifecycle?: SquireSnapshotEntry["squire"]["lifecycle"];
    readonly createdAt?: string;
    readonly openDecisionCount?: number;
    readonly leadRaisedDecisionCount?: number;
  } = {},
): SquireSnapshotEntry {
  return {
    squire: {
      id,
      name: overrides.name ?? id,
      role: overrides.role ?? "squire",
      lifecycle: overrides.lifecycle ?? "ready",
      status: "active",
      createdAt: overrides.createdAt ?? "2026-10-01T00:00:00.000Z",
    },
    openDecisionCount: overrides.openDecisionCount ?? 0,
    ...(overrides.leadRaisedDecisionCount === undefined
      ? {}
      : { leadRaisedDecisionCount: overrides.leadRaisedDecisionCount }),
    held: [],
  } as unknown as SquireSnapshotEntry;
}

const idle = { state: "idle", badge: null, workingLabel: false } as const;
const working = { state: "working", badge: null, workingLabel: true } as const;
const waiting = (badge: number | null) =>
  ({ state: "waiting", badge, workingLabel: false }) as const;
const needsProvider = { state: "needs_provider", badge: null, workingLabel: false } as const;

describe("squireLeadBlock", () => {
  it("puts the Lead first and its Squires under it by name, case-insensitively", () => {
    const block = squireLeadBlock({
      lead: LEAD,
      squires: [
        entry(RELEASE, { name: "release" }),
        entry(LEAD, { name: "Lead", role: "lead" }),
        entry(DOCS, { name: "Docs" }),
      ],
      rooms: [],
    });
    expect(block.lead?.squire.id).toBe(LEAD);
    expect(block.squires.map((e) => e.squire.name)).toEqual(["Docs", "release"]);
  });

  it("breaks name ties by creation so equal names keep their order", () => {
    const block = squireLeadBlock({
      lead: LEAD,
      squires: [
        entry("b" as SquireId, { name: "Review", createdAt: "2026-10-02T00:00:00.000Z" }),
        entry("a" as SquireId, { name: "Review", createdAt: "2026-10-03T00:00:00.000Z" }),
      ],
      rooms: [],
    });
    expect(block.squires.map((e) => e.squire.id)).toEqual(["b", "a"]);
  });

  it("reports no Lead until ensure creates one, and still lists the Squires", () => {
    const block = squireLeadBlock({ lead: null, squires: [entry(RELEASE)], rooms: [] });
    expect(block.lead).toBeNull();
    expect(block.squires.map((e) => e.squire.id)).toEqual([RELEASE]);
  });
});

describe("row trailing and labels", () => {
  it("shows working in place of the badge, and a badge only for open decisions", () => {
    expect(squireRowTrailing(working)).toEqual({ kind: "working" });
    expect(squireRowTrailing(waiting(3))).toEqual({ kind: "badge", count: 3 });
    // Waiting on held actions only: the ring says waiting, but there is nothing to count.
    expect(squireRowTrailing(waiting(null))).toEqual({ kind: "none" });
    expect(squireRowTrailing(idle)).toEqual({ kind: "none" });
  });

  it("names the state for screen readers", () => {
    expect(squireRowLabel("Release", waiting(1))).toBe("Release, 1 needs a decision");
    expect(squireRowLabel("Release", waiting(2))).toBe("Release, 2 need a decision");
    expect(squireRowLabel("Release", working)).toBe("Release, working");
    expect(squireRowLabel("Release", idle)).toBe("Release");
  });

  it("asks for a provider while the Lead has none, and says nothing for a ready Squire", () => {
    const lead = entry(LEAD, { role: "lead", lifecycle: "needs_provider" });
    expect(squireRowStatusLine(lead, needsProvider)).toBe("Choose a provider for the Lead");
    expect(squireRowStatusLine(entry(RELEASE, { lifecycle: "creating" }), idle)).toBe("Setting up");
    expect(squireRowStatusLine(entry(RELEASE), waiting(2))).toBeNull();
  });
});

describe("squireChildRows", () => {
  let next = 0;
  const card = (kind: SquireCardKind, squireId: SquireId, status: SquireCardStatus = "open") => ({
    id: `card-${next++}` as SquireCardId,
    kind,
    status,
    squireId,
  });

  it("lists its view's Needs a decision rows: queued, never FYI or held", () => {
    const items = [
      card("steer", RELEASE),
      card("fyi", RELEASE),
      card("question", RELEASE, "held"),
      card("proposal", RELEASE),
      card("steer", RELEASE, "accepting"),
      card("steer", RELEASE, "dismissed"),
    ];
    const { rows, moreCount } = squireChildRows(items, {
      squireId: RELEASE,
      leadId: LEAD,
      openDecisionCount: 3,
    });
    expect(rows.map((row) => row.status)).toEqual(["open", "open", "accepting"]);
    expect(moreCount).toBe(0);
  });

  it("gives a Squire the Lead's items on its threads, and the Lead only what it raised", () => {
    const items = [card("overlap", LEAD), card("steer", RELEASE), card("question", DOCS)];
    expect(
      squireChildRows(items, { squireId: LEAD, leadId: LEAD, openDecisionCount: 1 }).rows.map(
        (row) => row.kind,
      ),
    ).toEqual(["overlap"]);
    // The Lead's overlap on Release's thread lists once, under the Lead; Release's badge still
    // counts it, and it is not left over as "+1 more".
    const release = squireChildRows([card("overlap", LEAD), card("steer", RELEASE)], {
      squireId: RELEASE,
      leadId: LEAD,
      openDecisionCount: 2,
      leadRaisedDecisionCount: 1,
    });
    expect(release.rows.map((row) => row.kind)).toEqual(["steer"]);
    expect(release.moreCount).toBe(0);
  });

  it("caps the rows and counts the rest, including what the page left out", () => {
    const items = Array.from({ length: 7 }, () => card("steer", RELEASE));
    const capped = squireChildRows(items, {
      squireId: RELEASE,
      leadId: LEAD,
      openDecisionCount: 7,
    });
    expect(capped.rows).toHaveLength(5);
    expect(capped.moreCount).toBe(2);
    const paged = squireChildRows(items.slice(0, 3), {
      squireId: RELEASE,
      leadId: LEAD,
      openDecisionCount: 9,
    });
    expect(paged.rows).toHaveLength(3);
    expect(paged.moreCount).toBe(6);
  });
});

describe("type dots and age", () => {
  it("gives each decision kind its own tone and FYI none", () => {
    const tones = (["steer", "question", "overlap", "proposal"] as const).map(
      (kind) => squireKindDot(kind)?.tone,
    );
    expect(new Set(tones).size).toBe(4);
    expect(squireKindDot("fyi")).toBeNull();
  });

  it("reads ages compactly", () => {
    expect(squireChildAgeText({ status: "relative", value: "just now", suffix: null })).toBe("now");
    expect(squireChildAgeText({ status: "relative", value: "5m", suffix: "ago" })).toBe("5m");
    expect(squireChildAgeText({ status: "invalid" })).toBe("");
  });
});

describe("fold state", () => {
  const squire = { kind: "squire", environmentId: ENV, squireId: RELEASE } as const;

  it("starts with the group, environments, and Leads open and Squires folded", () => {
    expect(isSquireFoldCollapsed({}, { kind: "group" })).toBe(false);
    expect(isSquireFoldCollapsed({}, { kind: "lead", environmentId: ENV })).toBe(false);
    expect(isSquireFoldCollapsed({}, { kind: "environment", environmentId: ENV })).toBe(false);
    expect(isSquireFoldCollapsed({}, squire)).toBe(true);
  });

  it("keeps explicit choices per environment and Squire", () => {
    const collapsedByKey = { [squireFoldKey(squire)]: false };
    expect(isSquireFoldCollapsed(collapsedByKey, squire)).toBe(false);
    expect(isSquireFoldCollapsed(collapsedByKey, { ...squire, environmentId: OTHER_ENV })).toBe(
      true,
    );
    expect(squireFoldKey({ kind: "environment", environmentId: ENV })).not.toBe(
      squireFoldKey({ kind: "environment", environmentId: OTHER_ENV }),
    );
  });

  it("opens a row only while it has decisions to list", () => {
    const opened = { [squireFoldKey(squire)]: false };
    expect(isSquireRowExpanded(opened, squire, 2)).toBe(true);
    expect(isSquireRowExpanded(opened, squire, 0)).toBe(false);
  });
});

describe("Lead fold", () => {
  const block = (leadCount: number, squireCounts: ReadonlyArray<number>) =>
    squireLeadBlock({
      lead: LEAD,
      squires: [
        entry(LEAD, { role: "lead", openDecisionCount: leadCount }),
        ...squireCounts.map((count, index) =>
          entry(`s${index}` as SquireId, { openDecisionCount: count }),
        ),
      ],
      rooms: [],
    });
  const leadKey = squireFoldKey({ kind: "lead", environmentId: ENV });

  it("starts open, folds its Squires, and keeps the choice per environment", () => {
    expect(squireLeadFold({}, ENV, block(0, [1]))).toEqual({ expandable: true, expanded: true });
    expect(squireLeadFold({ [leadKey]: true }, ENV, block(0, [1]))).toEqual({
      expandable: true,
      expanded: false,
    });
    expect(squireLeadFold({ [leadKey]: true }, OTHER_ENV, block(0, [1])).expanded).toBe(true);
  });

  it("has nothing to fold with no Squires and no items of its own", () => {
    expect(squireLeadFold({}, ENV, block(0, []))).toEqual({ expandable: false, expanded: false });
    expect(squireLeadFold({}, ENV, block(2, [])).expandable).toBe(true);
  });

  it("folds open rooms under the Lead and leaves closed ones out", () => {
    const room = (id: string, status: "open" | "closed") => ({
      id: SquireRoomId.make(id),
      topic: id,
      status,
      muted: false,
      members: [],
      includesLead: true,
      unread: false,
      lastPostAt: null,
    });
    const withRooms = squireLeadBlock({
      lead: LEAD,
      squires: [entry(LEAD, { role: "lead" })],
      rooms: [room("open", "open"), room("closed", "closed")],
    });
    expect(withRooms.rooms.map((r) => r.id)).toEqual(["open"]);
    expect(squireLeadFold({}, ENV, withRooms)).toEqual({ expandable: true, expanded: true });
  });

  it("labels the Lead's own items only when Squires share its fold", () => {
    expect(squireLeadItemsLabel(block(1, [0]))).toBe("Needs a decision");
    expect(squireLeadItemsLabel(block(1, []))).toBeNull();
  });

  it("sums the Lead's own items and every Squire's", () => {
    expect(squireLeadAggregateCount(block(1, [3, 0, 2]))).toBe(6);
  });

  it("counts a Lead-raised item on a Squire's thread once, though both badges show it", () => {
    const shared = squireLeadBlock({
      lead: LEAD,
      squires: [
        entry(LEAD, { role: "lead", openDecisionCount: 1 }),
        entry(RELEASE, { openDecisionCount: 4, leadRaisedDecisionCount: 1 }),
        entry(DOCS, { openDecisionCount: 2 }),
      ],
      rooms: [],
    });
    expect(squireLeadAggregateCount(shared)).toBe(6);
    expect(squireTeamRaisedCounts(shared.squires).map((e) => e.openDecisionCount)).toEqual([2, 3]);
  });

  it("shows the total while folded, ahead of working, and its own count while open", () => {
    const b = block(1, [3, 2]);
    expect(squireLeadTrailing(waiting(1), b, false)).toEqual({ kind: "badge", count: 1 });
    expect(squireLeadTrailing(waiting(1), b, true)).toEqual({ kind: "badge", count: 6 });
    expect(squireLeadTrailing(working, b, true)).toEqual({ kind: "badge", count: 6 });
    expect(squireLeadTrailing(working, block(0, [0]), true)).toEqual({ kind: "working" });
    expect(squireLeadTrailing(idle, block(0, [0]), true)).toEqual({ kind: "none" });
  });
});

describe("visibility and selection", () => {
  it("hides the group while searching or with no Squire environment", () => {
    expect(isSquiresGroupVisible({ isSearching: false, environmentCount: 1 })).toBe(true);
    expect(isSquiresGroupVisible({ isSearching: true, environmentCount: 1 })).toBe(false);
    expect(isSquiresGroupVisible({ isSearching: false, environmentCount: 0 })).toBe(false);
  });

  it("labels environments only when there are several", () => {
    expect(showSquireEnvironmentLabels(1)).toBe(false);
    expect(showSquireEnvironmentLabels(2)).toBe(true);
  });

  it("highlights the route's row and its item only on that Squire's view", () => {
    const route = parseSquireRouteKey(
      squireRouteKey({
        params: { environmentId: ENV, squireId: RELEASE },
        search: { item: "card-9" },
      }),
    );
    expect(squireRowSelection(route, ENV, RELEASE)).toEqual({
      active: true,
      selectedItem: "card-9",
    });
    expect(squireRowSelection(route, OTHER_ENV, RELEASE)).toEqual({
      active: false,
      selectedItem: null,
    });
    expect(squireRowSelection(route, ENV, DOCS).selectedItem).toBeNull();
    expect(squireRowSelection(parseSquireRouteKey(""), ENV, RELEASE).active).toBe(false);
  });
});
