import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { projectSettledPage } from "./sidebarSettledGroups";

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
