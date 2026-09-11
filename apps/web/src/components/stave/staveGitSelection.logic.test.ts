import { describe, expect, it } from "vite-plus/test";
import { resolveProjectGitTargets } from "@t3tools/client-runtime/state/projectGit";
import { selectStaveGitTarget } from "./staveGitSelection.logic";

describe("Stave Git selection", () => {
  const targets = resolveProjectGitTargets({
    project: {
      workspaceRoot: "/space",
      stave: {
        spaceId: "space",
        kind: "ticket",
        primaryRepoPath: "/space/a",
        primaryBranch: "old-primary",
        isSaga: false,
        memories: [],
        repos: [
          { name: "docs", path: "references/docs", mode: "reference" },
          { name: "a", path: "a", mode: "edit", branch: "a-branch" },
          { name: "b", path: "nested/b", mode: "edit", branch: "b-branch" },
        ],
      },
    },
    includeReferences: true,
  });
  it("starts with an editable checkout even when references come first", () => {
    expect(selectStaveGitTarget(targets)?.cwd).toBe("/space/a");
  });
  it("keeps nested checkout identity and branch together", () => {
    expect(selectStaveGitTarget(targets, "/space/nested/b")).toMatchObject({
      cwd: "/space/nested/b",
      branch: "b-branch",
      repoName: "b",
    });
  });
  it("exposes a selected reference as read only for inspection", () => {
    expect(selectStaveGitTarget(targets, "/space/references/docs")?.mode).toBe("reference");
  });
  it("drops a removed checkout instead of retaining a stale mutation target", () => {
    expect(
      selectStaveGitTarget(
        targets.filter((target) => target.repoName !== "b"),
        "/space/nested/b",
      )?.cwd,
    ).toBe("/space/a");
  });
  it("supports inspecting spaces containing only references", () => {
    expect(
      selectStaveGitTarget(targets.filter((target) => target.mode === "reference"))?.mode,
    ).toBe("reference");
  });
  it("has no Git target after the final repository is removed", () => {
    expect(selectStaveGitTarget([], "/space/a")).toBeNull();
  });
});
