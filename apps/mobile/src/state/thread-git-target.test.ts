import { describe, expect, it } from "vite-plus/test";

import { resolveThreadGitTarget } from "./thread-git-target";

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

describe("resolveThreadGitTarget", () => {
  it("preserves no Git target for a reference-only space beneath an ancestor repo", () => {
    expect(
      resolveThreadGitTarget({
        project: {
          workspaceRoot: "/ancestor/space",
          stave: {
            spaceId: "reference-only",
            isSaga: false,
            repos: [],
            memories: [],
          },
        },
        thread: { branch: "old", worktreePath: "/legacy/wt" },
      }),
    ).toEqual({ cwd: null, branch: null });
  });

  it("keeps worktree-over-root targeting for ordinary projects", () => {
    expect(
      resolveThreadGitTarget({
        project: { workspaceRoot: "/repo" },
        thread: { branch: "feature", worktreePath: "/repo/.t3/worktrees/feature" },
      }),
    ).toEqual({ cwd: "/repo/.t3/worktrees/feature", branch: "feature" });
    expect(
      resolveThreadGitTarget({
        project: { workspaceRoot: "/repo" },
        thread: { branch: null, worktreePath: null },
      }),
    ).toEqual({ cwd: "/repo", branch: null });
  });

  it("targets the primary repo and manifest branch for Stave threads", () => {
    expect(
      resolveThreadGitTarget({
        project: staveProject,
        thread: { branch: null, worktreePath: null },
      }),
    ).toEqual({ cwd: "/spaces/lecturn/lecturn", branch: "lecturn/main" });
  });

  it("keeps a Stave thread's own branch when it has one", () => {
    // PR lookup compares status.refName against this branch, so a thread that
    // was explicitly switched must not be reported against the manifest branch.
    expect(
      resolveThreadGitTarget({
        project: staveProject,
        thread: { branch: "lecturn/feature", worktreePath: null },
      }),
    ).toEqual({ cwd: "/spaces/lecturn/lecturn", branch: "lecturn/feature" });
  });

  it("treats a project shell without stave info as an ordinary repo", () => {
    expect(
      resolveThreadGitTarget({
        project: { workspaceRoot: "/repo", stave: null },
        thread: { branch: null, worktreePath: null },
      }),
    ).toEqual({ cwd: "/repo", branch: null });
  });

  it("falls back to the thread worktree while the project shell is missing", () => {
    expect(
      resolveThreadGitTarget({
        project: null,
        thread: { branch: "feature", worktreePath: "/repo/.t3/worktrees/feature" },
      }),
    ).toEqual({ cwd: "/repo/.t3/worktrees/feature", branch: "feature" });
    expect(resolveThreadGitTarget({ project: null, thread: null })).toEqual({
      cwd: null,
      branch: null,
    });
  });
});
