/**
 * Lecturn deltas on upstream thread.fork (ThreadForkService):
 * - `sourceMessageId`: the user message the fork is cut at. The fork carries
 *   history through that message's run (inclusive) and records the anchor as
 *   `forkOrigin.messageId` (null for fork-at-end).
 * - `workspace: "new-worktree"` + `prepareWorktree`: the child works on a new
 *   branch in its own worktree instead of inheriting the parent's.
 * - Imported origin and the linked pull request ride on the spread of the
 *   source thread in ThreadForkService; a child on a new branch drops only the
 *   branch-derived pull request.
 * - First new turn of a child that still carries its default fork title
 *   generates a real title (see `shouldGenerateForkChildTitle`).
 */
import type {
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadForkPrepareWorktree,
} from "@lecturn/contracts";
import { buildTemporaryWorktreeBranchName } from "@lecturn/shared/git";
import * as Effect from "effect/Effect";

import type * as GitWorkflow from "../../git/GitWorkflowService.ts";

export type ThreadForkCommand = Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>;

export type ForkCutResolution =
  | { readonly type: "source-point" }
  | { readonly type: "run"; readonly runId: OrchestrationV2Run["id"] }
  | { readonly type: "rejected"; readonly reason: string };

/**
 * Where a message-anchored fork is cut. The anchor must be a user message of
 * the source thread. A message started by a run cuts at that run; imported
 * history (no run) cannot be cut on V2 runs.
 */
export function resolveForkCut(input: {
  readonly sourceMessageId: MessageId | undefined;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "role" | "runId">
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "userMessageId">>;
}): ForkCutResolution {
  if (input.sourceMessageId === undefined) return { type: "source-point" };
  const message = input.messages.find((candidate) => candidate.id === input.sourceMessageId);
  if (message === undefined || message.role !== "user") {
    return {
      type: "rejected",
      reason: "The message to fork from is not a user message of the source thread.",
    };
  }
  const run =
    input.runs.find((candidate) => candidate.userMessageId === message.id) ??
    (message.runId === null ? undefined : input.runs.find((c) => c.id === message.runId));
  if (run === undefined) {
    return {
      type: "rejected",
      reason:
        "Imported history cannot be forked at a single message yet. Fork after a turn sent in Lecturn.",
    };
  }
  return { type: "run", runId: run.id };
}

export function validateForkWorkspace(command: ThreadForkCommand): string | undefined {
  if (command.workspace === "new-worktree" && command.prepareWorktree === undefined) {
    return "Forking into a new worktree needs the worktree to prepare.";
  }
  return undefined;
}

/** Apply the Lecturn fields to the child planned by ThreadForkService. */
export function applyForkDeltas(input: {
  readonly targetThread: OrchestrationV2AppThread;
  readonly command: ThreadForkCommand;
  readonly worktree?: { readonly branch: string; readonly worktreePath: string };
}): OrchestrationV2AppThread {
  const { command } = input;
  return {
    ...input.targetThread,
    forkOrigin: { threadId: command.sourceThreadId, messageId: command.sourceMessageId ?? null },
    ...(input.worktree === undefined
      ? {}
      : {
          branch: input.worktree.branch,
          worktreePath: input.worktree.worktreePath,
          // The pull request found for the parent's branch is not this branch's.
          branchPullRequest: null,
        }),
  };
}

/**
 * Create the child's worktree. Without an explicit branch the worktree gets a
 * temporary `lecturn/<hash>` branch, like a new worktree thread.
 */
export const provisionForkWorktree = Effect.fn("ThreadForkDeltas.provisionForkWorktree")(
  function* (input: {
    readonly git: GitWorkflow.GitWorkflowService["Service"];
    readonly prepareWorktree: OrchestrationV2ThreadForkPrepareWorktree;
    readonly mintId: () => string;
  }) {
    const { git, prepareWorktree } = input;
    let startRef = prepareWorktree.baseBranch;
    if (
      prepareWorktree.startFromOrigin === true &&
      (yield* git.remoteExists({ cwd: prepareWorktree.projectCwd, remoteName: "origin" }))
    ) {
      yield* git.fetchRemote({
        cwd: prepareWorktree.projectCwd,
        remoteName: "origin",
        refName: prepareWorktree.baseBranch,
      });
      if (
        yield* git.remoteBranchExists({
          cwd: prepareWorktree.projectCwd,
          remoteName: "origin",
          refName: prepareWorktree.baseBranch,
        })
      ) {
        startRef = (yield* git.resolveRemoteTrackingCommit({
          cwd: prepareWorktree.projectCwd,
          refName: prepareWorktree.baseBranch,
          fallbackRemoteName: "origin",
        })).commitSha;
      }
    }
    const created = yield* git.createWorktree({
      cwd: prepareWorktree.projectCwd,
      refName: startRef,
      newRefName: prepareWorktree.branch ?? buildTemporaryWorktreeBranchName(input.mintId),
      baseRefName: prepareWorktree.baseBranch,
      path: null,
    });
    return { branch: created.worktree.refName, worktreePath: created.worktree.path };
  },
);

/**
 * A fork child generates its title on its first new turn while it still has
 * the default fork title (an explicit title is the user's choice).
 */
export function shouldGenerateForkChildTitle(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "forkedFrom" | "title">;
  readonly parentTitle: string | undefined;
  readonly localUserMessageCount: number;
}): boolean {
  return (
    input.thread.forkedFrom !== null &&
    input.localUserMessageCount === 0 &&
    input.parentTitle !== undefined &&
    input.thread.title === `${input.parentTitle} fork`
  );
}
