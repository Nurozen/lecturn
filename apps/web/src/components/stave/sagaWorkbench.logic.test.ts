import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type SagaWorkbenchWorkflow,
} from "@lecturn/contracts";
import {
  parseSagaWorkbenchSearch,
  sagaSummarySourceTarget,
  sagaWorkflowLabel,
  sagaThreadActivity,
  sagaProjectActivities,
  sagaStageDropInput,
  captureSagaStageDrag,
  sagaRunningProjects,
} from "./sagaWorkbench.logic";
import { sagaSidebarThreadOrder } from "./staveSaga.logic";

const environment = EnvironmentId.make("remote-server");
const workflow: SagaWorkbenchWorkflow = {
  identity: {
    projectId: ProjectId.make("space"),
    workspaceRoot: "/spaces/one",
    spaceId: "one",
    createdAt: "2026-01-01T00:00:00Z",
  },
  revision: 1,
  stage: "accept",
  accepted: null,
  completedAt: "2026-01-02T00:00:00Z",
  summary: null,
};
describe("saga workbench navigation and freshness", () => {
  it("preserves selected member across every view and rejects invalid view values", () => {
    for (const view of ["board", "list", "dependencies", "activity", "settings"])
      expect(parseSagaWorkbenchSearch({ view, member: "api" })).toEqual({ view, member: "api" });
    expect(parseSagaWorkbenchSearch({ view: "destroy", member: 12 })).toEqual({ view: "board" });
  });
  it("routes thread provenance inside its originating environment", () => {
    expect(sagaSummarySourceTarget("lecturn:thread:shared-id", environment)).toEqual({
      kind: "thread",
      environmentId: environment,
      threadId: "shared-id",
    });
    expect(sagaSummarySourceTarget("https://host/repo/pull/1", environment)).toEqual({
      kind: "external",
      url: "https://host/repo/pull/1",
    });
    for (const url of ["/spaces/a/SPEC.md", "javascript:alert(1)", "lecturn:thread:"])
      expect(sagaSummarySourceTarget(url, environment).kind).toBe("reference");
  });
  it("never presents stale completion as current completion", () => {
    expect(sagaWorkflowLabel({ ...workflow, evidenceState: "stale" })).toBe(
      "Completion needs verification",
    );
    expect(sagaWorkflowLabel({ ...workflow, evidenceState: "unverified" })).toBe(
      "Completed · last verified",
    );
    expect(sagaWorkflowLabel(null)).toBe("Unavailable");
  });
  it("matches keyboard order to visible hierarchy, retaining shelf order within projects", () => {
    const child = {
      group: { key: "space", memberProjectRefs: [{ environmentId: "local", projectId: "space" }] },
      children: [],
    };
    const saga = {
      group: { key: "saga", memberProjectRefs: [{ environmentId: "local", projectId: "saga" }] },
      children: [child],
    };
    const clone = {
      group: {
        key: "remote",
        memberProjectRefs: [{ environmentId: "remote", projectId: "space" }],
      },
      children: [],
    };
    const rows = [
      { id: "pinned-member", environmentId: "local", projectId: "space" },
      { id: "saga-conversation", environmentId: "local", projectId: "saga" },
      { id: "remote-clone", environmentId: "remote", projectId: "space" },
      { id: "settled-member", environmentId: "local", projectId: "space" },
    ];
    const ids = (collapsed: string[]) =>
      sagaSidebarThreadOrder([saga, clone], new Set(collapsed), rows).map((row) => row.id);
    expect(ids([])).toEqual([
      "saga-conversation",
      "pinned-member",
      "settled-member",
      "remote-clone",
    ]);
    expect(ids(["space"])).toEqual(["saga-conversation", "remote-clone"]);
    expect(ids(["saga"])).toEqual(["remote-clone"]);
    expect(ids(["saga", "remote"])).toEqual([]);
  });
});

describe("saga agent activity", () => {
  const idle: Parameters<typeof sagaThreadActivity>[0] = {
    environmentId: environment,
    projectId: ProjectId.make("space"),
    archivedAt: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    latestTurn: null,
    session: null,
  };
  const running: typeof idle = {
    ...idle,
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "running",
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-1"),
      lastError: null,
      updatedAt: "2026-01-01T00:00:00Z",
    },
  };
  it("uses current attention flags ahead of a running session", () => {
    expect(sagaThreadActivity(running)).toEqual({ kind: "running", label: "Running" });
    expect(sagaThreadActivity({ ...running, hasPendingUserInput: true })).toEqual({
      kind: "waiting",
      label: "Waiting for human · input",
    });
    expect(
      sagaThreadActivity({ ...running, hasPendingUserInput: true, hasPendingApprovals: true }),
    ).toEqual({ kind: "waiting", label: "Waiting for human · approval" });
    expect(sagaThreadActivity(idle)).toEqual({ kind: "idle", label: "Idle" });
  });
  it("rolls up attention before running before idle across member conversations", () => {
    const activity = (rows: readonly (typeof idle)[]) =>
      sagaProjectActivities(rows, environment).get(idle.projectId);
    expect(activity([idle, running])?.kind).toBe("running");
    expect(activity([running, { ...idle, hasPendingUserInput: true }])?.label).toBe(
      "Waiting for human · input",
    );
    expect(activity([idle])?.kind).toBe("idle");
    expect(activity([{ ...running, archivedAt: "2026-01-02T00:00:00Z" }, idle])?.kind).toBe("idle");
  });
  it("keeps the running border when a different chat is waiting, with environment isolation", () => {
    expect(
      sagaRunningProjects([running, { ...idle, hasPendingUserInput: true }], environment).has(
        idle.projectId,
      ),
    ).toBe(true);
    expect(
      sagaRunningProjects(
        [
          { ...running, archivedAt: "2026-01-02T00:00:00Z" },
          { ...running, environmentId: EnvironmentId.make("other-server") },
        ],
        environment,
      ).size,
    ).toBe(0);
  });
  it("isolates same-ID projects on other environments and other projects locally", () => {
    const otherProject = ProjectId.make("other-space");
    const activity = sagaProjectActivities(
      [
        idle,
        { ...running, environmentId: EnvironmentId.make("other-server") },
        { ...running, projectId: otherProject },
      ],
      environment,
    );
    expect(activity.get(idle.projectId)?.kind).toBe("idle");
    expect(activity.get(otherProject)?.kind).toBe("running");
  });
  it("preserves background monitoring and work without confusing them with completion", () => {
    expect(sagaThreadActivity({ ...idle, backgroundLiveness: "working" })?.label).toBe("Running");
    expect(sagaThreadActivity({ ...idle, backgroundLiveness: "monitoring" })?.label).toBe(
      "Monitoring",
    );
  });
});

describe("manual board movement", () => {
  const manual = { ...workflow, completedAt: null, stage: "spec" as const, automaticStage: false };
  const member = {
    id: "one",
    after: [],
    state: "live" as const,
    identity: manual.identity,
    workflow: manual,
  };
  it("uses the dragged member's captured identity and revision, independent of inspector selection", () => {
    const other = {
      ...member,
      id: "two",
      workflow: {
        ...manual,
        revision: 9,
        identity: {
          ...manual.identity,
          projectId: ProjectId.make("two"),
          spaceId: "two",
          workspaceRoot: "/spaces/two",
        },
      },
    };
    expect(
      sagaStageDropInput([member, other], captureSagaStageDrag(other), "build", true, "request"),
    ).toEqual({
      identity: other.workflow.identity,
      expectedRevision: 9,
      requestId: "request",
      stage: "build",
    });
  });
  it("blocks automatic, pinned, complete, inactive, disconnected and obsolete drops", () => {
    for (const blocked of [
      { ...member, workflow: { ...workflow, completedAt: null } },
      { ...member, workflow: { ...manual, automaticStage: true } },
      { ...member, workflow: { ...manual, stagePinned: true } },
      { ...member, workflow: { ...manual, completedAt: "2026-01-02T00:00:00Z" } },
      { ...member, state: "archived" as const },
      { ...member, workflow: null },
    ])
      expect(
        sagaStageDropInput([blocked], captureSagaStageDrag(member), "build", true, "r"),
      ).toBeNull();
    expect(
      sagaStageDropInput([member], captureSagaStageDrag(member), "build", false, "r"),
    ).toBeNull();
    expect(sagaStageDropInput([member], null, "build", true, "r")).toBeNull();
    expect(
      sagaStageDropInput([member], captureSagaStageDrag(member), "spec", true, "r"),
    ).toBeNull();
    expect(
      sagaStageDropInput([member], captureSagaStageDrag(member), "completed", true, "r"),
    ).toBeNull();
  });
  it("rejects a replacement incarnation even when its name and revision match", () => {
    const gesture = captureSagaStageDrag(member);
    for (const identity of [
      { ...manual.identity, createdAt: "2026-02-01T00:00:00Z" },
      { ...manual.identity, projectId: ProjectId.make("replacement") },
      { ...manual.identity, workspaceRoot: "/spaces/replacement" },
      { ...manual.identity, spaceId: "replacement" },
    ]) {
      const replacement = { ...member, identity, workflow: { ...manual, identity } };
      expect(sagaStageDropInput([replacement], gesture, "build", true, "r")).toBeNull();
    }
  });
  it("rejects concurrent stage or pin changes, including a pin that was cleared again", () => {
    const gesture = captureSagaStageDrag(member);
    for (const changed of [
      { ...manual, revision: 2, stage: "plan" as const },
      { ...manual, revision: 2, stagePinned: true },
      { ...manual, revision: 3, stagePinned: false },
    ])
      expect(
        sagaStageDropInput([{ ...member, workflow: changed }], gesture, "build", true, "r"),
      ).toBeNull();
  });
  it("keeps pickup identity and revision independent of later live data changes", () => {
    const live = { ...member, workflow: { ...manual, identity: { ...manual.identity } } };
    const gesture = captureSagaStageDrag(live);
    live.workflow.identity.createdAt = "2026-02-01T00:00:00Z";
    live.workflow.revision = 2;
    expect(gesture?.identity.createdAt).toBe(manual.identity.createdAt);
    expect(gesture?.revision).toBe(manual.revision);
    expect(sagaStageDropInput([live], gesture, "build", true, "r")).toBeNull();
  });
  it("permits backward and skipped phases when manual and unpinned", () => {
    expect(
      sagaStageDropInput([member], captureSagaStageDrag(member), "accept", true, "r")?.stage,
    ).toBe("accept");
    expect(
      sagaStageDropInput(
        [{ ...member, workflow: { ...manual, stage: "review" } }],
        captureSagaStageDrag(member),
        "plan",
        true,
        "r",
      )?.stage,
    ).toBe("plan");
  });
});
