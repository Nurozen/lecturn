import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadCheckpointSummaries,
  resolveRevertTargetCheckpoint,
} from "./threadCheckpoints.ts";

type Checkpoint = OrchestrationV2ThreadProjection["checkpoints"][number];

const scopeId = CheckpointScopeId.make("scope-root");
const capturedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const checkpoint = (
  id: string,
  ordinalWithinScope: number,
  appRunOrdinal: number | null,
): Checkpoint => ({
  id: CheckpointId.make(id),
  threadId: ThreadId.make("thread-1"),
  scopeId,
  runId: appRunOrdinal === null ? null : RunId.make(`run-${appRunOrdinal}`),
  nodeId: NodeId.make("node-1"),
  parentCheckpointId: null,
  ordinalWithinScope,
  appRunOrdinal,
  ref: CheckpointRef.make(`refs/lecturn/${id}`),
  status: "ready",
  files: [],
  capturedAt,
});

describe("resolveRevertTargetCheckpoint", () => {
  const checkpoints = [
    checkpoint("baseline", 0, null),
    checkpoint("run-1-a", 1, 1),
    checkpoint("run-1-b", 2, 1),
    checkpoint("run-2", 3, 2),
  ];

  it("resolves turn count 0 to the pre-run baseline the summaries omit", () => {
    expect(resolveRevertTargetCheckpoint(checkpoints, 0)?.id).toBe("baseline");
    // The review summaries drop the baseline, which is why the revert preview
    // cannot look the target up there.
    expect(
      deriveThreadCheckpointSummaries({
        checkpoints,
        messages: [],
      } as unknown as OrchestrationV2ThreadProjection).some(
        (summary) => summary.checkpointId === "baseline",
      ),
    ).toBe(false);
  });

  it("resolves a run ordinal to its latest checkpoint, like the rollback", () => {
    expect(resolveRevertTargetCheckpoint(checkpoints, 1)?.id).toBe("run-1-b");
    expect(resolveRevertTargetCheckpoint(checkpoints, 2)?.id).toBe("run-2");
    expect(resolveRevertTargetCheckpoint(checkpoints, 3)).toBeUndefined();
  });

  it("does not treat a later run-less checkpoint as the baseline", () => {
    expect(resolveRevertTargetCheckpoint([checkpoint("other", 4, null)], 0)).toBeUndefined();
  });
});
