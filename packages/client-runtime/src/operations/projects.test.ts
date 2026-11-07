import { SourceControlProviderKind } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import { AppId, EnvironmentId, ProjectId, CommandId } from "@lecturn/contracts";

import {
  ADD_PROJECT_STAVE_SOURCES,
  availableAddProjectStaveSources,
  addProjectStaveSourceDescription,
  addProjectStaveSourceLabel,
  buildProjectCreateCommand,
  isAddProjectStaveSource,
  findExistingAddProject,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  normalizePastedCloneUrl,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  nurozen/lecturn  ")).toBe(
      "https://github.com/nurozen/lecturn.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });

  it("never resolves an added folder to an app project on the same path", () => {
    const env = EnvironmentId.make("env");
    const base = {
      environmentId: env,
      workspaceRoot: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
    };
    const app: EnvironmentProject = {
      ...base,
      id: ProjectId.make("app-project"),
      title: "Rocket",
      appBinding: { appId: AppId.make("dev.example.rocket"), workspaceRoot: "/repo" },
    };
    const normal: EnvironmentProject = { ...base, id: ProjectId.make("project"), title: "Repo" };

    expect(findExistingAddProject({ projects: [app], environmentId: env, path: "/repo" })).toBe(
      null,
    );
    expect(
      findExistingAddProject({ projects: [app, normal], environmentId: env, path: "/repo" })?.id,
    ).toBe("project");
  });

  it("lets a Stave-created project keep its manifest id and existing root", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/work/demo",
        title: "demo-space",
        createWorkspaceRootIfMissing: false,
      }),
    ).toMatchObject({
      title: "demo-space",
      workspaceRoot: "/work/demo",
      createWorkspaceRootIfMissing: false,
    });
  });

  it("keeps the Stave sources apart from the remote sources", () => {
    expect(ADD_PROJECT_STAVE_SOURCES).toEqual(["stave-space", "stave-saga"]);
    expect(isAddProjectStaveSource("stave-space")).toBe(true);
    expect(isAddProjectStaveSource("stave-saga")).toBe(true);
    expect(isAddProjectStaveSource("url")).toBe(false);
    expect(isAddProjectStaveSource(SourceControlProviderKind.make("github"))).toBe(false);
    expect(addProjectStaveSourceLabel("stave-space")).toBe("New Stave space");
    expect(addProjectStaveSourceLabel("stave-saga")).toBe("New Stave saga");
    expect(addProjectStaveSourceDescription("stave-space")).toContain("space");
    expect(addProjectStaveSourceDescription("stave-saga")).toContain("saga");
  });

  it("offers Stave sources only behind the gate and drops unsupported creates", () => {
    expect(availableAddProjectStaveSources({ available: false })).toEqual([]);
    expect(availableAddProjectStaveSources({ available: true })).toEqual([
      "stave-space",
      "stave-saga",
    ]);
    expect(
      availableAddProjectStaveSources({ available: true, unsupportedOperations: ["createSaga"] }),
    ).toEqual(["stave-space"]);
    expect(
      availableAddProjectStaveSources({
        available: true,
        unsupportedOperations: ["createSpace", "createSaga"],
      }),
    ).toEqual([]);
  });
});
