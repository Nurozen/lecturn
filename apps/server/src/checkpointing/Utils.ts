import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@lecturn/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/lecturn/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

// Persisted refs retain the namespace used when their snapshots were captured.
// Match the checkpoint structure so older namespaces remain usable without an
// application-name compatibility list. Provider placeholders are not Git refs.
export function isThreadCheckpointRef(ref: string): boolean {
  return /^refs\/[^/]+\/checkpoints\/[^/]+\/turn\/\d+$/.test(ref);
}

export function checkpointBaselineRefForThread(
  threadId: ThreadId,
  checkpoints: ReadonlyArray<{
    readonly checkpointTurnCount: number;
    readonly checkpointRef: string;
  }>,
): CheckpointRef {
  const earliest = checkpoints.reduce<(typeof checkpoints)[number] | undefined>(
    (first, checkpoint) =>
      isThreadCheckpointRef(checkpoint.checkpointRef) &&
      (first === undefined || checkpoint.checkpointTurnCount < first.checkpointTurnCount)
        ? checkpoint
        : first,
    undefined,
  );
  return earliest
    ? CheckpointRef.make(earliest.checkpointRef.replace(/\/turn\/\d+$/, "/turn/0"))
    : checkpointRefForThreadTurn(threadId, 0);
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
