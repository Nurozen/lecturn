import { AppId, EnvironmentId, ProjectId } from "@lecturn/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Record<string, unknown>>,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => entities.projects }));

import {
  partitionThreadsByProjectKeys,
  withoutArchivedStaveProjectThreads,
} from "./listedProjects.logic";
import { useListedProjects } from "./useListedProjects";

const desk = EnvironmentId.make("desk");
const laptop = EnvironmentId.make("laptop");
const rocket = AppId.make("dev.example.rocket");

const project = (environmentId: EnvironmentId, id: string, extra: object = {}) => ({
  environmentId,
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: "/work/rocket",
  ...extra,
});
const normal = project(desk, "normal");
// Same folder as the normal project: the two coexist, only the app one leaves the list.
const app = project(desk, "app", { appBinding: { appId: rocket, workspaceRoot: "/work/rocket" } });
const remoteApp = project(laptop, "app", {
  appBinding: { appId: rocket, workspaceRoot: "/work/rocket" },
});
const archived = project(desk, "archived", { stave: { state: "archived" } });

const thread = (environmentId: EnvironmentId, projectId: string, id: string) => ({
  environmentId,
  projectId,
  id,
});
const threads = [
  thread(desk, "normal", "normal-1"),
  thread(desk, "app", "app-1"),
  thread(laptop, "app", "remote-app-1"),
  thread(desk, "archived", "archived-1"),
  thread(desk, "unloaded", "unloaded-1"),
];

beforeEach(() => {
  entities.projects = [normal, app, remoteApp, archived];
});

describe("useListedProjects", () => {
  it("lists neither app projects nor archived Stave spaces, and keys each kind apart", () => {
    const listed = useListedProjects();
    expect(listed.projects).toEqual([normal]);
    expect([...listed.appProjectKeys]).toEqual(["desk:app", "laptop:app"]);
    expect([...listed.archivedProjectKeys]).toEqual(["desk:archived"]);
  });

  it("keeps the project list's identity when nothing is hidden", () => {
    entities.projects = [normal];
    const listed = useListedProjects();
    expect(listed.projects).toBe(entities.projects);
    expect(listed.appProjectKeys.size).toBe(0);
  });

  it("drops app threads from the Projects list but keeps them for sidebar search", () => {
    const { archivedProjectKeys, appProjectKeys } = useListedProjects();
    const { outside, inside } = partitionThreadsByProjectKeys(
      withoutArchivedStaveProjectThreads(threads, archivedProjectKeys),
      appProjectKeys,
    );
    expect(outside.map((entry) => entry.id)).toEqual(["normal-1", "unloaded-1"]);
    expect(inside.map((entry) => entry.id)).toEqual(["app-1", "remote-app-1"]);
  });

  it("keeps app threads in the palette's thread list, which drops only archived spaces", () => {
    const { archivedProjectKeys } = useListedProjects();
    expect(
      withoutArchivedStaveProjectThreads(threads, archivedProjectKeys).map((entry) => entry.id),
    ).toEqual(["normal-1", "app-1", "remote-app-1", "unloaded-1"]);
  });

  it("returns the thread list unchanged when no app project matches", () => {
    const own = [thread(desk, "normal", "normal-1")];
    const split = partitionThreadsByProjectKeys(own, useListedProjects().appProjectKeys);
    expect(split.outside).toBe(own);
    expect(split.inside).toEqual([]);
  });
});
