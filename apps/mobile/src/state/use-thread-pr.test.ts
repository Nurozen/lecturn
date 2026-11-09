import { ProjectId, type ThreadPullRequestLink, type VcsStatusResult } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  presentThreadGitStatusPr,
  presentThreadLinkedPullRequests,
  rememberBounded,
  resolveThreadPrSource,
  resolveThreadPullRequestRef,
} from "./thread-pr-presentation";

const pullRequest: NonNullable<VcsStatusResult["pr"]> = {
  number: 3774,
  title: "Desktop-style pull request indicator",
  url: "https://github.com/nurozen/lecturn/pull/3774",
  baseRef: "main",
  headRef: "codex/desktop-style-pr-indicator",
  state: "merged",
};

describe("inferred thread pull requests", () => {
  const status = { refName: "new-live-branch", pr: pullRequest };
  it("follows a single-edit Stave checkout's current branch after a branch switch", () => {
    expect(presentThreadGitStatusPr(status, undefined)).toMatchObject({ number: 3774 });
    expect(presentThreadGitStatusPr(null, undefined)).toBeUndefined();
  });

  it("still requires the ordinary thread branch to match and suppresses ambiguous spaces", () => {
    expect(presentThreadGitStatusPr(status, "stale-manifest-branch")).toBeNull();
    expect(presentThreadGitStatusPr(status, "new-live-branch")).toMatchObject({ number: 3774 });
    expect(presentThreadGitStatusPr(status, null)).toBeNull();
    expect(
      presentThreadGitStatusPr({ refName: "new-live-branch", pr: null }, undefined),
    ).toBeNull();
  });
});

describe("server-provided thread pull requests", () => {
  const branchPullRequest = {
    projectId: ProjectId.make("project-1"),
    repository: "team/repo",
    host: "gitlab.example.com",
    number: 42,
    url: "https://gitlab.example.com/team/repo/-/merge_requests/42",
  };
  const linkedPullRequest = { ...branchPullRequest, number: 43 };
  const project = {
    workspaceRoot: "/spaces/lecturn",
    stave: {
      spaceId: "lecturn",
      isSaga: false,
      repos: [{ name: "app", path: "app", mode: "edit" as const }],
      memories: [],
    },
  };

  it("uses a server PR with its host before the project shell loads", () => {
    expect(resolveThreadPullRequestRef({ branchPullRequest }, null)).toEqual(branchPullRequest);
    expect(resolveThreadPullRequestRef({}, null)).toBeNull();
    expect(resolveThreadPullRequestRef({ branchPullRequest: null }, null)).toBeNull();
  });

  it("uses the explicit linked PR ahead of the branch PR", () => {
    expect(resolveThreadPullRequestRef({ linkedPullRequest, branchPullRequest }, project)).toEqual(
      linkedPullRequest,
    );
  });

  it("allows a single editable Stave repo alongside reference repos", () => {
    expect(
      resolveThreadPullRequestRef(
        { branchPullRequest },
        {
          ...project,
          stave: {
            ...project.stave,
            repos: [...project.stave.repos, { name: "docs", path: "docs", mode: "reference" }],
          },
        },
      ),
    ).toEqual(branchPullRequest);
  });

  it("clears inferred PRs for ambiguous and reference-only spaces but keeps explicit links", () => {
    for (const repos of [
      [],
      [{ name: "docs", path: "docs", mode: "reference" as const }],
      [...project.stave.repos, { name: "api", path: "api", mode: "edit" as const }],
    ]) {
      const ambiguous = { ...project, stave: { ...project.stave, repos } };
      expect(resolveThreadPullRequestRef({ branchPullRequest }, ambiguous)).toBeNull();
      expect(
        resolveThreadPullRequestRef({ linkedPullRequest, branchPullRequest }, ambiguous),
      ).toEqual(linkedPullRequest);
    }
  });
});

function linkedPr(
  number: number,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "nurozen/lecturn",
    number,
    url: `https://github.com/nurozen/lecturn/pull/${number}`,
    source: "manual",
    linkedAt: "2026-09-08T00:00:00.000Z",
    stack: null,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch: `change-${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-09-08T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("presentThreadLinkedPullRequests", () => {
  it("uses the top of a derived stack even when its bottom was linked later", () => {
    const bottom = linkedPr(1, { linkedAt: "2026-09-09T00:00:00.000Z" });
    const top = linkedPr(2);
    expect(
      presentThreadLinkedPullRequests([
        bottom,
        {
          ...top,
          snapshot: { ...top.snapshot!, baseBranch: "change-1" },
        },
      ]),
    ).toMatchObject({ kind: "stack", label: "2", number: 2, url: top.url });
  });

  it("names a single link with its host's term", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(7)])?.accessibilityLabel).toBe(
      "#7 pull request open",
    );
    expect(
      presentThreadLinkedPullRequests([
        linkedPr(7, {
          host: "gitlab.com",
          repository: "nurozen/lecturn",
          url: "https://gitlab.com/nurozen/lecturn/-/merge_requests/7",
        }),
      ])?.accessibilityLabel,
    ).toBe("#7 merge request open");
  });
});

describe("resolveThreadPrSource compatibility", () => {
  const legacyRef = {
    projectId: ProjectId.make("project"),
    repository: "nurozen/lecturn",
    number: 1,
    url: "https://github.com/nurozen/lecturn/pull/1",
  };
  const branchRef = { ...legacyRef, number: 2, url: "https://github.com/nurozen/lecturn/pull/2" };

  it("polls the stored reference before the server config loads", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        false,
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("uses snapshots without polling once the server config loads", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        true,
      ),
    ).toMatchObject({ linkedPresentation: { number: 3 }, pullRequestRef: null });
  });

  it("does not revive a removed modern link from the compatibility reference", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        true,
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: branchRef });
  });

  it("does not poll when a modern link is waiting for its first snapshot", () => {
    expect(
      resolveThreadPrSource(
        {
          pullRequests: [linkedPr(3, { snapshot: null })],
          linkedPullRequest: legacyRef,
          branchPullRequest: branchRef,
        },
        true,
      ),
    ).toMatchObject({ linkedPresentation: { number: 3, state: null }, pullRequestRef: null });
  });

  it("suppresses the inferred branch PR for multi-repo Stave spaces in both modes", () => {
    const ambiguous = {
      workspaceRoot: "/spaces/lecturn",
      stave: {
        spaceId: "lecturn",
        isSaga: false,
        repos: [
          { name: "app", path: "app", mode: "edit" as const },
          { name: "api", path: "api", mode: "edit" as const },
        ],
        memories: [],
      },
    };
    expect(
      resolveThreadPrSource({ pullRequests: [], branchPullRequest: branchRef }, true, ambiguous),
    ).toEqual({ linkedPresentation: null, pullRequestRef: null });
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        false,
        ambiguous,
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });
});

describe("rememberBounded", () => {
  it("moves a re-answered entry to the newest slot and evicts the oldest past the limit", () => {
    let snapshots: ReadonlyMap<string, number> = new Map();
    snapshots = rememberBounded(snapshots, "a", 1, 2);
    snapshots = rememberBounded(snapshots, "b", 2, 2);
    snapshots = rememberBounded(snapshots, "a", 3, 2);
    snapshots = rememberBounded(snapshots, "c", 4, 2);
    expect([...snapshots]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
  });
});
