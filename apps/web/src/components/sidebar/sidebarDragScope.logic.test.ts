import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@lecturn/contracts";
import { scopeThreadRef, scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import { type Thread } from "../../types";
import {
  planSidebarThreadDrop,
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
} from "../Sidebar.logic";
import {
  buildScopedSidebarItems,
  projectSidebarDrop,
  sidebarDropConfirmed,
  type SidebarDropHold,
  type SidebarLists,
} from "./sidebarDragScope.logic";

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("work"),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pullRequests: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}
const key = (row: Pick<Thread, "id" | "environmentId">) =>
  scopedThreadKey(scopeThreadRef(row.environmentId, row.id));
const empty: SidebarLists = { pinned: [], active: [], snoozed: [], settled: [] };
const expanded = {
  snoozedExpanded: true,
  settledExpanded: true,
  settledLimit: 10,
  routeThreadKey: null,
};

it.each(["active", "snoozed", "settled"] as const)(
  "materializes only owning account/project pins when dragging from %s",
  (section) => {
    const source = thread("move", section === "settled" ? { settledOverride: "settled" } : {});
    const one = thread("one", { pinnedAt: "2026-03-09" });
    const two = thread("two", { pinnedAt: "2026-03-09" });
    const foreign = thread("one", {
      environmentId: EnvironmentId.make("personal"),
      pinOrderKey: "a0",
    });
    const sibling = thread("sibling", {
      projectId: ProjectId.make("another-space"),
      pinOrderKey: "a1",
    });
    const lists = { ...empty, pinned: [one, two], [section]: [source] };
    const items = buildScopedSidebarItems(lists, expanded);
    const target = resolveSidebarDropTarget(items, key(source), key(one));
    if (!target) throw new Error("Expected target");
    const all = [source, one, two, foreign, sibling];
    const drop = planSidebarThreadDrop({
      activeKey: key(source),
      activeSection: section,
      target,
      supportsSettlement: true,
      pinnedOrder: [key(one), key(two)],
      activeOrder: section === "active" ? [key(source)] : [],
      pinnedKeysById: new Map(all.map((row) => [key(row), row.pinOrderKey])),
      activeKeysById: new Map(all.map((row) => [key(row), row.activeOrderKey])),
    });
    expect(drop.kind).toBe("pin");
    if (drop.kind !== "pin") throw new Error("Expected pin");
    expect(drop.order).toEqual([key(source), key(one), key(two)]);
    expect(drop.extraAssignments.map((write) => write.id).sort()).toEqual(
      [key(one), key(two)].sort(),
    );
    const keys = [drop.orderKey, ...drop.extraAssignments.map((write) => write.orderKey)];
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain("a0");
    expect(keys).not.toContain("a1");
    expect(resolveSidebarDropTarget(items, key(source), key(foreign))).toBeNull();
    expect(resolveSidebarDropTarget(items, key(source), key(sibling))).toBeNull();
  },
);

it("materializes only this project's active order when waking a snoozed pin", () => {
  const source = thread("source", { pinnedAt: "2026-03-09", snoozedUntil: "2027-01-01" });
  const one = thread("one");
  const two = thread("two");
  const foreign = thread("foreign", {
    activeOrderKey: "a0",
    environmentId: EnvironmentId.make("personal"),
  });
  const lists = { ...empty, active: [one, two], snoozed: [source] };
  const target = resolveSidebarDropTarget(
    buildScopedSidebarItems(lists, expanded),
    key(source),
    key(two),
  );
  if (!target) throw new Error("Expected target");
  const all = [source, one, two, foreign];
  const drop = planSidebarThreadDrop({
    activeKey: key(source),
    activeSection: "snoozed",
    activePinned: true,
    target,
    pinnedOrder: [],
    activeOrder: [key(one), key(two)],
    pinnedKeysById: new Map(),
    activeKeysById: new Map(all.map((row) => [key(row), row.activeOrderKey])),
  });
  if (drop.kind !== "move-active") throw new Error("Expected active move");
  expect(drop).toMatchObject({ unpin: true, unsnooze: true, unsettle: false });
  expect(drop.assignments.map((write) => write.id).sort()).toEqual(
    [key(source), key(one), key(two)].sort(),
  );
  expect(drop.assignments.map((write) => write.orderKey)).not.toContain("a0");
});

it("excludes inert rows, retains the selected flat-shelf row in place, and provides empty destinations", () => {
  const rows = [thread("one"), thread("selected"), thread("three")];
  const input = {
    ...expanded,
    snoozedExpanded: false,
    settledExpanded: false,
    routeThreadKey: key(rows[1]!),
  };
  const items = buildScopedSidebarItems({ ...empty, settled: rows }, input);
  expect(items.map(sidebarListItemId)).toEqual([
    sidebarMarkerId("pinned-header"),
    sidebarMarkerId("pinned-divider"),
    sidebarMarkerId("active-placeholder"),
    sidebarMarkerId("settled-header"),
    sidebarMarkerId("settled-placeholder"),
    key(rows[1]!),
  ]);
  const hierarchy = buildScopedSidebarItems(
    { ...empty, settled: rows },
    { ...input, retainCurrentSettled: false },
  );
  expect(hierarchy.map(sidebarListItemId)).toContain(sidebarMarkerId("settled-placeholder"));
  expect(hierarchy.filter((item) => item.kind === "thread")).toEqual([]);
  const expandedHierarchy = buildScopedSidebarItems(
    { ...empty, settled: rows },
    { ...input, settledExpanded: true, settledLimit: 1, retainCurrentSettled: false },
  );
  expect(expandedHierarchy.filter((item) => item.kind === "thread").map(sidebarListItemId)).toEqual(
    [key(rows[0]!), key(rows[1]!)],
  );
  const open = buildScopedSidebarItems(
    { ...empty, settled: rows },
    { ...input, settledExpanded: true, settledLimit: 1 },
  );
  expect(open.filter((item) => item.kind === "thread").map(sidebarListItemId)).toEqual([
    key(rows[0]!),
    key(rows[1]!),
  ]);
});

describe("scoped optimistic acknowledgement", () => {
  const one = thread("one", { activeOrderKey: null });
  const two = thread("two", { activeOrderKey: null });
  const hold: SidebarDropHold = {
    key: key(one),
    sourceSection: "active",
    section: "active",
    occurredAt: "2026-03-10",
    clearsSnooze: true,
    order: [key(two), key(one)],
    keysAtDrop: new Map([
      [key(one), null],
      [key(two), null],
    ]),
    assignedKeys: new Map([
      [key(one), "a1"],
      [key(two), "a0"],
    ]),
  };
  it("holds through partial writes, then releases when every assignment lands", () => {
    const lists = { ...empty, active: [one, two] };
    expect(sidebarDropConfirmed(lists, hold)).toBe(false);
    expect(projectSidebarDrop(lists, hold).active.map(key)).toEqual([key(two), key(one)]);
    expect(
      sidebarDropConfirmed({ ...empty, active: [{ ...two, activeOrderKey: "a0" }, one] }, hold),
    ).toBe(false);
    expect(
      sidebarDropConfirmed(
        {
          ...empty,
          active: [
            { ...two, activeOrderKey: "a0" },
            { ...one, activeOrderKey: "a1" },
          ],
        },
        hold,
      ),
    ).toBe(true);
  });
  it("releases for concurrent keys, membership changes or a disappearing source", () => {
    expect(
      sidebarDropConfirmed({ ...empty, active: [one, { ...two, activeOrderKey: "a2" }] }, hold),
    ).toBe(true);
    expect(sidebarDropConfirmed({ ...empty, active: [one, two, thread("new")] }, hold)).toBe(true);
    expect(sidebarDropConfirmed({ ...empty, active: [two] }, hold)).toBe(true);
  });
  it("waits for lifecycle and keys, and leaves another account's scope untouched", () => {
    const pinHold = {
      ...hold,
      sourceSection: "settled" as const,
      section: "pinned" as const,
      order: [key(one)],
      assignedKeys: new Map([[key(one), "a0"]]),
    };
    expect(sidebarDropConfirmed({ ...empty, settled: [one] }, pinHold)).toBe(false);
    const own = { ...empty, pinned: [{ ...one, pinnedAt: "2026-03-10", pinOrderKey: null }] };
    const foreign = {
      ...empty,
      active: [thread("unrelated", { environmentId: EnvironmentId.make("personal") })],
    };
    expect(sidebarDropConfirmed(own, pinHold)).toBe(false);
    expect(projectSidebarDrop(foreign, pinHold)).toBe(foreign);
  });
});
