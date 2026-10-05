import { describe, expect, it } from "vite-plus/test";

import {
  archivedStaveProjectKeys,
  withoutArchivedStaveProjectThreads,
} from "./listedProjects.logic";

const projects = [
  { environmentId: "env-a", id: "live", stave: { state: "live" } },
  { environmentId: "env-a", id: "archived", stave: { state: "archived" } },
  { environmentId: "env-b", id: "archived", stave: null },
  { environmentId: "env-b", id: "plain" },
];

describe("archivedStaveProjectKeys", () => {
  it("keys only archived Stave projects, per environment", () => {
    expect([...archivedStaveProjectKeys(projects)]).toEqual(["env-a:archived"]);
  });
});

describe("withoutArchivedStaveProjectThreads", () => {
  it("drops threads of archived projects and keeps same-id projects elsewhere", () => {
    const threads = [
      { environmentId: "env-a", projectId: "live", id: "1" },
      { environmentId: "env-a", projectId: "archived", id: "2" },
      { environmentId: "env-b", projectId: "archived", id: "3" },
    ];
    expect(
      withoutArchivedStaveProjectThreads(threads, archivedStaveProjectKeys(projects)).map(
        (thread) => thread.id,
      ),
    ).toEqual(["1", "3"]);
  });

  it("returns the same list when nothing is archived", () => {
    const threads = [{ environmentId: "env-a", projectId: "live" }];
    expect(withoutArchivedStaveProjectThreads(threads, new Set())).toBe(threads);
  });
});
