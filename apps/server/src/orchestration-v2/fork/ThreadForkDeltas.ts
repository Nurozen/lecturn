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
 * - Run-less history (a V1 migration transcript or an imported session) has
 *   no run to fork natively: the child gets a copy of that history up to the
 *   cut and its first turn receives it as portable context (see
 *   `planRunlessForkHistory`).
 * - First new turn of a child that still carries its default fork title
 *   generates a real title (see `shouldGenerateForkChildTitle`).
 */
import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadForkPrepareWorktree,
  type OrchestrationV2TurnItem,
  type ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@lecturn/shared/git";
import * as Effect from "effect/Effect";

import { withoutThreadAppMetadata } from "../../apps/threadAppMetadata.ts";
import type * as GitWorkflow from "../../git/GitWorkflowService.ts";

export type ThreadForkCommand = Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>;

export type ForkCutResolution =
  | { readonly type: "source-point" }
  | { readonly type: "run"; readonly runId: OrchestrationV2Run["id"] }
  /** The anchor is in run-less history: the fork copies that history up to the anchor's turn. */
  | { readonly type: "runless"; readonly messageId: MessageId }
  | { readonly type: "rejected"; readonly reason: string };

/**
 * Where a message-anchored fork is cut. The anchor must be a user message of
 * the source thread. A message started by a run cuts at that run; a message of
 * the source's run-less history (V1 migration or import) cuts that history.
 */
export function resolveForkCut(input: {
  readonly sourceMessageId: MessageId | undefined;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "role" | "runId">
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "userMessageId">>;
  /** The source holds run-less history (`hasRunlessHistory`). */
  readonly runlessHistory?: boolean;
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
  if (run !== undefined) return { type: "run", runId: run.id };
  if (message.runId === null && input.runlessHistory === true) {
    return { type: "runless", messageId: message.id };
  }
  return {
    type: "rejected",
    reason: "The message to fork from has no turn in the source thread to fork at.",
  };
}

interface RunlessForkHistory {
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** The last source item the fork carries (the transfer's source point). */
  readonly lastSourceItemId: TurnItemId;
}

const runlessForkId = (targetThreadId: ThreadId, sourceId: string) =>
  `fork:${targetThreadId}:${sourceId}`;

/**
 * The child's copy of the source's run-less history. A cut at a user message
 * carries that message and everything up to the next user message (its
 * reply); without a cut the whole run-less history is carried. Copies get ids
 * derived from the child and source ids (a replayed plan is identical) and
 * keep their source timestamps, so imported history still reads as imported.
 * Returns `undefined` when there is nothing to carry or the cut is not found.
 */
export function planRunlessForkHistory(input: {
  readonly targetThreadId: ThreadId;
  readonly cutMessageId: MessageId | undefined;
  /** The source's run-less turn items, any order. */
  readonly sourceItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** The source messages those items reference. */
  readonly sourceMessages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}): RunlessForkHistory | undefined {
  const ordered = input.sourceItems
    .filter((item) => item.runId === null && item.type !== "fork")
    .toSorted((left, right) => left.ordinal - right.ordinal);
  let endExclusive = ordered.length;
  if (input.cutMessageId !== undefined) {
    const cutIndex = ordered.findIndex(
      (item) => item.type === "user_message" && item.messageId === input.cutMessageId,
    );
    if (cutIndex < 0) return undefined;
    const nextUser = ordered.findIndex(
      (item, index) => index > cutIndex && item.type === "user_message",
    );
    endExclusive = nextUser < 0 ? ordered.length : nextUser;
  }
  const carried = ordered.slice(0, endExclusive);
  const lastSourceItem = carried.at(-1);
  if (lastSourceItem === undefined) return undefined;

  const messageIds = new Map<MessageId, MessageId>();
  const itemIds = new Map<TurnItemId, TurnItemId>();
  for (const item of carried) {
    itemIds.set(item.id, TurnItemId.make(runlessForkId(input.targetThreadId, item.id)));
    if ("messageId" in item && item.messageId !== undefined && item.messageId !== null) {
      messageIds.set(
        item.messageId,
        MessageId.make(runlessForkId(input.targetThreadId, item.messageId)),
      );
    }
  }
  const turnItems = carried.map((item): OrchestrationV2TurnItem => {
    const copied = {
      ...item,
      id: itemIds.get(item.id)!,
      threadId: input.targetThreadId,
      parentItemId: item.parentItemId === null ? null : (itemIds.get(item.parentItemId) ?? null),
    };
    return "messageId" in copied && copied.messageId != null
      ? ({
          ...copied,
          messageId: messageIds.get(copied.messageId) ?? copied.messageId,
        } as OrchestrationV2TurnItem)
      : copied;
  });
  const messages = input.sourceMessages.flatMap((message) => {
    const id = messageIds.get(message.id);
    return id === undefined ? [] : [{ ...message, id, threadId: input.targetThreadId }];
  });
  return { messages, turnItems, lastSourceItemId: lastSourceItem.id };
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
    ...withoutThreadAppMetadata(input.targetThread),
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
    let newRefName = prepareWorktree.branch ?? buildTemporaryWorktreeBranchName(input.mintId);
    // A plain `lecturn` branch makes every `lecturn/<hash>` ref impossible.
    if (
      isTemporaryWorktreeBranch(newRefName) &&
      (yield* git.hasCommit({
        cwd: prepareWorktree.projectCwd,
        refName: `refs/heads/${WORKTREE_BRANCH_PREFIX}`,
      }))
    ) {
      newRefName = flattenTemporaryWorktreeBranchName(newRefName);
    }
    const created = yield* git.createWorktree({
      cwd: prepareWorktree.projectCwd,
      refName: startRef,
      newRefName,
      baseRefName: prepareWorktree.baseBranch,
      path: null,
    });
    return { branch: created.worktree.refName, worktreePath: created.worktree.path };
  },
);

/**
 * Whether a fork child still has the title minted at fork time: Lecturn
 * clients mint "<parent> (fork)" (or "Untitled (fork)"), upstream's server
 * default is "<parent> fork". Same rule as the client's
 * `isDefaultForkChildTitle`; anything else is a title the user chose.
 */
export function isDefaultForkTitle(title: string, parentTitle: string | undefined): boolean {
  const trimmed = title.trim();
  if (trimmed.endsWith("(fork)")) return true;
  const parent = parentTitle?.trim();
  return parent !== undefined && parent !== "" && trimmed === `${parent} fork`;
}

/** A thread created by thread.fork (a run-anchored or run-less fork). */
export function isForkChild(thread: Pick<OrchestrationV2AppThread, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "fork";
}

/**
 * A fork child generates its title on its first new turn while it still has
 * the default fork title (an explicit title is the user's choice).
 */
export function shouldGenerateForkChildTitle(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage" | "title">;
  readonly parentTitle: string | undefined;
  readonly localUserMessageCount: number;
}): boolean {
  return (
    isForkChild(input.thread) &&
    input.localUserMessageCount === 0 &&
    isDefaultForkTitle(input.thread.title, input.parentTitle)
  );
}
