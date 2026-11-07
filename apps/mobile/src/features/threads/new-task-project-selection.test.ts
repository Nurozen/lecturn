import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  newTaskDestination,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
  resolveNewTaskDraftProject,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/nurozen/lecturn",
    title: "Lecturn",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

describe("resolveNewTaskDraftProject", () => {
  it("waits for the stamped environment even when other accounts have projects", () => {
    const other = makeProject("shared-id", "other-account");
    const target = makeProject("shared-id", "draft-account");
    const stamp = { environmentId: target.environmentId, projectId: target.id };
    expect(resolveNewTaskDraftProject([other], stamp)).toBeNull();
    expect(resolveNewTaskDraftProject([other, target], stamp)).toBe(target);
    // Losing the target after opening must never silently switch the draft.
    expect(resolveNewTaskDraftProject([other], stamp)).toBeNull();
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("lecturn", "mac", { repositoryKey: "github.com/Nurozen/lecturn" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/Nurozen/other" }),
      makeProject("lecturn-clone", "server", { repositoryKey: "github.com/Nurozen/lecturn" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("lecturn", "mac", { workspaceRoot: "/Users/me/lecturn" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/lecturn" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "lecturn" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("lecturn", "mac", {
      repositoryKey: "github.com/Nurozen/lecturn",
      workspaceRoot: "/Users/me/lecturn",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/lecturn",
      title: "lecturn",
      workspaceRoot: "/home/me/lecturn",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/lecturn" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });
});

describe("resolveDraftProjectSelection", () => {
  it("selects one logical project even when it has multiple physical workspaces", () => {
    const projects = [makeProject("lecturn"), makeProject("lecturn-2"), makeProject("lecturn-3")];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "select",
      project: projects[0],
    });
  });

  it("does not preserve a project key that is missing from the catalog", () => {
    const project = makeProject("lecturn");
    expect(
      resolveDraftProjectSelection("environment:removed", [project], [makeScope([project])]),
    ).toEqual({
      kind: "select",
      project,
    });
  });
});

describe("newTaskDestination", () => {
  it("opens the current thread's project directly in split view", () => {
    const projects = [makeProject("first"), makeProject("current", "other-environment")];
    expect(newTaskDestination(true, projects, projects[1], "request")).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "current" },
    });
  });
  it("uses an available project when split view has no current project", () => {
    expect(newTaskDestination(true, [makeProject("first")], undefined, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "first" },
    });
  });
  it("falls back to a listed project, past app workspaces and archived spaces", () => {
    const appWorkspace = { ...makeProject("app"), appBinding: { appId: "dev.example" } };
    const archived = {
      ...makeProject("archived"),
      stave: { spaceId: "space", isSaga: false, repos: [], state: "archived" },
    };
    const projects = [appWorkspace, archived, makeProject("listed")] as EnvironmentProject[];
    expect(newTaskDestination(true, projects, undefined, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "listed" },
    });
    expect(
      newTaskDestination(true, [appWorkspace] as EnvironmentProject[], undefined, "r"),
    ).toEqual({ draft: { requestId: "r" } });
  });
  it("still finds a current project that only the Apps tab lists", () => {
    const appWorkspace = { ...makeProject("app"), appBinding: { appId: "dev.example" } };
    const projects = [makeProject("listed"), appWorkspace] as EnvironmentProject[];
    expect(newTaskDestination(true, projects, appWorkspace, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "app" },
    });
  });
  it("keeps the picker when there are no projects", () => {
    expect(newTaskDestination(true, [], undefined, "request")).toEqual({
      draft: { requestId: "request" },
    });
  });
  it("opens the same draft route in compact view", () => {
    const project = makeProject("current");
    expect(newTaskDestination(false, [project], project, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "current" },
    });
  });
});
