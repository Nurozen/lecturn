import { describe, expect, it } from "vite-plus/test";
import type {
  OlderSettledPages,
  OlderSettledShelfEnvironment,
} from "@lecturn/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import {
  listSettledInParts,
  projectOlderSettledScopes,
  projectSettledPage,
  wantedPartSettledPages,
  withUnloadedSettled,
} from "./sidebarSettledGroups";

const rows = Array.from({ length: 6 }, (_, index) => ({
  id: ThreadId.make(`thread-${index}`),
  environmentId: EnvironmentId.make("local"),
}));

describe("project settled shelves", () => {
  it("keeps each project's history collapsed and counts it without rendering", () => {
    expect(projectSettledPage(rows, undefined, null, 2)).toMatchObject({
      expanded: false,
      total: 6,
      visible: [],
      hidden: 6,
    });
    expect(projectSettledPage(rows, { expanded: true, limit: 2 }, null, 2).visible).toEqual(
      rows.slice(0, 2),
    );
  });
  it("shows a deep-linked settled thread without loading the entire tail", () => {
    const page = projectSettledPage(rows, undefined, "local:thread-5", 2);
    expect(page.expanded).toBe(true);
    expect(page.visible).toEqual([rows[0], rows[1], rows[5]]);
    expect(page.hidden).toBe(3);
  });
  it("respects a deliberate collapse and distinguishes environments", () => {
    expect(
      projectSettledPage(rows, { expanded: false, limit: 2 }, "local:thread-5", 2).visible,
    ).toEqual([]);
    expect(projectSettledPage(rows, undefined, "remote:thread-5", 2).expanded).toBe(false);
  });
});

describe("older settled threads in segment and nested project shelves", () => {
  it("counts threads the shell left out as hidden, so Show more appears", () => {
    const page = withUnloadedSettled(
      projectSettledPage(rows, { expanded: true, limit: 6 }, null, 2),
      4,
    );
    expect(page).toMatchObject({ total: 10, hidden: 4 });
    expect(page.visible).toHaveLength(6);
  });

  it("scopes a nested project to its members per environment", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    expect(
      projectOlderSettledScopes([
        { environmentId: local, projectId: ProjectId.make("a") },
        { environmentId: remote, projectId: ProjectId.make("b") },
        { environmentId: local, projectId: ProjectId.make("c") },
      ]),
    ).toEqual([
      { environmentId: local, projectIds: ["a", "c"] },
      { environmentId: remote, projectIds: ["b"] },
    ]);
  });
});

describe("segment and nested project shelves over environments with different cuts", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const at = (day: number) => DateTime.formatIso(DateTime.makeUnsafe(day * DAY));
  const busy = EnvironmentId.make("busy");
  const quiet = EnvironmentId.make("quiet");
  const project = ProjectId.make("project");
  // The busy account cut yesterday (day 99); the quiet one keeps months of settled threads.
  const environment = (
    cutDay: number,
    pages: Partial<OlderSettledPages> = {},
    unloaded = 0,
  ): OlderSettledShelfEnvironment => ({
    older: {
      before: at(cutDay),
      beforeMs: cutDay * DAY,
      counts: new Map([[project, unloaded]]),
    },
    pages: { reads: [], frontier: { settledAt: at(cutDay) }, status: "ready", ...pages },
  });
  const settled = (environmentId: EnvironmentId, id: string, day: number) => ({
    id: ThreadId.make(id),
    environmentId,
    source: {
      id: ThreadId.make(id),
      settledAt: DateTime.makeUnsafe(day * DAY),
    },
  });
  const threads = [
    settled(busy, "busy-new", 100),
    settled(quiet, "quiet-week", 93),
    settled(quiet, "quiet-month", 70),
  ];

  it("lists a quieter environment's rows below a busier environment's cut", () => {
    const environments = new Map([
      [busy, environment(99, {}, 400)],
      [quiet, environment(10)],
    ]);
    // One list (every environment): the busy cut holds the quiet rows back until pages load.
    const oneList = listSettledInParts(threads, environments, () => [busy, quiet]);
    expect(oneList.map((thread) => thread.id)).toEqual(["busy-new"]);
    // One segment per environment: each lists against its own cut, so both quiet rows list
    // and count in the quiet segment.
    const segments = listSettledInParts(threads, environments, (thread) => [thread.environmentId]);
    expect(segments.map((thread) => thread.id)).toEqual(["busy-new", "quiet-week", "quiet-month"]);
    expect(segments.filter((thread) => thread.environmentId === quiet)).toHaveLength(2);
  });

  it("reads only the short shelf's own environments, and stops at their ends", () => {
    const environments = new Map([
      [busy, environment(99, {}, 400)],
      [quiet, environment(60, {}, 30)],
    ]);
    const quietShelf = {
      environmentIds: [quiet],
      expanded: true,
      listed: 2,
      limit: 10,
      unloaded: 30,
    };
    const busyShelf = {
      environmentIds: [busy],
      expanded: true,
      listed: 10,
      limit: 10,
      unloaded: 400,
    };
    const requested = new Map<EnvironmentId, number>();
    expect([
      ...wantedPartSettledPages({ requested, environments, parts: [busyShelf, quietShelf] }),
    ]).toEqual([[quiet, 1]]);
    // Reads continue from the quiet environment's own pages.
    expect([
      ...wantedPartSettledPages({
        requested: new Map([[quiet, 1]]),
        environments: new Map([
          [busy, environment(99, {}, 400)],
          [quiet, environment(60, { frontier: { settledAt: at(40) } }, 5)],
        ]),
        parts: [busyShelf, { ...quietShelf, listed: 7, unloaded: 5 }],
      }),
    ]).toEqual([[quiet, 2]]);
    // Its end (no frontier), a full or closed shelf, or nothing unread: no reads.
    const ended = new Map([
      [busy, environment(99, {}, 400)],
      [quiet, environment(60, { frontier: null })],
    ]);
    for (const [shelves, shelfEnvironments] of [
      [[quietShelf], ended],
      [[{ ...quietShelf, listed: 10 }], environments],
      [[{ ...quietShelf, expanded: false }], environments],
      [[{ ...quietShelf, unloaded: 0 }], environments],
      [
        [{ ...quietShelf, environmentIds: [quiet], unloaded: 30 }],
        new Map([[busy, environment(99, {}, 400)]]),
      ],
    ] as const) {
      expect(
        wantedPartSettledPages({ requested, environments: shelfEnvironments, parts: shelves }),
      ).toBe(requested);
    }
  });

  it("pages a nested project spanning both environments at its own frontier", () => {
    const environments = new Map([
      [busy, environment(99, {}, 400)],
      [quiet, environment(60, {}, 30)],
    ]);
    const project = {
      environmentIds: [busy, quiet],
      expanded: true,
      listed: 1,
      limit: 10,
      unloaded: 30,
    };
    // Rows merge across both, so the busier one reads down to the quiet one's cut first.
    expect([
      ...wantedPartSettledPages({ requested: new Map(), environments, parts: [project] }),
    ]).toEqual([[busy, 1]]);
  });
});
