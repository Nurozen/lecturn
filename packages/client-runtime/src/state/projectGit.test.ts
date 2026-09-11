import { describe, expect, it } from "vite-plus/test";

import {
  isStaveProject,
  resolveRepositoryPullRequestSelector,
  normalizeProjectThreadWorkspace,
  resolveProjectGitRepositoryIdentity,
  resolveProjectGitTargets,
  resolveProjectGitBranch,
  resolveProjectGitCwd,
  staveForcedEnvMode,
} from "./projectGit.ts";

const plainProject = { workspaceRoot: "/work/app" };
const plainProjectExplicitNull = { workspaceRoot: "/work/app", stave: null };
const staveProject = {
  workspaceRoot: "/work/space",
  stave: {
    spaceId: "space-1",
    isSaga: false,
    repos: [],
    memories: [],
    primaryRepoPath: "/work/space/app",
    primaryBranch: "space-1/app",
  },
};
const staveProjectWithoutPrimary = {
  workspaceRoot: "/work/space",
  stave: { spaceId: "space-2", isSaga: true, repos: [], memories: [] },
};

describe("isStaveProject", () => {
  it("is true only when the project carries Stave info", () => {
    expect(isStaveProject(staveProject)).toBe(true);
    expect(isStaveProject(staveProjectWithoutPrimary)).toBe(true);
    expect(isStaveProject(plainProject)).toBe(false);
    expect(isStaveProject(plainProjectExplicitNull)).toBe(false);
    expect(isStaveProject(null)).toBe(false);
    expect(isStaveProject(undefined)).toBe(false);
  });
});

describe("resolveProjectGitCwd", () => {
  it("keeps the worktree-over-root order for ordinary projects", () => {
    expect(resolveProjectGitCwd({ project: plainProject, thread: null })).toBe("/work/app");
    expect(resolveProjectGitCwd({ project: plainProject })).toBe("/work/app");
    expect(
      resolveProjectGitCwd({ project: plainProject, thread: { worktreePath: "/work/wt" } }),
    ).toBe("/work/wt");
    expect(
      resolveProjectGitCwd({ project: plainProjectExplicitNull, thread: { worktreePath: null } }),
    ).toBe("/work/app");
  });

  it("targets the primary repo for Stave projects even when a thread has a worktree", () => {
    expect(resolveProjectGitCwd({ project: staveProject, thread: null })).toBe("/work/space/app");
    expect(
      resolveProjectGitCwd({ project: staveProject, thread: { worktreePath: "/legacy/wt" } }),
    ).toBe("/work/space/app");
  });

  it("has no Git target without an editable repo, even with legacy thread metadata", () => {
    for (const thread of [null, { worktreePath: "/legacy/wt", branch: "old" }]) {
      expect(resolveProjectGitCwd({ project: staveProjectWithoutPrimary, thread })).toBeNull();
      expect(resolveProjectGitBranch({ project: staveProjectWithoutPrimary, thread })).toBeNull();
    }
  });

  it("returns null without a project", () => {
    expect(resolveProjectGitCwd({ project: null, thread: { worktreePath: "/wt" } })).toBeNull();
    expect(resolveProjectGitCwd({ project: undefined })).toBeNull();
  });
});

describe("resolveProjectGitBranch", () => {
  it("prefers the thread branch", () => {
    expect(
      resolveProjectGitBranch({ project: staveProject, thread: { branch: "feature/x" } }),
    ).toBe("feature/x");
    expect(resolveProjectGitBranch({ project: plainProject, thread: { branch: "main" } })).toBe(
      "main",
    );
  });

  it("uses the primary manifest branch when the thread has none", () => {
    expect(resolveProjectGitBranch({ project: staveProject, thread: { branch: null } })).toBe(
      "space-1/app",
    );
    expect(resolveProjectGitBranch({ project: staveProject })).toBe("space-1/app");
  });

  it("is null for ordinary projects without a thread branch", () => {
    expect(resolveProjectGitBranch({ project: plainProject, thread: { branch: null } })).toBeNull();
    expect(
      resolveProjectGitBranch({ project: staveProjectWithoutPrimary, thread: null }),
    ).toBeNull();
    expect(resolveProjectGitBranch({ project: null, thread: null })).toBeNull();
  });
});

describe("staveForcedEnvMode", () => {
  it("forces local only for Stave projects", () => {
    expect(staveForcedEnvMode(staveProject)).toBe("local");
    expect(staveForcedEnvMode(staveProjectWithoutPrimary)).toBe("local");
    expect(staveForcedEnvMode(plainProject)).toBeUndefined();
    expect(staveForcedEnvMode(plainProjectExplicitNull)).toBeUndefined();
    expect(staveForcedEnvMode(null)).toBeUndefined();
  });
});

describe("workspace submission normalization", () => {
  const savedDraft = {
    envMode: "worktree" as const,
    worktreePath: "/old/worktree",
    branch: "old/base",
    startFromOrigin: true,
    prompt: "Preserve my work",
  };
  it("submits an invested saved Stave draft locally and preserves its content", () => {
    expect(normalizeProjectThreadWorkspace(staveProject, savedDraft)).toEqual({
      ...savedDraft,
      envMode: "local",
      worktreePath: null,
      branch: "space-1/app",
      startFromOrigin: false,
    });
    expect(savedDraft.worktreePath).toBe("/old/worktree");
  });
  it("overrides worktree requests even before a path exists", () => {
    expect(
      normalizeProjectThreadWorkspace(staveProject, { ...savedDraft, worktreePath: null }),
    ).toMatchObject({
      envMode: "local",
      worktreePath: null,
      branch: "space-1/app",
      startFromOrigin: false,
    });
    expect(
      normalizeProjectThreadWorkspace(staveProjectWithoutPrimary, savedDraft).branch,
    ).toBeNull();
  });
  it("keeps an explicitly selected local Stave branch", () => {
    expect(
      normalizeProjectThreadWorkspace(staveProject, {
        envMode: "local",
        worktreePath: null,
        branch: "selected",
      }).branch,
    ).toBe("selected");
  });
  it("preserves ordinary project worktree choices", () => {
    expect(normalizeProjectThreadWorkspace(plainProject, savedDraft)).toBe(savedDraft);
  });
});

describe("PR repository identity", () => {
  const outer = {
    canonicalKey: "github.com/acme/outer",
    displayName: "acme/outer",
    rootPath: "/work",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/outer",
    },
  };
  const primary = {
    ...outer,
    canonicalKey: "github.com/acme/app",
    displayName: "acme/app",
    rootPath: "/work/space/app",
  };
  it("uses the primary repo for a Stave space inside another Git repository", () => {
    expect(
      resolveProjectGitRepositoryIdentity({
        ...staveProject,
        repositoryIdentity: outer,
        stave: { ...staveProject.stave, primaryRepositoryIdentity: primary },
      }),
    ).toBe(primary);
    expect(
      resolveProjectGitRepositoryIdentity({
        ...staveProjectWithoutPrimary,
        repositoryIdentity: outer,
      }),
    ).toBeNull();
  });
  it("retains ordinary repository identity", () => {
    expect(
      resolveProjectGitRepositoryIdentity({ ...plainProject, repositoryIdentity: outer }),
    ).toBe(outer);
    expect(resolveProjectGitRepositoryIdentity(null)).toBeNull();
  });
});

describe("space Git targets", () => {
  const identity = {
    canonicalKey: "github.com/acme/api",
    rootPath: "/work/space/services/api",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/api",
    },
  };
  const repos = [
    { name: "web", mode: "edit" as const, path: "apps/web", branch: "space/web" },
    {
      name: "api",
      mode: "edit" as const,
      path: "services/api",
      branch: "space/api",
      repositoryIdentity: identity,
    },
    { name: "docs", mode: "reference" as const, path: "references/docs", ref: "main" },
  ];
  const project = { ...staveProject, stave: { ...staveProject.stave, repos } };

  it("addresses all nested editable repos with their own branch and identity", () => {
    expect(resolveProjectGitTargets({ project })).toEqual([
      {
        key: "/work/space/apps/web",
        cwd: "/work/space/apps/web",
        repoName: "web",
        mode: "edit",
        branch: "space/web",
        repositoryIdentity: null,
      },
      {
        key: "/work/space/services/api",
        cwd: "/work/space/services/api",
        repoName: "api",
        mode: "edit",
        branch: "space/api",
        repositoryIdentity: identity,
      },
    ]);
    expect(resolveProjectGitTargets({ project, includeReferences: true }).at(-1)).toMatchObject({
      cwd: "/work/space/references/docs",
      mode: "reference",
      branch: null,
    });
  });

  it("uses server resolved paths and retains identity from older primary payloads only for the matching checkout", () => {
    const targets = resolveProjectGitTargets({
      project: {
        ...project,
        stave: {
          ...project.stave,
          primaryRepoPath: identity.rootPath,
          primaryRepositoryIdentity: identity,
          repos: [
            { name: "api", mode: "edit", path: "old/api", resolvedPath: identity.rootPath },
            repos[0] as (typeof repos)[number],
          ],
        },
      },
    });
    expect(targets[0]).toMatchObject({ cwd: identity.rootPath, repositoryIdentity: identity });
    expect(targets[1]?.repositoryIdentity).toBeNull();
  });

  it("resolves Windows paths from a remote server and deduplicates casing and separators", () => {
    expect(
      resolveProjectGitTargets({
        project: {
          workspaceRoot: "C:\\work\\space",
          stave: {
            ...project.stave,
            repos: [
              { name: "web", mode: "edit", path: "apps/web" },
              { name: "alias", mode: "edit", path: ".\\Apps\\WEB\\" },
              { name: "api", mode: "edit", path: "services/api" },
            ],
          },
        },
      }).map(({ cwd }) => cwd),
    ).toEqual(["C:\\work\\space\\apps\\web", "C:\\work\\space\\services\\api"]);
    expect(
      resolveProjectGitTargets({
        project: {
          workspaceRoot: "\\\\host\\share\\space",
          stave: {
            ...project.stave,
            repos: [repos[0] as (typeof repos)[number]],
          },
        },
      })[0]?.cwd,
    ).toBe("\\\\host\\share\\space\\apps\\web");
  });

  it("rejects relative escapes and keeps conflicting reference aliases read-only", () => {
    const conflicted = {
      ...project,
      stave: {
        ...project.stave,
        repos: [
          { name: "bad", mode: "edit" as const, path: "../outside" },
          { name: "bad-drive", mode: "edit" as const, path: "C:outside" },
          { name: "web", mode: "edit" as const, path: "apps/../web" },
          { name: "web-context", mode: "reference" as const, path: "./web" },
        ],
      },
    };
    expect(resolveProjectGitTargets({ project: conflicted })).toEqual([]);
    expect(
      resolveProjectGitTargets({ project: conflicted, includeReferences: true }),
    ).toMatchObject([{ cwd: "/work/space/web", mode: "reference" }]);
  });

  it("does not invent targets for empty spaces or missing project data", () => {
    expect(resolveProjectGitTargets({ project: staveProject })).toEqual([]);
    expect(resolveProjectGitTargets({ project: staveProjectWithoutPrimary })).toEqual([]);
    expect(resolveProjectGitTargets({ project: undefined })).toEqual([]);
  });

  it("retains a single workspace target for ordinary projects", () => {
    expect(
      resolveProjectGitTargets({ project: { ...plainProject, repositoryIdentity: identity } }),
    ).toEqual([
      {
        key: "/work/app",
        cwd: "/work/app",
        repoName: "app",
        mode: "edit",
        branch: null,
        repositoryIdentity: identity,
      },
    ]);
  });
});

describe("resolveRepositoryPullRequestSelector", () => {
  it("preserves a nested GitLab namespace", () => {
    expect(
      resolveRepositoryPullRequestSelector({
        provider: "gitlab",
        displayName: "acme/platform/api",
        owner: "acme",
        name: "api",
      }),
    ).toBe("acme/platform/api");
  });
  it("preserves the Azure organization and project in the repository identity", () => {
    expect(
      resolveRepositoryPullRequestSelector({
        provider: "azure-devops",
        displayName: "org/project/_git/api",
        name: "api",
      }),
    ).toBe("org/project/_git/api");
    expect(
      resolveRepositoryPullRequestSelector({
        provider: "azure-devops",
        displayName: "org/project/_git/api",
      }),
    ).toBe("org/project/_git/api");
  });
  it("supports legacy owner/name identities and refuses missing selectors", () => {
    expect(
      resolveRepositoryPullRequestSelector({ provider: "github", owner: "acme", name: "api" }),
    ).toBe("acme/api");
    expect(resolveRepositoryPullRequestSelector({ provider: "github" })).toBeNull();
    expect(resolveRepositoryPullRequestSelector(null)).toBeNull();
  });
});
