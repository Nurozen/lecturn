import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  SquireCardId,
  SquireCardRow,
  SquireId,
  SquireRule,
  SquireRuleOffer,
  SquireSnapshot,
  ThreadId,
  type PullRequestWatchSnapshot,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { makeThreadFixture } from "../../test-fixtures";
import {
  CoalescedActivityPublication,
  activityRowVisualState,
  withActivityAccountMarks,
  resolveActivityAction,
  boundedActivitySnapshot,
  watchActivityRows,
  scopedPullRequestProjectIds,
  threadActivityRows,
  resolveSquireActivityAction,
  runSquireActivityAction,
  squireActivityItemResult,
  squireActivityOverlay,
  squireActivityRowId,
  squireActivityRows,
  squireOfferRowId,
  type SquireActivityAction,
  type SquireActivityDeps,
  type SquireActivityOffer,
  type SquireActivitySource,
} from "./desktopActivity.logic";

const runningRuntime = {
  status: "running" as const,
  activeRunId: RunId.make("run"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-09-14T04:00:00Z",
};

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
    runtime: null,
    archivedAt: null,
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
  const rows = threadActivityRows(
    [
      base,
      {
        ...base,
        id: ThreadId.make("monitor"),
        pendingBackgroundTasks: [{ kind: "command" as const, taskId: "watch-logs" }],
      },
      {
        ...base,
        id: ThreadId.make("approval"),
        hasPendingApprovals: true,
        runtime: runningRuntime,
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
    ["monitor", "Working · background tasks"],
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
    runtime: null,
    archivedAt: null,
    settledOverride: null,
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
      runtime: null,
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

describe("settled conversation visibility", () => {
  const local = EnvironmentId.make("local");
  const connected = new Set([local]);
  const makeThread = (
    id: string,
    overrides: Partial<EnvironmentThreadShell> = {},
  ): EnvironmentThreadShell =>
    makeThreadFixture({
      id: ThreadId.make(id),
      environmentId: local,
      projectId: ProjectId.make("project"),
      title: id,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      createdAt: "2026-09-14T00:00:00Z",
      updatedAt: "2026-09-14T00:00:00Z",
      ...overrides,
    });

  it("fills all three recent slots from unsettled threads, including offline conversations", () => {
    const threads = [
      makeThread("older", { latestUserMessageAt: "2026-09-14T01:00:00Z" }),
      makeThread("second", { latestUserMessageAt: "2026-09-14T02:00:00Z" }),
      makeThread("offline", {
        environmentId: EnvironmentId.make("remote"),
        latestUserMessageAt: "2026-09-14T03:00:00Z",
      }),
      makeThread("settled", {
        settledOverride: "settled",
        latestUserMessageAt: "2026-09-14T04:00:00Z",
      }),
    ];
    const rows = threadActivityRows(threads, connected, {
      "local:settled": "2026-09-14T05:00:00Z",
    });
    expect(rows.map((row) => row.threadId)).toEqual(["offline", "second", "older"]);
    expect(rows.every((row) => row.recent)).toBe(true);
    expect(boundedActivitySnapshot(rows).summary).toBe("3 activity items");
  });

  it.each([
    ...(["running", "starting", "failed", "interrupted", "idle"] as const).map((status) => ({
      runtime: { ...runningRuntime, status },
    })),
    { pendingBackgroundTasks: [{ kind: "command" as const, taskId: "watch-logs" }] },
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
  ])("ignores stale activity on settled threads: %j", (activity) => {
    expect(
      threadActivityRows(
        [makeThread("settled", { ...activity, settledOverride: "settled" })],
        connected,
      ),
    ).toEqual([]);
  });

  it("removes settled rows and stale actions, retains PR watches, and restores explicitly unsettled rows", () => {
    const thread = makeThread("recent", { latestUserMessageAt: "2026-09-14T04:00:00Z" });
    const before = threadActivityRows([thread], connected);
    const row = before[0]!;
    const settledThread = { ...thread, settledOverride: "settled" as const };
    const settled = threadActivityRows([settledThread], connected);
    const watched = {
      ...snapshot,
      watches: snapshot.watches.map((watch) => ({
        ...watch,
        managerThreadId: thread.id,
        threadIds: [thread.id],
      })),
    };
    const watches = watchActivityRows([[local, watched]], [settledThread]);
    const after = [...settled, ...watches];
    expect(boundedActivitySnapshot(after).summary).toBe("1 activity item");
    expect(after).toEqual(watches);
    expect(
      resolveActivityAction(
        {
          kind: "steer",
          rowId: row.id,
          environmentId: row.environmentId,
          projectId: row.projectId,
          threadId: row.threadId!,
          text: "continue",
        },
        after,
      ),
    ).toBeNull();
    expect(threadActivityRows([{ ...thread, settledOverride: "active" }], connected)).toEqual(
      before,
    );
    expect(boundedActivitySnapshot(settled)).toEqual({ summary: "0 activity items", rows: [] });
  });
});

describe("desktop activity account ownership", () => {
  it("marks only catalog-owned rows and clears a previous owner's mark after sign-out", () => {
    const rows = watchActivityRows([
      [EnvironmentId.make("one"), snapshot],
      [EnvironmentId.make("two"), snapshot],
    ]);
    const marks = new Map([["one", { accountId: "user_a", label: "Work", color: "#5599aa" }]]);
    const marked = withActivityAccountMarks(rows, marks);
    expect(marked[0]).toMatchObject({
      accountId: "user_a",
      accountLabel: "Work",
      accountColor: "#5599aa",
    });
    expect(marked[1]).not.toHaveProperty("accountId");
    expect(withActivityAccountMarks(marked, new Map())).toEqual(rows);
    expect(
      withActivityAccountMarks(
        marked,
        new Map([["one", { accountId: "user_b", label: "Personal", color: "#aa55aa" }]]),
      )[0],
    ).toMatchObject({ accountId: "user_b", accountLabel: "Personal" });
  });
});

// ── Squire rows (10c) ─────────────────────────────────────────

const squireAt = "2026-11-01T10:00:00.000Z";
const decodeSquireSnapshot = Schema.decodeUnknownSync(SquireSnapshot);
const decodeCardRow = Schema.decodeUnknownSync(SquireCardRow);
const encodeCardRow = Schema.encodeSync(SquireCardRow);
const squireEnv = EnvironmentId.make("env");

const squireEntry = (
  id: string,
  extra: {
    held?: Array<{ cardId: string; executesInMs: number; heldOverCardId?: string }>;
    role?: "lead" | "squire";
  } = {},
): SquireSnapshotEntry => ({
  ...decodeSquireSnapshot({
    squire: {
      id,
      role: extra.role ?? "squire",
      name: id === "lead" ? "Lead" : "Release",
      lifecycle: "ready",
      status: "active",
      homeProjectId: "home-project",
      homeThreadId: `home-${id}`,
      providerInstanceId: null,
      modelSelection: null,
      summaryModelSelection: null,
      brief: "",
      grants: [],
      undoWindowSeconds: 60,
      companion: { palette: id === "lead" ? "gold" : "brass" },
      digest: null,
      sweep: null,
      onboardedAt: null,
      automationPausedAt: null,
      revision: 0,
      createdAt: squireAt,
      updatedAt: squireAt,
    },
    openDecisionCount: 1,
    countsByKind: { steer: 1, question: 0, overlap: 0, proposal: 0, fyi: 0 },
    held: (extra.held ?? []).map((hold) => ({
      ...hold,
      kind: "steer",
      targetThreadId: "target",
    })),
    budget: { steersLeft: 7, threadsLeft: 3 },
    conflicts: [],
    trackedCount: 1,
    containerNames: [],
    recentActivity: [],
    itemsRevision: 1,
    decisionRevision: 1,
  }),
  receivedAt: 1_000,
});

const cardRow = (id: string, status: "open" | "held", ruleId: string | null = null) =>
  decodeCardRow({
    id,
    squireId: "release",
    ownerSquireId: "release",
    kind: "steer",
    status,
    title: status === "held" ? "Rerun api-e2e" : "Rebase onto main",
    targetThreadId: "target",
    projectId: "project",
    origin: "event",
    steerKind: "rebase",
    ruleId,
    routedTaskId: null,
    caption: null,
    replacedCount: 0,
    executesAt: null,
    openedAt: null,
    createdAt: squireAt,
    updatedAt: squireAt,
  });

const allowRule = Schema.decodeSync(SquireRule)({
  id: "rule-1",
  squireId: "release",
  effect: "allow",
  actionClass: "steer",
  targetKind: "thread",
  targetId: "target",
  steerKind: "rerun-checks",
  matchCount: 1,
  lastMatchedAt: null,
  status: "active",
  createdAt: squireAt,
});

const squireSource = (
  items: ReadonlyArray<SquireCardRow>,
  heldOverCardId?: string,
): SquireActivitySource => {
  const lead = squireEntry("lead", { role: "lead" });
  const release = squireEntry("release", {
    held: [
      {
        cardId: "held-1",
        executesInMs: 60_000,
        ...(heldOverCardId === undefined ? {} : { heldOverCardId }),
      },
    ],
  });
  return {
    environmentId: squireEnv,
    state: { lead: lead.squire.id, squires: [lead, release], rooms: [] },
    items,
    rules: new Map([[release.squire.id, [allowRule]]]),
    threadTitle: () => "Fix invoice rounding",
    targetName: () => "Fix invoice rounding",
  };
};

const undoOffer: SquireActivityOffer = {
  environmentId: squireEnv,
  card: {
    id: SquireCardId.make("held-1"),
    squireId: SquireId.make("release"),
    ownerSquireId: SquireId.make("release"),
    kind: "steer",
  },
  squireName: "Release",
  palette: "brass",
  offer: Schema.decodeSync(SquireRuleOffer)({
    effect: "ask-first",
    actionClass: "steer",
    targetKind: "thread",
    targetId: "target",
    steerKind: "rerun-checks",
    text: 'Release asks first before sending rerun checks steers on "Fix invoice rounding"',
    capReached: false,
  }),
};

describe("Squire notch rows", () => {
  const items = [cardRow("card-1", "open"), cardRow("held-1", "held", "rule-1")];

  it("publishes an open card with its accept, dismiss, and open buttons", () => {
    const [card] = squireActivityRows([squireSource(items)], [], 1_000);
    expect(card).toMatchObject({
      id: squireActivityRowId(squireEnv, SquireCardId.make("card-1")),
      environmentId: "env",
      threadId: "target",
      title: "Rebase onto main",
      squire: { squireId: "release", cardId: "card-1", cardKind: "steer", palette: "brass" },
    });
    expect(card!.squire!.holdRemainingMs).toBeUndefined();
    expect(card!.actions.map((action) => action.id)).toEqual([
      "squire-accept",
      "squire-dismiss",
      "squire-open",
    ]);
  });

  it("publishes a held action with what remains of its hold, its rule label, and Undo", () => {
    const rows = squireActivityRows([squireSource(items)], [], 11_000);
    const held = rows.find((row) => row.squire?.cardId === "held-1")!;
    expect(held.squire!.holdRemainingMs).toBe(50_000);
    expect(held.detail).toContain("Auto by rule: Release may auto-send rerun checks steers");
    expect(held.actions.map((action) => action.id)).toEqual(["squire-undo", "squire-open"]);
  });

  it("offers ask-first after an Undo, as its own row", () => {
    const rows = squireActivityRows([squireSource([])], [undoOffer], 1_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: squireOfferRowId(squireEnv, SquireCardId.make("held-1")),
      title: "Always ask first for this",
      squire: { caption: undoOffer.offer.text },
    });
    expect(rows[0]!.actions.map((action) => action.id)).toEqual([
      "squire-accept",
      "squire-dismiss",
    ]);
  });
});

describe("Squire notch hold pairing (P7.6)", () => {
  const items = [cardRow("card-1", "open"), cardRow("held-1", "held", "rule-1")];
  const rows = squireActivityRows([squireSource(items, "card-1")], [], 11_000);

  it("shows a hold beside its open card as one card, not a second row", () => {
    expect(rows).toHaveLength(1);
    const [card] = rows;
    expect(card!.squire).toMatchObject({
      cardId: "card-1",
      caption: "A newer steer is about to send",
      heldOver: {
        heldCardId: "held-1",
        label: "Newer steer held",
        remainingMs: 50_000,
        ruleLabel: expect.stringContaining("Auto by rule: Release may auto-send rerun checks"),
      },
    });
    // The countdown is the hold's, on its line; the open card itself is not held.
    expect(card!.squire!.holdRemainingMs).toBeUndefined();
    // The open card keeps its own buttons, plus the hold's Undo that the notch puts on its line.
    expect(card!.actions.map((action) => action.id)).toEqual([
      "squire-accept",
      "squire-dismiss",
      "squire-open",
      "squire-undo",
    ]);
  });

  it("keeps a hold whose open card is not in the queue as its own row", () => {
    const lone = squireActivityRows([squireSource([items[1]!], "card-1")], [], 11_000);
    expect(lone.map((row) => row.squire?.cardId)).toEqual(["held-1"]);
  });

  it("undoes the held card, not the open one, from the paired card's Undo", async () => {
    const source = squireSource(items, "card-1");
    const [card] = rows;
    const press = {
      rowId: card!.id,
      environmentId: card!.environmentId,
      projectId: card!.projectId,
      threadId: card!.threadId!,
      kind: "squire-undo" as const,
      requestId: "request-1",
    };
    const target = resolveSquireActivityAction(press, rows, [], [source]);
    expect(target).toMatchObject({ type: "card", cardId: "held-1", card: { id: "held-1" } });
    const act = vi.fn<SquireActivityDeps["act"]>(async () => ({
      ok: true,
      value: {
        results: [{ cardId: SquireCardId.make("held-1"), status: "dismissed", error: null }],
      },
    }));
    await runSquireActivityAction(press, target!, {
      act,
      createRule: async () => ({ ok: true, value: {} }),
      open: async () => undefined,
    });
    expect(act).toHaveBeenCalledWith(squireEnv, { cardIds: ["held-1"], action: "undo" });
    // Accept on the same card still acts on the open card.
    expect(
      resolveSquireActivityAction({ ...press, kind: "squire-accept" }, rows, [], [source]),
    ).toMatchObject({ cardId: "card-1" });
  });

  it("reads an overlap as its thread count and project, as the web row does", () => {
    const overlap = decodeCardRow({
      ...encodeCardRow(items[0]!),
      id: "overlap-1",
      squireId: "lead",
      kind: "overlap",
      steerKind: null,
      targetThreadId: null,
      overlapProviders: ["codex", "claudeAgent"],
    });
    const [row] = squireActivityRows(
      [
        {
          ...squireSource([overlap]),
          projectTitle: (id) => (id === "project" ? "billing-service" : null),
        },
      ],
      [],
      1_000,
    );
    expect(row!.excerpt).toBe("2 threads · billing-service");
  });
});

describe("Squire notch actions", () => {
  const items = [cardRow("card-1", "open"), cardRow("held-1", "held")];
  const rows = squireActivityRows([squireSource(items)], [undoOffer], 1_000);
  const press = (row: (typeof rows)[number], kind: SquireActivityAction["kind"]) =>
    ({
      rowId: row.id,
      environmentId: row.environmentId,
      projectId: row.projectId,
      ...(row.threadId ? { threadId: row.threadId } : {}),
      kind,
      requestId: "request-1",
    }) satisfies SquireActivityAction;
  const card = rows.find((row) => row.squire?.cardId === "card-1")!;
  const held = rows.find(
    (row) => row.id === squireActivityRowId(squireEnv, SquireCardId.make("held-1")),
  )!;
  const offerRow = rows.find(
    (row) => row.id === squireOfferRowId(squireEnv, SquireCardId.make("held-1")),
  )!;
  const deps = (
    act: SquireActivityDeps["act"],
    createRule: SquireActivityDeps["createRule"] = async () => ({ ok: true, value: {} }),
  ): SquireActivityDeps => ({ act, createRule, open: async () => undefined });

  it("refuses a press whose identity is no longer published", () => {
    expect(
      resolveSquireActivityAction({ ...press(card, "squire-accept"), threadId: "other" }, rows, [
        undoOffer,
      ]),
    ).toBeNull();
    expect(resolveSquireActivityAction(press(card, "squire-undo"), rows, [undoOffer])).toBeNull();
  });

  it("returns the server's result for an accept, and its refusal for a refused one", async () => {
    const target = resolveSquireActivityAction(press(card, "squire-accept"), rows, [undoOffer])!;
    const accepted = await runSquireActivityAction(
      press(card, "squire-accept"),
      target,
      deps(async () => ({
        ok: true,
        value: {
          results: [{ cardId: SquireCardId.make("card-1"), status: "resolved", error: null }],
        },
      })),
    );
    expect(accepted.result).toEqual({ requestId: "request-1", ok: true });
    const refused = await runSquireActivityAction(
      press(card, "squire-accept"),
      target,
      deps(async () => ({
        ok: true,
        value: {
          results: [
            {
              cardId: SquireCardId.make("card-1"),
              status: "outdated",
              error: { code: "outdated", message: "The thread started a new turn." },
            },
          ],
        },
      })),
    );
    // An outdated card is not a failure: the notch shows it as info.
    expect(refused.result).toEqual({
      requestId: "request-1",
      ok: true,
      error: "The thread started a new turn.",
    });
  });

  it("classifies the server's per-card answers as success, info, or error", () => {
    const answer = (
      status: SquireCardRow["status"],
      code: "outdated" | "not_found" | "invalid_request" | "permission_denied" | null,
      message = "reason",
    ) => squireActivityItemResult("r", { status, error: code === null ? null : { code, message } });
    const kind = (result: { ok: boolean; error?: string }) =>
      result.ok ? (result.error === undefined ? "success" : "info") : "error";
    expect(kind(answer("resolved", null))).toBe("success");
    expect(kind(squireActivityItemResult("r", undefined))).toBe("success");
    // Already settled, outdated, and gone are not failures.
    expect(kind(answer("dismissed", "invalid_request", "This item was dismissed."))).toBe("info");
    expect(kind(answer("outdated", "outdated"))).toBe("info");
    expect(kind(answer("open", "not_found"))).toBe("info");
    // A refusal with a reason on a live card is.
    expect(kind(answer("open", "invalid_request", "Choose an answer first."))).toBe("error");
    expect(kind(answer("open", "permission_denied"))).toBe("error");
    expect(answer("dismissed", "invalid_request", "This item was dismissed.")).toEqual({
      requestId: "r",
      ok: true,
      error: "This item was dismissed.",
    });
  });

  it("carries a refused RPC's reason in the result the notch receives", async () => {
    const target = resolveSquireActivityAction(press(card, "squire-accept"), rows, [undoOffer])!;
    const transport = await runSquireActivityAction(
      press(card, "squire-accept"),
      target,
      deps(async () => ({ ok: false, error: "Release is paused. Resume it to act on cards." })),
    );
    expect(transport.result).toEqual({
      requestId: "request-1",
      ok: false,
      error: "Release is paused. Resume it to act on cards.",
    });
    const thrown = await runSquireActivityAction(
      press(card, "squire-accept"),
      target,
      deps(async () => {
        throw new Error("Environment disconnected.");
      }),
    );
    expect(thrown.result).toMatchObject({ ok: false, error: "Environment disconnected." });
  });

  it("turns an Undo's ask-first offer into an offer, and saving it settles the offer", async () => {
    const undone = await runSquireActivityAction(
      press(held, "squire-undo"),
      resolveSquireActivityAction(press(held, "squire-undo"), rows, [undoOffer])!,
      deps(async () => ({
        ok: true,
        value: {
          results: [
            {
              cardId: SquireCardId.make("held-1"),
              status: "open",
              error: null,
              ruleOffer: undoOffer.offer,
            },
          ],
        },
      })),
    );
    expect(undone.offer?.offer).toEqual(undoOffer.offer);
    const created: unknown[] = [];
    const saved = await runSquireActivityAction(
      press(offerRow, "squire-accept"),
      resolveSquireActivityAction(press(offerRow, "squire-accept"), rows, [undoOffer])!,
      deps(
        async () => ({ ok: false, error: "unexpected" }),
        async (_environmentId, input) => {
          created.push(input);
          return { ok: true, value: {} };
        },
      ),
    );
    expect(saved).toMatchObject({ result: { ok: true }, settledOffer: "held-1" });
    expect(saved.result.error).toBeUndefined();
    expect(created).toEqual([
      expect.objectContaining({ effect: "ask-first", targetId: "target", fromCardId: "held-1" }),
    ]);
  });

  it("offers Always allow this after an accept, as the app does, when the queue card allows it", async () => {
    const allowOffer: SquireRuleOffer = {
      ...undoOffer.offer,
      effect: "allow",
      text: 'Release may auto-send rebase steers on "Fix invoice rounding"',
    };
    const accept = (sources: ReadonlyArray<SquireActivitySource>) =>
      runSquireActivityAction(
        press(card, "squire-accept"),
        resolveSquireActivityAction(press(card, "squire-accept"), rows, [], sources)!,
        deps(async () => ({
          ok: true,
          value: {
            results: [
              {
                cardId: SquireCardId.make("card-1"),
                status: "resolved",
                error: null,
                ruleOffer: allowOffer,
              },
            ],
          },
        })),
      );
    const accepted = await accept([squireSource(items)]);
    expect(accepted.offer).toMatchObject({ card: { id: "card-1" }, offer: { effect: "allow" } });
    expect(squireActivityRows([squireSource([])], [accepted.offer!], 1_000)[0]).toMatchObject({
      title: "Always allow this",
      status: "Rule offer",
    });
    // Without the queue card the notch cannot tell whether the rule could match, so no offer.
    expect((await accept([])).offer).toBeNull();
  });
});

describe("Squire notch rows from the Lead's combined queue", () => {
  const leadRaised = decodeCardRow({
    ...cardRow("lead-card", "open"),
    squireId: "lead",
    kind: "question",
    steerKind: null,
    title: "Which base should Release use?",
  });
  const fyi = decodeCardRow({ ...cardRow("fyi-1", "open"), kind: "fyi", steerKind: null });
  const source = squireSource([cardRow("card-1", "open"), fyi, leadRaised]);
  const rows = squireActivityRows([source], [], 1_000);

  it("keeps queue order across Squires, names each raiser, and skips FYI", () => {
    expect(rows.map((row) => [row.squire?.cardId, row.subtitle, row.status])).toEqual([
      ["card-1", "Release", "Action · Rebase"],
      ["lead-card", "Lead", "Question"],
    ]);
    expect(rows[1]).toMatchObject({
      squire: { squireId: "release", palette: "gold", cardKind: "question" },
      actions: [
        { id: "squire-open", label: "Answer" },
        { id: "squire-dismiss", label: "Dismiss" },
        { id: "squire-open", label: "Open" },
        { id: "open", label: "Open thread" },
      ],
    });
  });

  it("orders every card primary, Dismiss, Open, and adds Open thread only for a target thread", () => {
    const overlap = (targetThreadId: string | null) =>
      squireActivityRows(
        [
          squireSource([
            decodeCardRow({
              ...cardRow("overlap-1", "open"),
              kind: "overlap",
              steerKind: null,
              targetThreadId,
            }),
          ]),
        ],
        [],
        1_000,
      )[0]!.actions.map((action) => [action.id, action.label]);
    expect(overlap("target")).toEqual([
      ["squire-open", "Review"],
      ["squire-dismiss", "Dismiss"],
      ["squire-open", "Open"],
      ["open", "Open thread"],
    ]);
    expect(overlap(null)).toEqual([
      ["squire-open", "Review"],
      ["squire-dismiss", "Dismiss"],
      ["squire-open", "Open"],
    ]);
  });

  it("files a Lead-raised card's Undo offer under the Lead, which owns the rule", () => {
    const row = rows[1]!;
    const target = resolveSquireActivityAction(
      {
        rowId: row.id,
        environmentId: row.environmentId,
        projectId: row.projectId,
        threadId: row.threadId!,
        kind: "squire-dismiss",
        requestId: "request-2",
      },
      rows,
      [],
      [source],
    );
    expect(target).toMatchObject({
      type: "card",
      squireId: "release",
      card: { squireId: "lead", ownerSquireId: "release" },
    });
  });

  it("disables only the pressed row", () => {
    const [pressed, other] = squireActivityOverlay(rows, new Set([rows[0]!.id]));
    expect(pressed!.status).toBe("Updating…");
    expect(pressed!.actions.every((action) => action.disabled)).toBe(true);
    expect(other).toBe(rows[1]);
  });
});

describe("activity publication", () => {
  // React's StrictMode runs every effect cleanup once at mount in dev, so the bridge disposes
  // its publication and then offers again; that must still reach the host.
  it("publishes after a dispose and re-offer, as a StrictMode remount does", () => {
    vi.useFakeTimers();
    try {
      const published: string[] = [];
      const publication = new CoalescedActivityPublication<string>(300);
      publication.offer("first", (snapshot) => published.push(snapshot));
      publication.dispose();
      publication.offer("rows", (snapshot) => published.push(snapshot));
      publication.offer("more rows", (snapshot) => published.push(snapshot));
      vi.advanceTimersByTime(300);
      expect(published).toEqual(["more rows"]);
      publication.offer("later", (snapshot) => published.push(snapshot));
      vi.advanceTimersByTime(300);
      expect(published).toEqual(["more rows", "later"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
