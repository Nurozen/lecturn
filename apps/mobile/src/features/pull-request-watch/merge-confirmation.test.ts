import { ProjectId, type PullRequestWatch } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import { matchesMergeConfirmation, mergeConfirmationTarget } from "./merge-confirmation";

const watch: PullRequestWatch = {
  id: "watch-1",
  reference: { projectId: ProjectId.make("project-1"), repository: "owner/repo", number: 42 },
  revision: 2,
  binding: "incarnation-1",
  watching: true,
  threadIds: [],
  managerThreadId: null,
  managerStatus: "unassigned",
  authorization: null,
  lastAttemptAt: null,
  error: null,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  observation: {
    provider: "github",
    title: "Fix",
    url: "https://github.com/owner/repo/pull/42",
    state: "open",
    headRevision: "a".repeat(40),
    baseBranch: "main",
    reviewDecision: null,
    checks: [],
    checksState: "pending",
    requiredChecks: "pending",
    checksRevision: "a".repeat(40),
    mergeable: false,
    autoMergeEnabled: false,
    supportsAutoMerge: true,
    supportsRevisionMerge: true,
    observedAt: "2026-09-13T00:00:00.000Z",
  },
};

describe("native merge confirmation", () => {
  it("allows authorization while checks are pending and the confirmed target is unchanged", () => {
    const target = mergeConfirmationTarget(watch, "follow-pr");
    expect(target).not.toBeNull();
    expect(matchesMergeConfirmation(target!, watch)).toBe(true);
  });
  it.each([
    { ...watch, binding: "incarnation-2" },
    { ...watch, revision: 3 },
    { ...watch, observation: { ...watch.observation!, baseBranch: "release" } },
    { ...watch, observation: { ...watch.observation!, headRevision: "b".repeat(40) } },
    { ...watch, observation: { ...watch.observation!, state: "merged" as const } },
    undefined,
  ])(
    "rejects stale confirmation after target, authorization, or connection data changes",
    (changed) => {
      const target = mergeConfirmationTarget(watch, "follow-pr")!;
      expect(matchesMergeConfirmation(target, changed)).toBe(false);
    },
  );
  it("does not offer revision authorization without a known SHA and atomic host support", () => {
    expect(
      mergeConfirmationTarget(
        { ...watch, observation: { ...watch.observation!, headRevision: null } },
        "revision-only",
      ),
    ).toBeNull();
    expect(
      mergeConfirmationTarget(
        { ...watch, observation: { ...watch.observation!, supportsRevisionMerge: false } },
        "revision-only",
      ),
    ).toBeNull();
  });
  it("does not offer follow-PR authorization when the host cannot enforce revision checks", () => {
    expect(
      mergeConfirmationTarget(
        { ...watch, observation: { ...watch.observation!, supportsRevisionMerge: false } },
        "follow-pr",
      ),
    ).toBeNull();
  });
});
