import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type PullRequestWatchSnapshot,
} from "@lecturn/contracts";
import {
  activityRowVisualState,
  resolveActivityAction,
  boundedActivitySnapshot,
  watchActivityRows,
  scopedPullRequestProjectIds,
  threadActivityRows,
} from "./desktopActivity.logic";

const snapshot: PullRequestWatchSnapshot = {
  defaultMergeMode: "follow-pr",
  watches: [
    {
      id: "watch-1",
      reference: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 7 },
      revision: 0,
      binding: "private-checkout-binding",
      watching: true,
      threadIds: [],
      managerThreadId: null,
      managerStatus: "unassigned",
      observation: null,
      authorization: null,
      lastAttemptAt: null,
      error: null,
      createdAt: "2026-09-13T00:00:00Z",
      updatedAt: "2026-09-13T00:00:00Z",
    },
  ],
};

describe("desktop activity routing", () => {
  it("keeps identical watch IDs on separate environments distinct and rejects mixed identities", () => {
    const rows = watchActivityRows([
      [EnvironmentId.make("one"), snapshot],
      [EnvironmentId.make("two"), snapshot],
    ]);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    const row = rows[0]!;
    const action = {
      kind: "stop-watch" as const,
      rowId: row.id,
      environmentId: row.environmentId,
      projectId: row.projectId,
      watchId: row.watchId!,
      watchRevision: row.watchRevision!,
    };
    expect(resolveActivityAction(action, rows)).toEqual(row);
    expect(resolveActivityAction({ ...action, environmentId: "two" }, rows)).toBeNull();
    expect(resolveActivityAction({ ...action, projectId: "other" }, rows)).toBeNull();
    expect(resolveActivityAction({ ...action, watchRevision: 99 }, rows)).toBeNull();
    expect(resolveActivityAction({ ...action, threadId: "injected-thread" }, rows)).toBeNull();
  });
  it("does not route merge until an open head has been observed or unsupported steer actions", () => {
    const rows = watchActivityRows([[EnvironmentId.make("one"), snapshot]]);
    const row = rows[0]!;
    const action = {
      rowId: row.id,
      environmentId: row.environmentId,
      projectId: row.projectId,
      watchId: row.watchId!,
      watchRevision: row.watchRevision!,
    };
    expect(resolveActivityAction({ ...action, kind: "merge" }, rows)).toBeNull();
    expect(resolveActivityAction({ ...action, kind: "steer", text: "go" }, rows)).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("private-checkout-binding");
  });
});

describe("hierarchical PR scopes", () => {
  const environmentId = EnvironmentId.make("local");
  const project = {
    id: ProjectId.make("one"),
    environmentId,
    workspaceRoot: "/work/one",
    repositoryIdentity: {
      canonicalKey: "github.com/a/repo",
      rootPath: "/work/one",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/a/repo",
      },
    },
  };
  const sibling = { ...project, id: ProjectId.make("two"), workspaceRoot: "/work/two" };
  const remote = {
    ...project,
    id: ProjectId.make("remote"),
    environmentId: EnvironmentId.make("remote"),
  };
  it("unions folder checkouts without confusing another environment and honors separate grouping", () => {
    const root = { environmentId, projectId: project.id };
    const settings = {
      sidebarProjectGroupingMode: "repository" as const,
      sidebarProjectGroupingOverrides: {},
    };
    expect(scopedPullRequestProjectIds([project, sibling, remote], root, settings)).toEqual([
      project.id,
      sibling.id,
    ]);
    expect(
      scopedPullRequestProjectIds([project, sibling], root, {
        ...settings,
        sidebarProjectGroupingMode: "separate",
      }),
    ).toEqual([project.id]);
  });
  it("expands a non-repository saga root into nested editable spaces", () => {
    const stave = {
      spaceId: "saga",
      createdAt: "2026-09-13T00:00:00Z",
      isSaga: true,
      memories: [],
      repos: [],
    };
    const saga = { id: ProjectId.make("saga"), environmentId, workspaceRoot: "/work/saga", stave };
    const member = {
      id: ProjectId.make("member"),
      environmentId,
      workspaceRoot: "/work/member",
      stave: {
        ...stave,
        isSaga: false,
        spaceId: "member",
        memberOf: "saga",
        repos: [{ name: "nested/repo", path: "nested/repo", mode: "edit" as const }],
      },
    };
    expect(
      scopedPullRequestProjectIds(
        [saga, member, project],
        { environmentId, projectId: saga.id },
        { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      ),
    ).toEqual([saga.id, member.id]);
    const duplicate = {
      ...saga,
      id: ProjectId.make("duplicate"),
      workspaceRoot: "/elsewhere/saga",
    };
    const entry = {
      environmentId,
      sagaRoot: saga.workspaceRoot,
      status: {
        sagaId: "saga",
        sagaCreatedAt: stave.createdAt,
        notes: [],
        members: [
          {
            id: "member",
            workspaceRoot: member.workspaceRoot,
            createdAt: stave.createdAt,
            after: [],
            state: "live" as const,
            dirty: false,
            repos: [],
            prs: [],
          },
        ],
      },
    };
    const settings = {
      sidebarProjectGroupingMode: "repository" as const,
      sidebarProjectGroupingOverrides: {},
    };
    const projects = [saga, duplicate, member];
    expect(
      scopedPullRequestProjectIds(projects, { environmentId, projectId: saga.id }, settings, [
        entry,
      ]),
    ).toEqual([saga.id, member.id]);
    expect(
      scopedPullRequestProjectIds(projects, { environmentId, projectId: duplicate.id }, settings, [
        entry,
      ]),
    ).toEqual([duplicate.id]);
    expect(
      scopedPullRequestProjectIds(projects, { environmentId, projectId: saga.id }, settings, [
        { ...entry, status: { ...entry.status, sagaCreatedAt: "2025-01-01T00:00:00Z" } },
      ]),
    ).toEqual([saga.id]);
  });
});

it("publishes each environment's configured default merge policy", () => {
  expect(
    watchActivityRows([
      [EnvironmentId.make("one"), { ...snapshot, defaultMergeMode: "revision-only" }],
    ])[0]?.defaultMergeMode,
  ).toBe("revision-only");
});

it("shows actual active conversations and approval state while excluding idle, archived and offline threads", () => {
  const local = EnvironmentId.make("local");
  const base = {
    id: ThreadId.make("thread"),
    environmentId: local,
    projectId: ProjectId.make("project"),
    title: "Task",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    session: null,
    archivedAt: null,
    backgroundLiveness: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
  const rows = threadActivityRows(
    [
      base,
      { ...base, id: ThreadId.make("monitor"), backgroundLiveness: "monitoring" },
      {
        ...base,
        id: ThreadId.make("approval"),
        hasPendingApprovals: true,
        backgroundLiveness: "working",
      },
      {
        ...base,
        id: ThreadId.make("archived"),
        hasPendingUserInput: true,
        archivedAt: "2026-09-13T00:00:00Z",
      },
      {
        ...base,
        id: ThreadId.make("offline"),
        hasPendingUserInput: true,
        environmentId: EnvironmentId.make("remote"),
      },
    ],
    new Set([local]),
  );
  expect(rows.map((row) => [row.threadId, row.status])).toEqual([
    ["monitor", "Monitoring"],
    ["approval", "Needs approval"],
  ]);
  expect(rows.every((row) => !row.watchId)).toBe(true);
});

it("bounds retained activity history without hiding the total", () => {
  const row = watchActivityRows([[EnvironmentId.make("one"), snapshot]])[0]!;
  const output = boundedActivitySnapshot(
    Array.from({ length: 250 }, (_, index) => ({
      ...row,
      id: `row-${index}`,
      detail: "x".repeat(10000),
    })),
  );
  expect(output.rows.length).toBeLessThanOrEqual(200);
  expect(output.rows.length).toBeGreaterThan(0);
  expect(output.summary).toContain("250");
  expect(JSON.stringify(output).length).toBeLessThan(1000000);
});

it("removes stopped watches from native activity and its count without deleting history", () => {
  const stopped = {
    ...snapshot,
    watches: snapshot.watches.map((watch) => ({ ...watch, watching: false })),
  };
  expect(watchActivityRows([[EnvironmentId.make("one"), stopped]])).toEqual([]);
  expect(stopped.watches).toHaveLength(1);
  const rows = watchActivityRows([[EnvironmentId.make("one"), snapshot]]);
  expect(boundedActivitySnapshot(rows).summary).toBe("1 activity item");
});

it("always retains the three latest interacted threads, including idle and offline, without counting background updates", () => {
  const local = EnvironmentId.make("local");
  const makeThread = (id: string, at: string | null, environmentId = local) => ({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    session: null,
    archivedAt: null,
    backgroundLiveness: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestUserMessageAt: at,
  });
  const rows = threadActivityRows(
    [
      makeThread("old", "2026-09-14T01:00:00Z"),
      makeThread("new", "2026-09-14T02:00:00Z"),
      makeThread("offline", "2026-09-14T03:00:00Z", EnvironmentId.make("remote")),
      makeThread("viewed", null),
      { ...makeThread("archived", "2026-09-14T05:00:00Z"), archivedAt: "2026-09-14T06:00:00Z" },
    ],
    new Set([local]),
    { "local:viewed": "2026-09-14T04:00:00Z" },
  );
  expect(rows.map((row) => row.threadId)).toEqual(["viewed", "offline", "new"]);
  expect(rows.every((row) => row.recent && row.status === "Idle")).toBe(true);
});

describe("native watch activity state", () => {
  const row = {
    ...watchActivityRows([[EnvironmentId.make("one"), snapshot]])[0]!,
    status: "offline · checks pending",
    checks: [{ name: "Tests", status: "pending" as const }],
  };
  it("keeps live CI active with a stopped manager but respects a disconnected monitor", () => {
    expect(activityRowVisualState(row)).toBe("active");
    expect(activityRowVisualState({ ...row, status: "Offline · last observed" })).toBe("offline");
    expect(activityRowVisualState({ ...row, status: "Monitor unavailable · last observed" })).toBe(
      "offline",
    );
  });
  it("prioritizes managing thread input over running checks", () => {
    const manager = {
      hasPendingApprovals: true,
      hasPendingUserInput: false,
      session: null,
      settledOverride: null,
    };
    expect(activityRowVisualState(row, manager)).toBe("attention");
    expect(
      activityRowVisualState(row, {
        ...manager,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toBe("attention");
    expect(activityRowVisualState({ ...row, status: "Offline · last observed" }, manager)).toBe(
      "offline",
    );
  });
});
