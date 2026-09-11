import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import { findExistingAddProject } from "@lecturn/client-runtime/operations/projects";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@lecturn/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@lecturn/contracts";
import type { useNavigate } from "@tanstack/react-router";

import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShells } from "../state/entities";
import type { projectEnvironment } from "../state/projects";
import { waitForStaveProjectVisible } from "../state/staveOperations";
import { buildThreadRouteParams } from "../threadRoutes";
import { getLatestThreadForProject } from "./threadSort";
import { inferProjectTitleFromPath } from "./projectPaths";
import { newProjectId } from "./utils";

/**
 * The tail every "add project" surface shares: reuse an existing project at
 * the path (open its latest thread, or start one), otherwise `project.create`
 * and start a thread in it. The command palette reaches it with a resolved
 * folder or clone destination; the Stave wizard reaches
 * `openExistingProjectAndThread` after the server created the project.
 */

type NavigateFn = ReturnType<typeof useNavigate>;
type CreateProjectCommandInput = Parameters<typeof projectEnvironment.create.run>[1]["input"];
type ThreadSortOrder = Parameters<typeof getLatestThreadForProject>[2];

export type AddProjectOutcome =
  | { readonly status: "opened"; readonly projectId: ProjectId; readonly created: boolean }
  /** The create command was interrupted; callers stay quiet, as the palette always has. */
  | { readonly status: "interrupted" }
  | {
      readonly status: "failed";
      readonly stage: "open-existing" | "create" | "open-created";
      readonly error: unknown;
    };

export interface OpenProjectThreadDeps {
  readonly navigate: NavigateFn;
  readonly handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>;
  /** Defaults to the live client store; the palette passes what it rendered from. */
  readonly projects?: ReadonlyArray<EnvironmentProject>;
  readonly threads?: ReadonlyArray<EnvironmentThreadShell>;
  readonly sidebarThreadSortOrder?: ThreadSortOrder;
}

async function openThreadForProject(
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
  deps: OpenProjectThreadDeps,
): Promise<AddProjectOutcome> {
  const threads = deps.threads ?? readThreadShells();
  const sortOrder = deps.sidebarThreadSortOrder ?? getClientSettings().sidebarThreadSortOrder;
  const latestThread = getLatestThreadForProject(
    threads.filter((thread) => thread.environmentId === project.environmentId),
    project.id,
    sortOrder,
  );
  if (latestThread) {
    await deps.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(latestThread.environmentId, latestThread.id)),
    });
    return { status: "opened", projectId: project.id, created: false };
  }
  const navigationResult = await settlePromise(() =>
    deps.handleNewThread(scopeProjectRef(project.environmentId, project.id)),
  );
  if (navigationResult._tag === "Failure") {
    return {
      status: "failed",
      stage: "open-existing",
      error: squashAtomCommandFailure(navigationResult),
    };
  }
  return { status: "opened", projectId: project.id, created: false };
}

export interface AddProjectAndOpenThreadInput extends OpenProjectThreadDeps {
  readonly environmentId: EnvironmentId;
  /** Already resolved for dispatch (absolute, or relative to the active project). */
  readonly workspaceRoot: string;
  /** Defaults to the folder name. */
  readonly title?: string;
  readonly createWorkspaceRootIfMissing: boolean;
  readonly createProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: CreateProjectCommandInput;
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}

export async function addProjectAndOpenThread(
  input: AddProjectAndOpenThreadInput,
): Promise<AddProjectOutcome> {
  const projects = input.projects ?? readProjects();
  const existing = findExistingAddProject({
    projects,
    environmentId: input.environmentId,
    path: input.workspaceRoot,
  });
  if (existing) {
    return openThreadForProject(existing, input);
  }

  const projectId = newProjectId();
  const createResult = await input.createProject({
    environmentId: input.environmentId,
    input: {
      projectId,
      title: input.title ?? inferProjectTitleFromPath(input.workspaceRoot),
      workspaceRoot: input.workspaceRoot,
      createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
      defaultModelSelection: null,
    },
  });
  if (createResult._tag === "Failure") {
    return isAtomCommandInterrupted(createResult)
      ? { status: "interrupted" }
      : { status: "failed", stage: "create", error: squashAtomCommandFailure(createResult) };
  }

  const navigationResult = await settlePromise(() =>
    input.handleNewThread(scopeProjectRef(input.environmentId, projectId)),
  );
  if (navigationResult._tag === "Failure") {
    return {
      status: "failed",
      stage: "open-created",
      error: squashAtomCommandFailure(navigationResult),
    };
  }
  return { status: "opened", projectId, created: true };
}

export interface OpenExistingProjectAndThreadInput extends OpenProjectThreadDeps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /**
   * The shell sequence a server-side `project.create` produced (a Stave
   * `createSpace` result). When given, the open waits until this client's
   * shell has applied it, so a freshly created project is never opened
   * before it is in the store (deviation 26).
   */
  readonly sequence?: number;
}

export async function openExistingProjectAndThread(
  input: OpenExistingProjectAndThreadInput,
): Promise<AddProjectOutcome> {
  if (input.sequence !== undefined) {
    const visible = await runAtomCommand(
      appAtomRegistry,
      waitForStaveProjectVisible,
      {
        environmentId: input.environmentId,
        projectId: input.projectId,
        sequence: input.sequence,
      },
      { reportFailure: false },
    );
    if (visible._tag === "Failure") {
      return {
        status: "failed",
        stage: "open-existing",
        error: squashAtomCommandFailure(visible),
      };
    }
  }
  return openThreadForProject({ environmentId: input.environmentId, id: input.projectId }, input);
}
