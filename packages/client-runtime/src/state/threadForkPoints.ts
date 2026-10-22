import type {
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2ThreadForkSourcePoint,
  RunId,
} from "@lecturn/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

/**
 * Lecturn fork points on V2. A fork is cut at a completed run: the run's user
 * message and everything that run produced travel to the child. The V1
 * `completedTurns` list is gone; runs carry the same information.
 */

type ForkableRun = Pick<OrchestrationV2Run, "id" | "userMessageId" | "status">;

/** The V2 source point for forking through `runId`. */
export function forkSourcePointForRun(runId: RunId): OrchestrationV2ThreadForkSourcePoint {
  return { type: "run", runId };
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
