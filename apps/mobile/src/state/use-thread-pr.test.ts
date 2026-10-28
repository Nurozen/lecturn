import { SourceControlProviderKind } from "@lecturn/contracts";
import { ProjectId, type ThreadPullRequestLink, type VcsStatusResult } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  presentThreadGitStatusPr,
  presentThreadLinkedPullRequests,
  presentThreadPr,
  resolveThreadPrBadgeAction,
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

describe("presentThreadPr", () => {
  it("uses the compact pull request number label without a hash prefix", () => {
    expect(presentThreadPr(pullRequest, undefined)).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 pull request merged",
      textClassName: "text-adaptive-violet-600-400",
    });
  });

  it("uses merge-request terminology for GitLab", () => {
    expect(
      presentThreadPr(pullRequest, {
        kind: SourceControlProviderKind.make("gitlab"),
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      }),
    ).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 merge request merged",
    });
  });

  it("uses gray for draft pull requests", () => {
    expect(
      presentThreadPr({ ...pullRequest, state: "open", isDraft: true }, undefined),
    ).toMatchObject({
      accessibilityLabel: "#3774 pull request draft",
      textClassName: "text-foreground-muted",
    });
  });
});

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
  it("renders unsynced links with neutral pending status", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(1, { snapshot: null })])).toMatchObject({
      number: 1,
      label: "1",
      state: null,
      textClassName: "text-foreground-muted",
      accessibilityLabel: "#1 pull request status pending",
    });
  });

  it("counts unrelated links without labelling them a stack", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(1), linkedPr(2)])).toMatchObject({
      kind: "pull-request",
      label: "+2",
      others: 1,
      state: "open",
      isDraft: false,
      textClassName: "text-adaptive-emerald-600-400",
    });
  });

  it.each([
    ["closed", false, "closed", false, "closed", false, "text-adaptive-rose-600-400"],
    ["open", true, "open", true, "open", true, "text-foreground-muted"],
    ["open", true, "open", false, "open", false, "text-adaptive-emerald-600-400"],
    ["closed", false, "open", false, "open", false, "text-adaptive-emerald-600-400"],
    ["merged", false, "merged", false, "merged", false, "text-adaptive-violet-600-400"],
    ["closed", false, "merged", false, "closed", false, "text-adaptive-rose-600-400"],
  ] as const)(
    "colors linked %s (draft %s) and %s (draft %s) by their aggregate state",
    (firstState, firstDraft, secondState, secondDraft, state, isDraft, textClassName) => {
      const first = linkedPr(1);
      const second = linkedPr(2);
      expect(
        presentThreadLinkedPullRequests([
          { ...first, snapshot: { ...first.snapshot!, state: firstState, isDraft: firstDraft } },
          {
            ...second,
            snapshot: { ...second.snapshot!, state: secondState, isDraft: secondDraft },
          },
        ]),
      ).toMatchObject({
        label: "+2",
        state,
        isDraft,
        textClassName,
        accessibilityLabel: `2 linked pull requests, overall ${isDraft ? "draft" : state}`,
      });
    },
  );

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

  it("hides dismissed stack members", () => {
    expect(
      presentThreadLinkedPullRequests([linkedPr(1, { source: "stack-dismissed" })]),
    ).toBeNull();
  });

  it("retains merged state from the persisted snapshot", () => {
    const link = linkedPr(1);
    expect(
      presentThreadLinkedPullRequests([
        { ...link, snapshot: { ...link.snapshot!, state: "merged" } },
      ]),
    ).toMatchObject({ state: "merged", textClassName: "text-adaptive-violet-600-400" });
  });
});

describe("resolveThreadPrBadgeAction", () => {
  it("opens a single linked or branch pull request directly", () => {
    expect(resolveThreadPrBadgeAction(presentThreadLinkedPullRequests([linkedPr(1)])!)).toEqual({
      kind: "open",
      accessibilityLabel: "Open #1 pull request open",
    });
    expect(resolveThreadPrBadgeAction(presentThreadPr(pullRequest, null))).toMatchObject({
      kind: "open",
    });
  });

  it("lists unrelated linked pull requests", () => {
    expect(
      resolveThreadPrBadgeAction(presentThreadLinkedPullRequests([linkedPr(1), linkedPr(2)])!),
    ).toEqual({
      kind: "list",
      accessibilityLabel: "Show 2 linked pull requests, overall open",
    });
  });

  it("lists a stack even though the badge shows its top pull request", () => {
    const top = linkedPr(2);
    const stack = presentThreadLinkedPullRequests([
      linkedPr(1),
      { ...top, snapshot: { ...top.snapshot!, baseBranch: "change-1" } },
    ])!;
    expect(resolveThreadPrBadgeAction(stack)).toMatchObject({ kind: "list" });
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

  it("polls the legacy reference when only the older linking capability exists", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("keeps the legacy reference for a server without either capability", () => {
    expect(resolveThreadPrSource({ pullRequests: [], linkedPullRequest: legacyRef }, {})).toEqual({
      linkedPresentation: null,
      pullRequestRef: legacyRef,
    });
  });

  it("ignores stale snapshots after reconnecting to a server without array support", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef },
        { threadPullRequestLinking: true, threadPullRequests: false },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("uses snapshots without polling when both capabilities are advertised", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true, threadPullRequests: true },
      ),
    ).toMatchObject({ linkedPresentation: { number: 3 }, pullRequestRef: null });
  });

  it("does not revive a removed modern link from the compatibility reference", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequests: true },
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
        { threadPullRequests: true },
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
      resolveThreadPrSource(
        { pullRequests: [], branchPullRequest: branchRef },
        { threadPullRequests: true },
        ambiguous,
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: null });
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true },
        ambiguous,
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });
});
