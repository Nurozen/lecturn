import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { addProjectAndOpenThread } from "./addProject";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const WORKSPACE_ROOT = "/repo/project";

const project = {
  id: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  workspaceRoot: WORKSPACE_ROOT,
} as unknown as EnvironmentProject;

function makeThread(settledOverride: "settled" | "active" | null): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    archivedAt: null,
    settledOverride,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
  } as unknown as EnvironmentThreadShell;
}

async function addExistingProject(thread: EnvironmentThreadShell) {
  const navigate = vi.fn(async () => undefined);
  const handleNewThread = vi.fn(async () => undefined);
  const createProject = vi.fn();
  const outcome = await addProjectAndOpenThread({
    environmentId: ENVIRONMENT_ID,
    workspaceRoot: WORKSPACE_ROOT,
    createWorkspaceRootIfMissing: false,
    createProject,
    navigate: navigate as never,
    handleNewThread,
    projects: [project],
    threads: [thread],
    sidebarThreadSortOrder: "updated_at",
  });
  return { outcome, navigate, handleNewThread, createProject };
}

describe("addProjectAndOpenThread", () => {
  it("reopens the latest thread of an existing project", async () => {
    const { outcome, navigate, handleNewThread, createProject } = await addExistingProject(
      makeThread(null),
    );
    expect(outcome).toEqual({ status: "opened", projectId: PROJECT_ID, created: false });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("starts a new thread instead of reopening a settled one", async () => {
    const { outcome, navigate, handleNewThread } = await addExistingProject(makeThread("settled"));
    expect(outcome).toEqual({ status: "opened", projectId: PROJECT_ID, created: false });
    expect(navigate).not.toHaveBeenCalled();
    expect(handleNewThread).toHaveBeenCalledTimes(1);
  });
});
