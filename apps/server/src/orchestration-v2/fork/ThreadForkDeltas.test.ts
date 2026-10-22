import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as GitWorkflow from "../../git/GitWorkflowService.ts";
import {
  applyForkDeltas,
  provisionForkWorktree,
  resolveForkCut,
  shouldGenerateForkChildTitle,
  type ThreadForkCommand,
  validateForkWorkspace,
} from "./ThreadForkDeltas.ts";

const sourceThreadId = ThreadId.make("thread:source");
const targetThreadId = ThreadId.make("thread:child");
const userMessageId = MessageId.make("message:user-2");
const runId = RunId.make("run:2");

const command: ThreadForkCommand = {
  type: "thread.fork",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make("cmd-fork"),
  sourceThreadId,
  targetThreadId,
  sourcePoint: { type: "latest_stable" },
};

const now = DateTime.makeUnsafe("2026-05-01T00:00:00.000Z");
const childThread = {
  createdBy: "user",
  creationSource: "web",
  id: targetThreadId,
  projectId: "project-1",
  title: "Source fork",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/source",
  worktreePath: "/worktrees/source",
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: sourceThreadId,
    relationshipToParent: "fork",
    rootThreadId: sourceThreadId,
  },
  forkedFrom: { type: "run", threadId: sourceThreadId, runId },
  // A fork of a fork carries the parent's origin until the deltas replace it.
  forkOrigin: { threadId: ThreadId.make("thread:grandparent"), messageId: null },
  importedFrom: {
    providerInstanceId: ProviderInstanceId.make("codex"),
    driverKind: "codex",
    sessionId: "external",
    cwd: "/repo",
    title: "External",
    importedAt: "2026-04-01T00:00:00.000Z",
    historyTruncated: false,
  },
  linkedPullRequest: null,
  branchPullRequest: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastVisitedAt: null,
  deletedAt: null,
} as unknown as OrchestrationV2AppThread;

describe("resolveForkCut", () => {
  const runs = [
    { id: RunId.make("run:1"), userMessageId: MessageId.make("message:user-1") },
    { id: runId, userMessageId },
  ];
  it("keeps the command's source point without an anchor", () => {
    assert.deepEqual(resolveForkCut({ sourceMessageId: undefined, messages: [], runs }), {
      type: "source-point",
    });
  });
  it("cuts at the run of the anchored user message", () => {
    assert.deepEqual(
      resolveForkCut({
        sourceMessageId: userMessageId,
        messages: [{ id: userMessageId, role: "user", runId }],
        runs,
      }),
      { type: "run", runId },
    );
  });
  it("rejects assistant anchors, unknown messages and imported history", () => {
    for (const messages of [[], [{ id: userMessageId, role: "assistant" as const, runId }]]) {
      assert.equal(
        resolveForkCut({ sourceMessageId: userMessageId, messages, runs }).type,
        "rejected",
      );
    }
    const imported = MessageId.make("import:thread:source:message:000001");
    const result = resolveForkCut({
      sourceMessageId: imported,
      messages: [{ id: imported, role: "user", runId: null }],
      runs,
    });
    assert.equal(result.type, "rejected");
    assert.include(result.type === "rejected" ? result.reason : "", "Imported history");
  });
});

describe("applyForkDeltas", () => {
  it("records the fork origin and keeps the inherited workspace and import origin", () => {
    const forked = applyForkDeltas({
      targetThread: childThread,
      command: { ...command, sourceMessageId: userMessageId },
    });
    assert.deepEqual(forked.forkOrigin, { threadId: sourceThreadId, messageId: userMessageId });
    assert.equal(forked.worktreePath, "/worktrees/source");
    assert.equal(forked.branch, "feature/source");
    assert.deepEqual(forked.importedFrom, childThread.importedFrom);
    assert.deepEqual(applyForkDeltas({ targetThread: childThread, command }).forkOrigin, {
      threadId: sourceThreadId,
      messageId: null,
    });
  });
  it("moves a new-worktree child onto its own branch", () => {
    const forked = applyForkDeltas({
      targetThread: { ...childThread, branchPullRequest: { number: 1 } as never },
      command: { ...command, workspace: "new-worktree" },
      worktree: { branch: "lecturn/abcd1234", worktreePath: "/worktrees/child" },
    });
    assert.equal(forked.branch, "lecturn/abcd1234");
    assert.equal(forked.worktreePath, "/worktrees/child");
    assert.equal(forked.branchPullRequest, null);
  });
  it("requires a worktree to prepare for new-worktree forks", () => {
    assert.isString(validateForkWorkspace({ ...command, workspace: "new-worktree" }));
    assert.isUndefined(validateForkWorkspace(command));
    assert.isUndefined(
      validateForkWorkspace({
        ...command,
        workspace: "new-worktree",
        prepareWorktree: { projectCwd: "/repo", baseBranch: "main" },
      }),
    );
  });
});

describe("provisionForkWorktree", () => {
  const fakeGit = (calls: Array<string>, remote: boolean) =>
    ({
      remoteExists: () => Effect.sync(() => (calls.push("remoteExists"), remote)),
      fetchRemote: () => Effect.sync(() => void calls.push("fetchRemote")),
      remoteBranchExists: () => Effect.sync(() => (calls.push("remoteBranchExists"), true)),
      resolveRemoteTrackingCommit: () =>
        Effect.sync(
          () => (calls.push("resolve"), { commitSha: "abc123", remoteRefName: "origin/main" }),
        ),
      createWorktree: (input: { readonly refName: string; readonly newRefName?: string }) =>
        Effect.sync(() => {
          calls.push(`create:${input.refName}:${input.newRefName}`);
          return { worktree: { path: "/worktrees/new", refName: input.newRefName ?? "x" } };
        }),
    }) as unknown as GitWorkflow.GitWorkflowService["Service"];

  it.effect("creates a temporary branch from the local base", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const created = yield* provisionForkWorktree({
        git: fakeGit(calls, false),
        prepareWorktree: { projectCwd: "/repo", baseBranch: "main" },
        mintId: () => "deadbeef",
      });
      assert.deepEqual(created, { branch: "lecturn/deadbeef", worktreePath: "/worktrees/new" });
      assert.deepEqual(calls, ["create:main:lecturn/deadbeef"]);
    }),
  );

  it.effect("starts from origin when asked and the remote branch exists", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const created = yield* provisionForkWorktree({
        git: fakeGit(calls, true),
        prepareWorktree: {
          projectCwd: "/repo",
          baseBranch: "main",
          branch: "feature/child",
          startFromOrigin: true,
        },
        mintId: () => "deadbeef",
      });
      assert.equal(created.branch, "feature/child");
      assert.deepEqual(calls, [
        "remoteExists",
        "fetchRemote",
        "remoteBranchExists",
        "resolve",
        "create:abc123:feature/child",
      ]);
    }),
  );
});

describe("shouldGenerateForkChildTitle", () => {
  it("titles a fork child on its first new turn while it has the default title", () => {
    assert.isTrue(
      shouldGenerateForkChildTitle({
        thread: childThread,
        parentTitle: "Source",
        localUserMessageCount: 0,
      }),
    );
    assert.isFalse(
      shouldGenerateForkChildTitle({
        thread: { ...childThread, title: "Chosen by user" },
        parentTitle: "Source",
        localUserMessageCount: 0,
      }),
    );
    assert.isFalse(
      shouldGenerateForkChildTitle({
        thread: childThread,
        parentTitle: "Source",
        localUserMessageCount: 1,
      }),
    );
    assert.isFalse(
      shouldGenerateForkChildTitle({
        thread: { ...childThread, forkedFrom: null },
        parentTitle: "Source",
        localUserMessageCount: 0,
      }),
    );
  });
});
