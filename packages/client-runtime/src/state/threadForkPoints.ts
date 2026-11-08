import type {
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2ThreadForkSourcePoint,
  RunId,
  ThreadId,
} from "@lecturn/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

/**
 * Lecturn fork points on V2. A fork is cut at a completed run: its user message and everything it
 * produced travel to the child. Run-less history (a V1 transcript or imported session) forks by
 * message: `sourceMessageId` at a run-less user message copies through the turn it started, and
 * `latest_stable` with no stable run copies all of it.
 */

type ForkableRun = Pick<OrchestrationV2Run, "id" | "userMessageId" | "status">;

/** Where a fork is cut. */
export type ThreadForkPoint =
  | { readonly type: "run"; readonly runId: RunId }
  /**
   * Run-less history: through the turn started by user message `messageId`,
   * or all of it when `messageId` is null (whole-thread fork).
   */
  | { readonly type: "runless"; readonly messageId: MessageId | null };

/** The V2 source point for forking through `runId`. */
export function forkSourcePointForRun(runId: RunId): OrchestrationV2ThreadForkSourcePoint {
  return { type: "run", runId };
}

/**
 * Whether the thread itself holds run-less history the server can fork (`hasRunlessHistory`). A
 * V2 native fork child (`forkedFrom` set) inherits `importedFrom`/`historyOrigin`, but its history
 * stays on the parent and the server rejects the fork. A run-less fork child (`forkedFrom` null)
 * owns its copy, so it stays forkable.
 */
export function hasRunlessForkHistory(
  thread:
    | Pick<EnvironmentThreadShell, "historyOrigin" | "importedFrom" | "forkedFrom">
    | null
    | undefined,
): boolean {
  if (thread == null || thread.forkedFrom != null) return false;
  return thread.historyOrigin === "v1_import" || thread.importedFrom != null;
}

/**
 * The `thread.fork` source fields for `point`. A run cut may name its anchor
 * user message (recorded as the child's `forkOrigin.messageId`); a run-less cut
 * is addressed by message alone and rides on `latest_stable`.
 */
export function forkCommandSource(
  point: ThreadForkPoint,
  anchorMessageId?: MessageId,
): {
  readonly sourcePoint: OrchestrationV2ThreadForkSourcePoint;
  readonly sourceMessageId?: MessageId;
} {
  if (point.type === "run") {
    return {
      sourcePoint: forkSourcePointForRun(point.runId),
      ...(anchorMessageId === undefined ? {} : { sourceMessageId: anchorMessageId }),
    };
  }
  return {
    sourcePoint: { type: "latest_stable" },
    ...(point.messageId === null ? {} : { sourceMessageId: point.messageId }),
  };
}

export function isSameForkPoint(left: ThreadForkPoint, right: ThreadForkPoint): boolean {
  return left.type === "run"
    ? right.type === "run" && left.runId === right.runId
    : right.type === "runless" && left.messageId === right.messageId;
}

/**
 * The point a shell-only surface (header menu, sidebar row, palette, /fork)
 * forks the whole thread at: the latest run once it completed; for a thread
 * that never ran but holds run-less history, all of that history; otherwise
 * null.
 */
export function latestForkPoint(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "historyOrigin" | "importedFrom" | "forkedFrom">
    | null
    | undefined,
): ThreadForkPoint | null {
  const runId = latestForkableRunId(shell);
  if (runId !== null) return { type: "run", runId };
  return shell != null && shell.latestRun === null && hasRunlessForkHistory(shell)
    ? { type: "runless", messageId: null }
    : null;
}

/**
 * The run a shell-only surface (header menu, sidebar row, palette, /fork) forks
 * through: the latest run once it completed, otherwise null.
 */
export function latestForkableRunId(
  shell: Pick<EnvironmentThreadShell, "latestRun"> | null | undefined,
): RunId | null {
  const run = shell?.latestRun;
  return run != null && run.status === "completed" ? run.runId : null;
}

/**
 * User message -> completed run it started, for fork-from-message menus. Messages
 * without an entry (imported history, queued or still-running turns) cannot be
 * fork points.
 */
export function forkableRunIdsByUserMessage(
  runs: ReadonlyArray<ForkableRun>,
): ReadonlyMap<MessageId, RunId> {
  const byMessage = new Map<MessageId, RunId>();
  for (const run of runs) {
    if (run.status === "completed") byMessage.set(run.userMessageId, run.id);
  }
  return byMessage;
}

/** A timeline message as fork-point resolution sees it. */
export interface ForkPointMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant" | "system";
  readonly runId: RunId | null;
  readonly streaming?: boolean;
  /** Inherited from the parent of a fork child: not this thread's to cut. */
  readonly inherited?: boolean;
}

/**
 * Message-anchored fork points, oldest first. `byUserMessage` (edit-and-branch) forks through the
 * turn completed just before it; `byRunlessReply` forks through the reply's own turn. A turn
 * completes with a finished assistant message of a completed run other than `activeRunId`, or a
 * finished run-less reply (only with `runlessHistory`). Inherited rows are skipped.
 */
export function resolveMessageForkPoints(input: {
  readonly messages: Iterable<ForkPointMessage>;
  readonly completedRunIds: ReadonlySet<RunId>;
  readonly activeRunId: RunId | null;
  readonly runlessHistory: boolean;
}): {
  readonly byUserMessage: ReadonlyMap<MessageId, ThreadForkPoint>;
  readonly byRunlessReply: ReadonlyMap<MessageId, ThreadForkPoint>;
} {
  const byUserMessage = new Map<MessageId, ThreadForkPoint>();
  const byRunlessReply = new Map<MessageId, ThreadForkPoint>();
  let previous: ThreadForkPoint | null = null;
  let openRunlessTurn: ThreadForkPoint | null = null;
  for (const message of input.messages) {
    if (message.inherited === true) continue;
    if (message.role === "user") {
      if (previous !== null) byUserMessage.set(message.id, previous);
      openRunlessTurn =
        input.runlessHistory && message.runId === null
          ? { type: "runless", messageId: message.id }
          : null;
      continue;
    }
    if (message.role !== "assistant" || message.streaming === true) continue;
    if (message.runId === null) {
      if (openRunlessTurn !== null) {
        byRunlessReply.set(message.id, openRunlessTurn);
        previous = openRunlessTurn;
      }
      continue;
    }
    if (message.runId === input.activeRunId || !input.completedRunIds.has(message.runId)) {
      continue;
    }
    previous =
      previous?.type === "run" && previous.runId === message.runId
        ? previous
        : { type: "run", runId: message.runId };
  }
  return { byUserMessage, byRunlessReply };
}

type ForkChildShell = Pick<EnvironmentThreadShell, "title" | "forkedFrom" | "forkOrigin">;

/** The thread a fork child was cut from, or null when `thread` is not a fork child. */
export function forkParentThreadId(
  thread: Pick<EnvironmentThreadShell, "forkedFrom" | "forkOrigin">,
): ThreadId | null {
  if (thread.forkOrigin != null) return thread.forkOrigin.threadId;
  return thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : null;
}

/**
 * Whether a fork child still carries the title minted when it was forked:
 * Lecturn's "<parent> (fork)" (or "Untitled (fork)"), or upstream's
 * "<parent> fork" when the parent title is known. Anything else is a title the
 * user chose.
 */
export function isDefaultForkChildTitle(title: string, parentTitle?: string | null): boolean {
  const trimmed = title.trim();
  if (trimmed.endsWith("(fork)")) return true;
  const parent = parentTitle?.trim();
  return parent !== undefined && parent !== "" && trimmed === `${parent} fork`;
}

/**
 * The `titleSeed` a turn on `thread` sends. The server retitles a thread with no stored messages,
 * which a V2 fork child always is on its first send. So a fork child seeds its default title, a
 * renamed one sends no seed so the rename stands, and others seed from the message.
 */
export function resolveTurnTitleSeed(input: {
  readonly thread: ForkChildShell;
  readonly parentTitle?: string | null | undefined;
  readonly messageTitleSeed: string;
}): string | undefined {
  const { thread } = input;
  if (thread.forkOrigin == null && thread.forkedFrom == null) return input.messageTitleSeed;
  return isDefaultForkChildTitle(thread.title, input.parentTitle) ? thread.title.trim() : undefined;
}
