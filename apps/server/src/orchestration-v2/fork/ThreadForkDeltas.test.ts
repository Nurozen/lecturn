import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as GitWorkflow from "../../git/GitWorkflowService.ts";
import {
  applyForkDeltas,
  isDefaultForkTitle,
  planRunlessForkHistory,
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
  it("rejects assistant anchors and unknown messages", () => {
    for (const messages of [[], [{ id: userMessageId, role: "assistant" as const, runId }]]) {
      assert.equal(
        resolveForkCut({ sourceMessageId: userMessageId, messages, runs }).type,
        "rejected",
      );
    }
  });
  it("cuts run-less history (V1 migration, import) without a run", () => {
    const imported = MessageId.make("import:thread:source:message:000001");
    const messages = [{ id: imported, role: "user" as const, runId: null }];
    assert.deepEqual(
      resolveForkCut({ sourceMessageId: imported, messages, runs, runlessHistory: true }),
      { type: "runless", messageId: imported },
    );
    // A run-less message on a thread without run-less history has no turn to cut.
    const result = resolveForkCut({ sourceMessageId: imported, messages, runs });
    assert.equal(result.type, "rejected");
    assert.include(result.type === "rejected" ? result.reason : "", "no turn");
  });
});

describe("planRunlessForkHistory", () => {
  const at = DateTime.makeUnsafe("2026-04-01T00:00:00.000Z");
  const message = (index: number, role: "user" | "assistant"): OrchestrationV2ConversationMessage =>
    ({
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "server",
      id: MessageId.make(`legacy:message:${index}`),
      threadId: sourceThreadId,
      runId: null,
      nodeId: null,
      role,
      text: `${role} ${index}`,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    }) as OrchestrationV2ConversationMessage;
  const item = (index: number, role: "user" | "assistant"): OrchestrationV2TurnItem =>
    ({
      id: TurnItemId.make(`legacy:item:${index}`),
      threadId: sourceThreadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: role === "user" ? "user_message" : "assistant_message",
      messageId: MessageId.make(`legacy:message:${index}`),
      text: `${role} ${index}`,
      ...(role === "user"
        ? {
            createdBy: "user",
            creationSource: "server",
            inputIntent: "turn_start",
            attachments: [],
          }
        : { streaming: false }),
    }) as OrchestrationV2TurnItem;
  const roles = ["user", "assistant", "user", "assistant"] as const;
  const sourceItems = roles.map((role, index) => item(index + 1, role)).toReversed();
  const sourceMessages = roles.map((role, index) => message(index + 1, role));

  it("carries the anchored user message and its reply, copied into the child", () => {
    const planned = planRunlessForkHistory({
      targetThreadId,
      cutMessageId: MessageId.make("legacy:message:1"),
      sourceItems,
      sourceMessages,
    });
    assert.deepEqual(
      planned?.turnItems.map((copy) => [copy.id, copy.threadId]),
      [
        [`fork:${targetThreadId}:legacy:item:1`, targetThreadId],
        [`fork:${targetThreadId}:legacy:item:2`, targetThreadId],
      ],
    );
    assert.deepEqual(
      planned?.messages.map((copy) => [copy.id, copy.threadId, copy.text]),
      [
        [`fork:${targetThreadId}:legacy:message:1`, targetThreadId, "user 1"],
        [`fork:${targetThreadId}:legacy:message:2`, targetThreadId, "assistant 2"],
      ],
    );
    const first = planned?.turnItems[0];
    assert.equal(
      first?.type === "user_message" ? first.messageId : undefined,
      `fork:${targetThreadId}:legacy:message:1`,
    );
    assert.equal(planned?.lastSourceItemId, "legacy:item:2");
  });

  it("carries the whole run-less history without a cut and refuses an unknown cut", () => {
    const whole = planRunlessForkHistory({
      targetThreadId,
      cutMessageId: undefined,
      sourceItems,
      sourceMessages,
    });
    assert.lengthOf(whole?.turnItems ?? [], 4);
    assert.equal(whole?.lastSourceItemId, "legacy:item:4");
    assert.isUndefined(
      planRunlessForkHistory({
        targetThreadId,
        cutMessageId: MessageId.make("legacy:message:missing"),
        sourceItems,
        sourceMessages,
      }),
    );
    assert.isUndefined(
      planRunlessForkHistory({
        targetThreadId,
        cutMessageId: undefined,
        sourceItems: [],
        sourceMessages: [],
      }),
    );
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
  const fakeGit = (calls: Array<string>, remote: boolean, blockedNamespace = false) =>
    ({
      hasCommit: (input: { readonly refName: string }) =>
        Effect.succeed(blockedNamespace && input.refName === "refs/heads/lecturn"),
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

  it.effect("falls back to lecturn-<hash> when a plain lecturn branch blocks lecturn/*", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const created = yield* provisionForkWorktree({
        git: fakeGit(calls, false, true),
        prepareWorktree: { projectCwd: "/repo", baseBranch: "main" },
        mintId: () => "deadbeef",
      });
      assert.deepEqual(created, { branch: "lecturn-deadbeef", worktreePath: "/worktrees/new" });
      assert.deepEqual(calls, ["create:main:lecturn-deadbeef"]);
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
  it("titles a fork child on its first new turn while it has a default title", () => {
    assert.isTrue(
      shouldGenerateForkChildTitle({
        thread: childThread,
        parentTitle: "Source",
        localUserMessageCount: 0,
      }),
    );
    // Lecturn clients mint "<parent> (fork)".
    assert.isTrue(
      shouldGenerateForkChildTitle({
        thread: { ...childThread, title: "Source (fork)" },
        parentTitle: "Source",
        localUserMessageCount: 0,
      }),
    );
    // A run-less fork child is not forkedFrom a run but is still a fork child.
    const runlessChild: OrchestrationV2AppThread = { ...childThread, forkedFrom: null };
    assert.isTrue(
      shouldGenerateForkChildTitle({
        thread: runlessChild,
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
        thread: { ...childThread, lineage: { ...childThread.lineage, relationshipToParent: null } },
        parentTitle: "Source",
        localUserMessageCount: 0,
      }),
    );
  });

  it("recognizes the Lecturn and upstream default fork titles", () => {
    assert.isTrue(isDefaultForkTitle("Source fork", "Source"));
    assert.isTrue(isDefaultForkTitle("Source (fork)", "Source"));
    // The parent may have been renamed (or deleted) since the fork.
    assert.isTrue(isDefaultForkTitle("Old name (fork)", undefined));
    assert.isFalse(isDefaultForkTitle("Source fork", undefined));
    assert.isFalse(isDefaultForkTitle("Renamed", "Source"));
  });
});
