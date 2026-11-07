import { describe, expect, it } from "vite-plus/test";

import { findChangeRequestTarget } from "@lecturn/client-runtime/change-request-links";
import { sourceControlClients } from "@lecturn/client-runtime/source-control-clients";
import { type RepositoryIdentity, SourceControlProviderKind } from "@lecturn/contracts";

import { findProjectOnChangeRequestHost } from "./openPullRequestLink";

function parseChangeRequestUrl(url: string) {
  const parsed = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (parsed === undefined) return null;
  const { repositoryUrl: _repositoryUrl, ...link } = parsed;
  return link;
}

describe("parseChangeRequestUrl", () => {
  it("reads a GitHub pull request", () => {
    expect(parseChangeRequestUrl("https://github.com/Nurozen/Lecturn/pull/123")).toEqual({
      host: "github.com",
      repository: "nurozen/lecturn",
      number: 123,
    });
  });

  it("reads a pull request on a GitHub Enterprise host", () => {
    expect(parseChangeRequestUrl("https://github.acme.test/platform/api/pull/7")).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 7,
    });
  });

  it("reads a GitLab merge request, nested groups and all", () => {
    expect(
      parseChangeRequestUrl("https://gitlab.com/nurozen/platform/lecturn/-/merge_requests/42"),
    ).toEqual({
      host: "gitlab.com",
      repository: "nurozen/platform/lecturn",
      number: 42,
    });
  });

  it("reads a merge request on a self-hosted GitLab named nothing like GitLab", () => {
    expect(parseChangeRequestUrl("https://code.acme.test/team/project/-/merge_requests/9")).toEqual(
      {
        host: "code.acme.test",
        repository: "team/project",
        number: 9,
      },
    );
  });

  it("reads a Bitbucket pull request", () => {
    expect(parseChangeRequestUrl("https://bitbucket.org/workspace/repo/pull-requests/5")).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
    });
  });

  it("reads both Azure DevOps URL forms, keeping `_git` in the repository path", () => {
    expect(
      parseChangeRequestUrl("https://dev.azure.com/acme/platform/_git/lecturn/pullrequest/17"),
    ).toEqual({
      host: "dev.azure.com",
      repository: "acme/platform/_git/lecturn",
      number: 17,
    });
    expect(
      parseChangeRequestUrl("https://acme.visualstudio.com/platform/_git/lecturn/pullrequest/17"),
    ).toEqual({
      host: "acme.visualstudio.com",
      repository: "platform/_git/lecturn",
      number: 17,
    });
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(parseChangeRequestUrl("https://github.com/nurozen/lecturn/pull/123/files?w=1")).toEqual({
      host: "github.com",
      repository: "nurozen/lecturn",
      number: 123,
    });
    expect(
      parseChangeRequestUrl("https://gitlab.com/team/project/-/merge_requests/42/diffs#note_1"),
    ).toEqual({ host: "gitlab.com", repository: "team/project", number: 42 });
    expect(
      parseChangeRequestUrl("https://bitbucket.org/team/repo/pull-requests/5/commits"),
    ).toEqual({ host: "bitbucket.org", repository: "team/repo", number: 5 });
    expect(parseChangeRequestUrl("https://github.com/nurozen/lecturn/pull/123/")).toEqual({
      host: "github.com",
      repository: "nurozen/lecturn",
      number: 123,
    });
  });

  it("claims nothing it cannot be sure of, so the link goes to the browser", () => {
    for (const link of [
      "https://github.com/nurozen/lecturn/issues/123",
      "https://github.com/nurozen/lecturn/commit/0a1b2c3",
      "https://github.com/nurozen/lecturn",
      "https://github.com/nurozen/lecturn/pull/abc",
      "https://gitlab.com/nurozen/lecturn/-/snippets/12",
      "https://gitlab.com/nurozen/lecturn/-/issues/12",
      // A lookalike is deliberately not fought here: `github.com.evil.test` reads as a GitHub
      // Enterprise install and there is no way to tell it from one. It is `findProjectForChange
      // Request` that refuses it, because no project in the workspace is checked out from it.
      "javascript:alert(1)//github.com/nurozen/lecturn/pull/1",
      "not a url",
    ]) {
      expect(parseChangeRequestUrl(link), link).toBeNull();
    }
  });
});

describe("findProjectOnChangeRequestHost", () => {
  const project = (id: string, identity: Record<string, unknown>) =>
    ({ id, workspaceRoot: `/repos/${id}`, repositoryIdentity: identity }) as never;
  const frontend = project("frontend", {
    canonicalKey: "github.com/acme/frontend",
    provider: "github",
    owner: "acme",
    name: "frontend",
  });
  const backend = project("backend", {
    canonicalKey: "github.com/acme/backend",
    provider: "github",
    owner: "acme",
    name: "backend",
  });

  it("prefers the project checked out from the link's own repository", () => {
    expect(
      findProjectOnChangeRequestHost([frontend, backend], {
        host: "github.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(backend);
  });

  it("lends any project on the host to a repository nobody has checked out", () => {
    expect(
      findProjectOnChangeRequestHost([frontend], {
        host: "github.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(frontend);
  });
});

describe("Stave change request links", () => {
  const remote = (host: string, displayName: string): RepositoryIdentity => ({
    provider: SourceControlProviderKind.make("github"),
    canonicalKey: `${host}/${displayName.toLowerCase()}`,
    displayName,
    owner: displayName.split("/")[0]!,
    name: displayName.split("/").at(-1)!,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://${host}/${displayName}.git`,
    },
  });
  const publicRepo = remote("github.com", "Acme/API");
  const enterpriseRepo = remote("github.acme.test", "Acme/API");
  const space = {
    id: "space",
    workspaceRoot: "/spaces/test",
    repositoryIdentity: publicRepo,
    stave: {
      spaceId: "test",
      kind: "ticket",
      isSaga: false,
      memories: [],
      primaryRepoPath: "/spaces/test/api",
      primaryRepositoryIdentity: publicRepo,
      repos: [
        { name: "api", path: "api", mode: "edit", repositoryIdentity: publicRepo },
        {
          name: "enterprise-api",
          path: "nested/api",
          mode: "edit",
          repositoryIdentity: enterpriseRepo,
        },
        {
          name: "docs",
          path: "references/docs",
          mode: "reference",
          repositoryIdentity: remote("github.com", "Acme/Docs"),
        },
      ],
    },
  } as never;

  it("resolves secondary checkout URLs with host and the remote's own repository spelling", () => {
    expect(
      findChangeRequestTarget([space], {
        host: "github.acme.test",
        repository: "acme/api",
        number: 7,
      }),
    ).toEqual({ project: space, repository: "Acme/API", host: "github.acme.test" });
    expect(
      findChangeRequestTarget([space], {
        host: "github.com",
        repository: "acme/api",
        number: 7,
      }),
    ).toEqual({ project: space, repository: "Acme/API", host: "github.com" });
  });

  it("leaves reference repository PRs as ordinary external links", () => {
    expect(
      findChangeRequestTarget([space], {
        host: "github.com",
        repository: "acme/docs",
        number: 7,
      }),
    ).toBeUndefined();
  });

  it("does not associate an unknown host with the space", () => {
    expect(
      findChangeRequestTarget([space], {
        host: "github.other.test",
        repository: "acme/api",
        number: 7,
      }),
    ).toBeUndefined();
  });
});
