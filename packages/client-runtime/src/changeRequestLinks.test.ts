import {
  EnvironmentId,
  ProjectId,
  type RepositoryIdentity,
  SourceControlProviderKind,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForChangeRequest,
  projectChangeRequestUrl,
  resolvePullRequestPreviewTarget,
} from "./changeRequestLinks.ts";

describe("findProjectForChangeRequest", () => {
  const project = (identity: Record<string, unknown>) =>
    ({ id: "p1", repositoryIdentity: identity }) as never;

  it("matches a nested GitLab group by the whole path below the host", () => {
    const projects = [
      project({
        canonicalKey: "gitlab.com/nurozen/platform/lecturn",
        provider: SourceControlProviderKind.make("gitlab"),
        displayName: "nurozen/platform/lecturn",
        owner: "nurozen",
        name: "lecturn",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "gitlab.com",
        repository: "nurozen/platform/lecturn",
        number: 42,
      }),
    ).toBe(projects[0]);
  });

  it("claims nothing for a lookalike host, which is what keeps a link a link", () => {
    const projects = [
      project({
        canonicalKey: "github.com/Nurozen/lecturn",
        provider: SourceControlProviderKind.make("github"),
        owner: "nurozen",
        name: "lecturn",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "github.com-evil.test",
        repository: "Nurozen/lecturn",
        number: 1,
      }),
    ).toBeUndefined();
  });
});

describe("resolvePullRequestPreviewTarget", () => {
  const environmentId = EnvironmentId.make("env-1");
  const project = {
    id: ProjectId.make("project-1"),
    environmentId,
    repositoryIdentity: {
      canonicalKey: "github.com/acme/web",
      provider: SourceControlProviderKind.make("github"),
      displayName: "acme/web",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/web" },
    } satisfies RepositoryIdentity,
  };

  it("previews a pull request only under the project that holds its repository", () => {
    const target = (url: string) =>
      resolvePullRequestPreviewTarget({
        environmentId,
        projects: [project],
        pullRequestsEnabled: true,
        url,
      });
    expect(target("https://github.com/acme/web/pull/7")).toEqual({
      environmentId,
      input: { projectId: project.id, host: "github.com", repository: "acme/web", number: 7 },
    });
    expect(target("https://github.com/acme/other/pull/7")).toBeNull();
  });
});

describe("projectChangeRequestUrl", () => {
  const identity = (provider: string): RepositoryIdentity => ({
    canonicalKey: "github.com/acme/default",
    provider: SourceControlProviderKind.make(provider),
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/default",
    },
  });

  it("builds the requested repository's URL on the project's host", () => {
    expect(projectChangeRequestUrl(identity("github"), "acme/other", 42)).toBe(
      "https://github.com/acme/other/pull/42",
    );
  });

  it("builds the project's own Azure repository from its full path, not its short selector", () => {
    const azure: RepositoryIdentity = {
      canonicalKey: "dev.azure.com/org/project/_git/web",
      provider: SourceControlProviderKind.make("azure-devops"),
      owner: "org",
      name: "web",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://dev.azure.com/org/project/_git/web",
      },
    };
    expect(projectChangeRequestUrl(azure, "web", 42)).toBe(
      "https://dev.azure.com/org/project/_git/web/pullrequest/42",
    );
  });

  it("builds nothing without a project host that knows its URL shape", () => {
    expect(projectChangeRequestUrl(null, "acme/repository", 1)).toBeNull();
    expect(projectChangeRequestUrl(identity("unknown"), "acme/repository", 1)).toBeNull();
    const { provider: _provider, ...withoutProvider } = identity("github");
    expect(projectChangeRequestUrl(withoutProvider, "acme/repository", 1)).toBeNull();
  });
});
