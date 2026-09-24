import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadStatusPill } from "../Sidebar.logic";
import {
  buildSegmentEnvironmentFilters,
  buildSidebarSegments,
  buildSidebarSegmentViews,
  changeSegmentShelf,
  flattenSegmentsForNavigation,
  groupProjectsPerAccount,
  layoutSegmentBars,
  NO_ACCOUNT_SEGMENT_ID,
  NO_SEGMENT_SHELVES,
  pageSegmentSettledThreads,
  reorderIdsWithinSegment,
  resetSegmentSettledPages,
  resolveSidebarSegmentation,
  rollupAttention,
  SEGMENT_COLLAPSED_KEY,
  SegmentCollapsedSchema,
  toggleSegmentCollapsed,
  type SidebarSegmentViewsInput,
} from "./sidebarSegments.logic";

const decodeCollapsed = Schema.decodeUnknownSync(Schema.fromJsonString(SegmentCollapsedSchema));
const encodeCollapsed = Schema.encodeSync(Schema.fromJsonString(SegmentCollapsedSchema));

interface TestThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
}
interface TestNode {
  readonly group: {
    readonly key: string;
    readonly memberProjectRefs: ReadonlyArray<{ environmentId: string; projectId: string }>;
  };
  readonly children: ReadonlyArray<TestNode>;
}

const thread = (id: string, environmentId: string, projectId = "project"): TestThread => ({
  id,
  environmentId,
  projectId,
});
const project = (environmentId: string, id = "project") => ({ environmentId, id });
const node = (key: string, environmentId: string, projectId = "project"): TestNode => ({
  group: { key, memberProjectRefs: [{ environmentId, projectId }] },
  children: [],
});

// relay-work and relay-home are owned; relay-untagged is a relay entry no
// account has listed yet; local is this device.
const accountByEnvironmentId = new Map([
  ["relay-work", "account-work"],
  ["relay-home", "account-home"],
]);
const accountLabels = new Map<string, string>();
const segmentation = {
  knownAccountIds: ["account-work", "account-home"],
  accountByEnvironmentId,
  accountLabels,
};

const pill = (label: ThreadStatusPill["label"]): ThreadStatusPill => ({
  label,
  colorClass: "",
  dotClass: "",
  pulse: false,
});

function views(overrides: Partial<SidebarSegmentViewsInput<TestThread, TestNode>> = {}) {
  return buildSidebarSegmentViews<TestThread, TestNode>({
    segmentation,
    collapsedSegmentIds: [],
    projects: [project("relay-work"), project("relay-home")],
    pinnedThreads: [],
    activeThreads: [],
    snoozedThreads: [],
    settledThreads: [],
    nestedSettledThreads: [],
    scopedSagaTree: [],
    scopedProjectKeys: null,
    environmentFilters: buildSegmentEnvironmentFilters(segmentation),
    hasNoAccountDrafts: false,
    nestSagaProjects: false,
    collapsedProjectKeys: new Set(),
    settledVisibleCount: 10,
    snoozedShelfExpanded: false,
    settledShelfExpanded: false,
    shelves: NO_SEGMENT_SHELVES,
    isRouteThread: () => false,
    statusOf: () => null,
    ...overrides,
  });
}

const ids = (threads: ReadonlyArray<TestThread>) => threads.map((entry) => entry.id);

describe("resolveSidebarSegmentation", () => {
  const input = {
    knownAccountIds: ["account-work", "account-home"],
    accountByEnvironmentId,
    accountLabels,
  };

  it("segments only with two or more known accounts", () => {
    expect(resolveSidebarSegmentation({ ...input })).toEqual(segmentation);
    expect(
      resolveSidebarSegmentation({
        ...input,
        knownAccountIds: ["account-work"],
      }),
    ).toBeNull();
    expect(resolveSidebarSegmentation({ ...input, knownAccountIds: [] })).toBeNull();
  });
});

describe("buildSidebarSegments", () => {
  it("orders segments by the known list and puts what no account owns last", () => {
    const segments = buildSidebarSegments({
      segmentation: { ...segmentation, knownAccountIds: ["account-home", "account-work"] },
      collapsedSegmentIds: [],
      threads: [
        thread("local-1", "local"),
        thread("work-1", "relay-work"),
        thread("untagged-1", "relay-untagged"),
        thread("home-1", "relay-home"),
        thread("work-2", "relay-work"),
      ],
      projects: [project("relay-work"), project("local")],
    });
    expect(segments.map((segment) => [segment.id, ids(segment.threads)])).toEqual([
      ["account-home", ["home-1"]],
      ["account-work", ["work-1", "work-2"]],
      [NO_ACCOUNT_SEGMENT_ID, ["local-1", "untagged-1"]],
    ]);
    expect(segments.map((segment) => segment.projects.map((entry) => entry.environmentId))).toEqual(
      [[], ["relay-work"], ["local"]],
    );
  });

  it("keeps an empty account segment and drops an empty no-account segment", () => {
    const segments = buildSidebarSegments({
      segmentation,
      collapsedSegmentIds: [],
      threads: [thread("work-1", "relay-work")],
      projects: [],
    });
    expect(segments.map((segment) => [segment.accountId, segment.threads.length])).toEqual([
      ["account-work", 1],
      ["account-home", 0],
    ]);
  });

  it("treats an environment owned by an unknown account as having no account", () => {
    const segments = buildSidebarSegments({
      segmentation: {
        knownAccountIds: ["account-work", "account-home"],
        accountByEnvironmentId: new Map([["relay-gone", "account-gone"]]),
        accountLabels,
      },
      collapsedSegmentIds: [],
      threads: [thread("gone-1", "relay-gone")],
      projects: [],
    });
    expect(segments.at(-1)?.accountId).toBeNull();
    expect(ids(segments.at(-1)?.threads ?? [])).toEqual(["gone-1"]);
  });

  it("marks collapsed accounts, and never the no-account segment", () => {
    const segments = buildSidebarSegments({
      segmentation,
      collapsedSegmentIds: ["account-home", NO_ACCOUNT_SEGMENT_ID],
      threads: [thread("local-1", "local")],
      projects: [],
    });
    expect(segments.map((segment) => segment.collapsed)).toEqual([false, true, false]);
  });
});

describe("buildSidebarSegmentViews", () => {
  it("runs the flat composition per segment, with pinned rows per segment", () => {
    const pinnedWork = thread("pin-work", "relay-work");
    const pinnedHome = thread("pin-home", "relay-home");
    const pinnedLocal = thread("pin-local", "local");
    const snoozedHome = thread("snoozed-home", "relay-home");
    const result = views({
      // The sidebar's one pinned order interleaves accounts.
      pinnedThreads: [pinnedHome, pinnedLocal, pinnedWork],
      activeThreads: [thread("a-work", "relay-work"), thread("a-home", "relay-home")],
      snoozedThreads: [snoozedHome, thread("snoozed-work", "relay-work")],
      // Behind a closed shelf only the open thread keeps its row.
      isRouteThread: (entry) => entry === snoozedHome,
    });
    expect(result.map((segment) => ids(segment.pinnedThreads))).toEqual([
      ["pin-work"],
      ["pin-home"],
      ["pin-local"],
    ]);
    expect(result.map((segment) => ids(segment.orderedThreads))).toEqual([
      ["pin-work", "a-work"],
      ["pin-home", "a-home", "snoozed-home"],
      ["pin-local"],
    ]);
    expect(result.map((segment) => segment.snoozedThreads.length)).toEqual([1, 1, 0]);
  });

  it("pages the settled shelf per segment", () => {
    const settledThreads = [
      thread("s-work-1", "relay-work"),
      thread("s-home-1", "relay-home"),
      thread("s-work-2", "relay-work"),
      thread("s-work-3", "relay-work"),
    ];
    const expanded = views({
      settledThreads,
      settledShelfExpanded: true,
      settledVisibleCount: 2,
    });
    expect(expanded.map((segment) => ids(segment.renderedSettledThreads))).toEqual([
      ["s-work-1", "s-work-2"],
      ["s-home-1"],
    ]);
    expect(expanded.map((segment) => segment.hiddenSettledCount)).toEqual([1, 0]);

    const collapsedShelf = views({
      settledThreads,
      settledVisibleCount: 2,
      isRouteThread: (entry) => entry.id === "s-work-3",
    });
    expect(collapsedShelf.map((segment) => ids(segment.orderedThreads))).toEqual([
      ["s-work-3"],
      [],
    ]);
  });

  it("keeps the page limit independent of the extra deep-linked row across shelf toggles", () => {
    const settledThreads = [1, 2, 3, 4, 5].map((id) => thread(`work-${id}`, "relay-work"));
    const isRouteThread = (entry: TestThread) => entry.id === "work-5";
    for (const settledShelfExpanded of [true, false, true]) {
      const [segment] = views({
        settledThreads,
        settledShelfExpanded,
        settledVisibleCount: 1,
        shelves: new Map([["account-work", { settledVisibleCount: 2 }]]),
        isRouteThread,
      });
      expect(segment!.settledVisibleCount).toBe(2);
      const expanded = pageSegmentSettledThreads({
        settledThreads: segment!.settledThreads,
        visibleCount: segment!.settledVisibleCount,
        shelfExpanded: true,
        isRouteThread,
      });
      expect(ids(expanded.rendered)).toEqual(["work-1", "work-2", "work-5"]);
      expect(segment!.hiddenSettledCount).toBe(2);
    }
  });

  it("gives each segment its own project tree in hierarchy mode", () => {
    const work = thread("work-1", "relay-work");
    const home = thread("home-1", "relay-home");
    const homeSettled = thread("home-settled", "relay-home");
    const result = views({
      projects: [project("relay-work"), project("relay-home"), project("local")],
      nestSagaProjects: true,
      activeThreads: [home, work],
      settledThreads: [homeSettled],
      nestedSettledThreads: [homeSettled],
      scopedSagaTree: [
        node("repo@account:account-home", "relay-home"),
        node("repo@account:account-work", "relay-work"),
        node("repo", "local"),
      ],
      collapsedProjectKeys: new Set(["repo@account:account-work"]),
    });
    expect(result.map((segment) => segment.scopedSagaTree.map((entry) => entry.group.key))).toEqual(
      [["repo@account:account-work"], ["repo@account:account-home"], ["repo"]],
    );
    // A collapsed project hides its rows from navigation, as it does on screen.
    expect(result.map((segment) => ids(segment.orderedThreads))).toEqual([
      [],
      ["home-1", "home-settled"],
      [],
    ]);
  });

  it("puts a draft in its environment's segment while its project is not loaded", () => {
    // relay-home is offline or needs sign-in: no project shell and no thread of it is loaded.
    const result = views({ projects: [project("relay-work")] });
    const shownIn = (environmentId: string) =>
      result.filter((segment) => segment.ownsEnvironment(environmentId)).map(({ id }) => id);
    expect(shownIn("relay-home")).toEqual(["account-home"]);
    expect(shownIn("relay-work")).toEqual(["account-work"]);
    // The project scope applies apart from the segment, so it cannot hide that draft either.
    const scope = new Set(["relay-home:project"]);
    expect(views({ scopedProjectKeys: scope }).map((segment) => segment.scopedProjectKeys)).toEqual(
      [scope, scope],
    );
  });

  it("keeps the no-account segment for a draft that waits there with nothing loaded", () => {
    const result = views({ projects: [], hasNoAccountDrafts: true });
    expect(result.map((segment) => segment.id)).toEqual([
      "account-work",
      "account-home",
      NO_ACCOUNT_SEGMENT_ID,
    ]);
    expect(
      result.filter((segment) => segment.ownsEnvironment("local")).map(({ id }) => id),
    ).toEqual([NO_ACCOUNT_SEGMENT_ID]);
    expect(views({ projects: [] }).map((segment) => segment.id)).not.toContain(
      NO_ACCOUNT_SEGMENT_ID,
    );
  });

  it("opens, closes, and pages one segment's shelves and leaves the others", () => {
    const settledThreads = ["1", "2", "3"].flatMap((n) => [
      thread(`s-work-${n}`, "relay-work"),
      thread(`s-home-${n}`, "relay-home"),
    ]);
    const snoozedThreads = [thread("z-work", "relay-work"), thread("z-home", "relay-home")];
    let shelves = changeSegmentShelf(NO_SEGMENT_SHELVES, "account-home", (shelf) => ({
      ...shelf,
      settledVisibleCount: 2,
      snoozedExpanded: true,
    }));
    const paged = views({
      settledThreads,
      snoozedThreads,
      settledShelfExpanded: true,
      settledVisibleCount: 1,
      shelves,
    });
    expect(paged.map((segment) => ids(segment.renderedSettledThreads))).toEqual([
      ["s-work-1"],
      ["s-home-1", "s-home-2"],
    ]);
    expect(paged.map((segment) => ids(segment.visibleSnoozedThreads))).toEqual([[], ["z-home"]]);

    shelves = changeSegmentShelf(shelves, "account-work", (shelf) => ({
      ...shelf,
      settledExpanded: false,
    }));
    const closed = views({
      settledThreads,
      settledShelfExpanded: true,
      settledVisibleCount: 1,
      shelves: resetSegmentSettledPages(shelves),
    });
    expect(closed.map((segment) => segment.settledShelfExpanded)).toEqual([false, true]);
    // A project scope flip starts the pages over and keeps which shelves are open.
    expect(closed.map((segment) => ids(segment.renderedSettledThreads))).toEqual([
      [],
      ["s-home-1"],
    ]);
  });

  it("rolls attention up from the segment's pinned and active threads", () => {
    const waiting = thread("waiting", "relay-home");
    const result = views({
      pinnedThreads: [thread("working", "relay-work")],
      activeThreads: [waiting, thread("done", "relay-home")],
      statusOf: (entry) =>
        entry.id === "waiting"
          ? pill("Awaiting Input")
          : entry.id === "working"
            ? pill("Working")
            : pill("Completed"),
    });
    expect(result.map((segment) => segment.attention?.label ?? null)).toEqual([
      "Working",
      "Awaiting Input",
    ]);
    expect(result.map((segment) => segment.hasRows)).toEqual([true, true]);
  });
});

describe("flattenSegmentsForNavigation", () => {
  it("walks segments in visual order and skips collapsed ones", () => {
    const result = views({
      collapsedSegmentIds: ["account-home"],
      pinnedThreads: [thread("pin-home", "relay-home"), thread("pin-local", "local")],
      activeThreads: [
        thread("a-local", "local"),
        thread("a-work", "relay-work"),
        thread("a-home", "relay-home"),
      ],
    });
    expect(ids(flattenSegmentsForNavigation(result))).toEqual(["a-work", "pin-local", "a-local"]);
    // Every row a segment shows is walked, in the order the segment shows it.
    expect(ids(flattenSegmentsForNavigation(result))).toEqual(
      result
        .filter((segment) => !segment.collapsed)
        .flatMap((segment) => ids(segment.orderedThreads)),
    );
  });
});

describe("rollupAttention", () => {
  it("returns the highest-priority status", () => {
    expect(
      rollupAttention([pill("Completed"), null, pill("Plan Ready"), pill("Monitoring")])?.label,
    ).toBe("Plan Ready");
    expect(
      rollupAttention([pill("Working"), pill("Pending Approval"), pill("Awaiting Input")])?.label,
    ).toBe("Pending Approval");
    expect(rollupAttention([pill("Working"), pill("Awaiting Input")])?.label).toBe(
      "Awaiting Input",
    );
  });

  it("is null without a status", () => {
    expect(rollupAttention([null, null])).toBeNull();
    expect(rollupAttention([])).toBeNull();
  });
});

describe("pageSegmentSettledThreads", () => {
  const settledThreads = ["s1", "s2", "s3", "s4"];

  it("keeps the open thread visible past the page and behind a collapsed shelf", () => {
    const paged = pageSegmentSettledThreads({
      settledThreads,
      visibleCount: 2,
      shelfExpanded: true,
      isRouteThread: (id) => id === "s4",
    });
    expect(paged).toEqual({ rendered: ["s1", "s2", "s4"], hiddenCount: 1 });
    expect(
      pageSegmentSettledThreads({
        settledThreads,
        visibleCount: 2,
        shelfExpanded: false,
        isRouteThread: (id) => id === "s1",
      }),
    ).toEqual({ rendered: ["s1"], hiddenCount: 2 });
  });
});

describe("groupProjectsPerAccount", () => {
  const projects = [project("relay-work"), project("relay-home"), project("local")];
  const group = (items: ReadonlyArray<{ environmentId: string }>) => [
    { key: "repo", environments: items.map((item) => item.environmentId) },
  ];
  const rekey = (entry: { key: string; environments: string[] }, key: (key: string) => string) => ({
    ...entry,
    key: key(entry.key),
  });

  it("groups once per account and keeps the keys apart", () => {
    expect(groupProjectsPerAccount({ segmentation, projects, group, rekey })).toEqual([
      { key: "repo@account:account-work", environments: ["relay-work"] },
      { key: "repo@account:account-home", environments: ["relay-home"] },
      { key: "repo", environments: ["local"] },
    ]);
  });

  it("is the plain grouping without a segmentation", () => {
    expect(groupProjectsPerAccount({ segmentation: null, projects, group, rekey })).toEqual([
      { key: "repo", environments: ["relay-work", "relay-home", "local"] },
    ]);
  });
});

describe("segment collapse persistence", () => {
  it("stores under its own key, as a list of segment ids", () => {
    expect(SEGMENT_COLLAPSED_KEY).toBe("lecturn:sidebar:segment-collapsed");
    const stored = encodeCollapsed(toggleSegmentCollapsed([], "account-home"));
    expect(stored).toBe('["account-home"]');
    expect(decodeCollapsed(stored)).toEqual(["account-home"]);
    expect(() => decodeCollapsed('{"account-home":true}')).toThrow();
  });

  it("toggles one segment and leaves the others", () => {
    const collapsed = toggleSegmentCollapsed(["account-work"], "account-home");
    expect(collapsed).toEqual(["account-work", "account-home"]);
    expect(toggleSegmentCollapsed(collapsed, "account-work")).toEqual(["account-home"]);
  });
});

describe("reorderIdsWithinSegment", () => {
  const segments = [
    { pinnedThreads: [thread("work-1", "relay-work"), thread("work-2", "relay-work")] },
    { pinnedThreads: [thread("home-1", "relay-home")] },
  ];
  const idOf = (entry: TestThread) => entry.id;
  // The sidebar's one pinned order interleaves accounts.
  const orderedIds = ["work-2", "home-1", "work-1"];

  it("plans a drop against the moved thread's segment alone", () => {
    expect(reorderIdsWithinSegment({ segments, orderedIds, movedId: "work-1", idOf })).toEqual([
      "work-2",
      "work-1",
    ]);
    expect(reorderIdsWithinSegment({ segments, orderedIds, movedId: "home-1", idOf })).toEqual([
      "home-1",
    ]);
  });

  it("plans against the whole pinned block while the sidebar is one list", () => {
    expect(reorderIdsWithinSegment({ segments: null, orderedIds, movedId: "work-1", idOf })).toBe(
      orderedIds,
    );
  });
});

describe("layoutSegmentBars", () => {
  const bar = (accountId: string | null, attention: ThreadStatusPill | null = null) => ({
    accountId,
    attention,
  });

  it("sticks every bar at the top, and at the bottom only a bar with attention", () => {
    const layout = layoutSegmentBars([
      bar("a"),
      bar("b", pill("Working")),
      bar("c"),
      bar("d", pill("Awaiting Input")),
      bar(null),
    ]);
    expect(layout.map((entry) => entry.top)).toEqual([
      "0rem",
      "2.25rem",
      "4.5rem",
      "6.75rem",
      "9rem",
    ]);
    expect(layout.map((entry) => entry.bottom)).toEqual([
      undefined,
      "2.25rem",
      undefined,
      "0rem",
      undefined,
    ]);
  });

  it("clears a row of the bars that can cover it, per side", () => {
    const layout = layoutSegmentBars([bar("a"), bar("b", pill("Working")), bar("c"), bar(null)]);
    expect(layout.map((entry) => [entry.coveredTop, entry.coveredBottom])).toEqual([
      ["2.25rem", "2.25rem"],
      ["4.5rem", "0rem"],
      ["6.75rem", "0rem"],
      ["7.25rem", "0rem"],
    ]);
  });
});
