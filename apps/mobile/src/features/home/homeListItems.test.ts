import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeListLayout,
  buildHomeHierarchyV2Items,
  DEFAULT_GROUP_DISPLAY_STATE,
  HOME_INITIAL_VISIBLE_THREADS,
  HOME_SHOW_MORE_STEP,
  nextGroupDisplayState,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "./homeListItems";
import { buildThreadListV2Items, buildThreadListV2ListItems } from "../threads/threadListV2";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { buildHomeThreadGroups, type HomeThreadGroup } from "./homeThreadList";

const environmentId = EnvironmentId.make("environment-1");

function makeProject(id: string, title: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function makeThread(id: string, projectId: ProjectId): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeGroup(key: string, threadCount: number): HomeThreadGroup {
  const project = makeProject(key, key);
  const threads = Array.from({ length: threadCount }, (_, index) =>
    makeThread(`${key}-thread-${index}`, project.id),
  );
  return {
    key,
    title: key,
    representative: project,
    projects: [project],
    pendingTasks: [],
    threads,
    // All threads inside the recency window, so the baseline stays at the
    // initial page size and the pagination expectations below hold.
    recentThreads: threads,
    newThreadTarget: project,
  };
}

function itemTypes(items: ReadonlyArray<HomeListItem>): string[] {
  return items.map((item) => item.type);
}

function displayStates(
  entries: Record<string, HomeGroupDisplayState>,
): ReadonlyMap<string, HomeGroupDisplayState> {
  return new Map(Object.entries(entries));
}

describe("buildHomeListLayout", () => {
  it("renders a header plus all threads for a small group without a show-more row", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 3)],
      displayStates: displayStates({}),
    });

    expect(itemTypes(layout.items)).toEqual(["header", "thread", "thread", "thread"]);
    expect(layout.stickyHeaderIndices).toEqual([0]);
    expect(layout.items.at(-1)).toMatchObject({ type: "thread", isLast: true });
  });

  it("limits large groups to the initial visible count with a show-more row", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 133)],
      displayStates: displayStates({}),
    });

    const threadItems = layout.items.filter((item) => item.type === "thread");
    expect(threadItems).toHaveLength(HOME_INITIAL_VISIBLE_THREADS);
    expect(layout.items.at(-1)).toMatchObject({
      type: "show-more",
      groupKey: "alpha",
      hiddenCount: 133 - HOME_INITIAL_VISIBLE_THREADS,
      canShowLess: false,
    });
    // The show-more row takes over the last slot, so no thread is marked last.
    expect(threadItems.every((item) => item.type === "thread" && !item.isLast)).toBe(true);
  });

  it("reveals more threads per show-more step and offers show-less when exhausted", () => {
    const group = makeGroup("alpha", 20);

    const expandedOnce = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
      }),
    });
    expect(expandedOnce.items.filter((item) => item.type === "thread")).toHaveLength(
      HOME_INITIAL_VISIBLE_THREADS + HOME_SHOW_MORE_STEP,
    );
    expect(expandedOnce.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 4,
      canShowLess: true,
    });

    const fullyExpanded = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(
          nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
          "show-more",
        ),
      }),
    });
    expect(fullyExpanded.items.filter((item) => item.type === "thread")).toHaveLength(20);
    expect(fullyExpanded.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 0,
      canShowLess: true,
    });

    const reset = nextGroupDisplayState(
      nextGroupDisplayState(
        nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
        "show-more",
      ),
      "show-less",
    );
    expect(reset.visibleCount).toBe(HOME_INITIAL_VISIBLE_THREADS);
  });

  it("offers show-less after expanding a stale group whose baseline is below the page size", () => {
    // Stale project: 10 threads total but only 3 within the recency window.
    const project = makeProject("stale", "stale");
    const threads = Array.from({ length: 10 }, (_, index) =>
      makeThread(`stale-thread-${index}`, project.id),
    );
    const group: HomeThreadGroup = {
      key: "stale",
      title: "stale",
      representative: project,
      projects: [project],
      pendingTasks: [],
      threads,
      recentThreads: threads.slice(0, 3),
      newThreadTarget: project,
    };

    const collapsedToRecent = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({}),
    });
    expect(collapsedToRecent.items.filter((item) => item.type === "thread")).toHaveLength(3);
    expect(collapsedToRecent.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 7,
      canShowLess: false,
    });

    const expanded = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        stale: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
      }),
    });
    expect(expanded.items.filter((item) => item.type === "thread")).toHaveLength(10);
    expect(expanded.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 0,
      canShowLess: true,
    });
  });

  it("hides threads and the show-more row for collapsed groups", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 12), makeGroup("beta", 2)],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "toggle-collapsed"),
      }),
    });

    expect(itemTypes(layout.items)).toEqual(["header", "header", "thread", "thread"]);
    expect(layout.items[0]).toMatchObject({ type: "header", collapsed: true, isFirst: true });
    expect(layout.items[1]).toMatchObject({ type: "header", collapsed: false, isFirst: false });
    expect(layout.stickyHeaderIndices).toEqual([0, 1]);
  });

  it("suspends collapse and pagination while searching", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 12)],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "toggle-collapsed"),
      }),
      showAllThreads: true,
    });

    expect(layout.items.filter((item) => item.type === "thread")).toHaveLength(12);
    expect(layout.items.some((item) => item.type === "show-more")).toBe(false);
  });

  it("keeps sticky indices aligned across multiple expanded groups", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 8), makeGroup("beta", 1)],
      displayStates: displayStates({}),
    });

    // header + 6 threads + show-more = 8 items, so beta's header is index 8.
    expect(layout.stickyHeaderIndices).toEqual([0, 8]);
    expect(layout.items[8]).toMatchObject({ type: "header", isFirst: false });
  });
});

describe("saga list layout", () => {
  const sagaGroup = (id: string, isSaga = false) => {
    const group = makeGroup(id, 1);
    const project = {
      ...group.representative,
      stave: {
        spaceId: id,
        createdAt: "2026-09-01T00:00:00Z",
        isSaga,
        state: "live" as const,
        repos: [],
        memories: [],
      },
    };
    return { ...group, representative: project, projects: [project] };
  };
  const index = [
    {
      environmentId,
      sagaRoot: "/workspaces/saga",
      status: {
        sagaId: "saga",
        sagaCreatedAt: "2026-09-01T00:00:00Z",
        members: [
          {
            id: "a",
            workspaceRoot: "/workspaces/a",
            createdAt: "2026-09-01T00:00:00Z",
            after: [],
            state: "live" as const,
            dirty: false,
            repos: [],
            prs: [],
          },
          {
            id: "b",
            workspaceRoot: "/workspaces/b",
            createdAt: "2026-09-01T00:00:00Z",
            after: ["a"],
            state: "live" as const,
            dirty: true,
            repos: [],
            prs: [],
          },
        ],
        notes: [],
      },
    },
  ];
  it("orders nested headers and keeps sticky header offsets attached to their rows", () => {
    const layout = buildHomeListLayout({
      groups: [sagaGroup("b"), sagaGroup("saga", true), sagaGroup("a")],
      displayStates: new Map(),
      sagaIndex: index,
    });
    const headers = layout.items.filter((item) => item.type === "header");
    expect(headers.map((item) => [item.group.key, item.depth])).toEqual([
      ["saga", 0],
      ["a", 1],
      ["b", 1],
    ]);
    expect(layout.stickyHeaderIndices).toEqual([0, 2, 4]);
    expect(headers[2]?.memberStatus?.dirty).toBe(true);
  });
  it("collapses the whole saga while search reveals member matches", () => {
    const input = {
      groups: [sagaGroup("b"), sagaGroup("saga", true), sagaGroup("a")],
      displayStates: new Map([["saga", { collapsed: true, visibleCount: 6 }]]),
      sagaIndex: index,
    };
    expect(buildHomeListLayout(input).items.map((item) => item.key)).toEqual(["header:saga"]);
    expect(
      buildHomeListLayout({ ...input, showAllThreads: true }).items.filter(
        (item) => item.type === "header",
      ),
    ).toHaveLength(3);
  });
  it("keeps missing parents and disabled nesting flat", () => {
    const groups = [sagaGroup("b"), sagaGroup("a")];
    for (const sagaIndex of [index, []]) {
      const layout = buildHomeListLayout({ groups, displayStates: new Map(), sagaIndex });
      expect(
        layout.items.filter((item) => item.type === "header").map((item) => item.group.key),
      ).toEqual(["b", "a"]);
    }
  });
  it("splits member clones and keeps their threads on the owning physical project", () => {
    const member = sagaGroup("a");
    const clone = {
      ...member.representative,
      id: ProjectId.make("clone"),
      workspaceRoot: "/other/a",
    };
    const cloneThread = makeThread("clone-thread", clone.id);
    const mixed = {
      ...member,
      projects: [member.representative, clone],
      threads: [...member.threads, cloneThread],
      recentThreads: [...member.threads, cloneThread],
    };
    const rows = buildHomeListLayout({
      groups: [mixed, sagaGroup("saga", true)],
      sagaIndex: index,
      displayStates: new Map(),
    }).items;
    const headers = rows.filter((row) => row.type === "header");
    expect(headers.find((row) => row.group.representative.id === "a")).toMatchObject({ depth: 1 });
    expect(headers.find((row) => row.group.representative.id === "clone")).toMatchObject({
      depth: 0,
    });
    expect(headers.find((row) => row.group.representative.id === "a")?.group.threads).toEqual(
      member.threads,
    );
    expect(headers.find((row) => row.group.representative.id === "clone")?.group.threads).toEqual([
      cloneThread,
    ]);
  });

  const v2Rows = (
    groups: ReadonlyArray<HomeThreadGroup>,
    extra: Partial<Parameters<typeof buildThreadListV2Items>[0]> = {},
  ) => {
    const layout = buildThreadListV2Items({
      threads: groups.flatMap((group) => group.threads),
      environmentId: null,
      searchQuery: "",
      now: "2026-09-10T00:00:00Z",
      ...extra,
    });
    return buildThreadListV2ListItems({
      ...layout,
      pendingTasks: groups.flatMap((group) => group.pendingTasks),
      snoozedShelfExpanded: extra.snoozedShelfExpanded,
      settledShelfExpanded: extra.settledShelfExpanded,
    });
  };

  it("keeps coordinator, member and standalone threads in a single V2 hierarchy", () => {
    const groups = [
      sagaGroup("b"),
      makeGroup("ordinary", 1),
      sagaGroup("saga", true),
      sagaGroup("a"),
    ];
    const rows = buildHomeHierarchyV2Items({
      groups,
      items: v2Rows(groups),
      sagaIndex: index,
      displayStates: new Map(),
    });
    const headers = rows.filter((row) => row.type === "header");
    expect(headers.map((row) => [row.group.key, row.depth])).toEqual([
      ["ordinary", 0],
      ["saga", 0],
      ["a", 1],
      ["b", 1],
    ]);
    const coordinator = rows.findIndex(
      (row) => row.type === "v2-thread" && row.item.thread.projectId === "saga",
    );
    expect(rows[coordinator - 1]).toMatchObject({ type: "header", group: { key: "saga" } });
    expect(rows[coordinator]).toMatchObject({ depth: 1 });
    expect(
      rows.find((row) => row.type === "v2-thread" && row.item.thread.projectId === "a"),
    ).toMatchObject({ depth: 2 });
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("preserves pin order, snoozed and settled shelves and selected-thread access", () => {
    const member = sagaGroup("a");
    const pinned = {
      ...makeThread("pinned", member.representative.id),
      pinnedAt: "2026-09-01T00:00:00Z",
      pinOrder: "a",
    };
    const snoozed = {
      ...makeThread("snoozed", member.representative.id),
      snoozedUntil: "2026-10-01T00:00:00Z",
    };
    const settled = {
      ...makeThread("settled", member.representative.id),
      settledOverride: "settled" as const,
      settledAt: "2026-09-01T00:00:00Z",
    };
    const groups = [
      sagaGroup("saga", true),
      { ...member, threads: [...member.threads, pinned, snoozed, settled] },
    ];
    const items = v2Rows(groups, { snoozedShelfExpanded: true, settledShelfExpanded: true });
    const rows = buildHomeHierarchyV2Items({
      groups,
      items,
      sagaIndex: index,
      displayStates: new Map(),
    });
    expect(
      rows.flatMap((row) =>
        row.type === "v2-thread" && row.item.thread.projectId === "a" ? [row.item.thread.id] : [],
      ),
    ).toEqual(["pinned", "a-thread-0", "snoozed", "settled"]);
    expect(
      rows
        .filter((row) => row.type === "v2-snoozed-shelf" || row.type === "v2-settled-shelf")
        .map((row) => row.type),
    ).toEqual(["v2-snoozed-shelf", "v2-settled-shelf"]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    const displayStates = new Map([
      ["saga", { collapsed: true, visibleCount: 6 }],
      ["a", { collapsed: true, visibleCount: 6 }],
    ]);
    const collapsed = buildHomeHierarchyV2Items({ groups, items, sagaIndex: index, displayStates });
    expect(collapsed.some((row) => row.type === "v2-thread")).toBe(false);
    const selected = buildHomeHierarchyV2Items({
      groups,
      items,
      sagaIndex: index,
      displayStates,
      selectedThreadKey: `${environmentId}:snoozed`,
    });
    expect(
      selected.some((row) => row.type === "v2-thread" && row.item.thread.id === "snoozed"),
    ).toBe(true);
    const searching = buildHomeHierarchyV2Items({
      groups,
      items,
      sagaIndex: index,
      displayStates,
      searching: true,
    });
    expect(searching.filter((row) => row.type === "v2-thread")).toHaveLength(5);
  });

  it("keeps queued offline tasks selectable when no project shell exists", () => {
    const creation = {
      projectId: ProjectId.make("offline"),
      workspaceMode: "local" as const,
      branch: null,
      worktreePath: null,
    };
    const task: PendingNewTask = {
      title: "offline task",
      creation,
      message: {
        creation,
        environmentId,
        threadId: ThreadId.make("offline-thread"),
        messageId: MessageId.make("offline-message"),
        commandId: CommandId.make("offline-command"),
        text: "offline task",
        attachments: [],
        createdAt: "2026-09-01T00:00:00Z",
      },
    };
    const items = buildThreadListV2ListItems({ items: [], pendingTasks: [task] });
    const rows = buildHomeHierarchyV2Items({ groups: [], items, displayStates: new Map() });
    expect(rows).toEqual(items);
    expect(rows[0]).toMatchObject({ type: "v2-pending", pendingTask: task });
  });
  it("search retains the matching member's saga ancestor without unrelated projects", () => {
    const source = [
      sagaGroup("saga", true),
      sagaGroup("a"),
      sagaGroup("b"),
      makeGroup("ordinary", 1),
    ];
    const groups = buildHomeThreadGroups({
      projects: source.flatMap((group) => group.projects),
      threads: source.flatMap((group) => group.threads),
      environmentId: null,
      searchQuery: "a-thread-0",
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
      projectGroupingMode: "separate",
      includeStaveProjects: true,
      sagaIndex: index,
    });
    const rows = buildHomeListLayout({
      groups,
      sagaIndex: index,
      displayStates: new Map(),
      showAllThreads: true,
    }).items;
    expect(
      rows
        .filter((row) => row.type === "header")
        .map((row) => [row.group.representative.id, row.depth]),
    ).toEqual([
      ["saga", 0],
      ["a", 1],
    ]);
  });

  const withSharedRepository = (group: HomeThreadGroup): HomeThreadGroup => {
    const project: EnvironmentProject = {
      ...group.representative,
      repositoryIdentity: {
        canonicalKey: "github.com/org/shared",
        provider: "github",
        owner: "org",
        name: "shared",
        displayName: "org/shared",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/org/shared.git",
        },
      },
    };
    return { ...group, representative: project, projects: [project] };
  };

  it("filters physical member clones before retaining search ancestry in V1 and V2", () => {
    const source = [
      sagaGroup("saga", true),
      withSharedRepository(sagaGroup("a")),
      withSharedRepository(sagaGroup("clone")),
    ];
    const groups = buildHomeThreadGroups({
      projects: source.flatMap((group) => group.projects),
      threads: source.flatMap((group) => group.threads),
      environmentId: null,
      searchQuery: "a-thread-0",
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
      projectGroupingMode: "repository",
      includeStaveProjects: true,
      sagaIndex: index,
    });
    const input = { groups, sagaIndex: index, displayStates: new Map() };
    const layouts = [
      buildHomeListLayout({ ...input, showAllThreads: true }).items,
      buildHomeHierarchyV2Items({
        ...input,
        items: v2Rows(groups),
        searching: true,
      }),
    ];
    for (const rows of layouts) {
      expect(
        rows
          .filter((row) => row.type === "header")
          .map((row) => [row.group.representative.id, row.depth]),
      ).toEqual([
        ["saga", 0],
        ["a", 1],
      ]);
    }
  });

  it("retains an empty physical member when its logical repository representative is ordinary", () => {
    const member = withSharedRepository(sagaGroup("a"));
    const source = [
      withSharedRepository(makeGroup("ordinary", 0)),
      { ...member, threads: [], recentThreads: [] },
      { ...sagaGroup("saga", true), threads: [], recentThreads: [] },
    ];
    const groups = buildHomeThreadGroups({
      projects: source.flatMap((group) => group.projects),
      threads: [],
      environmentId: null,
      searchQuery: "",
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
      projectGroupingMode: "repository",
      includeStaveProjects: true,
      sagaIndex: index,
    });
    const input = { groups, sagaIndex: index, displayStates: new Map() };
    for (const rows of [
      buildHomeListLayout(input).items,
      buildHomeHierarchyV2Items({ ...input, items: [] }),
    ]) {
      expect(
        rows
          .filter((row) => row.type === "header")
          .map((row) => [row.group.representative.id, row.depth]),
      ).toEqual([
        ["saga", 0],
        ["a", 1],
      ]);
    }
  });
});
