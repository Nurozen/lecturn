import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type PullRequestWatch } from "@lecturn/contracts";
import {
  projectPullRequestActivity,
  agentAwarenessPublishIdentity,
  pullRequestActivityPublishKey,
} from "./AgentAwarenessRelay.ts";
const now = Date.parse("2026-09-13T20:00:00Z");
const watch: PullRequestWatch = {
  id: "watch",
  reference: { projectId: ProjectId.make("project"), repository: "org/repo", number: 42 },
  revision: 1,
  binding: "binding",
  watching: true,
  threadIds: [],
  managerThreadId: null,
  managerStatus: "unassigned",
  authorization: null,
  lastAttemptAt: null,
  error: null,
  createdAt: "2026-09-13T20:00:00Z",
  updatedAt: "2026-09-13T20:00:00Z",
  observation: {
    provider: "github",
    title: "Feature",
    url: "https://github.com/org/repo/pull/42",
    state: "open",
    headRevision: "a".repeat(40),
    baseBranch: "main",
    reviewDecision: null,
    checks: [],
    checksState: "pending",
    requiredChecks: "pending",
    checksRevision: null,
    mergeable: false,
    autoMergeEnabled: false,
    supportsAutoMerge: true,
    supportsRevisionMerge: true,
    observedAt: "2026-09-13T20:00:00Z",
  },
};
const env = EnvironmentId.make("environment");
describe("independent PR live activities", () => {
  it("continues without a managing conversation and opens authenticated PR controls", () => {
    const state = projectPullRequestActivity(env, watch, "Project", now)!;
    expect(state.threadId).toBe("pr-watch:watch");
    expect(state.deepLink).toBe("/pr-watches/environment/watch");
    expect(state.pullRequest).toMatchObject({
      checks: "pending",
      manager: "unassigned",
      watching: true,
      stale: false,
    });
    expect(state.phase).toBe("running");
    const freshLater = {
      ...watch,
      observation: { ...watch.observation!, observedAt: "2026-09-13T20:05:00Z" },
    };
    expect(pullRequestActivityPublishKey(state)).not.toBe(
      pullRequestActivityPublishKey(
        projectPullRequestActivity(env, freshLater, "Project", now + 300_000),
      ),
    );
  });
  it("marks stale facts for attention while retaining the last CI result", () => {
    const state = projectPullRequestActivity(env, watch, "Project", now + 120_001)!;
    expect(state.phase).toBe("waiting_for_input");
    expect(state.pullRequest).toMatchObject({ stale: true, checks: "pending" });
    expect(
      projectPullRequestActivity(env, { ...watch, error: "offline" }, "Project", now)?.pullRequest
        ?.stale,
    ).toBe(true);
  });
  it("publishes terminal facts after the watcher automatically stops", () => {
    const completed = projectPullRequestActivity(
      env,
      {
        ...watch,
        watching: false,
        completedAt: "2026-09-13T20:00:00Z",
        observation: { ...watch.observation!, state: "merged" },
      },
      "Project",
      now,
    )!;
    expect(completed.phase).toBe("completed");
    expect(
      projectPullRequestActivity(
        env,
        { ...watch, observation: { ...watch.observation!, state: "merged" } },
        "Project",
        now,
      ),
    ).toBeNull();
    expect(completed.pullRequest).toMatchObject({ state: "merged", watching: false });
    const terminalWatch = {
      ...watch,
      watching: false,
      completedAt: "2026-09-13T20:00:00Z",
      observation: { ...watch.observation!, state: "merged" as const },
    };
    expect(
      projectPullRequestActivity(env, terminalWatch, "Project", now + 180_000)?.pullRequest?.stale,
    ).toBe(false);
    expect(projectPullRequestActivity(env, terminalWatch, "Project", now + 900_001)).toBeNull();
  });
  it("pausing removes activity and unchanged heartbeats retain semantic identity", () => {
    expect(
      projectPullRequestActivity(env, { ...watch, watching: false }, "Project", now),
    ).toBeNull();
    expect(
      agentAwarenessPublishIdentity(projectPullRequestActivity(env, watch, "Project", now)),
    ).toBe(
      agentAwarenessPublishIdentity(
        projectPullRequestActivity(env, watch, "Project", now + 10_000),
      ),
    );
  });
});
