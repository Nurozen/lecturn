import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";
import {
  appendReviewCommentsToPrompt,
  buildDiffReviewComment,
  parseReviewCommentMessageSegments,
} from "../../reviewCommentContext";
import { scopeStaveDiffReview } from "./staveDiffReview.logic";

const fileDiff = parsePatchFiles(
  [
    "diff --git a/src/main.ts b/src/main.ts",
    "--- a/src/main.ts",
    "+++ b/src/main.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n"),
  "space-review-test",
)[0]!.files[0]!;
const files = [{ filePath: "src/main.ts", fileDiff, fileKey: "same-diff" }];
const scope = (repositoryRoot: string, workspaceRoot = "/space", sectionId = "unstaged") =>
  scopeStaveDiffReview({
    repository: { workspaceRoot, repositoryRoot, repoName: "repo" },
    sectionId,
    sectionTitle: "Working tree",
    files,
  });

it("keeps identical repo-relative files in different comment namespaces", () => {
  const a = scope("/space/a");
  const b = scope("/space/nested/b");
  expect(a.sectionId).not.toBe(b.sectionId);
  expect(a.files[0]?.filePath).toBe("a/src/main.ts");
  expect(b.files[0]?.filePath).toBe("nested/b/src/main.ts");
  expect(a.files[0]?.fileDiff).toBe(fileDiff);
  expect(b.files[0]?.fileDiff).toBe(fileDiff);
  expect(files[0]?.filePath).toBe("src/main.ts");
});

it("serializes both repository paths and distinct identities into the submitted prompt", () => {
  const reviews = [scope("/space/a"), scope("/space/nested/b")];
  const comments = reviews.map((review, index) =>
    buildDiffReviewComment({
      id: `comment-${index}`,
      sectionId: review.sectionId,
      sectionTitle: review.sectionTitle,
      filePath: review.files[0]!.filePath,
      fileDiff,
      range: { start: 1, end: 1, side: "additions" },
      text: "Check this change.",
    })!,
  );
  const prompt = appendReviewCommentsToPrompt("Apply the feedback.", comments);
  expect(prompt).toContain('filePath="a/src/main.ts"');
  expect(prompt).toContain('filePath="nested/b/src/main.ts"');
  const parsed = parseReviewCommentMessageSegments(prompt);
  expect(parsed.filter((segment) => segment.kind === "review-comment")).toHaveLength(2);
  expect(comments.filter((comment) => comment.sectionId === reviews[0]!.sectionId)).toHaveLength(1);
});

describe("review path boundaries", () => {
  it("uses absolute paths for external references and prefix siblings", () => {
    expect(scope("/shared/reference").files[0]?.filePath).toBe("/shared/reference/src/main.ts");
    expect(scope("/space-other/a").files[0]?.filePath).toBe("/space-other/a/src/main.ts");
  });
  it("handles Windows remote paths without using the browser OS", () => {
    expect(scope("C:\\SPACE\\Nested\\Repo", "c:/space").files[0]?.filePath).toBe(
      "Nested/Repo/src/main.ts",
    );
    expect(scope("D:\\Reference", "c:/space").files[0]?.filePath).toBe("D:/Reference/src/main.ts");
  });
  it("keeps scopes distinct while retaining a repository's working tree comments on return", () => {
    expect(scope("/space/a", "/space", "branch").sectionId).not.toBe(scope("/space/a").sectionId);
    expect(scope("/space/a/").sectionId).toBe(scope("/space/a").sectionId);
  });
  it("leaves ordinary repository and checkpoint review identities unchanged", () => {
    const review = scopeStaveDiffReview({
      repository: null,
      sectionId: "turn:2",
      sectionTitle: "Turn 2",
      files,
    });
    expect(review).toEqual({ sectionId: "turn:2", sectionTitle: "Turn 2", files });
    expect(review.files).toBe(files);
  });
});
