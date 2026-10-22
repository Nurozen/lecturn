import { buildPendingNewTasks } from "../../state/pending-new-tasks-model";
import { makeThreadShellFixture } from "../../test-fixtures";
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
  homeListItemsAreEqual,
  buildHomeHierarchyV2Items,
  DEFAULT_GROUP_DISPLAY_STATE,
  HOME_INITIAL_VISIBLE_THREADS,
  HOME_SHOW_MORE_STEP,
  nextGroupDisplayState,
  type HomeAccountHeaderListItem,
  type HomeGroupDisplayState,
  type HomeHeaderListItem,
} from "./homeListItems";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  isThreadListV2ListItem,
} from "../threads/threadListV2";
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
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });
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
    recentThreads: threads,
    newThreadTarget: project,
  };
}

function displayStates(
  entries: Record<string, HomeGroupDisplayState>,
): ReadonlyMap<string, HomeGroupDisplayState> {
  return new Map(Object.entries(entries));
}

function v2Rows(
  groups: ReadonlyArray<HomeThreadGroup>,
  extra: Partial<Parameters<typeof buildThreadListV2Items>[0]> = {},
) {
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
}

describe("nextGroupDisplayState", () => {
  it("toggles collapse and pages threads by the show-more step", () => {
    const collapsed = nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "toggle-collapsed");
    expect(collapsed).toEqual({ collapsed: true, visibleCount: HOME_INITIAL_VISIBLE_THREADS });
    const more = nextGroupDisplayState(
      nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
      "show-more",
    );
    expect(more.visibleCount).toBe(HOME_INITIAL_VISIBLE_THREADS + 2 * HOME_SHOW_MORE_STEP);
    expect(nextGroupDisplayState(more, "show-less").visibleCount).toBe(
      HOME_INITIAL_VISIBLE_THREADS,
    );
  });
});

describe("homeListItemsAreEqual", () => {
  const group = makeGroup("alpha", 1);
  const header: HomeHeaderListItem = {
    type: "header",
    key: "v2-active-header:alpha",
    group,
    collapsed: false,
    isFirst: true,
    depth: 0,
  };
  const account: HomeAccountHeaderListItem = {
    type: "account-header",
    key: "connect-account:user_a",
    account: {
      accountId: "user_a",
      email: "a@example.test",
      label: "Work",
      preset: "jade",
      signedIn: true,
    },
    attention: "",
    collapsed: false,
  };

  it("compares project headers structurally on their stable group reference", () => {
    expect(homeListItemsAreEqual(header, { ...header })).toBe(true);
    expect(homeListItemsAreEqual(header, { ...header, collapsed: true })).toBe(false);
    expect(homeListItemsAreEqual(header, { ...header, depth: 1 })).toBe(false);
    expect(homeListItemsAreEqual(header, { ...header, group: { ...group } })).toBe(false);
    expect(homeListItemsAreEqual(header, account)).toBe(false);
  });

  it("compares account headers by visible account state", () => {
    expect(homeListItemsAreEqual(account, { ...account, account: { ...account.account! } })).toBe(
      true,
    );
    expect(
      homeListItemsAreEqual(account, {
        ...account,
        account: { ...account.account!, signedIn: false },
      }),
    ).toBe(false);
    expect(homeListItemsAreEqual(account, { ...account, attention: "1 awaiting approval" })).toBe(
      false,
    );
    expect(homeListItemsAreEqual(account, header)).toBe(false);
  });
});

describe("threadJumpTarget", () => {
  it("numbers only displayed threads across groups, skipping collapsed groups", () => {
    const groups = [makeGroup("collapsed", 3), makeGroup("alpha", 8), makeGroup("beta", 3)];
    const rows = buildHomeHierarchyV2Items({
      groups,
      items: v2Rows(groups),
      displayStates: displayStates({ collapsed: { collapsed: true, visibleCount: 6 } }),
    });
    const items = rows.filter(isThreadListV2ListItem);
    expect(threadJumpTarget(items, "thread.jump.1")?.projectId).toBe("alpha");
    expect(threadJumpTarget(items, "thread.jump.8")?.projectId).toBe("alpha");
    expect(threadJumpTarget(items, "thread.jump.9")?.projectId).toBe("beta");
    expect(threadJumpTarget(items, "thread.jump.9")?.id).toBe(
      rows.flatMap((row) => (row.type === "v2-thread" ? [row.item.thread.id] : []))[8],
    );
  });

  it("ignores missing positions and unrelated commands", () => {
    const groups = [makeGroup("alpha", 1)];
    const items = buildHomeHierarchyV2Items({
      groups,
      items: v2Rows(groups),
      displayStates: displayStates({}),
    }).filter(isThreadListV2ListItem);
    expect(threadJumpTarget(items, "thread.jump.1")?.id).toBe("alpha-thread-0");
    expect(threadJumpTarget(items, "thread.jump.2")).toBeNull();
    expect(threadJumpTarget([], "thread.jump.1")).toBeNull();
    expect(threadJumpTarget(items, "commandPalette")).toBeNull();
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
  it("orders nested headers under the saga and carries member status", () => {
    const groups = [sagaGroup("b"), sagaGroup("saga", true), sagaGroup("a")];
    const rows = buildHomeHierarchyV2Items({
      groups,
      items: v2Rows(groups),
      displayStates: new Map(),
      sagaIndex: index,
    });
    const headers = rows.filter((item) => item.type === "header");
    expect(headers.map((item) => [item.group.key, item.depth])).toEqual([
      ["saga", 0],
      ["a", 1],
      ["b", 1],
    ]);
    expect(headers[2]?.memberStatus?.dirty).toBe(true);
  });
  it("collapses the whole saga while search reveals member matches", () => {
    const groups = [sagaGroup("b"), sagaGroup("saga", true), sagaGroup("a")];
    const input = {
      groups,
      items: v2Rows(groups),
      displayStates: new Map([["saga", { collapsed: true, visibleCount: 6 }]]),
      sagaIndex: index,
    };
    expect(buildHomeHierarchyV2Items(input).map((item) => item.key)).toEqual([
      "v2-active-header:saga",
    ]);
    const searching = buildHomeHierarchyV2Items({ ...input, searching: true });
    expect(searching.filter((item) => item.type === "header")).toHaveLength(3);
    expect(searching.filter((item) => item.type === "v2-thread")).toHaveLength(3);
  });
  it("keeps missing parents and disabled nesting flat", () => {
    const groups = [sagaGroup("b"), sagaGroup("a")];
    for (const sagaIndex of [index, []]) {
      const rows = buildHomeHierarchyV2Items({
        groups,
        items: v2Rows(groups),
        displayStates: new Map(),
        sagaIndex,
      });
      const headers = rows.filter((item) => item.type === "header");
      expect(headers.map((item) => [item.group.key, item.depth])).toEqual([
        ["b", 0],
        ["a", 0],
      ]);
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
    const groups = [mixed, sagaGroup("saga", true)];
    const rows = buildHomeHierarchyV2Items({
      groups,
      items: v2Rows(groups),
      sagaIndex: index,
      displayStates: new Map(),
    });
    const headers = rows.filter((row) => row.type === "header");
    const scopes = threadMoveScopes(groups, index);
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
    const cloneRow = rows.findIndex(
      (row) => row.type === "v2-thread" && row.item.thread.id === "clone-thread",
    );
    expect(rows[cloneRow - 1]).toMatchObject({
      type: "header",
      group: { representative: { id: "clone" } },
    });
    expect(rows[cloneRow]).toMatchObject({ depth: 1 });
    expect(
      rows.find((row) => row.type === "v2-thread" && row.item.thread.id === "a-thread-0"),
    ).toMatchObject({ depth: 2 });
  });

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
      return buildHomeHierarchyV2Items({
        ...input,
        items: v2Rows(groups, { queuedThreadKeys: queued }),
      });
    };
    const rows = render();
    const visible = rows.flatMap((row) => (row.type === "v2-thread" ? [row.item.thread] : []));
    expect(visible).toEqual([memberThread]);
    expect(rows.find((row) => row.type === "v2-thread")).toMatchObject({ depth: 2 });
    const shelves = rows.filter((row) => row.type === "v2-settled-shelf");
    expect(shelves).toHaveLength(1);
    expect(shelves[0]).toMatchObject({ count: 1, expanded: false, disabled: false });
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    const unqueued = render(new Set());
    expect(unqueued.filter((row) => row.type === "v2-thread")).toHaveLength(0);
    expect(unqueued.filter((row) => row.type === "v2-settled-shelf")).toHaveLength(2);
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
    const rows = buildHomeHierarchyV2Items({
      groups,
      items: v2Rows(groups),
      sagaIndex: index,
      displayStates: new Map(),
      searching: true,
    });
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

  it("filters physical member clones before retaining search ancestry ", () => {
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
    const rows = buildHomeHierarchyV2Items({
      ...input,
      items: v2Rows(groups),
      searching: true,
    });
    expect(
      rows
        .filter((row) => row.type === "header")
        .map((row) => [row.group.representative.id, row.depth]),
    ).toEqual([
      ["saga", 0],
      ["a", 1],
    ]);
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
    const rows = buildHomeHierarchyV2Items({ ...input, items: [] });
    expect(
      rows
        .filter((row) => row.type === "header")
        .map((row) => [row.group.representative.id, row.depth]),
    ).toEqual([
      ["saga", 0],
      ["a", 1],
    ]);
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
    const items = v2Rows(groups);
    const expanded = buildHomeHierarchyV2Items({
      groups,
      items,
      displayStates: new Map(),
      accountSections,
    });
    const collapsed = buildHomeHierarchyV2Items({
      groups,
      items,
      displayStates: displayStates({
        "connect-account:user_a": { collapsed: true, visibleCount: 6 },
      }),
      accountSections,
    });
    expect(collapsed.map((item) => item.type)).toEqual(["account-header", "account-header"]);
    expect(collapsed[0]).toMatchObject({ attention: "2 awaiting approval", collapsed: true });
    expect(expanded.map((item) => item.type)).toEqual([
      "account-header",
      "header",
      "v2-thread",
      "v2-thread",
      "account-header",
    ]);
    const accountHeaders = (rows: typeof expanded) =>
      rows.filter((row): row is HomeAccountHeaderListItem => row.type === "account-header");
    const [expandedWork, expandedOther] = accountHeaders(expanded);
    const [collapsedWork, collapsedOther] = accountHeaders(collapsed);
    expect(homeListItemsAreEqual(expandedWork!, collapsedWork!)).toBe(false);
    expect(homeListItemsAreEqual(expandedOther!, collapsedOther!)).toBe(true);
    const searching = buildHomeHierarchyV2Items({
      groups,
      items,
      displayStates: displayStates({
        "connect-account:user_a": { collapsed: true, visibleCount: 6 },
      }),
      accountSections,
      searching: true,
    });
    expect(searching.filter((item) => item.type === "v2-thread")).toHaveLength(2);
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
    const rows = buildHomeHierarchyV2Items({
      groups,
      accountSections,
      displayStates: new Map(),
      items: buildThreadListV2ListItems({ items: [], pendingTasks: tasks }),
    });
    const owned = new Map<string | null, string[]>();
    let accountId: string | null = null;
    for (const row of rows) {
      if (row.type === "account-header") accountId = row.account?.accountId ?? null;
      if (row.type === "v2-pending")
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
