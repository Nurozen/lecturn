import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@lecturn/contracts";
import { Effect, Layer, Ref } from "effect";

import { GitManager } from "../git/GitManager.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import {
  aggregateSpacePullRequests,
  linkedHostMatchesMerge,
  make,
  type StaveMemberPullRequest,
} from "./StaveSettlement.ts";

const OLDER = "2026-08-19T00:00:00.000Z";
const LATEST = "2026-08-21T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project");

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Space",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: OLDER,
  updatedAt: OLDER,
  stave: {
    spaceId: "multi",
    isSaga: false,
    state: "live",
    memories: [],
    repos: [
      { name: "api", path: "services/api", mode: "edit", branch: "stale-manifest" },
      { name: "web", path: "web", mode: "edit", branch: "also-stale" },
      { name: "reference", path: "references/docs", mode: "reference" },
    ],
    primaryRepoPath: "/workspace/project/services/api",
    primaryBranch: "stale-primary",
  },
};

const member = (
  state: StaveMemberPullRequest["state"],
  at: string | null | undefined,
): StaveMemberPullRequest => ({
  state,
  closedAt: state === "closed" ? at : null,
  mergedAt: state === "merged" ? at : null,
});

describe("aggregateSpacePullRequests", () => {
  it("keeps the whole space active while any member is open", () => {
    assert.deepEqual(
      aggregateSpacePullRequests([member("merged", LATEST), { state: "open" }, null]),
      { state: "open" },
    );
  });
  it("decides nothing while a member has no evidence, or with no members", () => {
    assert.isNull(aggregateSpacePullRequests([member("merged", LATEST), null]));
    assert.isNull(aggregateSpacePullRequests([]));
  });
  for (const scenario of [
    { members: ["closed", "closed", "closed"], latest: 1, expected: "closed" },
    { members: ["merged", "closed", "merged"], latest: 1, expected: "merged" },
    { members: ["merged", "merged", "closed"], latest: 2, expected: "merged" },
    { members: ["merged", "merged", "merged"], latest: 0, expected: "merged" },
  ] as const)
    it(`settles ${scenario.members.join("/")} at the latest terminal time`, () => {
      const result = aggregateSpacePullRequests(
        scenario.members.map((state, index) =>
          member(state, index === scenario.latest ? LATEST : OLDER),
        ),
      );
      assert.deepEqual(
        result,
        scenario.expected === "closed"
          ? { state: "closed", closedAt: LATEST }
          : { state: "merged", mergedAt: LATEST },
      );
    });
  for (const invalid of [undefined, null, "invalid"])
    it(`has no terminal time when a member's time is ${String(invalid)}`, () => {
      assert.deepEqual(
        aggregateSpacePullRequests([member("merged", LATEST), member("merged", invalid)]),
        { state: "merged", mergedAt: null },
      );
    });
});

describe("linkedHostMatchesMerge", () => {
  it("requires the exact host for links in a Stave space", () => {
    assert.isTrue(
      linkedHostMatchesMerge({ host: "GitHub.Enterprise.test" }, "github.enterprise.test", true),
    );
    assert.isFalse(linkedHostMatchesMerge({ host: "github.enterprise.test" }, "github.com", true));
    assert.isFalse(linkedHostMatchesMerge({}, "github.com", true));
  });
  it("keeps ordinary links that predate hosts matching", () => {
    assert.isTrue(linkedHostMatchesMerge({}, "github.com", false));
    assert.isTrue(linkedHostMatchesMerge({ host: "github.com" }, undefined, false));
    assert.isFalse(linkedHostMatchesMerge({ host: "gitlab.com" }, "github.com", false));
  });
});

it.layer(NodeServices.layer)("StaveSettlement.spacePullRequest", (it) => {
  it.effect("reads every editable checkout's live branch plus the explicit link", () =>
    Effect.gen(function* () {
      const branchCalls = yield* Ref.make<ReadonlyArray<{ cwd: string; branch: string }>>([]);
      const settlement = yield* make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(GitManager)({
              localStatus: ({ cwd }) =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: cwd.endsWith("/api") ? "stave/multi/api" : "stave/multi/web",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              branchPullRequest: (input) =>
                Ref.update(branchCalls, (all) => [...all, input]).pipe(
                  Effect.as({
                    projectId: PROJECT_ID,
                    repository: "owner/repository",
                    number: input.cwd.endsWith("/api") ? 1 : 2,
                    url: "https://github.com/owner/repository/pull/1",
                    title: "PR",
                    baseRef: "main",
                    headRef: input.branch,
                    state: "merged" as const,
                    updatedAt: LATEST,
                    mergedAt: input.cwd.endsWith("/api") ? OLDER : LATEST,
                    repositoryKey: "github.com/owner/repository",
                  }),
                ),
            }),
            Layer.mock(PullRequestService)({
              summary: (input) =>
                Effect.succeed({
                  ...input,
                  provider: "github" as const,
                  title: "Linked",
                  url: "https://github.com/owner/repository/pull/42",
                  state: "open" as const,
                  headBranch: "feature",
                  baseBranch: "main",
                  updatedAt: LATEST,
                }),
            }),
          ),
        ),
      );
      const withoutLink = yield* settlement.spacePullRequest({ project, linkedPullRequest: null });
      assert.deepEqual(withoutLink, { state: "merged", mergedAt: LATEST });
      assert.deepEqual(yield* Ref.get(branchCalls), [
        { cwd: "/workspace/project/services/api", branch: "stave/multi/api" },
        { cwd: "/workspace/project/web", branch: "stave/multi/web" },
      ]);
      // An open explicit link keeps the space active after its checkouts merged.
      const withLink = yield* settlement.spacePullRequest({
        project,
        linkedPullRequest: {
          projectId: PROJECT_ID,
          repository: "owner/repository",
          number: 42,
          url: "https://github.com/owner/repository/pull/42",
        },
      });
      assert.deepEqual(withLink, { state: "open" });
      // Archived spaces and ordinary projects supply no space evidence.
      assert.isNull(
        yield* settlement.spacePullRequest({
          project: { ...project, stave: { ...project.stave!, state: "archived" } },
          linkedPullRequest: null,
        }),
      );
    }),
  );
});
