import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  getProjectScopeSelectionTarget,
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

describe("getProjectScopeSelectionTarget", () => {
  it("prefers a connected copy of a project that spans environments", () => {
    const mac = makeProject("lecturn", "mac");
    const server = makeProject("lecturn", "server");
    const target = (connected: ReadonlyArray<string>, preferred: string | null = null) =>
      getProjectScopeSelectionTarget(
        makeScope([mac, server]),
        preferred === null ? null : EnvironmentId.make(preferred),
        new Set(connected.map((id) => EnvironmentId.make(id))),
      );
    expect(target(["server"])).toBe(server);
    expect(target(["server"], "mac")).toBe(server);
    expect(target(["mac", "server"], "server")).toBe(server);
    expect(target(["mac", "server"])).toBe(mac);
    // With nothing connected, the usual order still applies.
    expect(target([], "server")).toBe(server);
    expect(target([])).toBe(mac);
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
  const projects = [makeProject("lecturn"), makeProject("lecturn-2")];
  const draft = { incomingShareId: undefined, pickerClosed: false };

  it("opens the picker instead of auto-selecting the only project", () => {
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)], draft)).toEqual({
      kind: "pick",
    });
  });

  it("selects the only logical project for shared content", () => {
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        ...draft,
        incomingShareId: "share",
      }),
    ).toEqual({ kind: "select", project: projects[0] });
  });

  it("dismisses the draft when the first picker closes without a choice", () => {
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        ...draft,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "dismiss" });
  });

  it("keeps the draft when the picker closes after a choice", () => {
    expect(
      resolveDraftProjectSelection("environment:lecturn-2", projects, [makeScope(projects)], {
        ...draft,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "preserve" });
  });

  it("keeps a share draft asking for a project when its picker closes without a choice", () => {
    const scopes = [makeScope([projects[0]!]), makeScope([projects[1]!])];
    expect(
      resolveDraftProjectSelection(null, projects, scopes, {
        incomingShareId: "share",
        pickerClosed: true,
      }),
    ).toEqual({ kind: "pick" });
  });
});

describe("newTaskDestination", () => {
  const picker = { draft: { requestId: "request" } };

  function destination(options: {
    readonly useLastProject: boolean | undefined;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly current?: EnvironmentProject;
    readonly last?: { readonly environmentId: string; readonly projectId: string };
  }) {
    return newTaskDestination({
      projects: options.projects,
      requestId: "request",
      useLastProject: options.useLastProject,
      currentProject: options.current && {
        environmentId: options.current.environmentId,
        projectId: options.current.id,
      },
      lastProject: options.last,
    });
  }

  it("starts in the current thread's project ahead of the remembered one", () => {
    const projects = [makeProject("remembered"), makeProject("current", "other-environment")];
    expect(
      destination({
        useLastProject: true,
        projects,
        current: projects[1],
        last: { environmentId: "environment", projectId: "remembered" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "current" },
    });
  });

  it("treats an unset preference as on", () => {
    const projects = [makeProject("first"), makeProject("current")];
    expect(destination({ useLastProject: undefined, projects, current: projects[1] })).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "current" },
    });
  });
  it("remembers only a listed project, never an app workspace or archived space", () => {
    const appWorkspace = { ...makeProject("app"), appBinding: { appId: "dev.example" } };
    const archived = {
      ...makeProject("archived"),
      stave: { spaceId: "space", isSaga: false, repos: [], state: "archived" },
    };
    const projects = [appWorkspace, archived, makeProject("listed")] as EnvironmentProject[];
    for (const last of [appWorkspace, archived]) {
      expect(
        destination({
          useLastProject: true,
          projects,
          last: { environmentId: last.environmentId, projectId: last.id },
        }),
      ).toEqual(picker);
    }
    expect(
      destination({
        useLastProject: true,
        projects,
        last: { environmentId: "environment", projectId: "listed" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "listed" },
    });
  });

  it("still finds a current project that only the Apps tab lists", () => {
    const appWorkspace = {
      ...makeProject("app"),
      appBinding: { appId: "dev.example" },
    } as EnvironmentProject;
    const projects = [makeProject("listed"), appWorkspace] as EnvironmentProject[];
    expect(destination({ useLastProject: true, projects, current: appWorkspace })).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "app" },
    });
  });

  it("starts in the remembered project of its own environment when there is no current one", () => {
    const projects = [makeProject("chosen"), makeProject("chosen", "other-environment")];
    expect(
      destination({
        useLastProject: true,
        projects,
        last: { environmentId: "other-environment", projectId: "chosen" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "chosen" },
    });
  });

  it("ignores a remembered project id from another environment", () => {
    expect(
      destination({
        useLastProject: true,
        projects: [makeProject("chosen")],
        last: { environmentId: "removed-environment", projectId: "chosen" },
      }),
    ).toEqual(picker);
  });

  it("opens the picker rather than the first project when nothing matches", () => {
    expect(
      destination({
        useLastProject: true,
        projects: [makeProject("first"), makeProject("second")],
        current: makeProject("removed"),
      }),
    ).toEqual(picker);
  });

  it("always opens the picker when the preference is off", () => {
    const only = makeProject("only");
    expect(
      destination({
        useLastProject: false,
        projects: [only],
        current: only,
        last: { environmentId: "environment", projectId: "only" },
      }),
    ).toEqual(picker);
  });
});
