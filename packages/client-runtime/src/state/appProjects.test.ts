import { AppId, EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appGroups,
  isAppProject,
  projectsForApp,
  projectsForProjectsMode,
  threadsForProjectsMode,
} from "./appProjects.ts";
import type { EnvironmentProject } from "./models.ts";

const desk = EnvironmentId.make("desk");
const laptop = EnvironmentId.make("laptop");
const rocket = AppId.make("dev.example.rocket");
const counter = AppId.make("dev.example.counter");

function project(
  environmentId: EnvironmentId,
  id: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: "/work/rocket",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function appProject(environmentId: EnvironmentId, id: string, appId: AppId, title = id) {
  return project(environmentId, id, {
    title,
    appBinding: { appId, workspaceRoot: "/work/rocket" },
  });
}

function thread(environmentId: EnvironmentId, projectId: string, id: string) {
  return { environmentId, projectId: ProjectId.make(projectId), id: ThreadId.make(id) };
}

describe("app projects", () => {
  it("marks a project as an app project only by its binding", () => {
    expect(isAppProject(appProject(desk, "app", rocket))).toBe(true);
    expect(isAppProject(project(desk, "normal"))).toBe(false);
  });

  it("leaves app projects and archived Stave spaces out of Projects mode", () => {
    const normal = project(desk, "normal");
    const archived = project(desk, "archived", {
      stave: { spaceId: "space", isSaga: false, repos: [], memories: [], state: "archived" },
    });
    const app = appProject(desk, "app", rocket);
    expect(projectsForProjectsMode([normal, archived, app])).toEqual([normal]);

    const plain = [normal, project(laptop, "other")];
    expect(projectsForProjectsMode(plain)).toBe(plain);
  });

  it("drops the threads of hidden projects but keeps threads whose project is unknown", () => {
    const projects = [project(desk, "normal"), appProject(desk, "app", rocket)];
    const kept = thread(desk, "normal", "t1");
    const pending = thread(desk, "not-loaded", "t2");
    const sameIdElsewhere = thread(laptop, "app", "t3");
    const threads = [kept, thread(desk, "app", "t4"), pending, sameIdElsewhere];
    expect(threadsForProjectsMode(projects, threads)).toEqual([kept, pending, sameIdElsewhere]);

    const plainThreads = [kept];
    expect(threadsForProjectsMode([project(desk, "normal")], plainThreads)).toBe(plainThreads);
  });

  it("selects one app's projects across environments", () => {
    const projects = [
      appProject(desk, "a", rocket),
      appProject(laptop, "b", rocket),
      appProject(desk, "c", counter),
      project(desk, "normal"),
    ];
    expect(projectsForApp(projects, rocket).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("groups app workspaces by app across environments with machine labels", () => {
    const labels = new Map([
      [desk, "Desk"],
      [laptop, "Laptop"],
    ]);
    const normal = project(desk, "normal");
    const groups = appGroups({
      projects: [
        appProject(laptop, "rocket-laptop", rocket, "Rocket"),
        appProject(desk, "rocket-desk", rocket, "Rocket"),
        appProject(desk, "counter-desk", counter, "Counter"),
        normal,
      ],
      threads: [
        thread(desk, "rocket-desk", "r1"),
        thread(desk, "normal", "n1"),
        thread(desk, "rocket-desk", "r2"),
        thread(laptop, "rocket-laptop", "r3"),
      ],
      environmentLabels: labels,
    });

    expect(groups.map((group) => group.appId)).toEqual([counter, rocket]);
    const [counterGroup, rocketGroup] = groups;
    expect(counterGroup!.spansEnvironments).toBe(false);
    expect(counterGroup!.workspaces).toEqual([
      expect.objectContaining({ key: "desk:counter-desk", machineLabel: null, threads: [] }),
    ]);
    expect(rocketGroup!.spansEnvironments).toBe(true);
    expect(
      rocketGroup!.workspaces.map((workspace) => ({
        key: workspace.key,
        machineLabel: workspace.machineLabel,
        threads: workspace.threads.map((entry) => entry.id),
      })),
    ).toEqual([
      { key: "desk:rocket-desk", machineLabel: "Desk", threads: ["r1", "r2"] },
      { key: "laptop:rocket-laptop", machineLabel: "Laptop", threads: ["r3"] },
    ]);
  });

  it("never merges an app workspace with a normal project on the same folder", () => {
    const groups = appGroups({
      projects: [appProject(desk, "app", rocket), project(desk, "normal")],
      threads: [thread(desk, "normal", "n1"), thread(desk, "app", "a1")],
      environmentLabels: new Map(),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.workspaces).toHaveLength(1);
    expect(groups[0]!.workspaces[0]!.threads.map((entry) => entry.id)).toEqual(["a1"]);
  });
});
