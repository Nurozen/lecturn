import { describe, expect, it } from "vite-plus/test";

import {
  filterNewTaskBranches,
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskBranchLabel,
  resolveNewTaskGitCwd,
  resolveNewTaskLocalWorkspaceSelection,
  shouldCheckoutNewTaskBranch,
} from "./new-task-context-presentation";

const staveProject = {
  workspaceRoot: "/spaces/lecturn",
  stave: {
    spaceId: "lecturn",
    isSaga: false,
    repos: [],
    memories: [],
    primaryRepoPath: "/spaces/lecturn/lecturn",
    primaryBranch: "lecturn/main",
  },
};

describe("resolveNewTaskLocalWorkspaceSelection", () => {
  it("waits for refs instead of carrying a worktree base into Current checkout", () => {
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [],
        projectCwd: "/repo",
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      awaitsCurrentBranch: true,
    });
  });

  it("adopts the checkout's current branch once refs load", () => {
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [
          { name: "feature/worktree-base", current: false, worktreePath: "/worktree" },
          { name: "main", current: true, worktreePath: "/repo" },
        ],
        projectCwd: "/repo",
      }),
    ).toEqual({
      branch: "main",
      worktreePath: null,
      awaitsCurrentBranch: false,
    });
  });

  it("never persists the primary repo checkout as a worktree for Stave projects", () => {
    // The primary repo's branch list reports its own checkout path for the
    // current branch; a Stave thread runs in the space root, so that path
    // must not become the thread's worktreePath.
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [
          { name: "lecturn/main", current: true, worktreePath: "/spaces/lecturn/lecturn" },
        ],
        projectCwd: "/spaces/lecturn",
        staveProject: true,
      }),
    ).toEqual({
      branch: "lecturn/main",
      worktreePath: null,
      awaitsCurrentBranch: false,
    });
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [{ name: "feature/x", current: true, worktreePath: "/spaces/lecturn/.wt/x" }],
        projectCwd: "/spaces/lecturn/lecturn",
        staveProject: true,
      }).worktreePath,
    ).toBeNull();
  });

  it("carries the worktree path when the current branch lives in another worktree", () => {
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [
          { name: "feature/split", current: true, worktreePath: "/repo/.lecturn/worktrees/split" },
          { name: "main", current: false, worktreePath: "/repo" },
        ],
        projectCwd: "/repo",
      }),
    ).toEqual({
      branch: "feature/split",
      worktreePath: "/repo/.lecturn/worktrees/split",
      awaitsCurrentBranch: false,
    });
  });
});

describe("resolveNewTaskBranchWorktreePath", () => {
  it("moves Current checkout to the selected existing worktree", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "local",
        projectCwd: "/repo",
        branchWorktreePath: "/repo/.lecturn/worktrees/feature",
      }),
    ).toBe("/repo/.lecturn/worktrees/feature");
  });

  it("keeps the project checkout represented by a null override", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "local",
        projectCwd: "/repo",
        branchWorktreePath: "/repo",
      }),
    ).toBeNull();
  });

  it("drops any reported path for Stave projects", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "local",
        projectCwd: "/spaces/lecturn/lecturn",
        branchWorktreePath: "/spaces/lecturn/.wt/feature",
        staveProject: true,
      }),
    ).toBeNull();
  });

  it("does not reuse an existing worktree while creating a new one", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "worktree",
        projectCwd: "/repo",
        branchWorktreePath: "/repo/.lecturn/worktrees/feature",
      }),
    ).toBeNull();
  });
});

describe("resolveNewTaskGitCwd", () => {
  it("targets the primary repo for Stave spaces and the root otherwise", () => {
    expect(resolveNewTaskGitCwd(staveProject)).toBe("/spaces/lecturn/lecturn");
    expect(resolveNewTaskGitCwd({ workspaceRoot: "/repo" })).toBe("/repo");
    expect(resolveNewTaskGitCwd({ workspaceRoot: "/repo", stave: null })).toBe("/repo");
  });

  it("issues no query for a stand-in project without a root", () => {
    expect(resolveNewTaskGitCwd({ workspaceRoot: "" })).toBeNull();
    expect(resolveNewTaskGitCwd(null)).toBeNull();
  });
});

describe("resolveNewTaskBranchLabel", () => {
  it("identifies a deferred PR checkout independently of the origin default", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "fork/feature",
        startFromOrigin: true,
        workspaceMode: "worktree",
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      }),
    ).toBe("From PR #123");
  });
  it("shows the checked-out branch without a base-ref prefix", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "feature/mobile",
        startFromOrigin: true,
        workspaceMode: "local",
      }),
    ).toBe("feature/mobile");
  });

  it("labels a local worktree base with From", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "main",
        startFromOrigin: false,
        workspaceMode: "worktree",
      }),
    ).toBe("From main");
  });

  it("labels a remote worktree base with From origin", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "main",
        startFromOrigin: true,
        workspaceMode: "worktree",
      }),
    ).toBe("From origin/main");
  });

  it("prompts when no branch is available", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: null,
        startFromOrigin: true,
        workspaceMode: "worktree",
      }),
    ).toBe("Choose branch");
  });
});

describe("Stave branch checkout", () => {
  it("requires a checkout in the primary repo when the branch is held by another space", () => {
    const input = {
      branchIsCurrent: false,
      branchWorktreePath: "/spaces/other/repo",
      workspaceMode: "local" as const,
    };
    expect(shouldCheckoutNewTaskBranch({ ...input, staveProject: true })).toBe(true);
    expect(shouldCheckoutNewTaskBranch(input)).toBe(false);
    expect(
      shouldCheckoutNewTaskBranch({ ...input, staveProject: true, branchIsCurrent: true }),
    ).toBe(false);
  });
});

describe("filterNewTaskBranches", () => {
  const branches = [
    { name: "main", isRemote: false },
    { name: "Feature/Login-Page", isRemote: false },
    { name: "origin/fix/remote-only", isRemote: true },
  ];
  const search = (query: string) =>
    filterNewTaskBranches(branches, query).map((branch) => branch.name);

  it("ignores case in both the query and the branch name", () => {
    expect(search("feature/login")).toEqual(["Feature/Login-Page"]);
    expect(search("MAIN")).toEqual(["main"]);
  });

  it("keeps remote-only branches searchable", () => {
    expect(search("remote-only")).toEqual(["origin/fix/remote-only"]);
  });

  it("matches a typed space against the dash a branch name uses", () => {
    expect(search("  login page ")).toEqual(["Feature/Login-Page"]);
  });
});
