import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

/**
 * Resolves the checkpoint a rollback to `turnCount` restores. Turn count 0 is
 * the thread baseline (captured before the first run, so it has no run
 * ordinal); any other count is the latest checkpoint recorded for that run
 * ordinal. The revert preview and the rollback command share this rule so the
 * preview names exactly the files the rollback will delete.
 */
export function resolveRevertTargetCheckpoint(
  checkpoints: OrchestrationV2ThreadProjection["checkpoints"],
  turnCount: number,
): OrchestrationV2ThreadProjection["checkpoints"][number] | undefined {
  return checkpoints.findLast((candidate) =>
    turnCount === 0
      ? candidate.ordinalWithinScope === 0 && candidate.appRunOrdinal === null
      : candidate.appRunOrdinal === turnCount,
  );
}

/** Derives the checkpoint/diff rows needed by review UIs from native V2 entities. */
export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}
