import { describe, expect, it } from "vite-plus/test";

import { resolveThreadGitTarget, selectThreadGitRepository } from "./thread-git-target";

const staveProject = {
  workspaceRoot: "/spaces/lecturn",
  stave: {
    spaceId: "lecturn",
    isSaga: false,
    repos: [
      { name: "lecturn", path: "lecturn", mode: "edit" as const, branch: "lecturn/main" },
      { name: "api", path: "nested/api", mode: "edit" as const, branch: "api/feature" },
      { name: "docs", path: "references/docs", mode: "reference" as const },
    ],
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

  it("defaults to the first editable manifest checkout for Stave threads", () => {
    expect(
      resolveThreadGitTarget({
        project: staveProject,
        thread: { branch: null, worktreePath: null },
      }),
    ).toEqual({ cwd: "/spaces/lecturn/lecturn", branch: "lecturn/main" });
  });

  it("uses the selected nested checkout and ignores stale thread branch metadata", () => {
    expect(
      resolveThreadGitTarget({
        project: staveProject,
        thread: { branch: "lecturn/feature", worktreePath: "/legacy/unused-worktree" },
        selectedRepoKey: "/spaces/lecturn/nested/api",
      }),
    ).toEqual({ cwd: "/spaces/lecturn/nested/api", branch: "api/feature" });
  });

  it("allows reference checkout inspection without inventing a writable target", () => {
    expect(
      resolveThreadGitTarget({
        project: staveProject,
        thread: null,
        selectedRepoKey: "/spaces/lecturn/references/docs",
      }),
    ).toEqual({ cwd: "/spaces/lecturn/references/docs", branch: null });
  });

  it("reconciles removed selections using manifest roles", () => {
    const reference = {
      key: "docs",
      cwd: "/docs",
      repoName: "docs",
      mode: "reference" as const,
      branch: null,
      repositoryIdentity: null,
    };
    const editable = {
      ...reference,
      key: "api",
      cwd: "/api",
      repoName: "api",
      mode: "edit" as const,
    };
    expect(selectThreadGitRepository([reference, editable], "removed")).toBe(editable);
    expect(selectThreadGitRepository([reference, editable], "docs")).toBe(reference);
    expect(selectThreadGitRepository([reference], null)).toBe(reference);
    expect(selectThreadGitRepository([], "removed")).toBeNull();
    // A confirmation opened for a removed repo must never switch its write target.
    expect(selectThreadGitRepository([reference, editable], "removed", true)).toBeNull();
    expect(selectThreadGitRepository([reference, editable], "api", true)).toBe(editable);
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
