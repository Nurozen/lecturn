import {
  EnvironmentId,
  ProjectId,
  type SagaWorkbenchSnapshot,
  type SagaWorkbenchWorkflow,
  type StaveSagaStatus,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "./models.ts";
import { buildProjectGroups } from "./projectGrouping.ts";
import {
  buildPhysicalSagaProjectGroups,
  buildPhysicalSagaProjectTree,
  buildSagaDependencyWaves,
  countSagaWorkbenchStages,
  reconcileSagaWorkbenchSnapshot,
  sagaWorkbenchSummaryFallback,
} from "./sagaWorkbench.ts";
const env = EnvironmentId.make("local");
const createdAt = "2026-09-01T00:00:00Z";
const project = (id: string, isSaga = false, environmentId = env): EnvironmentProject => ({
  environmentId,
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/spaces/${id}`,
  repositoryIdentity: {
    canonicalKey: "github.com/org/repo",
    provider: "github",
    owner: "org",
    name: "repo",
    displayName: "org/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/org/repo.git",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt,
  updatedAt: createdAt,
  stave: { spaceId: id, isSaga, createdAt, state: "live", repos: [], memories: [] },
});
const groups = (projects: EnvironmentProject[]) =>
  buildProjectGroups({
    projects,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  });
const member = (id: string): StaveSagaStatus["members"][number] => ({
  id,
  workspaceRoot: `/spaces/${id}`,
  createdAt,
  after: [],
  state: "live",
  dirty: false,
  repos: [],
  prs: [],
});
const index = [
  {
    environmentId: env,
    sagaRoot: "/spaces/saga",
    status: {
      sagaId: "saga",
      sagaCreatedAt: createdAt,
      members: [member("a"), member("b")],
      notes: [],
    },
  },
];
const workflow = (id: string, revision = 0): SagaWorkbenchWorkflow => ({
  identity: {
    projectId: ProjectId.make(id),
    workspaceRoot: `/spaces/${id}`,
    spaceId: id,
    createdAt,
  },
  revision,
  stage: "spec",
  accepted: null,
  completedAt: null,
  summary: null,
});
const snapshot = (
  first: SagaWorkbenchWorkflow | null = workflow("a"),
  second: SagaWorkbenchWorkflow | null = workflow("b"),
): SagaWorkbenchSnapshot => ({
  identity: workflow("saga").identity,
  workflow: workflow("saga"),
  members: ["a", "b"].map((id, i) => ({
    id,
    after: [],
    state: "live",
    identity: workflow(id).identity,
    workflow: i === 0 ? first : second,
  })),
});

describe("physical saga navigation", () => {
  it("keeps ambiguous alias references reachable instead of dropping their threads", () => {
    const input = groups([project("a"), project("b")]);
    const aliased = [
      {
        ...input[0]!,
        memberProjectRefs: [
          ...input[0]!.memberProjectRefs,
          { environmentId: env, projectId: ProjectId.make("old-alias") },
        ],
      },
    ];
    expect(buildPhysicalSagaProjectGroups(aliased, index)).toEqual(aliased);
  });

  it("splits a logical repository group into verified member spaces without moving another environment", () => {
    const input = groups([
      project("saga", true),
      project("a"),
      project("b"),
      project("a", false, EnvironmentId.make("remote")),
    ]);
    const tree = buildPhysicalSagaProjectTree(input, index);
    const saga = tree.find((node) => node.group.representative.stave?.isSaga)!;
    expect(saga.children.map((node) => node.group.representative.id)).toEqual(["a", "b"]);
    expect(tree.some((node) => node.group.representative.environmentId === "remote")).toBe(true);
    expect(
      saga.children.flatMap((node) => node.group.memberProjectRefs).map((ref) => ref.projectId),
    ).toEqual(["a", "b"]);
    expect(input).toHaveLength(1);
  });
  it("does not nest a recreated space using an older roster", () => {
    const child = {
      ...project("a"),
      stave: { ...project("a").stave!, createdAt: "2026-09-02T00:00:00Z" },
    };
    const tree = buildPhysicalSagaProjectTree(groups([project("saga", true), child]), index);
    expect(tree).toHaveLength(2);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });
  it("leaves ordinary repository grouping untouched", () => {
    const { stave: _staveA, ...a } = project("ordinary-a");
    const { stave: _staveB, ...b } = project("ordinary-b");
    const input = groups([a, b]);
    expect(buildPhysicalSagaProjectGroups(input, index)).toEqual(input);
  });
});

describe("dependency waves", () => {
  it("groups parallel work after its prerequisites without treating order as execution", () => {
    const nodes = [
      { id: "c", after: ["a", "b"] },
      { id: "a", after: [] },
      { id: "b", after: [] },
      { id: "d", after: ["c"] },
    ];
    expect(buildSagaDependencyWaves(nodes).waves.map((wave) => wave.map((x) => x.id))).toEqual([
      ["a", "b"],
      ["c"],
      ["d"],
    ]);
  });
  it("surfaces cycles, dependents of cycles, and missing prerequisites without inventing readiness", () => {
    const nodes = [
      { id: "a", after: ["b"] },
      { id: "b", after: ["a"] },
      { id: "c", after: ["b"] },
      { id: "d", after: ["missing"] },
    ];
    const result = buildSagaDependencyWaves(nodes);
    expect(result.waves).toEqual([]);
    expect(result.unresolved).toEqual(nodes);
    expect(result.missing.get("d")).toEqual(["missing"]);
  });
});

describe("workflow view consistency", () => {
  it("returns known stale completion to its active stage and explains the changed evidence", () => {
    const stale = {
      ...workflow("a"),
      stage: "accept" as const,
      completedAt: createdAt,
      evidenceState: "stale" as const,
    };
    expect(countSagaWorkbenchStages(snapshot(stale)).completed).toBe(0);
    expect(countSagaWorkbenchStages(snapshot(stale)).accept).toBe(1);
    expect(sagaWorkbenchSummaryFallback(stale)).toContain("changed since acceptance");
  });
  it("keeps completed outcomes and unavailable members outside active stages", () => {
    const data = snapshot({ ...workflow("a"), stage: "accept", completedAt: createdAt }, null);
    expect(countSagaWorkbenchStages(data)).toEqual({
      spec: 0,
      plan: 0,
      build: 0,
      review: 0,
      accept: 0,
      completed: 1,
      unavailable: 1,
    });
  });
  it("does not roll back a locally observed mutation on delayed remote response", () => {
    const current = snapshot({ ...workflow("a", 4), stage: "review" }),
      delayed = snapshot();
    expect(reconcileSagaWorkbenchSnapshot(current, delayed).members[0]!.workflow?.stage).toBe(
      "review",
    );
    const latest = snapshot({ ...workflow("a", 5), stage: "accept" });
    expect(reconcileSagaWorkbenchSnapshot(current, latest).members[0]!.workflow?.stage).toBe(
      "accept",
    );
  });
  it("does not carry an old incarnation workflow into a recreated member", () => {
    const current = snapshot(workflow("a", 8));
    const next = snapshot({
      ...workflow("a"),
      identity: { ...workflow("a").identity, createdAt: "2026-09-03T00:00:00Z" },
    });
    expect(reconcileSagaWorkbenchSnapshot(current, next).members[0]!.workflow?.revision).toBe(0);
  });
});
