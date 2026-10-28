import { describe, expect, it } from "vite-plus/test";
import { sidebarScopeRowModel } from "./SidebarScopeRow.logic";

describe("sidebar scope row", () => {
  it("labels the unscoped row with the mode's all-scope name", () => {
    expect(sidebarScopeRowModel({ kind: "projects", selectedLabel: null })).toEqual({
      label: "All projects",
      triggerLabel: "Filter threads by project",
      addLabel: "Add project",
    });
    expect(sidebarScopeRowModel({ kind: "apps", selectedLabel: null })).toEqual({
      label: "All apps",
      triggerLabel: "Filter threads by app",
      addLabel: "Add app",
    });
  });

  it("names the selected scope in both the visible and accessible labels", () => {
    expect(sidebarScopeRowModel({ kind: "projects", selectedLabel: "nurozen" })).toMatchObject({
      label: "nurozen",
      triggerLabel: "Filter threads by project: nurozen",
    });
    expect(sidebarScopeRowModel({ kind: "apps", selectedLabel: "RocketWright" })).toMatchObject({
      label: "RocketWright",
      triggerLabel: "Filter threads by app: RocketWright",
    });
  });

  it("never reads as unscoped when the selected scope has a blank name", () => {
    expect(sidebarScopeRowModel({ kind: "projects", selectedLabel: "   " })).toMatchObject({
      label: "Untitled project",
      triggerLabel: "Filter threads by project: Untitled project",
    });
  });

  it("trims the selected name so the row and its accessible name agree", () => {
    expect(sidebarScopeRowModel({ kind: "apps", selectedLabel: " RocketWright " })).toMatchObject({
      label: "RocketWright",
      triggerLabel: "Filter threads by app: RocketWright",
    });
  });
});
