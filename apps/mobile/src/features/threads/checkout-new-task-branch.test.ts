import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId } from "@lecturn/contracts";
import { settlePromise, squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
let directory: string;
let cwd: string;
const git = (...args: string[]) => exec("git", ["-C", cwd, ...args]);
const branch = { name: "feature/a", current: false, isDefault: false, worktreePath: null };
const environmentId = EnvironmentId.make("branch-test-environment");

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-branch-selection-"));
  cwd = NodePath.join(directory, "project");
  await exec("git", ["init", "-b", "main", cwd]);
  await git("config", "user.name", "Branch test");
  await git("config", "user.email", "branch-test@example.com");
  await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "main\n");
  await git("add", ".");
  await git("commit", "-m", "main");
  await git("checkout", "-b", branch.name);
  await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "feature\n");
  await git("commit", "-am", "feature");
  await git("checkout", "main");
});

afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

function selectBranch(switchRef: Parameters<typeof checkoutNewTaskBranch>[0]["switchRef"]) {
  return checkoutNewTaskBranch({
    branch,
    project: { environmentId, workspaceRoot: cwd },
    workspaceMode: "local",
    refreshStatus,
    switchRef,
  });
}

const refreshStatus: Parameters<typeof checkoutNewTaskBranch>[0]["refreshStatus"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    const { stdout } = await exec("git", ["-C", request.input.cwd, "branch", "--show-current"]);
    return { isRepo: true, refName: stdout.trim() || null };
  });

const switchRef: Parameters<typeof checkoutNewTaskBranch>[0]["switchRef"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    await exec("git", ["-C", request.input.cwd, "checkout", request.input.refName]);
    const { stdout } = await exec("git", ["-C", request.input.cwd, "branch", "--show-current"]);
    return { refName: stdout.trim() };
  });

describe("new-task branch checkout", () => {
  it("switches main to the older thread's feature branch before returning a selection", async () => {
    const result = await selectBranch(switchRef);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Checkout failed");
    expect(result.value.name).toBe("feature/a");
    expect(result.value.current).toBe(true);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("feature/a");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe("feature\n");
  });

  it("does not release the selection while checkout is still pending", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let completed = false;
    const selection = selectBranch(async (request) => {
      entered.resolve();
      await release.promise;
      return switchRef(request);
    }).then((result) => {
      completed = true;
      return result;
    });
    await entered.promise;
    expect(completed).toBe(false);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    release.resolve();
    expect((await selection)._tag).toBe("Success");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("feature/a");
  });

  it("returns checkout failure without selecting the branch or losing dirty files", async () => {
    await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "unsaved local changes\n");
    const result = await selectBranch(switchRef);
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected checkout to fail");
    expect(String(squashAtomCommandFailure(result))).toContain("would be overwritten");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe(
      "unsaved local changes\n",
    );
  });

  it("fails when the source project is unavailable instead of releasing a composer selection", async () => {
    const result = await checkoutNewTaskBranch({
      branch,
      project: null,
      workspaceMode: "local",
      refreshStatus,
      switchRef: () => {
        throw new Error("An unavailable project must not run checkout");
      },
    });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected an unavailable-project failure");
    expect(String(squashAtomCommandFailure(result))).toContain("selected project is unavailable");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("reuses an existing worktree without switching the project checkout", async () => {
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      refreshStatus,
      switchRef: () => {
        throw new Error("Existing worktrees must not switch the project checkout");
      },
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Worktree selection failed");
    expect(result.value.worktreePath).toBe(worktreePath);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
      "feature\n",
    );
  });

  it("checks out a Stave branch in its primary repo even when refs report a worktree path", async () => {
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath: cwd },
      project: {
        environmentId,
        workspaceRoot: directory,
        stave: {
          spaceId: "branch-test",
          isSaga: false,
          repos: [],
          memories: [],
          primaryRepoPath: cwd,
          primaryBranch: "main",
        },
      },
      workspaceMode: "local",
      refreshStatus,
      switchRef,
    });
    expect(result._tag).toBe("Success");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe(branch.name);
  });

  it.each([false, true])(
    "rejects historical and stale picker metadata after the same shared path switches branch (current: %s)",
    async (current) => {
      const worktreePath = NodePath.join(directory, "shared-worktree");
      await git("worktree", "add", worktreePath, branch.name);
      await exec("git", ["-C", worktreePath, "checkout", "-b", "feature/b"]);
      await NodeFSP.writeFile(NodePath.join(worktreePath, "file.txt"), "thread B edits\n");

      const result = await checkoutNewTaskBranch({
        branch: { ...branch, current, worktreePath },
        project: { environmentId, workspaceRoot: cwd },
        workspaceMode: "local",
        refreshStatus,
        switchRef: () => {
          throw new Error("A stale shared worktree must not be switched");
        },
      });

      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Expected a shared-checkout conflict");
      expect(String(squashAtomCommandFailure(result))).toContain("no longer on feature/a");
      expect(
        (await exec("git", ["-C", worktreePath, "branch", "--show-current"])).stdout.trim(),
      ).toBe("feature/b");
      expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
        "thread B edits\n",
      );
      expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    },
  );

  it("waits for live worktree verification before releasing a valid picker selection", async () => {
    const worktreePath = NodePath.join(directory, "picker-worktree");
    await git("worktree", "add", worktreePath, branch.name);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let completed = false;
    const selection = checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      refreshStatus: async (request) => {
        expect(request.input.cwd).toBe(worktreePath);
        entered.resolve();
        await release.promise;
        return refreshStatus(request);
      },
      switchRef: () => {
        throw new Error("A verified picker worktree must not run checkout");
      },
    }).then((result) => {
      completed = true;
      return result;
    });
    await entered.promise;
    expect(completed).toBe(false);
    release.resolve();
    const result = await selection;
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Expected a verified selection");
    expect(result.value.worktreePath).toBe(worktreePath);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("does not release a historical path that no longer exists", async () => {
    const worktreePath = NodePath.join(directory, "removed-worktree");
    await git("worktree", "add", worktreePath, branch.name);
    await git("worktree", "remove", worktreePath);
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      refreshStatus,
      switchRef: () => {
        throw new Error("A missing worktree must not switch the project checkout");
      },
    });
    expect(result._tag).toBe("Failure");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("verifies the current picker branch without running checkout", async () => {
    await git("checkout", branch.name);
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, current: true },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      refreshStatus,
      switchRef: () => {
        throw new Error("A verified current branch must not run checkout");
      },
    });
    expect(result._tag).toBe("Success");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe(branch.name);
  });

  it("establishes a stale current-branch selection in the project checkout", async () => {
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, current: true },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      refreshStatus,
      switchRef,
    });
    expect(result._tag).toBe("Success");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe(branch.name);
  });

  it("leaves a new-worktree base selection for server preparation", async () => {
    const result = await checkoutNewTaskBranch({
      branch,
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "worktree",
      refreshStatus: () => {
        throw new Error("A base selection must not validate the current checkout");
      },
      switchRef: () => {
        throw new Error("A base selection must not switch the current checkout");
      },
    });
    expect(result._tag).toBe("Success");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("does not bypass Git safety when a Stave branch is held by another checkout", async () => {
    const worktreePath = NodePath.join(directory, "other-space-checkout");
    await git("worktree", "add", worktreePath, branch.name);
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: {
        environmentId,
        workspaceRoot: directory,
        stave: {
          spaceId: "branch-test",
          isSaga: false,
          repos: [],
          memories: [],
          primaryRepoPath: cwd,
          primaryBranch: "main",
        },
      },
      workspaceMode: "local",
      refreshStatus,
      switchRef,
    });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected Git to protect the other checkout");
    expect(String(squashAtomCommandFailure(result))).toContain("already used by worktree");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(
      (await exec("git", ["-C", worktreePath, "branch", "--show-current"])).stdout.trim(),
    ).toBe(branch.name);
  });

  it("refuses a Stave space without an editable Git target", async () => {
    const result = await checkoutNewTaskBranch({
      branch,
      project: {
        environmentId,
        workspaceRoot: directory,
        stave: { spaceId: "no-checkout", isSaga: false, repos: [], memories: [] },
      },
      workspaceMode: "local",
      refreshStatus,
      switchRef: () => {
        throw new Error("A space root must not receive Git commands");
      },
    });
    expect(result._tag).toBe("Failure");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });
});
