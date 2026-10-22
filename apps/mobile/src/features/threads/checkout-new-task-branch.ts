import { isStaveProject, resolveProjectGitCwd } from "@lecturn/client-runtime/state/projectGit";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import type { VcsRef } from "@lecturn/client-runtime/state/vcs";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@lecturn/client-runtime/state/runtime";
import type {
  VcsStatusInput,
  VcsStatusResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { shouldCheckoutNewTaskBranch } from "./new-task-context-presentation";

/** Existing worktrees may be shared by threads whose branch metadata has drifted.
 * Verify their live ref without switching them behind another thread. */
export async function checkoutNewTaskBranch<E>(input: {
  readonly branch: VcsRef;
  readonly project:
    | (Pick<EnvironmentProject, "environmentId" | "workspaceRoot"> &
        Partial<Pick<EnvironmentProject, "stave">>)
    | null;
  readonly workspaceMode: "local" | "worktree";
  readonly refreshStatus: (request: {
    readonly environmentId: EnvironmentProject["environmentId"];
    readonly input: VcsStatusInput;
  }) => Promise<AtomCommandResult<Pick<VcsStatusResult, "isRepo" | "refName">, E>>;
  readonly switchRef: (request: {
    readonly environmentId: EnvironmentProject["environmentId"];
    readonly input: VcsSwitchRefInput;
  }) => Promise<AtomCommandResult<VcsSwitchRefResult, E>>;
}): Promise<AtomCommandResult<VcsRef, E | Error>> {
  if (!input.project) {
    return AsyncResult.failure(
      Cause.fail(new Error("The selected project is unavailable. Reconnect and try again.")),
    );
  }
  if (input.workspaceMode === "worktree") {
    return AsyncResult.success(input.branch);
  }

  const cwd = resolveProjectGitCwd({ project: input.project });
  if (!cwd) {
    return AsyncResult.failure(
      Cause.fail(new Error("The selected project has no unambiguous editable Git checkout.")),
    );
  }
  const staveProject = isStaveProject(input.project);
  const worktreePath = staveProject ? null : input.branch.worktreePath;
  if (
    !shouldCheckoutNewTaskBranch({
      staveProject,
      branchIsCurrent: input.branch.current,
      branchWorktreePath: worktreePath,
      workspaceMode: input.workspaceMode,
    })
  ) {
    const status = await input.refreshStatus({
      environmentId: input.project.environmentId,
      input: { cwd: worktreePath ?? cwd },
    });
    if (status._tag === "Failure") return mapAtomCommandResult(status, () => input.branch);
    if (status.value.isRepo && status.value.refName === input.branch.name) {
      return AsyncResult.success(input.branch);
    }
    if (worktreePath || !status.value.isRepo) {
      return AsyncResult.failure(
        Cause.fail(
          new Error(
            `The checkout at ${worktreePath ?? cwd} is no longer on ${input.branch.name}. Choose a branch from the branch picker or create a new worktree to avoid switching a shared checkout.`,
          ),
        ),
      );
    }
  }
  const result = await input.switchRef({
    environmentId: input.project.environmentId,
    input: { cwd, refName: input.branch.name },
  });
  return mapAtomCommandResult(result, (value) => ({
    ...input.branch,
    current: true,
    isRemote: false,
    name: value.refName ?? input.branch.name,
  }));
}
