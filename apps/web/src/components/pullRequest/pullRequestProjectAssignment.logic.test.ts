import type { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignProjectsToEnvironments,
  projectPullRequestRepository,
  resolvePickableEnvironments,
  type AssignableProject,
} from "./pullRequestProjectAssignment.logic";

const project = (
  id: string,
  environmentId: string,
  canonicalKey?: string,
): AssignableProject & { workspaceRoot: string } => ({
  id: id as ProjectId,
  environmentId: environmentId as EnvironmentId,
  repositoryIdentity: canonicalKey === undefined ? null : { canonicalKey },
  workspaceRoot: `/srv/${environmentId}/${id}`,
});

const envs = (...ids: ReadonlyArray<string>) => ids as ReadonlyArray<EnvironmentId>;

const plain = (assignment: Map<EnvironmentId, ProjectId[]>) =>
  Object.fromEntries([...assignment].map(([id, projectIds]) => [id, projectIds]));

describe("one server per repository", () => {
  it("lets the first server list a repository both hold", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("b1", "env-1", "github.com/acme/tools"),
        project("a2", "env-2", "github.com/acme/app"),
        project("c2", "env-2", "github.com/acme/site"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1", "b1"], "env-2": ["c2"] });
  });

  it("prefers the named server over the first one", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-2" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-2": ["a2"] });
  });

  it("drops a server with nothing of its own", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(assignment.has("env-2" as EnvironmentId)).toBe(false);
  });

  it("keeps every copy of a project that has no identity to compare", () => {
    const assignment = assignProjectsToEnvironments(
      [project("p1", "env-1"), project("p2", "env-2")],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["p1"], "env-2": ["p2"] });
  });

  it("keeps a repository listed by the one server that holds it", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("b2", "env-2", "gitlab.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1"], "env-2": ["b2"] });
  });

  it("keeps a server's own worktrees of the repository it lists", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a1-wt", "env-1", "GitHub.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1", "a1-wt"] });
  });

  it("reads two servers' copies of one repository as one however the remote is cased", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "git.example.com/Team/App"),
        project("a2", "env-2", "GIT.example.com/team/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1"] });
  });

  it("ignores a project on a server that is not being read", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-2"),
      "env-2" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-2": ["a2"] });
  });

  it("answers the same whatever order the projects arrive in", () => {
    const projects = [
      project("a2", "env-2", "github.com/acme/app"),
      project("a1", "env-1", "github.com/acme/app"),
    ];
    const forward = assignProjectsToEnvironments(projects, envs("env-1", "env-2"), null);
    const backward = assignProjectsToEnvironments(
      projects.toReversed(),
      envs("env-1", "env-2"),
      null,
    );
    expect(plain(forward)).toEqual({ "env-1": ["a1"] });
    expect(plain(backward)).toEqual(plain(forward));
  });
});

const connected = (...ids: ReadonlyArray<string>) =>
  ids.map((id) => ({ environmentId: id as EnvironmentId, label: `Server ${id}` }));

const on = (environmentId: string, projectId: string) => ({
  environmentId: environmentId as EnvironmentId,
  projectId: projectId as ProjectId,
});

describe("where a pull request can be acted on", () => {
  it("offers every server holding the repository, the panel's own first", () => {
    const pickable = resolvePickableEnvironments(
      on("env-2", "a2"),
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
        project("c3", "env-3", "github.com/acme/site"),
      ],
      connected("env-1", "env-2", "env-3"),
    );
    expect(pickable).toEqual([
      {
        environmentId: "env-2",
        projectId: "a2",
        workspaceRoot: "/srv/env-2/a2",
        label: "Server env-2",
      },
      {
        environmentId: "env-1",
        projectId: "a1",
        workspaceRoot: "/srv/env-1/a1",
        label: "Server env-1",
      },
    ]);
  });

  it("matches copies however the remote is cased", () => {
    const pickable = resolvePickableEnvironments(
      on("env-1", "a1"),
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "GitHub.com/ACME/app"),
      ],
      connected("env-1", "env-2"),
    );
    expect(pickable.map((entry) => entry.environmentId)).toEqual(["env-1", "env-2"]);
  });

  it("offers nothing where one server holds the repository", () => {
    expect(
      resolvePickableEnvironments(
        on("env-1", "a1"),
        [
          project("a1", "env-1", "github.com/acme/app"),
          project("c2", "env-2", "github.com/acme/site"),
        ],
        connected("env-1", "env-2"),
      ),
    ).toEqual([]);
  });

  it("offers nothing for a project with no identity to compare", () => {
    expect(
      resolvePickableEnvironments(
        on("env-1", "p1"),
        [project("p1", "env-1"), project("p2", "env-2")],
        connected("env-1", "env-2"),
      ),
    ).toEqual([]);
  });

  it("offers nothing while the projects are still arriving", () => {
    expect(resolvePickableEnvironments(on("env-1", "a1"), [], connected("env-1", "env-2"))).toEqual(
      [],
    );
  });

  it("leaves out a server that is not connected", () => {
    expect(
      resolvePickableEnvironments(
        on("env-1", "a1"),
        [
          project("a1", "env-1", "github.com/acme/app"),
          project("a2", "env-2", "github.com/acme/app"),
        ],
        connected("env-1"),
      ),
    ).toEqual([]);
  });

  it("names one copy per server, so two worktrees are one choice", () => {
    const pickable = resolvePickableEnvironments(
      on("env-1", "a1"),
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a1-wt", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
        project("a2-wt", "env-2", "github.com/acme/app"),
      ],
      connected("env-1", "env-2"),
    );
    expect(pickable.map((entry) => entry.projectId)).toEqual(["a1", "a2"]);
  });

  it("keeps the panel's own worktree rather than the server's first copy", () => {
    const pickable = resolvePickableEnvironments(
      on("env-1", "a1-wt"),
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a1-wt", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      connected("env-1", "env-2"),
    );
    expect(pickable[0]).toEqual({
      environmentId: "env-1",
      projectId: "a1-wt",
      workspaceRoot: "/srv/env-1/a1-wt",
      label: "Server env-1",
    });
  });
});

describe("spaces with several repositories", () => {
  const identity = (host: string, name: string) => ({
    canonicalKey: `${host}/acme/${name}`,
    provider: "github",
    owner: "acme",
    name,
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: `https://${host}/acme/${name}.git`,
    },
  });
  const space = (
    id: string,
    env: string,
    repos: ReadonlyArray<{ host: string; name: string; mode?: "edit" | "reference" }>,
  ): AssignableProject & { workspaceRoot: string } => ({
    ...project(id, env, `${repos[0]?.host}/acme/${repos[0]?.name}`),
    stave: {
      spaceId: id,
      isSaga: false,
      memories: [],
      repos: repos.map((repo, index) => ({
        name: repo.name,
        path: `nested/${index}/${repo.name}`,
        mode: repo.mode ?? "edit",
        repositoryIdentity: identity(repo.host, repo.name),
      })),
    },
  });
  it("does not lose a space's other repository when another environment holds its primary", () => {
    const a = space("space-a", "env-1", [
      { host: "github.com", name: "app" },
      { host: "github.com", name: "api" },
    ]);
    const b = space("space-b", "env-2", [
      { host: "github.com", name: "app" },
      { host: "github.com", name: "docs" },
    ]);
    expect(plain(assignProjectsToEnvironments([a, b], envs("env-1", "env-2")))).toEqual({
      "env-1": ["space-a"],
      "env-2": ["space-b"],
    });
  });
  it("matches a secondary nested checkout and host when choosing an action environment", () => {
    const a = space("space-a", "env-1", [
      { host: "github.com", name: "web" },
      { host: "github.acme.dev", name: "api" },
    ]);
    const wrongHost = space("space-b", "env-2", [{ host: "github.com", name: "api" }]);
    const b = space("space-c", "env-2", [{ host: "github.acme.dev", name: "api" }]);
    const copies = resolvePickableEnvironments(
      {
        environmentId: a.environmentId,
        projectId: a.id,
        repository: "acme/api",
        host: "github.acme.dev",
      },
      [a, wrongHost, b],
      envs("env-1", "env-2").map((environmentId) => ({ environmentId, label: environmentId })),
    );
    expect(copies.map(({ projectId, workspaceRoot }) => ({ projectId, workspaceRoot }))).toEqual([
      { projectId: "space-a", workspaceRoot: "/srv/env-1/space-a/nested/1/api" },
      { projectId: "space-c", workspaceRoot: "/srv/env-2/space-c/nested/0/api" },
    ]);
  });
  it("refuses an ambiguous hostless link and excludes reference checkouts", () => {
    const a = space("space", "env-1", [
      { host: "github.com", name: "api" },
      { host: "github.acme.dev", name: "api" },
      { host: "github.com", name: "docs", mode: "reference" },
    ]);
    expect(projectPullRequestRepository(a, { repository: "acme/api" })).toBeUndefined();
    expect(
      projectPullRequestRepository(a, { repository: "acme/docs", host: "github.com" }),
    ).toBeUndefined();
    expect(
      projectPullRequestRepository(a, { repository: "acme/api", host: "GITHUB.ACME.DEV" })
        ?.workspaceRoot,
    ).toBe("/srv/env-1/space/nested/1/api");
  });
});

describe("provider-native PR checkout selection", () => {
  it.each([
    {
      provider: "gitlab",
      host: "gitlab.com",
      displayName: "acme/platform/api",
      repository: "acme/platform/api",
    },
    {
      provider: "azure-devops",
      host: "dev.azure.com",
      displayName: "acme/platform/_git/api",
      repository: "acme/platform/_git/api",
    },
  ])(
    "routes $provider PR refs to the nested manifest checkout",
    ({ provider, host, displayName, repository }) => {
      const workspace = {
        ...project("space", "env-1"),
        stave: {
          spaceId: "space",
          isSaga: false,
          memories: [],
          repos: [
            {
              name: "api",
              path: "nested/api",
              mode: "edit" as const,
              repositoryIdentity: {
                provider,
                canonicalKey: `${host}/${displayName}`,
                displayName,
                owner: "acme",
                name: "api",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://${host}/${displayName}.git`,
                },
              },
            },
          ],
        },
      };
      expect(projectPullRequestRepository(workspace, { repository, host })?.workspaceRoot).toBe(
        "/srv/env-1/space/nested/api",
      );
      expect(
        projectPullRequestRepository(workspace, { repository: "acme/api", host }),
      ).toBeUndefined();
    },
  );
});
