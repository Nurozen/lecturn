import { describe, expect, it } from "vite-plus/test";

import {
  isStaveProject,
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
