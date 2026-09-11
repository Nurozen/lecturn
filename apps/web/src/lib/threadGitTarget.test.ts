import { describe, expect, it } from "vite-plus/test";
import type { RepositoryIdentity, StaveProjectInfo } from "@lecturn/contracts";
import {
  STAVE_CHECKPOINTS_UNAVAILABLE_REASON,
  resolveCheckpointsUnavailableReason,
  resolveThreadGitRepositoryRoot,
  resolveThreadGitTarget,
} from "./threadGitTarget";

const ordinaryProject = { workspaceRoot: "/repos/app", stave: null };

const staveInfo: StaveProjectInfo = {
  spaceId: "space-1",
  isSaga: false,
  repos: [{ name: "app", mode: "edit", path: "app" }],
  memories: [],
  primaryRepoPath: "/spaces/space-1/app",
  primaryBranch: "space-1/feature",
  state: "live",
};
const staveProject = { workspaceRoot: "/spaces/space-1", stave: staveInfo };

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
        fallbackCwd: "/ancestor",
      }),
    ).toEqual({ cwd: null, branch: null, isStave: true, statusEnabled: false });
  });

  it("targets the thread worktree on an ordinary project", () => {
    const target = resolveThreadGitTarget({
      project: ordinaryProject,
      thread: { branch: "feature/x", worktreePath: "/repos/app/.worktrees/x" },
    });
    expect(target).toEqual({
      cwd: "/repos/app/.worktrees/x",
      branch: "feature/x",
      isStave: false,
      statusEnabled: true,
    });
  });

  it("targets the workspace root for an ordinary local thread with a branch", () => {
    const target = resolveThreadGitTarget({
      project: ordinaryProject,
      thread: { branch: "main", worktreePath: null },
    });
    expect(target).toEqual({
      cwd: "/repos/app",
      branch: "main",
      isStave: false,
      statusEnabled: true,
    });
  });

  it("keeps an ordinary local thread without a branch suppressed", () => {
    const target = resolveThreadGitTarget({
      project: ordinaryProject,
      thread: { branch: null, worktreePath: null },
    });
    expect(target.cwd).toBe("/repos/app");
    expect(target.branch).toBeNull();
    expect(target.statusEnabled).toBe(false);
  });

  it("falls back to the legacy project cwd when the project is unknown", () => {
    expect(
      resolveThreadGitTarget({
        project: null,
        thread: { branch: "main", worktreePath: null },
        fallbackCwd: "/repos/app",
      }),
    ).toEqual({ cwd: "/repos/app", branch: "main", isStave: false, statusEnabled: true });
    expect(
      resolveThreadGitTarget({
        project: null,
        thread: { branch: null, worktreePath: "/repos/app/.worktrees/x" },
      }),
    ).toEqual({
      cwd: "/repos/app/.worktrees/x",
      branch: null,
      isStave: false,
      statusEnabled: true,
    });
    expect(resolveThreadGitTarget({ project: null, thread: null }).statusEnabled).toBe(false);
  });

  it("targets the Stave primary repo and branch when the thread has neither", () => {
    const target = resolveThreadGitTarget({
      project: staveProject,
      thread: { branch: null, worktreePath: null },
    });
    expect(target).toEqual({
      cwd: "/spaces/space-1/app",
      branch: "space-1/feature",
      isStave: true,
      statusEnabled: true,
    });
  });

  it("ignores a legacy worktree path on a Stave project", () => {
    const target = resolveThreadGitTarget({
      project: staveProject,
      thread: { branch: "old/branch", worktreePath: "/spaces/space-1/.worktrees/old" },
    });
    expect(target.cwd).toBe("/spaces/space-1/app");
    expect(target.branch).toBe("old/branch");
    expect(target.statusEnabled).toBe(true);
  });

  it("still enables status for a Stave project whose manifest lacks a branch", () => {
    const target = resolveThreadGitTarget({
      project: {
        workspaceRoot: "/spaces/space-2",
        stave: {
          spaceId: "space-2",
          isSaga: false,
          repos: [],
          memories: [],
          primaryRepoPath: "/spaces/space-2/app",
        },
      },
      thread: { branch: null, worktreePath: null },
    });
    expect(target.branch).toBeNull();
    expect(target.statusEnabled).toBe(true);
  });
});

const repositoryIdentity = (rootPath: string): RepositoryIdentity => ({
  canonicalKey: `github.com/acme/${rootPath}`,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/app" },
  rootPath,
});

describe("resolveThreadGitRepositoryRoot", () => {
  it("uses the project identity for a local thread and none for a worktree thread", () => {
    const project = { ...ordinaryProject, repositoryIdentity: repositoryIdentity("/repos/app") };
    expect(
      resolveThreadGitRepositoryRoot({ project, thread: { branch: "main", worktreePath: null } }),
    ).toBe("/repos/app");
    expect(
      resolveThreadGitRepositoryRoot({
        project,
        thread: { branch: "feature/x", worktreePath: "/repos/app/.worktrees/x" },
      }),
    ).toBeUndefined();
    expect(resolveThreadGitRepositoryRoot({ project: null, thread: null })).toBeUndefined();
  });

  it("uses the Stave primary repo identity, ignoring the space root identity", () => {
    const project = {
      workspaceRoot: "/spaces/space-1",
      repositoryIdentity: repositoryIdentity("/spaces/space-1"),
      stave: {
        ...staveInfo,
        primaryRepositoryIdentity: repositoryIdentity("/spaces/space-1/app"),
      },
    };
    expect(
      resolveThreadGitRepositoryRoot({
        project,
        thread: { branch: null, worktreePath: "/spaces/space-1/.worktrees/old" },
      }),
    ).toBe("/spaces/space-1/app");
    expect(
      resolveThreadGitRepositoryRoot({
        project: staveProject,
        thread: { branch: null, worktreePath: null },
      }),
    ).toBeUndefined();
  });
});

describe("resolveCheckpointsUnavailableReason", () => {
  it("hides checkpoints only for Stave projects", () => {
    expect(resolveCheckpointsUnavailableReason(staveProject)).toBe(
      STAVE_CHECKPOINTS_UNAVAILABLE_REASON,
    );
    expect(resolveCheckpointsUnavailableReason(ordinaryProject)).toBeNull();
    expect(resolveCheckpointsUnavailableReason(null)).toBeNull();
  });
});
