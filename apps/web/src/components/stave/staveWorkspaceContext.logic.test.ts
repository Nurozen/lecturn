import type { StaveProjectInfo } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeStaveWorkspace } from "./staveWorkspaceContext.logic";

const stave: StaveProjectInfo = {
  spaceId: "feature",
  isSaga: false,
  memories: [],
  repos: [
    { name: "api", path: "./api", mode: "edit" },
    { name: "web", path: "web", mode: "edit" },
    { name: "docs", path: "references/docs", mode: "reference" },
  ],
  primaryRepoPath: "/work/feature/web",
  primaryBranch: "stave/feature/web",
};

describe("describeStaveWorkspace", () => {
  it("leaves ordinary and unloaded projects on their existing display path", () => {
    expect(describeStaveWorkspace(null)).toBeNull();
    expect(describeStaveWorkspace(undefined)).toBeNull();
    expect(describeStaveWorkspace({ workspaceRoot: "/work/repo" })).toBeNull();
    expect(describeStaveWorkspace({ workspaceRoot: "/work/repo", stave: null })).toBeNull();
  });

  it("describes all editable repos while identifying the actual primary Git target", () => {
    const context = describeStaveWorkspace({ workspaceRoot: "/work/feature", stave });
    expect(context?.label).toBe("Stave space · 2 editable repos");
    expect(context?.editableRepos.map((repo) => repo.name)).toEqual(["api", "web"]);
    expect(context?.referenceRepos.map((repo) => repo.name)).toEqual(["docs"]);
    expect(context?.primaryRepoName).toBe("web");
    expect(context?.primaryRepoPath).toBe("/work/feature/web");
    expect(context?.workspaceRoot).toBe("/work/feature");
    expect(context?.title).toBe(
      "Workspace: /work/feature\nEditable repos: api, web\nReferences: docs\nGit targets: api, web",
    );
  });

  it("resolves relative and absolute manifest paths without mistaking a reference for the primary", () => {
    expect(
      describeStaveWorkspace({
        workspaceRoot: "/work/feature",
        stave: { ...stave, primaryRepoPath: "/work/feature/api" },
      })?.primaryRepoName,
    ).toBe("api");
    expect(
      describeStaveWorkspace({
        workspaceRoot: "/work/feature",
        stave: {
          ...stave,
          repos: [{ name: "api", path: "/work/feature/api", mode: "edit" }],
          primaryRepoPath: "/work/feature/api",
        },
      })?.primaryRepoName,
    ).toBe("api");
    expect(
      describeStaveWorkspace({
        workspaceRoot: "/work/feature",
        stave: { ...stave, primaryRepoPath: "/work/feature/references/docs" },
      })?.primaryRepoName,
    ).toBeNull();
  });

  it("matches Windows primary paths with mixed separators and case", () => {
    const context = describeStaveWorkspace({
      workspaceRoot: "C:\\Work\\Feature",
      stave: { ...stave, primaryRepoPath: "c:/work/feature/API" },
    });
    expect(context?.primaryRepoName).toBe("api");
  });

  it("distinguishes a saga and uses singular editable repo wording", () => {
    const context = describeStaveWorkspace({
      workspaceRoot: "/work/feature",
      stave: { ...stave, isSaga: true, repos: [{ name: "api", path: "api", mode: "edit" }] },
    });
    expect(context?.label).toBe("Stave saga · 1 editable repo");
    expect(
      describeStaveWorkspace({
        workspaceRoot: "/work/feature/",
        stave: { ...stave, kind: "saga" },
      }),
    ).toMatchObject({ label: "Stave saga · 2 editable repos", primaryRepoName: "web" });
  });

  it("keeps reference-only and empty spaces accurate without inventing a Git target", () => {
    const base = { spaceId: "context", isSaga: false, memories: [] };
    const context = describeStaveWorkspace({
      workspaceRoot: "/work/context",
      stave: { ...base, repos: [{ name: "docs", path: "references/docs", mode: "reference" }] },
    });
    expect(context?.label).toBe("Stave space · 1 reference");
    expect(context?.primaryRepoName).toBeNull();
    expect(context?.title).toContain("Editable repos: None");
    expect(context?.title).toContain("Git targets: None");
    expect(context?.primaryRepoPath).toBeNull();
    expect(
      describeStaveWorkspace({ workspaceRoot: "/work/context", stave: { ...base, repos: [] } })
        ?.label,
    ).toBe("Stave space");
  });

  it("does not guess the first repo when the primary is missing or unknown", () => {
    const { primaryRepoPath: _path, ...withoutPrimary } = stave;
    expect(
      describeStaveWorkspace({ workspaceRoot: "/work/feature", stave: withoutPrimary })
        ?.primaryRepoName,
    ).toBeNull();
    const context = describeStaveWorkspace({
      workspaceRoot: "/work/feature",
      stave: { ...stave, primaryRepoPath: "/work/feature/unknown" },
    });
    expect(context?.primaryRepoName).toBeNull();
    expect(context?.title).toContain("Git targets: api, web");
    expect(context?.primaryRepoPath).toBe("/work/feature/unknown");
  });
});
