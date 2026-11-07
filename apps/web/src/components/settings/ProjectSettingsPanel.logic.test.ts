import { describe, expect, it } from "vite-plus/test";
import { planProjectRemoval } from "@lecturn/client-runtime/state/projects";

import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import type { Project } from "../../types";
import {
  buildSettingsProjectGroups,
  projectGroupTitleNeedsUpdate,
} from "./ProjectSettingsPanel.logic";

describe("settings project scopes", () => {
  const work = EnvironmentId.make("work");
  const personal = EnvironmentId.make("personal");
  const owners = new Map([
    [work, "account-work"],
    [personal, "account-personal"],
  ]);
  const projects: Project[] = [work, personal].map((environmentId) => ({
    id: ProjectId.make("same-project-id"),
    environmentId,
    title: "Lecturn",
    workspaceRoot: `/${environmentId}/lecturn`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    repositoryIdentity: {
      canonicalKey: "github.com/nurozen/lecturn",
      provider: "github",
      owner: "nurozen",
      name: "lecturn",
      displayName: "Lecturn",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/nurozen/lecturn.git",
      },
    },
  }));
  const input = {
    projects,
    primaryEnvironmentId: null,
    settings: {
      sidebarProjectGroupingMode: "repository" as const,
      sidebarProjectGroupingOverrides: {},
    },
    resolveEnvironmentLabel: () => null,
  };
  const segmentation = {
    knownAccountIds: ["account-work", "account-personal"],
    accountByEnvironmentId: owners,
    accountLabels: new Map([
      ["account-work", "Work"],
      ["account-personal", "Personal"],
    ]),
  };

  it("keeps identical repositories separate in the settings picker and follows an account-scoped link", () => {
    const picker = buildSettingsProjectGroups({
      input,
      accountScope: null,
      segmentation,
      segmentAccounts: true,
    });
    expect(picker).toHaveLength(2);
    const workGroup = picker.find((group) => group.environmentId === work)!;
    const scoped = buildSettingsProjectGroups({
      input,
      segmentation,
      segmentAccounts: true,
      accountScope: {
        accountId: "account-work",
        email: "work@example.com",
        accountByEnvironmentId: owners,
      },
    });
    expect(scoped[0]?.projectKey).toBe(workGroup.projectKey);
    expect(
      scoped.flatMap((group) => group.memberProjects.map((member) => member.environmentId)),
    ).toEqual([work]);
  });

  it("preserves combined groups for SagaWorkbench’s unscoped caller", () => {
    const groups = buildSettingsProjectGroups({
      input,
      accountScope: null,
      segmentation,
      segmentAccounts: false,
    });
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]?.memberProjects.map((member) => member.environmentId))).toEqual(
      new Set([work, personal]),
    );
  });

  it("does not widen a scoped project when account segmentation disappears", () => {
    const groups = buildSettingsProjectGroups({
      input,
      segmentation: null,
      segmentAccounts: true,
      accountScope: { accountId: "account-work", email: null, accountByEnvironmentId: owners },
    });
    expect(
      groups.flatMap((group) => group.memberProjects.map((member) => member.environmentId)),
    ).toEqual([work]);
  });

  it("keeps a signed-out account's project unavailable", () => {
    expect(
      buildSettingsProjectGroups({
        input,
        segmentation,
        segmentAccounts: true,
        accountScope: { accountId: "account-gone", email: null, accountByEnvironmentId: owners },
      }),
    ).toEqual([]);
  });
});

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name", true)).toBe(
      false,
    );
  });
});

describe("project removal confirmation", () => {
  const local = {
    id: ProjectId.make("shared-id"),
    environmentId: EnvironmentId.make("local"),
    title: "Repo",
    workspaceRoot: "/work/repo",
    environmentLabel: "Local",
  };
  const remote = {
    ...local,
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
  };

  it("limits a checkout's thread count to its environment and project", () => {
    const plan = planProjectRemoval({
      members: [local],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [
        { environmentId: local.environmentId, projectId: local.id },
        { environmentId: remote.environmentId, projectId: remote.id },
      ],
    });
    expect(plan.projectThreads).toHaveLength(1);
    expect(plan.confirmationMessage).toBe(
      'Remove checkout "Repo" and delete its 1 thread?\nPath: /work/repo\nEnvironment: Local\nThis permanently clears conversation history for those threads and any archived threads.\nOther entries in this grouped project are unaffected.\nThis action cannot be undone.',
    );
  });

  it("keeps an environment-filtered group scoped to its selected checkout", () => {
    const plan = planProjectRemoval({
      members: [remote],
      groupMemberCount: 1,
      hasOtherMembers: true,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("checkout");
    expect(plan.confirmationMessage).toContain("Environment: Remote");
    expect(plan.confirmationMessage).toContain(
      "Other entries in this grouped project are unaffected.",
    );
    expect(plan.confirmationMessage).toContain(
      "This permanently clears any archived conversation history.",
    );
  });

  it("states the full group count and preserves files when removing a project everywhere", () => {
    const plan = planProjectRemoval({
      members: [local, remote],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("project");
    expect(plan.confirmationMessage).toContain("This removes 2 grouped project entries.");
    expect(plan.confirmationMessage).toContain(
      "This removes only the project entries, not the files on disk.",
    );
  });
});
