import { SquireId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSquireTrackMenuItems,
  parseSquireTrackMenuId,
  squireCoversThread,
  squireSelectionGrants,
  squireSelectionMenuState,
  squireStaveScope,
  squireTrackers,
  squireTrackMenuState,
  type SquireThreadScope,
  type SquireTracker,
} from "./squireTrack.logic";

const scope = (threadId: string, extra: Partial<SquireThreadScope> = {}): SquireThreadScope => ({
  threadId,
  projectId: "project-a",
  staveSpaceId: null,
  staveSagaId: null,
  ...extra,
});

const tracker = (name: string, grants: SquireTracker["grants"]): SquireTracker => ({
  id: SquireId.make(name.toLowerCase()),
  name,
  grants,
});

describe("squireCoversThread", () => {
  it("covers a thread through its own grant or its project", () => {
    expect(squireCoversThread([{ kind: "thread", targetId: "t1" }], scope("t1"))).toBe(true);
    expect(squireCoversThread([{ kind: "thread", targetId: "t2" }], scope("t1"))).toBe(false);
    expect(squireCoversThread([{ kind: "project", targetId: "project-a" }], scope("t1"))).toBe(
      true,
    );
    expect(squireCoversThread([{ kind: "project", targetId: "project-b" }], scope("t1"))).toBe(
      false,
    );
  });

  it("lets an exclusion beat every container grant", () => {
    const grants = [
      { kind: "project", targetId: "project-a" },
      { kind: "staveSpace", targetId: "space-1" },
      { kind: "exclusion", targetId: "t1" },
    ] as const;
    expect(squireCoversThread(grants, scope("t1", { staveSpaceId: "space-1" }))).toBe(false);
    expect(squireCoversThread(grants, scope("t2", { staveSpaceId: "space-1" }))).toBe(true);
  });

  it("covers through a Stave space or saga, including a saga's own coordinating space", () => {
    const member = { spaceId: "space-1", isSaga: false, memberOf: "saga-1" };
    const coordinator = { spaceId: "saga-1", isSaga: true };
    expect(
      squireCoversThread(
        [{ kind: "staveSpace", targetId: "space-1" }],
        scope("t1", squireStaveScope(member)),
      ),
    ).toBe(true);
    expect(
      squireCoversThread(
        [{ kind: "staveSaga", targetId: "saga-1" }],
        scope("t1", squireStaveScope(member)),
      ),
    ).toBe(true);
    expect(
      squireCoversThread(
        [{ kind: "staveSaga", targetId: "saga-1" }],
        scope("t2", squireStaveScope(coordinator)),
      ),
    ).toBe(true);
    expect(squireCoversThread([{ kind: "staveSaga", targetId: "saga-1" }], scope("t3"))).toBe(
      false,
    );
  });
});

describe("squireTrackers", () => {
  const record = (
    id: string,
    patch: Partial<{ role: "lead" | "squire"; status: "active" | "paused"; lifecycle: string }>,
  ) => ({
    squire: {
      id: SquireId.make(id),
      name: id,
      role: "squire" as const,
      status: "active" as const,
      lifecycle: "ready" as const,
      grants: [],
      ...patch,
    } as never,
  });

  it("never offers the Lead or a Squire that is not set up", () => {
    const ids = squireTrackers([
      record("lead", { role: "lead" }),
      record("release", {}),
      record("paused", { status: "paused" }),
      record("creating", { lifecycle: "creating" }),
      record("orphan", { lifecycle: "needs_provider" }),
    ]).map((entry) => entry.id);
    expect(ids).toEqual(["release", "paused"]);
  });
});

describe("buildSquireTrackMenuItems", () => {
  const access = { canTrack: true, canUntrack: true };
  const target = { kind: "thread" as const, ...scope("t1") };

  it("names the one Squire, and nests several under Track with", () => {
    const release = tracker("Release", []);
    const research = tracker("Research", []);
    expect(
      buildSquireTrackMenuItems(squireTrackMenuState([release], target, access)).map(
        (item) => item.label,
      ),
    ).toEqual(["Track with Release"]);
    const [nested] = buildSquireTrackMenuItems(
      squireTrackMenuState([release, research], target, access),
    );
    expect(nested?.label).toBe("Track with");
    expect(nested?.children?.map((child) => child.label)).toEqual(["Release", "Research"]);
  });

  it("offers Stop tracking for the Squire that tracks it, and Track for the other", () => {
    const items = buildSquireTrackMenuItems(
      squireTrackMenuState(
        [tracker("Release", [{ kind: "project", targetId: "project-a" }]), tracker("Research", [])],
        target,
        access,
      ),
    );
    expect(items.map((item) => [item.id, item.label])).toEqual([
      ["squire-track:research", "Track with Research"],
      ["squire-untrack:release", "Stop tracking (Release)"],
    ]);
  });

  it("drops each direction its permission does not allow", () => {
    const state = squireTrackMenuState(
      [tracker("Release", [{ kind: "thread", targetId: "t1" }]), tracker("Research", [])],
      target,
      { canTrack: false, canUntrack: true },
    );
    expect(buildSquireTrackMenuItems(state).map((item) => item.id)).toEqual([
      "squire-untrack:release",
    ]);
  });

  it("tracks a container only by its own grant", () => {
    const release = tracker("Release", [{ kind: "staveSaga", targetId: "saga-1" }]);
    const items = buildSquireTrackMenuItems(
      squireTrackMenuState([release], { kind: "staveSpace", targetId: "space-1" }, access),
    );
    expect(items.map((item) => item.id)).toEqual(["squire-track:release"]);
  });

  it("round-trips the chosen Squire through the menu id", () => {
    expect(parseSquireTrackMenuId("squire-untrack:release")).toEqual({
      action: "untrack",
      squireId: "release",
    });
    expect(parseSquireTrackMenuId("squire-track")).toBeNull();
    expect(parseSquireTrackMenuId("rename")).toBeNull();
  });
});

describe("multi-select", () => {
  const access = { canTrack: true, canUntrack: true };
  const scopes = [scope("t1"), scope("t2", { projectId: "project-b" })];

  it("tracks until every selected thread is tracked, then untracks", () => {
    const partly = tracker("Release", [{ kind: "project", targetId: "project-a" }]);
    const fully = tracker("Research", [
      { kind: "project", targetId: "project-a" },
      { kind: "thread", targetId: "t2" },
    ]);
    const items = buildSquireTrackMenuItems(
      squireSelectionMenuState([partly, fully], scopes, access),
    );
    expect(items.map((item) => item.label)).toEqual([
      "Track with Release (2)",
      "Stop tracking (Research) (2)",
    ]);
  });

  it("grants only the threads not yet covered, and untracks each selected thread", () => {
    const partly = tracker("Release", [{ kind: "project", targetId: "project-a" }]);
    expect(squireSelectionGrants(partly, scopes, "track")).toEqual([
      { kind: "thread", targetId: "t2" },
    ]);
    expect(squireSelectionGrants(partly, scopes, "untrack")).toEqual([
      { kind: "thread", targetId: "t1" },
      { kind: "thread", targetId: "t2" },
    ]);
  });
});
