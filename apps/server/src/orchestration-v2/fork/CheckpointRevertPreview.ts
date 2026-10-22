/**
 * Lecturn: what a checkpoint rollback with file restore would delete for good.
 *
 * `git clean` during restore removes untracked, non-ignored files that have
 * no object in the repository, so the revert dialog lists them first. The
 * preview is advisory: when the scope, the checkpoint or its ref cannot be
 * resolved the rollback itself fails with a precise reason, so the preview
 * reports nothing at risk instead of a second, less useful error.
 */
import {
  ORCHESTRATION_REVERT_PREVIEW_MAX_PATHS,
  OrchestrationPreviewCheckpointRevertError,
  type OrchestrationPreviewCheckpointRevertInput,
  type OrchestrationPreviewCheckpointRevertResult,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

const NOTHING_AT_RISK: OrchestrationPreviewCheckpointRevertResult = {
  removedPaths: [],
  truncated: false,
};

export const previewCheckpointRevert = Effect.fn("orchestrationV2.previewCheckpointRevert")(
  function* (input: OrchestrationPreviewCheckpointRevertInput) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const previewError = (message: string, cause?: unknown) =>
      new OrchestrationPreviewCheckpointRevertError({
        message,
        ...(cause === undefined ? {} : { cause }),
      });
    const records = yield* projections
      .getThreadRecords(input.threadId, ["checkpointScopes", "checkpoints"])
      .pipe(Effect.mapError((cause) => previewError("Failed to load the thread.", cause)));
    if (records.thread.deletedAt !== null) {
      return yield* previewError("The thread no longer exists.");
    }
    const scope = records.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
    const checkpoint = records.checkpoints.find(
      (candidate) => candidate.id === input.checkpointId && candidate.scopeId === input.scopeId,
    );
    if (scope === undefined || checkpoint === undefined || checkpoint.status !== "ready") {
      return NOTHING_AT_RISK;
    }
    const deletions = yield* checkpointStore
      .listRestoreDeletions({
        cwd: scope.cwd,
        checkpointRef: checkpoint.ref,
        fallbackToHead: false,
      })
      .pipe(
        Effect.mapError((cause) =>
          previewError("Failed to inspect the workspace for files a revert would delete.", cause),
        ),
      );
    return {
      removedPaths: deletions.paths.slice(0, ORCHESTRATION_REVERT_PREVIEW_MAX_PATHS),
      truncated:
        deletions.truncated || deletions.paths.length > ORCHESTRATION_REVERT_PREVIEW_MAX_PATHS,
    } satisfies OrchestrationPreviewCheckpointRevertResult;
  },
);
