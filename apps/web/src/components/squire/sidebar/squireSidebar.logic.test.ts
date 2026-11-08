import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireId } from "@lecturn/contracts";
import { SquireRoomId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isSquireFoldCollapsed,
  isSquiresGroupVisible,
  parseSquireRouteKey,
  showSquireEnvironmentLabels,
  squireChildAgeText,
  squireFoldKey,
  squireLeadAggregateCount,
  squireLeadBlock,
  squireLeadFold,
  squireLeadTrailing,
  squireRouteKey,
  squireRowLabel,
  squireRowSelected,
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
  it("shows one state per row", () => {
    expect(squireRowTrailing("needs-you", 3)).toEqual({ kind: "needs-you", count: 3 });
    expect(squireRowTrailing("working", 0)).toEqual({ kind: "working" });
    expect(squireRowTrailing("unread", 0)).toEqual({ kind: "unread" });
    expect(squireRowTrailing("none", 0)).toEqual({ kind: "none" });
  });

  it("names the state for screen readers", () => {
    expect(squireRowLabel("Release", waiting(1), "needs-you")).toBe("Release, 1 needs a decision");
    expect(squireRowLabel("Release", waiting(2), "needs-you")).toBe("Release, 2 need a decision");
    expect(squireRowLabel("Release", working, "working")).toBe("Release, working");
    expect(squireRowLabel("Release", idle, "unread")).toBe("Release, unread messages");
    expect(squireRowLabel("Release", idle, "none")).toBe("Release");
  });

  it("asks for a provider while the Lead has none, and says nothing for a ready Squire", () => {
    const lead = entry(LEAD, { role: "lead", lifecycle: "needs_provider" });
    expect(squireRowStatusLine(lead, needsProvider)).toBe("Choose a provider for the Lead");
    expect(squireRowStatusLine(entry(RELEASE, { lifecycle: "creating" }), idle)).toBe("Setting up");
    expect(squireRowStatusLine(entry(RELEASE), waiting(2))).toBeNull();
  });
});

describe("squireChildAgeText", () => {
  it("reads ages compactly", () => {
    expect(squireChildAgeText({ status: "relative", value: "just now", suffix: null })).toBe("now");
    expect(squireChildAgeText({ status: "relative", value: "5m", suffix: "ago" })).toBe("5m");
    expect(squireChildAgeText({ status: "invalid" })).toBe("");
  });
});

describe("fold state", () => {
  it("starts with the group, environments, and Leads open", () => {
    expect(isSquireFoldCollapsed({}, { kind: "group" })).toBe(false);
    expect(isSquireFoldCollapsed({}, { kind: "lead", environmentId: ENV })).toBe(false);
    expect(isSquireFoldCollapsed({}, { kind: "environment", environmentId: ENV })).toBe(false);
  });

  it("keeps explicit choices per environment", () => {
    const lead = { kind: "lead", environmentId: ENV } as const;
    const collapsedByKey = { [squireFoldKey(lead)]: true };
    expect(isSquireFoldCollapsed(collapsedByKey, lead)).toBe(true);
    expect(isSquireFoldCollapsed(collapsedByKey, { ...lead, environmentId: OTHER_ENV })).toBe(
      false,
    );
    expect(squireFoldKey({ kind: "environment", environmentId: ENV })).not.toBe(
      squireFoldKey({ kind: "environment", environmentId: OTHER_ENV }),
    );
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

  it("has nothing to fold with no Squires or rooms, however many items it has", () => {
    expect(squireLeadFold({}, ENV, block(0, []))).toEqual({ expandable: false, expanded: false });
    expect(squireLeadFold({}, ENV, block(2, [])).expandable).toBe(false);
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

  it("shows the total while folded and its own state while open", () => {
    const b = block(1, [3, 2]);
    expect(squireLeadTrailing("needs-you", b, false)).toEqual({ kind: "needs-you", count: 1 });
    expect(squireLeadTrailing("needs-you", b, true)).toEqual({ kind: "needs-you", count: 6 });
    expect(squireLeadTrailing("working", b, true)).toEqual({ kind: "needs-you", count: 6 });
    expect(squireLeadTrailing("working", block(0, [0]), true)).toEqual({ kind: "working" });
    expect(squireLeadTrailing("unread", block(0, [0]), true)).toEqual({ kind: "unread" });
    expect(squireLeadTrailing("none", block(0, [0]), true)).toEqual({ kind: "none" });
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

  it("highlights only the route's own row", () => {
    const route = parseSquireRouteKey(
      squireRouteKey({ params: { environmentId: ENV, squireId: RELEASE } }),
    );
    expect(squireRowSelected(route, ENV, RELEASE)).toBe(true);
    expect(squireRowSelected(route, OTHER_ENV, RELEASE)).toBe(false);
    expect(squireRowSelected(route, ENV, DOCS)).toBe(false);
    expect(squireRowSelected(parseSquireRouteKey(""), ENV, RELEASE)).toBe(false);
  });
});
