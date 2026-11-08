import { resolveProjectGitCwd } from "@lecturn/client-runtime/state/projectGit";
import type { OrchestrationProjectShell } from "@lecturn/contracts";
import { sanitizeNewRefName } from "@lecturn/shared/git";
import { sourceControlClients } from "@lecturn/client-runtime/source-control-clients";
import { resolveSendEnvMode } from "@lecturn/shared/projectSettings";
import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

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

/**
 * Directory a draft's header reads git status from. `cwd` is the composer's directory: a worktree
 * path answers for itself, but a Stave space root is not a repository, so its primary repo does.
 */
export function resolveDraftHeaderGitCwd(
  project: NewTaskProjectLike,
  cwd: string | null,
): string | null {
  return cwd === project.workspaceRoot ? resolveNewTaskGitCwd(project) : cwd;
}

export function resolveNewTaskWorkspaceSelection(input: {
  readonly selection: ComposerDraftWorkspaceSelection | undefined;
  readonly fallback: ComposerDraftWorkspaceSelection;
  readonly isGitRepo: boolean;
}): ComposerDraftWorkspaceSelection {
  const selection = input.selection ?? input.fallback;
  const mode = resolveSendEnvMode({ requestedEnvMode: selection.mode, isGitRepo: input.isGitRepo });
  return input.isGitRepo ? selection : { mode, branch: null, worktreePath: null };
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
 * Worktree a local-mode draft runs in when the picked branch lives in one. `projectCwd`
 * is the git cwd the branch list came from, so the checkout never counts. Stave threads
 * always run in the space root, so a path from the primary repo's branch list is dropped.
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
  readonly pullRequestReference?: string;
}): string {
  if (input.workspaceMode === "worktree" && input.pullRequestReference) {
    const parsed = sourceControlClients.parseChangeRequestUrl(input.pullRequestReference);
    if (parsed) return `From ${parsed.definition.changeRequest.shortLabel} #${parsed.link.number}`;
  }
  if (!input.branchName) {
    return "Choose branch";
  }

  if (input.workspaceMode === "local") {
    return input.branchName;
  }

  // Only the server can determine a local branch's configured remote.
  return input.startFromOrigin ? `From ${input.branchName} (remote)` : `From ${input.branchName}`;
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

export function filterNewTaskBranches<T extends { readonly name: string }>(
  branches: ReadonlyArray<T>,
  rawQuery: string,
): ReadonlyArray<T> {
  const query = sanitizeNewRefName(rawQuery).toLowerCase();
  return query.length === 0
    ? branches
    : branches.filter((branch) => branch.name.toLowerCase().includes(query));
}

/**
 * A worktree with no chosen base starts from the default branch, and a local
 * selection the user just switched to follows the current checkout until refs
 * load. Both are derived, never written back, so a late ref list or lecturn.json
 * default still wins.
 */
export function fillNewTaskWorkspaceBranch(input: {
  readonly selection: ComposerDraftWorkspaceSelection;
  readonly branches: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly isDefault: boolean;
    readonly isRemote?: boolean;
    readonly worktreePath?: string | null;
  }>;
  readonly projectCwd: string | null;
  readonly worktreeDefaultSettled: boolean;
  readonly staveProject?: boolean;
}): ComposerDraftWorkspaceSelection {
  const { selection } = input;
  if (selection.branch !== null) return selection;
  if (selection.mode === "worktree") {
    // The default may only exist as origin/<default>, so search remote refs too.
    const base =
      input.branches.find((branch) => branch.isDefault) ??
      input.branches.find((branch) => !branch.isRemote && branch.current) ??
      null;
    return input.worktreeDefaultSettled && base
      ? { ...selection, branch: base.name, worktreePath: null }
      : selection;
  }
  if (!selection.followsCurrentCheckout || input.projectCwd === null) return selection;
  const local = resolveNewTaskLocalWorkspaceSelection({
    branches: input.branches.filter((branch) => !branch.isRemote),
    projectCwd: input.projectCwd,
    ...(input.staveProject !== undefined ? { staveProject: input.staveProject } : {}),
  });
  return local.awaitsCurrentBranch
    ? selection
    : { ...selection, branch: local.branch, worktreePath: local.worktreePath };
}

/**
 * The workspace a new-task draft starts in: its own selection, else the
 * project's default mode, with the branch filled in as above. The new-task
 * flow, its send path and the home pending-drafts list all resolve through
 * this, so what each shows is what is sent.
 */
export function resolveNewTaskDraftWorkspace(input: {
  readonly selection: ComposerDraftWorkspaceSelection | undefined;
  readonly canChooseWorkspace: boolean;
  readonly defaultMode: WorkspaceMode;
  readonly defaultModeSettled: boolean;
  readonly isGitRepo: boolean;
  readonly branches: Parameters<typeof fillNewTaskWorkspaceBranch>[0]["branches"];
  readonly projectCwd: string | null;
  /** A Stave space's mode, which beats a stale explicit pick left in the draft. */
  readonly forcedMode?: WorkspaceMode;
  /** A Stave thread never has a worktree, whatever an older draft recorded. */
  readonly staveProject?: boolean;
}): ComposerDraftWorkspaceSelection {
  const chosen = input.canChooseWorkspace ? input.selection : undefined;
  const selection =
    chosen !== undefined && input.forcedMode !== undefined && chosen.mode !== input.forcedMode
      ? { ...chosen, mode: input.forcedMode }
      : chosen;
  const resolved = fillNewTaskWorkspaceBranch({
    selection: resolveNewTaskWorkspaceSelection({
      selection,
      fallback: { mode: input.defaultMode, branch: null, worktreePath: null },
      isGitRepo: input.isGitRepo,
    }),
    branches: input.branches,
    projectCwd: input.projectCwd,
    worktreeDefaultSettled: selection?.mode !== undefined || input.defaultModeSettled,
    ...(input.staveProject !== undefined ? { staveProject: input.staveProject } : {}),
  });
  return input.staveProject === true && resolved.worktreePath !== null
    ? { ...resolved, worktreePath: null }
    : resolved;
}
