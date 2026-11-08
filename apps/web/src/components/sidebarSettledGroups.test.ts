import { describe, expect, it } from "vite-plus/test";
import type {
  OlderSettledPages,
  OlderSettledShelfEnvironment,
} from "@lecturn/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import {
  listSettledByOwnEnvironment,
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
    settled(quiet, "quiet-ancient", 5),
  ];
  const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);
  const part = (unloaded: ReadonlyArray<readonly [EnvironmentId, number]>, listed = 2) => ({
    expanded: true,
    listed,
    limit: 10,
    unloaded: unloaded.map(([environmentId, count]) => ({ environmentId, count })),
  });

  it("lists every loaded row unless it is below its own environment's cut", () => {
    const environments = new Map([
      [busy, environment(99, {}, 400)],
      [quiet, environment(10)],
    ]);
    // The busy cut (day 99) holds back nothing of the quiet environment; only a quiet row below
    // the quiet cut (day 10) waits for its page.
    expect(ids(listSettledByOwnEnvironment(threads, environments))).toEqual([
      "busy-new",
      "quiet-week",
      "quiet-month",
    ]);
    // Once the quiet environment is read to its end, everything lists.
    expect(
      ids(
        listSettledByOwnEnvironment(
          threads,
          new Map([
            [busy, environment(99, {}, 400)],
            [quiet, environment(10, { frontier: null })],
          ]),
        ),
      ),
    ).toHaveLength(4);
  });

  it("a nested project over both environments lists and counts quiet rows with no read when the busy project has nothing older", () => {
    // The busy environment's cut is high because of other projects; this project has no older
    // threads there, and the quiet environment keeps all of its own.
    const environments = new Map([
      [busy, environment(99, {}, 0)],
      [quiet, environment(1)],
    ]);
    const listed = listSettledByOwnEnvironment(threads, environments);
    expect(ids(listed)).toEqual(["busy-new", "quiet-week", "quiet-month", "quiet-ancient"]);
    const page = withUnloadedSettled(
      projectSettledPage(listed, { expanded: true, limit: 10 }, null, 10),
      0,
    );
    expect(page).toMatchObject({ total: 4, hidden: 0 });
    const requested = new Map<EnvironmentId, number>();
    expect(
      wantedPartSettledPages({
        requested,
        environments,
        parts: [
          part(
            [
              [busy, 0],
              [quiet, 0],
            ],
            4,
          ),
        ],
      }),
    ).toBe(requested);
  });

  it("reads only the environments with unread threads for a short shelf, and stops at their ends", () => {
    const environments = new Map([
      [busy, environment(99, {}, 400)],
      [quiet, environment(60, {}, 30)],
    ]);
    const requested = new Map<EnvironmentId, number>();
    // A short nested project over both: only the quiet environment has unread threads for it.
    expect([
      ...wantedPartSettledPages({
        requested,
        environments,
        parts: [
          part([
            [busy, 0],
            [quiet, 30],
          ]),
        ],
      }),
    ]).toEqual([[quiet, 1]]);
    // A full busy shelf reads nothing; the next quiet page follows the first.
    expect([
      ...wantedPartSettledPages({
        requested: new Map([[quiet, 1]]),
        environments: new Map([
          [busy, environment(99, {}, 400)],
          [quiet, environment(60, { frontier: { settledAt: at(40) } }, 5)],
        ]),
        parts: [part([[busy, 400]], 10), part([[quiet, 5]], 7)],
      }),
    ]).toEqual([[quiet, 2]]);
    // One page at a time even when two shelves want the same environment.
    expect([
      ...wantedPartSettledPages({
        requested,
        environments,
        parts: [part([[quiet, 30]]), part([[quiet, 30]])],
      }),
    ]).toEqual([[quiet, 1]]);
    const ended = new Map([
      [busy, environment(99, {}, 400)],
      [quiet, environment(60, { frontier: null })],
    ]);
    const pending = new Map([
      [busy, environment(99, {}, 400)],
      [quiet, environment(60, { status: "pending" }, 30)],
    ]);
    const short = part([[quiet, 30]]);
    for (const [shelves, shelfEnvironments] of [
      [[short], ended],
      [[short], pending],
      [[{ ...short, listed: 10 }], environments],
      [[{ ...short, expanded: false }], environments],
      [[part([[quiet, 0]])], environments],
      [[short], new Map([[busy, environment(99, {}, 400)]])],
    ] as const) {
      expect(
        wantedPartSettledPages({ requested, environments: shelfEnvironments, parts: shelves }),
      ).toBe(requested);
    }
  });
});
