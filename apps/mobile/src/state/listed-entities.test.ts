import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../test-fixtures";

import { listedProjects, listedThreadShells } from "./listed-entities";

function makeProject(
  id: string,
  environmentId: string,
  state?: "live" | "archived",
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...(state === undefined
      ? {}
      : { stave: { spaceId: id, isSaga: false, state, repos: [], memories: [] } }),
  };
}

function makeThread(id: string, project: EnvironmentProject): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId: project.environmentId,
    id: ThreadId.make(id),
    projectId: project.id,
    title: id,
  });
}

describe("listed projects and threads", () => {
  const plain = makeProject("plain", "mac");
  const live = makeProject("live", "mac", "live");
  const archived = makeProject("archived", "mac", "archived");
  // Same project id on another environment is a different project.
  const sameIdElsewhere = makeProject("archived", "server");

  it("drops archived Stave spaces and the threads under them", () => {
    const projects = [plain, live, archived, sameIdElsewhere];
    const threads = [
      makeThread("t-plain", plain),
      makeThread("t-live", live),
      makeThread("t-archived", archived),
      makeThread("t-elsewhere", sameIdElsewhere),
    ];
    expect(listedProjects(projects)).toEqual([plain, live, sameIdElsewhere]);
    expect(listedThreadShells(projects, threads).map((thread) => thread.id)).toEqual([
      "t-plain",
      "t-live",
      "t-elsewhere",
    ]);
  });

  it("keeps the input arrays when nothing is archived", () => {
    const projects = [plain, live];
    const threads = [makeThread("t-plain", plain)];
    expect(listedProjects(projects)).toBe(projects);
    expect(listedThreadShells(projects, threads)).toBe(threads);
  });
});
