import { EnvironmentId, ProjectId, ThreadId, type PullRequestWatch } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import { selectThreadPullRequestWatches, threadPullRequestLinks } from "./threadPullRequests.ts";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("app");
const thread = {
  id: ThreadId.make("thread"),
  projectId,
  environmentId,
  branch: "feature",
  worktreePath: null,
};
const project = {
  id: projectId,
  environmentId,
  workspaceRoot: "/work/app",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/app",
    rootPath: "/work/app",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/app",
    },
  },
};
const watch = (number: number, patch: Partial<PullRequestWatch> = {}): PullRequestWatch => ({
  id: `watch-${number}`,
  reference: { projectId, repository: "acme/app", number, host: "github.com" },
  binding: JSON.stringify([projectId, "/work/app", null, null, "/work/app", "github.com/acme/app"]),
  revision: 1,
  watching: true,
  threadIds: [thread.id],
  managerThreadId: null,
  managerStatus: "unassigned",
  authorization: null,
  observation: {
    provider: "github",
    title: `Change ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: "open",
    headRevision: "head",
    baseBranch: "main",
    reviewDecision: null,
    checks: [],
    checksState: "pending",
    requiredChecks: "unknown",
    checksRevision: "head",
    mergeable: true,
    autoMergeEnabled: false,
    supportsAutoMerge: true,
    supportsRevisionMerge: true,
    observedAt: "2026-09-13T01:00:00.000Z",
  },
  error: null,
  lastAttemptAt: null,
  createdAt: "2026-09-13T01:00:00.000Z",
  updatedAt: "2026-09-13T01:00:00.000Z",
  ...patch,
});
const select = (watches: readonly PullRequestWatch[]) =>
  selectThreadPullRequestWatches({ projects: [project], environmentId, thread, watches });

describe("thread pull request links", () => {
  it("retains every associated PR and a PR managed without an association", () => {
    const associated = watch(31);
    const managed = watch(32, { threadIds: [], managerThreadId: thread.id });
    const unrelated = watch(33, { threadIds: [] });
    expect(select([associated, managed, unrelated]).map((value) => value.reference.number)).toEqual(
      [31, 32],
    );
  });
  it("rejects stale bindings and another environment even when thread ids match", () => {
    expect(
      select([
        watch(31, {
          binding: JSON.stringify([
            projectId,
            "/other/app",
            null,
            null,
            "/other/app",
            "github.com/acme/app",
          ]),
        }),
      ]),
    ).toEqual([]);
    expect(
      selectThreadPullRequestWatches({
        projects: [project],
        environmentId: EnvironmentId.make("remote"),
        thread,
        watches: [watch(31)],
      }),
    ).toEqual([]);
  });
  it("keeps terminal and stopped PR links in the thread without resuming their watch", () => {
    const stopped = watch(31, { watching: false });
    expect(threadPullRequestLinks(select([stopped]))[0]?.watch?.watching).toBe(false);
  });
  it("deduplicates transient Git state against authoritative watches without losing different repositories with equal numbers", () => {
    const first = watch(31);
    const second = watch(31, {
      id: "other",
      reference: { ...first.reference, repository: "acme/other" },
      observation: { ...first.observation!, url: "https://github.com/acme/other/pull/31" },
    });
    expect(
      threadPullRequestLinks([first, second], {
        url: "https://github.com/ACME/app/pull/31/",
        number: 31,
        state: "closed",
      }).map((value) => [value.repository, value.state]),
    ).toEqual([
      ["acme/app", "open"],
      ["acme/other", "open"],
    ]);
  });
  it("does not invent a provider URL before observation but preserves the verified Git link", () => {
    const pending = watch(31, { observation: null });
    expect(threadPullRequestLinks([pending])).toEqual([]);
    expect(
      threadPullRequestLinks([pending], {
        url: "https://github.com/acme/app/pull/31",
        number: 31,
        state: "open",
      }),
    ).toHaveLength(1);
  });
});
