import { describe, expect, it } from "vite-plus/test";
import { buildReviewSectionItems, buildReviewParsedDiff } from "./reviewModel";
import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";

import {
  countReviewCommentContexts,
  formatReviewCommentContext,
  parseReviewCommentMessageSegments,
  parseReviewInlineComments,
  type ReviewCommentTarget,
} from "./reviewCommentSelection";

function makeTarget(): ReviewCommentTarget {
  return {
    sectionId: "section-1",
    sectionTitle: "Working tree",
    filePath: "apps/demo/src/main.ts",
    startIndex: 0,
    endIndex: 1,
    lines: [
      {
        kind: "line",
        id: "line-1",
        change: "delete",
        oldLineNumber: 7,
        newLineNumber: null,
        content: "const retryLimit = 2;",
        additionTokenIndex: null,
        deletionTokenIndex: 0,
        comparison: null,
      },
      {
        kind: "line",
        id: "line-2",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 7,
        content: "const retryLimit = 4;",
        additionTokenIndex: 0,
        deletionTokenIndex: null,
        comparison: null,
      },
    ],
  };
}

describe("review comment serialization", () => {
  it("preserves enough metadata for inline diff rendering", () => {
    const serialized = formatReviewCommentContext(makeTarget(), "Please keep this configurable.");

    expect(countReviewCommentContexts(serialized)).toBe(1);
    expect(parseReviewInlineComments(serialized)).toEqual([
      expect.objectContaining({
        sectionId: "section-1",
        sectionTitle: "Working tree",
        filePath: "apps/demo/src/main.ts",
        startIndex: 0,
        endIndex: 1,
        text: "Please keep this configurable.",
        diff: expect.stringContaining("-const retryLimit = 2;"),
      }),
    ]);
  });

  it("splits chat text into review comment segments", () => {
    const serialized = `Before\n${formatReviewCommentContext(makeTarget(), "Please keep this configurable.")}\nAfter`;
    const segments = parseReviewCommentMessageSegments(serialized);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual(expect.objectContaining({ kind: "text", text: "Before\n" }));
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "apps/demo/src/main.ts",
          text: "Please keep this configurable.",
          diff: expect.stringContaining("+const retryLimit = 4;"),
        }),
      }),
    );
    expect(segments[2]).toEqual(expect.objectContaining({ kind: "text", text: "\nAfter" }));
  });

  it("parses source-language review comments created by the web file viewer", () => {
    const [segment] = parseReviewCommentMessageSegments(
      [
        '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
        "Clarify this.",
        "```md",
        "# Plan",
        "- Step one",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "docs/plan.md",
          fenceLanguage: "md",
          diff: "# Plan\n- Step one",
        }),
      }),
    );
  });

  it("keeps fenced examples in comment prose separate from the context fence", () => {
    const [segment] = parseReviewCommentMessageSegments(
      [
        '<review_comment sectionId="section-1" sectionTitle="Working tree" filePath="src/app.ts" startIndex="0" endIndex="0" rangeLabel="+1">',
        "Try this:",
        "```ts",
        "const value = 1;",
        "```",
        "Then retry.",
        "```diff",
        "@@ -0,0 +1,1 @@",
        "+one",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          text: ["Try this:", "```ts", "const value = 1;", "```", "Then retry."].join("\n"),
          diff: "@@ -0,0 +1,1 @@\n+one",
        }),
      }),
    );
  });

  it("round-trips greater-than signs in review attributes", () => {
    const serialized = formatReviewCommentContext(
      { ...makeTarget(), sectionTitle: "Changes > 5" },
      "Check this.",
    );
    const [comment] = parseReviewInlineComments(serialized);

    expect(serialized).toContain('sectionTitle="Changes &gt; 5"');
    expect(comment?.sectionTitle).toBe("Changes > 5");
  });
});

describe("Stave repository comment isolation", () => {
  it("keeps a serialized comment on its checkout when two repos have the same file and diff", () => {
    const patch = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-const retryLimit = 2;",
      "+const retryLimit = 4;",
    ].join("\n");
    const sectionFor = (gitCwd: string, loading = false) =>
      buildReviewSectionItems({
        checkpoints: [],
        gitSections: loading
          ? []
          : [
              {
                id: "working-tree",
                kind: "working-tree",
                title: "Dirty worktree",
                baseRef: "HEAD",
                headRef: null,
                diff: patch,
                diffHash: "identical",
                truncated: false,
              },
            ],
        turnDiffById: {},
        loadingTurnIds: {},
        loadingGitSections: loading,
        gitCwd,
      })[0]!;
    const repoA = sectionFor('/spaces/test/nested/api "one"');
    const repoB = sectionFor("/spaces/test/nested/api-two");
    const draft = formatReviewCommentContext(
      { ...makeTarget(), sectionId: repoA.id, filePath: "src/index.ts" },
      "Only update repository A.",
    );
    const comments = parseReviewInlineComments(draft);
    const parsedDiff = buildReviewParsedDiff(patch, "repo-comment-isolation");
    const render = (id: string) =>
      getCachedNativeReviewDiffData({
        parsedDiff,
        comments: comments.filter((comment) => comment.sectionId === id),
      });

    expect(render(repoA.id).rows.filter((row) => row.kind === "comment")).toHaveLength(1);
    expect(render(repoB.id).rows.filter((row) => row.kind === "comment")).toHaveLength(0);
    expect(render("git:working-tree").rows.filter((row) => row.kind === "comment")).toHaveLength(0);
    // A refresh's loading placeholder retains the checkout identity and selection.
    expect(sectionFor('/spaces/test/nested/api "one"', true).id).toBe(repoA.id);
  });
});
