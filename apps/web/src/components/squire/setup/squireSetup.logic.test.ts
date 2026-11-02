import {
  DEFAULT_SQUIRE_BUDGETS,
  DEFAULT_SQUIRE_COMPANION,
  DEFAULT_SQUIRE_PERMISSIONS,
  ProjectId,
  ProviderInstanceId,
  SquireId,
  ThreadId,
  squireCompanionLookKey,
  squireDistinctCompanion,
  type Squire,
  type SquireActionLogEntry,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SQUIRE_NO_SUPPORTED_PROVIDER,
  SQUIRE_PALETTE_CHOICES,
  squireCompanionForRole,
  squireLeadActionRows,
  squireLeadActionText,
  squireProviderOptions,
  squireScopeThreadChecked,
  squireScopeToggleContainer,
  squireScopeToggleThread,
  squireScopeTree,
  squireSetupDraftForCreate,
  squireSetupDraftFromProposal,
  squireSetupDraftFromSquire,
  squireSetupRecordReady,
  squireSetupSaveState,
  squireSetupSections,
  squireUpdatePatch,
} from "./squireSetup.logic";

const claude = ProviderInstanceId.make("claude");
const cursor = ProviderInstanceId.make("cursor");

describe("squireSetupSections", () => {
  it("gives the Lead no scope, events, rules, or triggers, and adds digest, sweep, and Lead actions", () => {
    const lead = squireSetupSections("lead");
    for (const absent of ["scope", "events", "rules", "triggers"] as const) {
      expect(lead).not.toContain(absent);
    }
    for (const present of ["digest", "sweep", "leadActions", "companion"] as const) {
      expect(lead).toContain(present);
    }
  });

  it("gives a Squire scope, events, rules, and triggers but no Lead-only section", () => {
    const squire = squireSetupSections("squire");
    for (const present of ["scope", "events", "rules", "triggers", "companion"] as const) {
      expect(squire).toContain(present);
    }
    for (const absent of ["digest", "sweep", "leadActions"] as const) {
      expect(squire).not.toContain(absent);
    }
  });
});

describe("squireProviderOptions and save state", () => {
  const providers = [
    { instanceId: claude, label: "Claude" },
    { instanceId: cursor, label: "Cursor" },
  ];

  it("offers every provider with unknown support until the server answers", () => {
    expect(squireProviderOptions(providers, null).map((o) => o.supported)).toEqual([null, null]);
  });

  it("carries each instance's support flag and reason", () => {
    const options = squireProviderOptions(providers, [
      { instanceId: claude, supported: true, reason: null },
      { instanceId: cursor, supported: false, reason: "managed MCP configuration" },
    ]);
    expect(options.find((o) => o.instanceId === cursor)).toMatchObject({
      supported: false,
      reason: "managed MCP configuration",
    });
  });
});

const projectId = ProjectId.make("project-billing");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

function squireRecord(overrides: Partial<Squire> = {}): Squire {
  return {
    id: SquireId.make("squire-release"),
    role: "squire",
    name: "Release",
    lifecycle: "ready",
    status: "active",
    homeProjectId: projectId,
    homeThreadId: null,
    providerInstanceId: claude,
    modelSelection: null,
    summaryModelSelection: null,
    brief: "Ship releases.",
    grants: [{ kind: "project", targetId: projectId, origin: "granted", createdAt: NOW }],
    events: squireSetupDraftForCreate({ homeProjectId: null, providerInstanceId: null }).events,
    permissions: DEFAULT_SQUIRE_PERMISSIONS,
    budgets: DEFAULT_SQUIRE_BUDGETS,
    undoWindowSeconds: 10,
    companion: { ...DEFAULT_SQUIRE_COMPANION, palette: "sage" },
    digest: null,
    sweep: null,
    onboardedAt: null,
    automationPausedAt: null,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
const NOW = "2026-11-01T09:00:00.000Z";

describe("draft from a Lead proposal", () => {
  it("copies name, brief, grants, permissions, and companion over the create defaults", () => {
    const draft = squireSetupDraftFromProposal(
      {
        type: "squire-proposal",
        name: "Research",
        brief: "Watch the research threads.",
        grants: [{ kind: "staveSpace", targetId: "research" }],
        permissions: { steer: "off", createThread: "recommend", notify: "on" },
        companion: { ...DEFAULT_SQUIRE_COMPANION, palette: "rose", equipment: "astrolabe" },
      },
      { homeProjectId: projectId, providerInstanceId: claude },
    );
    expect(draft).toMatchObject({
      name: "Research",
      brief: "Watch the research threads.",
      grants: [{ kind: "staveSpace", targetId: "research" }],
      permissions: { steer: "off", createThread: "recommend", notify: "on" },
      companion: { palette: "rose", equipment: "astrolabe" },
      homeProjectId: projectId,
      providerInstanceId: claude,
      digest: null,
      sweep: null,
    });
  });
});

describe("squireUpdatePatch", () => {
  it("holds only the keys the user changed", () => {
    const squire = squireRecord();
    const draft = squireSetupDraftFromSquire(squire);
    expect(squireUpdatePatch(squire, draft)).toEqual({});
    const patch = squireUpdatePatch(squire, {
      ...draft,
      name: "Release train",
      permissions: { ...draft.permissions, steer: "auto" },
    });
    expect(patch).toEqual({
      name: "Release train",
      permissions: { ...DEFAULT_SQUIRE_PERMISSIONS, steer: "auto" },
    });
  });

  it("ignores grant order and sends a provider change as providerInstanceId", () => {
    const squire = squireRecord({
      grants: [
        { kind: "project", targetId: projectId, origin: "granted", createdAt: NOW },
        { kind: "exclusion", targetId: threadA, origin: "granted", createdAt: NOW },
      ],
    });
    const draft = squireSetupDraftFromSquire(squire);
    expect(
      squireUpdatePatch(squire, {
        ...draft,
        grants: [...draft.grants].toReversed(),
        providerInstanceId: cursor,
      }),
    ).toEqual({ providerInstanceId: cursor });
  });
});

describe("save state", () => {
  const draft = {
    ...squireSetupDraftForCreate({ homeProjectId: projectId, providerInstanceId: claude }),
    name: "Docs",
  };
  const option = (instanceId: typeof claude, supported: boolean | null) => ({
    instanceId,
    label: instanceId,
    supported,
    reason: supported === false ? "managed MCP configuration" : null,
  });

  it("blocks with No supported provider only when support is known and none is supported", () => {
    expect(squireSetupSaveState(draft, [option(claude, false), option(cursor, false)])).toEqual({
      canSave: false,
      reason: SQUIRE_NO_SUPPORTED_PROVIDER,
    });
    expect(squireSetupSaveState(draft, [option(claude, null), option(cursor, null)])).toEqual({
      canSave: true,
    });
    expect(squireSetupSaveState(draft, [option(claude, true), option(cursor, false)])).toEqual({
      canSave: true,
    });
  });

  it("refuses an unsupported pick with the server's reason", () => {
    expect(
      squireSetupSaveState({ ...draft, providerInstanceId: cursor }, [
        option(claude, true),
        option(cursor, false),
      ]),
    ).toEqual({ canSave: false, reason: "managed MCP configuration" });
  });
});

describe("companion palette", () => {
  it("keeps the Lead on gold and never lets a Squire's draft pick gold", () => {
    const lead = squireRecord({
      role: "lead",
      companion: { ...DEFAULT_SQUIRE_COMPANION, palette: "brass" },
      digest: { time: "09:00", push: false },
    });
    expect(squireSetupDraftFromSquire(lead).companion.palette).toBe("gold");
    const gilded = squireRecord({ companion: { ...DEFAULT_SQUIRE_COMPANION, palette: "gold" } });
    expect(squireSetupDraftFromSquire(gilded).companion.palette).not.toBe("gold");
    expect(
      squireCompanionForRole({ ...DEFAULT_SQUIRE_COMPANION, palette: "gold" }, "squire").palette,
    ).not.toBe("gold");
    expect(SQUIRE_PALETTE_CHOICES).not.toContain("gold");
    expect(squireDistinctCompanion([]).palette).not.toBe("gold");
  });

  it("gives a new Squire a look, palette, and equipment nobody else uses", () => {
    const taken = [
      { ...DEFAULT_SQUIRE_COMPANION, palette: "gold" as const },
      { ...DEFAULT_SQUIRE_COMPANION, palette: "brass" as const, equipment: "helmet" as const },
    ];
    const next = squireDistinctCompanion(taken);
    expect(taken.map(squireCompanionLookKey)).not.toContain(squireCompanionLookKey(next));
    expect(`${next.appearance}/${next.hood}`).not.toBe(
      `${DEFAULT_SQUIRE_COMPANION.appearance}/${DEFAULT_SQUIRE_COMPANION.hood}`,
    );
    expect(["gold", "brass"]).not.toContain(next.palette);
    expect(next.equipment).not.toBe("helmet");
  });
});

describe("scope tree", () => {
  const project = [{ kind: "project" as const, targetId: projectId }];
  const inProject = [{ kind: "project" as const, targetId: projectId }];

  it("records an exclusion when a thread inside a granted project is unchecked", () => {
    const excluded = squireScopeToggleThread(project, threadA, inProject);
    expect(excluded).toContainEqual({ kind: "exclusion", targetId: threadA });
    expect(squireScopeThreadChecked(excluded, threadA, inProject)).toBe(false);
    expect(squireScopeThreadChecked(excluded, threadB, inProject)).toBe(true);
    expect(squireScopeToggleThread(excluded, threadA, inProject)).toEqual(project);
  });

  it("grants a single thread outside any granted project, and a project grant replaces it", () => {
    const single = squireScopeToggleThread([], threadA, inProject);
    expect(single).toEqual([{ kind: "thread", targetId: threadA }]);
    expect(squireScopeToggleContainer(single, "project", projectId, [threadA])).toEqual(project);
  });

  it("counts a thread as watched through its space or saga, and excludes it from there", () => {
    const space = [{ kind: "staveSpace" as const, targetId: "billing" }];
    const chain = [...inProject, ...space, { kind: "staveSaga" as const, targetId: "v2-release" }];
    expect(squireScopeThreadChecked(space, threadA, chain)).toBe(true);
    const excluded = squireScopeToggleThread(space, threadA, chain);
    expect(excluded).toEqual([...space, { kind: "exclusion", targetId: threadA }]);
    expect(squireScopeThreadChecked(excluded, threadA, chain)).toBe(false);
    expect(squireScopeToggleThread(excluded, threadA, chain)).toEqual(space);
  });

  it("nests saga, member space, and project once each, with plain projects at the top", () => {
    const row = (
      id: string,
      title: string,
      stave: Parameters<typeof squireScopeTree>[0][number]["stave"] = null,
    ) => ({
      id: ProjectId.make(id),
      title,
      stave,
    });
    const tree = squireScopeTree([
      row("p-plaudio", "plaudio", { spaceId: "plaudio", isSaga: false }),
      row("p-loose", "loose"),
      row("p-billing", "billing-service", {
        spaceId: "billing",
        isSaga: false,
        memberOf: "v2-release",
      }),
      row("p-saga", "v2-release", { spaceId: "v2-release", isSaga: true }),
      row("p-billing-web", "billing-web", {
        spaceId: "billing",
        isSaga: false,
        memberOf: "v2-release",
      }),
    ]);
    const shape = (nodes: typeof tree): unknown =>
      nodes.map((node) =>
        node.kind === "project"
          ? node.label
          : { [`${node.kind}:${node.label}`]: shape(node.children) },
      );
    expect(shape(tree)).toEqual([
      {
        "staveSaga:v2-release": [
          "v2-release",
          { "staveSpace:billing": ["billing-service", "billing-web"] },
        ],
      },
      { "staveSpace:plaudio": ["plaudio"] },
      "loose",
    ]);
  });
});

describe("create draft", () => {
  it("starts empty, never carrying another Squire's name, brief, or watches", () => {
    const draft = squireSetupDraftForCreate({
      homeProjectId: projectId,
      providerInstanceId: claude,
    });
    expect([draft.name, draft.brief, draft.grants]).toEqual(["", "", []]);
  });
});

describe("edit sheet record", () => {
  // A sheet reopened after a fixture set the undo window to 60 s showed the persisted
  // detail copy (10 s) and froze it into the draft.
  it("waits for a copy at least as new as the snapshot before seeding the draft", () => {
    const cached = { revision: 4 };
    expect(squireSetupRecordReady({ squire: cached, snapshotRevision: 5, refetching: true })).toBe(
      false,
    );
    expect(
      squireSetupRecordReady({ squire: { revision: 5 }, snapshotRevision: 5, refetching: false }),
    ).toBe(true);
    // A current persisted copy opens at once, without waiting on the refetch.
    expect(
      squireSetupRecordReady({ squire: { revision: 5 }, snapshotRevision: 5, refetching: true }),
    ).toBe(true);
  });

  it("without a snapshot entry, waits out the refetch", () => {
    expect(
      squireSetupRecordReady({ squire: null, snapshotRevision: null, refetching: false }),
    ).toBe(false);
    expect(
      squireSetupRecordReady({ squire: { revision: 4 }, snapshotRevision: null, refetching: true }),
    ).toBe(false);
    expect(
      squireSetupRecordReady({
        squire: { revision: 4 },
        snapshotRevision: null,
        refetching: false,
      }),
    ).toBe(true);
  });
});

describe("Lead actions", () => {
  const entry = (
    id: number,
    kind: SquireActionLogEntry["kind"],
    data: Record<string, unknown>,
  ) => ({
    id,
    squireId: SquireId.make("lead"),
    kind,
    threadId: null,
    cardId: null,
    eventId: null,
    runId: null,
    roomId: null,
    postId: null,
    triggerId: null,
    taskId: null,
    data,
    createdAt: NOW,
  });

  it("lists control executions newest first and marks reverted ones", () => {
    const rows = squireLeadActionRows([
      entry(1, "action.executed", {
        action: "control",
        control: "pause",
        squireId: "squire-release",
        reason: "Idle",
      }),
      entry(2, "action.executed", { action: "steer" }),
      entry(3, "action.executed", {
        action: "control",
        control: "forward",
        squireId: null,
        toSquireId: "squire-docs",
      }),
      entry(4, "control.reverted", { logEntryId: 1, requestId: "r" }),
    ]);
    expect(rows.map((row) => [row.logEntryId, row.control, row.reverted])).toEqual([
      [3, "forward", false],
      [1, "pause", true],
    ]);
    expect(squireLeadActionText(rows[1]!, () => "Release")).toBe("Paused Release");
  });
});
