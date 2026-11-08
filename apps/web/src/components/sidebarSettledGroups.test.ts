import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import {
  partSettledShelfShort,
  projectOlderSettledScopes,
  projectSettledPage,
  withUnloadedSettled,
} from "./sidebarSettledGroups";

const rows = Array.from({ length: 6 }, (_, index) => ({
  id: ThreadId.make(`thread-${index}`),
  environmentId: EnvironmentId.make("local"),
}));

describe("project settled shelves", () => {
  it("keeps each project's history collapsed and counts it without rendering", () => {
    expect(projectSettledPage(rows, undefined, null, 2)).toMatchObject({
      expanded: false,
      total: 6,
      visible: [],
      hidden: 6,
    });
    expect(projectSettledPage(rows, { expanded: true, limit: 2 }, null, 2).visible).toEqual(
      rows.slice(0, 2),
    );
  });
  it("shows a deep-linked settled thread without loading the entire tail", () => {
    const page = projectSettledPage(rows, undefined, "local:thread-5", 2);
    expect(page.expanded).toBe(true);
    expect(page.visible).toEqual([rows[0], rows[1], rows[5]]);
    expect(page.hidden).toBe(3);
  });
  it("respects a deliberate collapse and distinguishes environments", () => {
    expect(
      projectSettledPage(rows, { expanded: false, limit: 2 }, "local:thread-5", 2).visible,
    ).toEqual([]);
    expect(projectSettledPage(rows, undefined, "remote:thread-5", 2).expanded).toBe(false);
  });
});

describe("older settled threads in segment and nested project shelves", () => {
  const shelf = { expanded: true, listed: 3, limit: 10, unloaded: 40, canLoad: true };

  it("counts threads the shell left out as hidden, so Show more appears", () => {
    const page = withUnloadedSettled(
      projectSettledPage(rows, { expanded: true, limit: 6 }, null, 2),
      4,
    );
    expect(page).toMatchObject({ total: 10, hidden: 4 });
    expect(page.visible).toHaveLength(6);
  });

  it("reads older pages only for an open shelf that lists fewer rows than it shows", () => {
    expect(partSettledShelfShort([shelf])).toBe(true);
    expect(partSettledShelfShort([{ ...shelf, expanded: false }])).toBe(false);
    expect(partSettledShelfShort([{ ...shelf, listed: 10 }])).toBe(false);
    expect(partSettledShelfShort([{ ...shelf, unloaded: 0 }])).toBe(false);
    // No environment in scope can read more (all read, or the last read failed).
    expect(partSettledShelfShort([{ ...shelf, canLoad: false }])).toBe(false);
    expect(partSettledShelfShort([{ ...shelf, listed: 10 }, shelf])).toBe(true);
  });

  it("scopes a nested project to its members per environment", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    expect(
      projectOlderSettledScopes([
        { environmentId: local, projectId: ProjectId.make("a") },
        { environmentId: remote, projectId: ProjectId.make("b") },
        { environmentId: local, projectId: ProjectId.make("c") },
      ]),
    ).toEqual([
      { environmentId: local, projectIds: ["a", "c"] },
      { environmentId: remote, projectIds: ["b"] },
    ]);
  });
});
