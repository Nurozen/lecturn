import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  buildProjectGroups,
  buildSagaProjectTree,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  resolveScratchProjectScopeKey,
  sortProjectsByGroupOrder,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");

describe("load balancing shared project machines", () => {
  const now = 100_000;
  const resources = {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  };

  it("compares three machines using free capacity and preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 1 },
      { environmentId: "idle", resources, weight: 1 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 3 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });

  it("rejects stale, unknown, excluded and saturated machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "stale",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 1,
          },
          { environmentId: "unknown", resources: null, weight: 1 },
          {
            environmentId: "no-cpu-sample",
            resources: { ...resources, cpuUtilization: null },
            weight: 1,
          },
          { environmentId: "excluded", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 1,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 1,
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("uses client receipt time when host clocks differ", () => {
    const candidate = {
      environmentId: "different-clock",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 1,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("different-clock");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});
const repositoryIdentity = {
  canonicalKey: "github.com/nurozen/lecturn",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/nurozen/lecturn.git",
  },
  provider: "github",
  owner: "nurozen",
  name: "lecturn",
  displayName: "Lecturn",
};

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  overrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"] = {},
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides: overrides,
  };
}

describe("buildProjectGroups", () => {
  it.each(["repository", "repository_path", "separate"] as const)(
    "keeps scratch project ownership separate by default in %s mode",
    (mode) => {
      const projects = [
        makeProject("scratch-local", "/local/scratch", {
          isScratch: true,
          repositoryIdentity: null,
        }),
        makeProject("scratch-remote", "/remote/scratch", {
          environmentId: EnvironmentId.make("remote"),
          isScratch: true,
          repositoryIdentity: null,
        }),
      ];
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups.map((group) => group.key)).toEqual(projects.map(derivePhysicalProjectKey));
      expect(groups.map((group) => group.memberProjectRefs)).toEqual(
        projects.map((project) => [
          { environmentId: project.environmentId, projectId: project.id },
        ]),
      );
      expect(
        buildProjectGroups({ projects, settings: settings(mode), groupScratchProjects: true }),
      ).toHaveLength(1);
    },
  );

  it.each(["repository", "repository_path", "separate"] as const)(
    "migrates a pre-config %s scratch selection and retains it after the original host is removed",
    (mode) => {
      const local = makeProject("scratch-local", "/local/repo/scratch", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/local/repo" },
      });
      const remote = makeProject("scratch-remote", "/remote/scratch", {
        environmentId: EnvironmentId.make("remote"),
        repositoryIdentity: null,
        isScratch: true,
      });
      const groupingSettings = settings(mode);
      const selectedBeforeConfig = deriveLogicalProjectKeyFromSettings(local, groupingSettings);
      const loaded = [{ ...local, isScratch: true as const }, remote];
      const migrated = resolveScratchProjectScopeKey(
        selectedBeforeConfig,
        loaded,
        groupingSettings,
      );
      const scratchKey = buildProjectGroups({
        projects: loaded,
        settings: groupingSettings,
        groupScratchProjects: true,
      })[0]!.key;
      expect(migrated).toBe(scratchKey);
      expect(resolveScratchProjectScopeKey(migrated, [remote], groupingSettings)).toBe(scratchKey);
      expect(
        buildProjectGroups({
          projects: [remote],
          settings: groupingSettings,
          groupScratchProjects: true,
        })[0]?.memberProjectRefs,
      ).toEqual([{ environmentId: remote.environmentId, projectId: remote.id }]);
    },
  );

  it("retains a repository filter that still belongs to an ordinary project", () => {
    const scratch = makeProject("scratch", "/scratch", { isScratch: true });
    const ordinary = makeProject("ordinary", "/ordinary");
    const key = deriveLogicalProjectKeyFromSettings(ordinary, settings("repository"));
    expect(resolveScratchProjectScopeKey(key, [scratch, ordinary])).toBe(key);
  });

  it.each(["repository", "repository_path", "separate"] as const)(
    "coalesces scratch homes in %s mode without merging ordinary same-title projects",
    (mode) => {
      const remoteEnvironmentId = EnvironmentId.make("remote");
      const projects = [
        makeProject("scratch-local", "/local/scratch", {
          title: "No project",
          isScratch: true,
          repositoryIdentity: null,
        }),
        makeProject("scratch-remote", "/remote/scratch", {
          title: "No project",
          environmentId: remoteEnvironmentId,
          isScratch: true,
        }),
        makeProject("scratch-duplicate", "/remote/scratch/", {
          title: "No project",
          environmentId: remoteEnvironmentId,
          isScratch: true,
          repositoryIdentity: null,
          updatedAt: "2026-07-02T00:00:00.000Z",
        }),
        makeProject("ordinary", "/ordinary", { title: "No project" }),
        makeProject("reserved-collision", "/other", {
          title: "No project",
          repositoryIdentity: { ...repositoryIdentity, canonicalKey: "\0no-project" },
        }),
      ];
      const groups = buildProjectGroups({
        projects,
        groupScratchProjects: true,
        settings: settings(mode, { [derivePhysicalProjectKey(projects[0]!)]: "separate" }),
        preferredEnvironmentId: remoteEnvironmentId,
      });
      expect(groups).toHaveLength(3);
      const scratch = groups.find((group) => group.representative.isScratch)!;
      expect(scratch.label).toBe("No project");
      expect(scratch.representative.id).toBe(projects[2]?.id);
      expect(scratch.members).toHaveLength(2);
      expect(scratch.memberProjectRefs).toEqual(
        projects.slice(0, 3).map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        })),
      );
      expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(projects[1]!), projects)).toBe(
        scratch.key,
      );
      expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(projects[3]!), projects)).toBe(
        derivePhysicalProjectKey(projects[3]!),
      );
      expect(groups.filter((group) => !group.representative.isScratch)).toHaveLength(2);
    },
  );

  it("preserves every physical clone as a selectable member in repository modes", () => {
    const projects = [
      makeProject("lecturn", "/work/lecturn"),
      makeProject("lecturn-2", "/work/lecturn-2"),
      makeProject("lecturn-3", "/work/lecturn-3"),
    ];

    for (const mode of ["repository", "repository_path"] as const) {
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members.map((member) => member.project.id)).toEqual([
        "lecturn",
        "lecturn-2",
        "lecturn-3",
      ]);
      expect(groups[0]?.memberProjectRefs).toHaveLength(3);
    }
  });

  it("uses a shared custom title as the repository group's label", () => {
    const projects = [
      makeProject("first", "/work/lecturn", { title: "Custom project" }),
      makeProject("second", "/work/lecturn-2", { title: "Custom project" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "Custom project",
    );
  });

  it("keeps the repository label when shared titles match its repository name", () => {
    const projects = [
      makeProject("first", "/work/lecturn", { title: "lecturn" }),
      makeProject("second", "/work/lecturn-2", { title: "lecturn" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "Lecturn",
    );
  });

  it("keeps a fork apart from its upstream checkout and labels it by its own remote", () => {
    const fork = makeProject("fork", "/work/lecturn-fork", {
      repositoryIdentity: {
        ...repositoryIdentity,
        origin: {
          canonicalKey: "github.com/julius/lecturn-fork",
          displayName: "julius/lecturn-fork",
        },
      },
    });
    const forkWorktree = makeProject("fork-2", "/work/lecturn-fork-2", {
      repositoryIdentity: fork.repositoryIdentity,
    });
    const projects = [makeProject("lecturn", "/work/lecturn"), fork, forkWorktree];

    const groups = buildProjectGroups({ projects, settings: settings("repository") });
    expect(groups.map((group) => group.key)).toEqual([
      "github.com/nurozen/lecturn",
      "github.com/julius/lecturn-fork",
    ]);
    expect(groups[1]?.members.map((member) => member.project.id)).toEqual(["fork", "fork-2"]);
    expect(groups[1]?.label).toBe("julius/lecturn-fork");
  });

  it("labels a fork by its canonical key when its origin has no display name", () => {
    const identity = {
      ...repositoryIdentity,
      origin: { canonicalKey: "internal-host" },
    };
    const projects = [
      makeProject("fork", "/work/fork", { repositoryIdentity: identity }),
      makeProject("fork-2", "/work/fork-2", { repositoryIdentity: identity }),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("repository") });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("internal-host");
  });

  it("keeps physical clones in separate groups when requested", () => {
    const projects = [
      makeProject("lecturn", "/work/lecturn"),
      makeProject("lecturn-2", "/work/lecturn-2"),
      makeProject("lecturn-3", "/work/lecturn-3"),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("separate") });
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((group) => group.members)).toHaveLength(3);
    expect(groups.map((group) => group.label)).toEqual(["lecturn", "lecturn-2", "lecturn-3"]);
  });

  it("applies a physical-project override without dropping its siblings", () => {
    const first = makeProject("lecturn", "/work/lecturn");
    const second = makeProject("lecturn-2", "/work/lecturn-2");
    const third = makeProject("lecturn-3", "/work/lecturn-3");
    const groups = buildProjectGroups({
      projects: [first, second, third],
      settings: settings("repository", {
        [derivePhysicalProjectKey(second)]: "separate",
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
      "lecturn",
      "lecturn-3",
      "lecturn-2",
    ]);
  });

  it("dedupes stale registrations at one physical path using the freshest project", () => {
    const stale = makeProject("stale", "/work/lecturn", {
      repositoryIdentity: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/lecturn/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const groups = buildProjectGroups({
      projects: [stale, fresh],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.representative.id).toBe("fresh");
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("uses repository identity from a duplicate registration when the winner lacks it", () => {
    const identified = makeProject("identified", "/work/lecturn", {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshUnidentified = makeProject("fresh", "/work/lecturn/", {
      repositoryIdentity: null,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/lecturn-2");

    const groups = buildProjectGroups({
      projects: [identified, freshUnidentified, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest winner's repository identity when stale duplicates disagree", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/nurozen/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const stale = makeProject("stale", "/work/lecturn", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/lecturn/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/lecturn-2");

    const groups = buildProjectGroups({
      projects: [stale, fresh, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest identity-bearing duplicate when the winner lacks identity", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/nurozen/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const staleIdentified = makeProject("stale-identified", "/work/lecturn", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshIdentified = makeProject("fresh-identified", "/work/lecturn/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const winner = makeProject("winner", "/work/lecturn", {
      repositoryIdentity: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/lecturn-2");

    const groups = buildProjectGroups({
      projects: [staleIdentified, freshIdentified, winner, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["winner", "sibling"]);
  });
});

describe("buildSagaProjectTree", () => {
  const stave = (spaceId: string, isSaga = false) => ({
    spaceId,
    createdAt: "2026-09-01T00:00:00Z",
    isSaga,
    state: "live" as const,
    repos: [],
    memories: [],
  });
  const member = (id: string) => ({
    id,
    workspaceRoot: `/work/${id}`,
    createdAt: "2026-09-01T00:00:00Z",
    after: [],
    state: "live" as const,
    dirty: false,
    repos: [],
    prs: [],
  });
  const projects = () => [
    makeProject("b", "/work/b", { repositoryIdentity: null, stave: stave("b") }),
    makeProject("ordinary", "/work/ordinary", { repositoryIdentity: null }),
    makeProject("saga", "/work/saga", { repositoryIdentity: null, stave: stave("saga", true) }),
    makeProject("a", "/work/a", { repositoryIdentity: null, stave: stave("a") }),
  ];
  const groupsFor = (items = projects()) =>
    buildProjectGroups({ projects: items, settings: settings("separate") });
  const index = () => [
    {
      environmentId,
      sagaRoot: "/work/saga",
      status: {
        sagaId: "saga",
        sagaCreatedAt: "2026-09-01T00:00:00Z",
        members: [member("a"), member("b")],
        notes: [],
      },
    },
  ];

  it("uses Stave's member order and preserves every existing group and key", () => {
    const groups = groupsFor();
    const tree = buildSagaProjectTree(groups, index());
    const parent = tree.find((node) => node.group.representative.id === "saga")!;
    expect(parent.children.map((node) => node.group.representative.id)).toEqual(["a", "b"]);
    expect(tree.map((node) => node.group.representative.id)).toEqual(["ordinary", "saga"]);
    const flattened = tree.flatMap((node) => [
      node.group,
      ...node.children.map((child) => child.group),
    ]);
    expect(new Set(flattened.map((group) => group.key))).toEqual(
      new Set(groups.map((group) => group.key)),
    );
    for (const group of flattened) expect(groups).toContain(group);
  });

  it("keeps all projects visible when status or the parent is missing", () => {
    const groups = groupsFor();
    expect(buildSagaProjectTree(groups, []).map((node) => node.group)).toEqual(groups);
    const withoutParent = groups.filter((group) => !group.representative.stave?.isSaga);
    expect(buildSagaProjectTree(withoutParent, index()).map((node) => node.group)).toEqual(
      withoutParent,
    );
  });

  it("keeps other installations and archived incarnations with the same ID outside the saga", () => {
    const otherInstallation = makeProject("other-a", "/other-work/a", {
      repositoryIdentity: null,
      stave: stave("a"),
    });
    const oldArchive = makeProject("old-a", "/work/.archive/a-old", {
      repositoryIdentity: null,
      stave: { ...stave("a"), state: "archived", createdAt: "2026-08-01T00:00:00Z" },
    });
    const tree = buildSagaProjectTree(
      groupsFor([...projects(), otherInstallation, oldArchive]),
      index(),
    );
    expect(
      tree
        .find((node) => node.group.representative.id === "saga")
        ?.children.map((node) => node.group.representative.id),
    ).toEqual(["a", "b"]);
    expect(
      tree
        .filter((node) => ["other-a", "old-a"].includes(node.group.representative.id))
        .map((node) => node.memberStatus),
    ).toEqual([null, null]);
  });

  it("does not guess membership when identity is missing or the root was recreated", () => {
    const roster = index();
    roster[0]!.status.members[0]!.createdAt = "2026-08-01T00:00:00Z";
    const tree = buildSagaProjectTree(groupsFor(), roster);
    expect(
      tree
        .find((node) => node.group.representative.id === "saga")
        ?.children.map((node) => node.group.representative.id),
    ).toEqual(["b"]);
    const legacy = [
      {
        ...roster[0]!,
        status: {
          sagaId: "saga",
          members: roster[0]!.status.members.map(
            ({ workspaceRoot: _root, createdAt: _stamp, ...member }) => member,
          ),
          notes: [],
        },
      },
    ];
    expect(
      buildSagaProjectTree(groupsFor(), legacy).every((node) => node.children.length === 0),
    ).toBe(true);
    roster[0]!.status.sagaCreatedAt = "2026-08-01T00:00:00Z";
    expect(
      buildSagaProjectTree(groupsFor(), roster).every((node) => node.children.length === 0),
    ).toBe(true);
  });

  it("keeps a same-id member from another environment outside the saga", () => {
    const other = makeProject("remote-a", "/work/a", {
      environmentId: EnvironmentId.make("remote"),
      repositoryIdentity: null,
      stave: stave("a"),
    });
    const tree = buildSagaProjectTree(groupsFor([...projects(), other]), index());
    expect(tree.some((node) => node.group.representative === other)).toBe(true);
    expect(tree.find((node) => node.group.representative.id === "saga")?.children).toHaveLength(2);
  });

  it("preserves missing/corrupt state for visible member projects", () => {
    const rows = index();
    const status = {
      ...rows[0]!.status,
      members: [
        { ...member("a"), state: "missing" as const },
        { ...member("b"), state: "corrupt" as const, dirty: true },
      ],
    };
    const tree = buildSagaProjectTree(groupsFor(), [{ ...rows[0]!, status }]);
    expect(
      tree
        .find((node) => node.group.representative.id === "saga")
        ?.children.map((node) => [node.memberStatus?.state, node.memberStatus?.dirty]),
    ).toEqual([
      ["missing", false],
      ["corrupt", true],
    ]);
  });

  it("does not move an unrelated physical clone inside a grouped saga member", () => {
    const groups = groupsFor();
    const a = groups.find((group) => group.representative.id === "a")!;
    const ordinary = groups.find((group) => group.representative.id === "ordinary")!;
    const combined = {
      ...a,
      members: [...a.members, ...ordinary.members],
      memberProjectRefs: [...a.memberProjectRefs, ...ordinary.memberProjectRefs],
    };
    const input = groups.filter((group) => group !== a && group !== ordinary).concat(combined);
    expect(buildSagaProjectTree(input, index()).some((node) => node.group === combined)).toBe(true);
  });

  it("leaves ambiguous duplicate rosters flat and never forms saga cycles", () => {
    const groups = groupsFor();
    expect(
      buildSagaProjectTree(groups, [...index(), ...index()]).map((node) => node.group),
    ).toEqual(groups);
    const recursive = index();
    recursive[0]!.status.members.unshift(member("saga"));
    const tree = buildSagaProjectTree(groups, recursive);
    expect(tree.find((node) => node.group.representative.id === "saga")?.children).toHaveLength(2);
  });
});

describe("sortProjectsByGroupOrder", () => {
  const remote = EnvironmentId.make("remote");
  const ref = (projectId: string, env = environmentId) => ({
    environmentId: env,
    projectId: ProjectId.make(projectId),
  });
  const project = (id: string, env: string = environmentId) => ({ id, environmentId: env });

  it("follows the group order, keeping ungrouped projects last in their own order", () => {
    const sorted = sortProjectsByGroupOrder(
      [
        project("alpha"),
        project("zeta"),
        project("orphan-b"),
        project("beta"),
        project("orphan-a"),
      ],
      [{ memberProjectRefs: [ref("zeta")] }, { memberProjectRefs: [ref("beta"), ref("alpha")] }],
    );
    expect(sorted.map((entry) => entry.id)).toEqual([
      "zeta",
      "alpha",
      "beta",
      "orphan-b",
      "orphan-a",
    ]);
  });

  it("tells the same project id on two environments apart", () => {
    const sorted = sortProjectsByGroupOrder(
      [project("shared"), project("shared", remote)],
      [{ memberProjectRefs: [ref("shared", remote)] }, { memberProjectRefs: [ref("shared")] }],
    );
    expect(sorted.map((entry) => entry.environmentId)).toEqual([remote, environmentId]);
  });
});
