import { resolveProjectGitCwd } from "@lecturn/client-runtime/state/projectGit";
import type { OrchestrationProjectShell } from "@lecturn/contracts";

type WorkspaceMode = "local" | "worktree";

type NewTaskProjectLike = Pick<OrchestrationProjectShell, "workspaceRoot" | "stave">;

/**
 * Directory the composer's branch list, status stream and checkout commands
 * target. A Stave space root is not a git repository, so its primary repo
 * answers instead; a stand-in project with an empty root yields null so no
 * query is issued against a fabricated path.
 */
export function resolveNewTaskGitCwd(
  project: NewTaskProjectLike | null | undefined,
): string | null {
  return resolveProjectGitCwd({ project }) || null;
}

export function resolveNewTaskWorkspaceLabel(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly worktreePath: string | null;
}): "Current checkout" | "Current worktree" | "New worktree" {
  if (input.workspaceMode === "worktree") {
    return "New worktree";
  }
  return input.worktreePath ? "Current worktree" : "Current checkout";
}

/**
 * Worktree a local-mode draft should run in when the picked branch lives in
 * one. `projectCwd` is the git cwd the branch list was fetched from, so the
 * checkout itself never counts as a worktree. Stave threads always run in
 * the space root: any path the primary repo's branch list reports is that
 * repo's checkout, never a thread worktree, so it is dropped.
 */
export function resolveNewTaskBranchWorktreePath(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly projectCwd: string;
  readonly branchWorktreePath: string | null | undefined;
  readonly staveProject?: boolean;
}): string | null {
  if (
    input.staveProject === true ||
    input.workspaceMode === "worktree" ||
    !input.branchWorktreePath ||
    input.branchWorktreePath === input.projectCwd
  ) {
    return null;
  }
  return input.branchWorktreePath;
}

export function resolveNewTaskLocalWorkspaceSelection(input: {
  readonly branches: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly worktreePath?: string | null;
  }>;
  readonly projectCwd: string;
  readonly staveProject?: boolean;
}): {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly awaitsCurrentBranch: boolean;
} {
  const currentBranch = input.branches.find((branch) => branch.current) ?? null;
  if (!currentBranch) {
    return {
      branch: null,
      worktreePath: null,
      awaitsCurrentBranch: true,
    };
  }

  return {
    branch: currentBranch.name,
    worktreePath: resolveNewTaskBranchWorktreePath({
      workspaceMode: "local",
      projectCwd: input.projectCwd,
      branchWorktreePath: currentBranch.worktreePath,
      ...(input.staveProject !== undefined ? { staveProject: input.staveProject } : {}),
    }),
    awaitsCurrentBranch: false,
  };
}

export function resolveNewTaskBranchLabel(input: {
  readonly branchName: string | null;
  readonly startFromOrigin: boolean;
  readonly workspaceMode: WorkspaceMode;
}): string {
  if (!input.branchName) {
    return "Choose branch";
  }

  if (input.workspaceMode === "local") {
    return input.branchName;
  }

  const baseRef = input.startFromOrigin ? `origin/${input.branchName}` : input.branchName;
  return `From ${baseRef}`;
}

export function shouldCheckoutNewTaskBranch(input: {
  readonly staveProject?: boolean;
  readonly branchIsCurrent: boolean;
  readonly branchWorktreePath: string | null | undefined;
  readonly workspaceMode: WorkspaceMode;
}): boolean {
  return (
    input.workspaceMode === "local" &&
    !input.branchIsCurrent &&
    (input.staveProject === true || !input.branchWorktreePath)
  );
}
