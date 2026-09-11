import type { VcsStatusResult } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadPr, presentThreadGitStatusPr } from "./thread-pr-presentation";

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
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      }),
    ).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 merge request merged",
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
