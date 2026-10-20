import { buildPendingNewTasks } from "../../state/pending-new-tasks-model";
import { threadMoveScopes } from "./threadMoveScopes";
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
  homeListItemsAreEqual,
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
import { threadJumpTarget } from "../keyboard/threadKeyboardShortcuts";

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
    pullRequests: [],
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

describe("threadJumpTarget", () => {
  it("numbers only displayed threads across groups, skipping collapsed groups and pagination rows", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("collapsed", 3), makeGroup("alpha", 8), makeGroup("beta", 3)],
      displayStates: displayStates({ collapsed: { collapsed: true, visibleCount: 6 } }),
    });
    expect(threadJumpTarget(layout.items, "thread.jump.1")?.id).toBe("alpha-thread-0");
    expect(threadJumpTarget(layout.items, "thread.jump.7")?.id).toBe("beta-thread-0");
    expect(threadJumpTarget(layout.items, "thread.jump.9")?.id).toBe("beta-thread-2");
  });

  it("ignores missing positions and unrelated commands", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 1)],
      displayStates: displayStates({}),
    });
    expect(threadJumpTarget(layout.items, "thread.jump.2")).toBeNull();
    expect(threadJumpTarget([], "thread.jump.1")).toBeNull();
    expect(threadJumpTarget(layout.items, "commandPalette")).toBeNull();
  });
});

describe("buildHomeListLayout", () => {
  it("keeps settled history under its owner in the legacy grouped list", () => {
    const original = makeGroup("project", 2);
    const threads = original.threads.map((thread, index) =>
      index === 1 ? { ...thread, settledOverride: "settled" as const } : thread,
    );
    const group = { ...original, threads, recentThreads: threads };
    const collapsed = buildHomeListLayout({ groups: [group], displayStates: new Map() }).items;
    expect(itemTypes(collapsed)).toEqual(["header", "thread", "v2-settled-shelf"]);
    expect(collapsed.at(-1)).toMatchObject({ count: 1, expanded: false, depth: 1 });
    const expanded = buildHomeListLayout({
      groups: [group],
      displayStates: new Map([["settled:project", { collapsed: false, visibleCount: 6 }]]),
    }).items;
    expect(expanded.at(-1)).toMatchObject({
      type: "thread",
      depth: 2,
      settledBranch: true,
      thread: { id: "project-thread-1" },
    });
  });

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

describe("queued threads through legacy grouping and layout", () => {
  const now = Date.parse("2026-06-28T00:00:00Z");
  const project = makeProject("queued-project", "Queued project");
  const groupInput = {
    projects: [project],
    environmentId: null,
    searchQuery: "",
    projectSortOrder: "updated_at" as const,
    threadSortOrder: "updated_at" as const,
    projectGroupingMode: "separate" as const,
    now,
  };

  it("adds an old queued row without replacing the stale-project fallback", () => {
    const threads = Array.from({ length: 5 }, (_, index) => ({
      ...makeThread(`t${index + 1}`, project.id),
      updatedAt: `2026-06-${16 - index}T00:00:00Z`,
    }));
    const queuedThreadKeys = new Set([`${environmentId}:t5`]);
    const groups = buildHomeThreadGroups({ ...groupInput, threads, queuedThreadKeys });
    expect(groups[0]?.recentThreads.map((thread) => thread.id)).toEqual(["t1", "t2", "t3", "t5"]);
    const layout = (display = DEFAULT_GROUP_DISPLAY_STATE, queued = queuedThreadKeys) =>
      buildHomeListLayout({
        groups: buildHomeThreadGroups({ ...groupInput, threads, queuedThreadKeys: queued }),
        queuedThreadKeys: queued,
        displayStates: new Map([[groups[0]!.key, display]]),
      }).items;
    const rows = layout();
    expect(rows.flatMap((row) => (row.type === "thread" ? [row.thread.id] : []))).toEqual([
      "t1",
      "t2",
      "t3",
      "t5",
    ]);
    expect(rows.at(-1)).toMatchObject({ type: "show-more", hiddenCount: 1, canShowLess: false });
    const more = nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more");
    expect(layout(more).flatMap((row) => (row.type === "thread" ? [row.thread.id] : []))).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
    ]);
    expect(layout(more).at(-1)).toMatchObject({ hiddenCount: 0, canShowLess: true });
    expect(layout(nextGroupDisplayState(more, "show-less"))).toEqual(rows);
    expect(
      layout(DEFAULT_GROUP_DISPLAY_STATE, new Set()).flatMap((row) =>
        row.type === "thread" ? [row.thread.id] : [],
      ),
    ).toEqual(["t1", "t2", "t3"]);
  });

  it("keeps queued settled rows beyond both the first and expanded pages", () => {
    const threads = Array.from({ length: 22 }, (_, index) => ({
      ...makeThread(`t${index + 1}`, project.id),
      updatedAt: new Date(now - index * 1000).toISOString(),
      settledOverride: index === 21 ? ("settled" as const) : null,
    }));
    const queuedThreadKeys = new Set([`${environmentId}:t22`]);
    const groups = buildHomeThreadGroups({ ...groupInput, threads, queuedThreadKeys });
    const layout = (display: HomeGroupDisplayState, showAllThreads = false) =>
      buildHomeListLayout({
        groups,
        queuedThreadKeys,
        showAllThreads,
        displayStates: new Map([[groups[0]!.key, display]]),
      }).items;
    const first = layout(DEFAULT_GROUP_DISPLAY_STATE);
    expect(first.flatMap((row) => (row.type === "thread" ? [row.thread.id] : []))).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t22",
    ]);
    expect(first.at(-1)).toMatchObject({ hiddenCount: 15, canShowLess: false });
    expect(first.some((row) => row.type === "v2-settled-shelf")).toBe(false);
    const expanded = layout(nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"));
    const expandedThreads = expanded.filter((row) => row.type === "thread");
    expect(expandedThreads).toHaveLength(17);
    expect(expandedThreads.at(-1)?.thread.id).toBe("t22");
    expect(expanded.at(-1)).toMatchObject({ hiddenCount: 5, canShowLess: true });
    const searching = layout({ collapsed: true, visibleCount: 6 }, true);
    expect(searching.filter((row) => row.type === "thread")).toHaveLength(22);
    expect(new Set(searching.map((row) => row.key)).size).toBe(searching.length);
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
    const scopes = threadMoveScopes([mixed, sagaGroup("saga", true)], index);
    expect(scopes.get(`${environmentId}:a`)).toEqual([`${environmentId}:a`]);
    expect(scopes.get(`${environmentId}:clone`)).toEqual([`${environmentId}:clone`]);
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

  it("preserves queue promotion through account and saga recursion using scoped identities", () => {
    const foreignEnvironment = EnvironmentId.make("environment-2");
    const accountSections = {
      accounts: [
        {
          accountId: "work",
          label: "Work",
          email: "work@example.test",
          preset: "jade",
          signedIn: true,
        },
        {
          accountId: "personal",
          label: "Personal",
          email: "personal@example.test",
          preset: "jade",
          signedIn: true,
        },
      ],
      owners: new Map([
        [environmentId, "work"],
        [foreignEnvironment, "personal"],
      ]),
    };
    const source = [sagaGroup("saga", true), sagaGroup("a")];
    const memberThread = {
      ...makeThread("queued", ProjectId.make("a")),
      settledOverride: "settled" as const,
    };
    const projects = [
      ...source.flatMap((group) => group.projects),
      { ...makeProject("a", "Foreign project"), environmentId: foreignEnvironment },
    ];
    const threads = [memberThread, { ...memberThread, environmentId: foreignEnvironment }];
    const queuedThreadKeys = new Set([`${environmentId}:queued`]);
    const render = (queued = queuedThreadKeys) => {
      const groups = buildHomeThreadGroups({
        accountSections,
        projects,
        threads,
        queuedThreadKeys: queued,
        environmentId: null,
        searchQuery: "",
        projectSortOrder: "created_at",
        threadSortOrder: "created_at",
        projectGroupingMode: "separate",
        includeStaveProjects: true,
        sagaIndex: index,
        now: Date.parse("2026-09-10T00:00:00Z"),
      });
      const input = { accountSections, groups, sagaIndex: index, displayStates: new Map() };
      return [
        buildHomeListLayout({ ...input, queuedThreadKeys: queued }).items,
        buildHomeHierarchyV2Items({
          ...input,
          items: v2Rows(groups, { queuedThreadKeys: queued }),
        }),
      ];
    };
    for (const rows of render()) {
      const visible = rows.flatMap((row) =>
        row.type === "thread" ? [row.thread] : row.type === "v2-thread" ? [row.item.thread] : [],
      );
      expect(visible).toEqual([memberThread]);
      expect(rows.find((row) => row.type === "thread" || row.type === "v2-thread")).toMatchObject({
        depth: 2,
      });
      const shelves = rows.filter((row) => row.type === "v2-settled-shelf");
      expect(shelves).toHaveLength(1);
      expect(shelves[0]).toMatchObject({ count: 1, expanded: false });
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    }
    for (const rows of render(new Set())) {
      expect(rows.filter((row) => row.type === "thread" || row.type === "v2-thread")).toHaveLength(
        0,
      );
      expect(rows.filter((row) => row.type === "v2-settled-shelf")).toHaveLength(2);
    }
  });

  it("preserves snooze priority for queued settled rows until they wake", () => {
    const group = makeGroup("snoozed-project", 1);
    const thread = {
      ...group.threads[0]!,
      settledOverride: "settled" as const,
      snoozedUntil: "2026-10-01T00:00:00Z",
    };
    const groups = buildHomeThreadGroups({
      projects: group.projects,
      threads: [thread],
      environmentId: null,
      searchQuery: "",
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
      projectGroupingMode: "separate",
      now: Date.parse("2026-09-10T00:00:00Z"),
    });
    const queuedThreadKeys = new Set([`${environmentId}:${thread.id}`]);
    const render = (extra: Partial<Parameters<typeof buildThreadListV2Items>[0]>) =>
      buildHomeHierarchyV2Items({
        groups,
        displayStates: new Map(),
        items: v2Rows(groups, { queuedThreadKeys, ...extra }),
      });
    expect(render({}).filter((row) => row.type === "v2-thread")).toHaveLength(0);
    const expanded = render({ snoozedShelfExpanded: true });
    expect(expanded.find((row) => row.type === "v2-thread")).toMatchObject({
      item: { variant: "slim", snoozed: true },
    });
    expect(expanded.some((row) => row.type === "v2-settled-shelf")).toBe(false);
    const awake = render({ now: "2026-10-02T00:00:00Z" });
    expect(awake.find((row) => row.type === "v2-thread")).toMatchObject({
      item: { variant: "card", snoozed: false },
    });
    const unsupported = render({
      queuedThreadKeys: new Set(),
      settlementEnvironmentIds: new Set(),
      snoozeEnvironmentIds: new Set(),
    });
    expect(unsupported.find((row) => row.type === "v2-thread")).toMatchObject({
      item: { variant: "card", snoozed: false },
    });
  });

  it("retains queued settled rows beyond the settled partition page", () => {
    const project = makeProject("settled-project", "Settled project");
    const threads = Array.from({ length: 12 }, (_, index) => ({
      ...makeThread(`settled-${index}`, project.id),
      settledOverride: "settled" as const,
      settledAt: new Date(Date.parse("2026-09-10T00:00:00Z") - index * 1000).toISOString(),
    }));
    const queuedThreadKeys = new Set([`${environmentId}:settled-11`]);
    const groups = buildHomeThreadGroups({
      projects: [project],
      threads,
      queuedThreadKeys,
      environmentId: null,
      searchQuery: "",
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
      projectGroupingMode: "separate",
      now: Date.parse("2026-09-10T00:00:00Z"),
    });
    const rows = buildHomeHierarchyV2Items({
      groups,
      displayStates: new Map(),
      items: v2Rows(groups, { queuedThreadKeys, settledLimit: 1 }),
    });
    expect(rows.flatMap((row) => (row.type === "v2-thread" ? [row.item.thread.id] : []))).toEqual([
      "settled-11",
    ]);
  });

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
    ).toEqual(["pinned", "a-thread-0", "snoozed"]);
    expect(
      rows
        .filter((row) => row.type === "v2-snoozed-shelf" || row.type === "v2-settled-shelf")
        .map((row) => row.type),
    ).toEqual(["v2-snoozed-shelf", "v2-settled-shelf"]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    const shelf = rows.find((row) => row.type === "v2-settled-shelf");
    expect(shelf).toMatchObject({ count: 1, expanded: false, depth: 2, settledBranch: true });
    expect(rows.filter((row) => row.type === "header").map((row) => row.group.key)).toEqual([
      "saga",
      "a",
    ]);
    const expanded = buildHomeHierarchyV2Items({
      groups,
      items,
      sagaIndex: index,
      displayStates: new Map([["settled:a", { collapsed: false, visibleCount: 6 }]]),
    });
    expect(
      expanded.find((row) => row.type === "v2-thread" && row.item.thread.id === "settled"),
    ).toMatchObject({ depth: 3, settledBranch: true });
    const selectedSettled = buildHomeHierarchyV2Items({
      groups,
      items,
      sagaIndex: index,
      displayStates: new Map(),
      selectedThreadKey: `${environmentId}:settled`,
    });
    expect(
      selectedSettled.some((row) => row.type === "v2-thread" && row.item.thread.id === "settled"),
    ).toBe(true);

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
      kind: "pending",
      key: "pending-task:offline-message",
      environmentId,
      projectId: creation.projectId,
      projectTitle: undefined,
      projectCwd: undefined,
      branch: null,
      createdAt: "2026-09-01T00:00:00Z",
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

describe("account sections", () => {
  const account = {
    accountId: "user_a",
    email: "a@example.test",
    label: "Work",
    preset: "jade",
    signedIn: true,
  };
  const other = { ...account, accountId: "user_b", label: "Personal" };
  const accountSections = {
    accounts: [account, other],
    owners: new Map([[environmentId, account.accountId]]),
  };
  it("retains attention on a collapsed account and restores its threads without changing the other section", () => {
    const group = makeGroup("work", 2);
    const groups = [
      {
        ...group,
        threads: group.threads.map((thread) => ({ ...thread, hasPendingApprovals: true })),
      },
    ];
    const expanded = buildHomeListLayout({ groups, displayStates: new Map(), accountSections });
    const collapsed = buildHomeListLayout({
      groups,
      displayStates: displayStates({
        "connect-account:user_a": { collapsed: true, visibleCount: 6 },
      }),
      accountSections,
    });
    expect(collapsed.items.map((item) => item.type)).toEqual(["account-header", "account-header"]);
    expect(collapsed.items[0]).toMatchObject({ attention: "2 awaiting approval", collapsed: true });
    expect(expanded.items.some((item) => item.type === "thread")).toBe(true);
    expect(homeListItemsAreEqual(expanded.items[0]!, collapsed.items[0]!)).toBe(false);
    expect(homeListItemsAreEqual(expanded.items.at(-1)!, collapsed.items.at(-1)!)).toBe(true);
    expect(expanded.stickyHeaderIndices).toEqual([]);
  });
  it("keeps expired empty accounts visible with a sign-in state", () => {
    const layout = buildHomeHierarchyV2Items({
      groups: [],
      items: [],
      displayStates: new Map(),
      accountSections: { ...accountSections, accounts: [{ ...account, signedIn: false }, other] },
    });
    expect(layout).toHaveLength(2);
    expect(layout[0]).toMatchObject({ type: "account-header", account: { signedIn: false } });
  });
});

describe("draft ownership through the mobile hierarchy", () => {
  it("keeps several drafts and queued work in their account/project, including missing project shells", () => {
    const environments = ["work", "personal", "direct"].map((id) => EnvironmentId.make(id));
    const projects = environments.map((environmentId) => ({
      ...makeProject("shared", "Shared"),
      environmentId,
      repositoryIdentity: {
        canonicalKey: "github:owner/repo",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:owner/repo.git",
        },
      },
    }));
    const accounts = ["work-user", "personal-user"].map((accountId) => ({
      accountId,
      label: accountId,
      email: `${accountId}@test.example`,
      preset: "jade",
      signedIn: true,
    }));
    const accountSections = {
      accounts,
      owners: new Map([
        [environments[0]!, accounts[0]!.accountId],
        [environments[1]!, accounts[1]!.accountId],
      ]),
    };
    const drafts = Object.fromEntries(
      [0, 0, 1, 2].map((owner, index) => [
        `new-task:draft-${index}`,
        {
          text: `idea-${index}`,
          attachments: [],
          project: {
            environmentId: environments[owner]!,
            projectId: ProjectId.make("shared"),
            createdAt: "2026-09-01T00:00:00Z",
          },
        },
      ]),
    );
    const tasks = buildPendingNewTasks({
      drafts,
      queuedMessages: [
        {
          environmentId: environments[1]!,
          threadId: ThreadId.make("pending"),
          messageId: MessageId.make("pending"),
          commandId: CommandId.make("pending"),
          text: "queued",
          attachments: [],
          createdAt: "2026-09-01T00:00:00Z",
          creation: {
            projectId: ProjectId.make("shared"),
            workspaceMode: "local",
            branch: null,
            worktreePath: null,
          },
        },
      ],
    });
    // Personal is offline: synthetic project grouping must still own its work.
    const groups = buildHomeThreadGroups({
      accountSections,
      projects: projects.filter((p) => p.environmentId !== environments[1]),
      threads: [],
      pendingTasks: tasks,
      environmentId: null,
      searchQuery: "",
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
      projectGroupingMode: "repository",
    });
    expect(groups.map((group) => group.pendingTasks.length).sort()).toEqual([1, 2, 2]);
    const scopes = threadMoveScopes(groups, []);
    for (const project of projects)
      expect(scopes.get(`${project.environmentId}:${project.id}`)).toEqual([
        `${project.environmentId}:${project.id}`,
      ]);
    const layouts = [
      buildHomeListLayout({ groups, accountSections, displayStates: new Map() }).items,
      buildHomeHierarchyV2Items({
        groups,
        accountSections,
        displayStates: new Map(),
        items: buildThreadListV2ListItems({ items: [], pendingTasks: tasks }),
      }),
    ];
    for (const rows of layouts) {
      const owned = new Map<string | null, string[]>();
      let accountId: string | null = null;
      for (const row of rows) {
        if (row.type === "account-header") accountId = row.account?.accountId ?? null;
        if (row.type === "pending-task" || row.type === "v2-pending")
          owned.set(accountId, [...(owned.get(accountId) ?? []), row.pendingTask.key]);
      }
      expect(owned.get("work-user")?.sort()).toEqual([
        "draft-task:new-task:draft-0",
        "draft-task:new-task:draft-1",
      ]);
      expect(owned.get("personal-user")?.sort()).toEqual([
        "draft-task:new-task:draft-2",
        "pending-task:pending",
      ]);
      expect(owned.get(null)).toEqual(["draft-task:new-task:draft-3"]);
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    }
    const collapsed = buildHomeHierarchyV2Items({
      groups,
      accountSections,
      displayStates: new Map([["connect-account:work-user", { collapsed: true, visibleCount: 6 }]]),
      items: buildThreadListV2ListItems({ items: [], pendingTasks: tasks }),
    });
    expect(
      collapsed
        .filter((row) => row.type === "v2-pending")
        .map((row) => row.pendingTask.environmentId),
    ).not.toContain(environments[0]);
  });
});
