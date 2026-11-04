import {
  OrchestrationV2Actor,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointFileSummary,
  type SquireFileEntry,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { resolveInferenceModel } from "../textGeneration/inferenceModel.ts";
import * as SquireSummaries from "./SquireSummaries.ts";
import {
  parseSquireNameStatus,
  squireFilesFromCheckpoint,
  squireSummaryInputFromRun,
  type SquireRunSnapshot,
} from "./SquireSummaryInput.ts";

type TurnItem<T extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { readonly type: T }
>;
type Projection = Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "nodes" | "turnItems">;

const isActor = Schema.is(OrchestrationV2Actor);
const isType =
  <T extends OrchestrationV2TurnItem["type"]>(type: T) =>
  (item: OrchestrationV2TurnItem): item is TurnItem<T> =>
    item.type === type;

// Checkpoint paths are repo-relative; Claude reports absolute item paths.
const relativeTo = (root: string | null) => (path: string) =>
  root !== null && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

const relativeFileChanges = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  relative: (path: string) => string,
) =>
  items.map((item) =>
    item.type === "file_change"
      ? {
          ...item,
          fileName: relative(item.fileName),
          ...(item.changes
            ? {
                changes: item.changes.map((change) => ({
                  ...change,
                  path: relative(change.path),
                })),
              }
            : {}),
        }
      : item,
  );

/** Before a checkpoint exists: the run's own file-change items, one entry per path. */
function filesFromItems(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  const summaries = new Map<string, OrchestrationV2CheckpointFileSummary>();
  let insertions = 0;
  let deletions = 0;
  for (const item of items.filter(isType("file_change"))) {
    insertions += item.additions ?? 0;
    deletions += item.deletions ?? 0;
    for (const path of [item.fileName, ...(item.changes ?? []).map((change) => change.path)]) {
      if (!summaries.has(path)) {
        summaries.set(path, { path, kind: "modified", additions: 0, deletions: 0 });
      }
    }
  }
  return {
    files: squireFilesFromCheckpoint([...summaries.values()], items),
    insertions,
    deletions,
  };
}

function pendingRequestOf(
  projection: Projection,
  runId: SquireSummaries.SquireSummaryKey["runId"],
  requestId: string | null,
): SquireRunSnapshot["pendingRequest"] {
  const runNodes = new Set(
    projection.nodes.filter((node) => node.runId === runId).map((node) => node.id),
  );
  const runtime = projection.runtimeRequests.findLast(
    (request) =>
      request.status === "pending" &&
      runNodes.has(request.nodeId) &&
      (requestId === null || request.id === requestId),
  );
  if (runtime) {
    const questions =
      runtime.kind === "user_input"
        ? projection.turnItems
            .filter(isType("user_input_request"))
            .findLast((item) => item.requestId === runtime.id)
            ?.questions.map((question) => question.question)
        : undefined;
    return {
      kind: runtime.kind,
      requestId: runtime.id,
      question: questions && questions.length > 0 ? questions.join("\n") : null,
    };
  }
  const secret = projection.turnItems
    .filter(isType("secret_request"))
    .findLast(
      (item) => item.secretStatus === "pending" && (requestId === null || item.id === requestId),
    );
  if (!secret) return null;
  const reason = secret.reason.trim();
  return {
    kind: "secret",
    requestId: secret.id,
    question: reason ? `${secret.label}: ${reason}` : secret.label,
  };
}

/**
 * The actor of the run's last interrupt request. One with no recorded
 * provenance (history from before interrupts recorded their actor) counts as the user's.
 */
function interruptActorOf(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  const request = items.findLast(isType("run_interrupt_request"));
  if (!request) return null;
  return "createdBy" in request && isActor(request.createdBy) ? request.createdBy : "user";
}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;

  /**
   * Exact added/deleted kinds from the checkpoint's `name-status` diff against
   * its parent, without the paths a pull or rebase brought in. Null
   * when the diff cannot be read; the caller then keeps the hinted kinds.
   */
  const nameStatusFiles = (
    checkpoint: OrchestrationV2Checkpoint,
    records: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "checkpointScopes">,
  ) => {
    const parent = records.checkpoints.find(
      (candidate) => candidate.id === checkpoint.parentCheckpointId,
    );
    const scope = records.checkpointScopes.find((candidate) => candidate.id === checkpoint.scopeId);
    if (!parent || !scope) return Effect.succeed(null);
    const refs = {
      cwd: scope.cwd,
      fromCheckpointRef: parent.ref,
      toCheckpointRef: checkpoint.ref,
    };
    return Effect.all([
      checkpointStore.diffCheckpoints({
        ...refs,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
        format: "name-status",
      }),
      checkpointStore.listAuthoredPaths(refs).pipe(Effect.orElseSucceed(() => null)),
    ]).pipe(
      Effect.map(([diff, authoredPaths]): ReadonlyArray<SquireFileEntry> | null =>
        parseSquireNameStatus(diff).filter(
          (file) => authoredPaths === null || authoredPaths.has(file.path),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("squire run source name-status diff failed", {
          checkpointId: checkpoint.id,
          cause: String(cause),
        }).pipe(Effect.as(null)),
      ),
    );
  };

  const load: SquireSummaries.SquireRunSource["Service"]["load"] = Effect.fn(
    "SquireRunSource.load",
  )(function* ({ threadId, runId, stage }) {
    const fail = (detail: string) =>
      new SquireSummaries.SquireRunSourceError({ threadId, runId, detail });
    const readFailed = (error: ProjectionStore.ProjectionStoreV2Error) =>
      fail(
        error._tag === "ProjectionStoreThreadNotFoundError"
          ? "thread not found"
          : "projection read failed",
      );

    const records = yield* projections
      .getThreadRecords(
        threadId,
        ["runs", "turnItems", "runtimeRequests", "nodes", "providerThreads"],
        // Runtime-request nodes are never settled leaves, so they stay.
        { runIds: [runId], turnItemRunId: runId, omitSettledLeafNodes: true },
      )
      .pipe(Effect.mapError(readFailed));
    const run = records.runs.find((candidate) => candidate.id === runId);
    if (!run) return yield* fail("run not found");
    const { thread } = records;
    const turnItems = records.turnItems.toSorted((a, b) => a.ordinal - b.ordinal);

    const project = yield* projects
      .get(thread.projectId, { includeDeleted: true })
      .pipe(Effect.mapError(() => fail("project read failed")));
    const relative = relativeTo(
      thread.worktreePath ?? Option.getOrNull(Option.map(project, (row) => row.workspaceRoot)),
    );

    const instance = yield* instances.getInstance(run.providerInstanceId);
    const driverKind =
      instance?.driverKind ??
      (
        records.providerThreads.find(
          (providerThread) => providerThread.id === run.providerThreadId,
        ) ??
        records.providerThreads.find(
          (providerThread) => providerThread.providerInstanceId === run.providerInstanceId,
        )
      )?.driver;
    if (driverKind === undefined) return yield* fail("provider instance not found");

    const requestId = stage === "terminal" ? null : stage.slice("request:".length);
    const relativeItems = relativeFileChanges(turnItems, relative);
    let changes = filesFromItems(relativeItems);
    if (stage === "terminal") {
      const checkpointRecords = yield* projections
        .getThreadRecords(threadId, ["checkpoints", "checkpointScopes"])
        .pipe(Effect.mapError(readFailed));
      const { checkpoints } = checkpointRecords;
      const checkpoint =
        checkpoints.find((candidate) => candidate.id === run.checkpointId) ??
        checkpoints.findLast((candidate) => candidate.runId === runId);
      if (checkpoint && (checkpoint.status === "ready" || checkpoint.status === "stale")) {
        const exact = yield* nameStatusFiles(checkpoint, checkpointRecords);
        changes = {
          files: exact ?? squireFilesFromCheckpoint(checkpoint.files, relativeItems),
          insertions: checkpoint.files.reduce((sum, file) => sum + file.additions, 0),
          deletions: checkpoint.files.reduce((sum, file) => sum + file.deletions, 0),
        };
      }
    }

    const snapshot: SquireRunSnapshot = {
      thread: {
        threadId,
        title: thread.title,
        project: Option.match(project, { onNone: () => "", onSome: (row) => row.title }),
        projectId: thread.projectId,
        provider: driverKind,
      },
      runId,
      status: run.status,
      pendingRequest: pendingRequestOf({ ...records, turnItems }, runId, requestId),
      interruptedBy:
        run.status === "interrupted" || run.status === "cancelled"
          ? interruptActorOf(turnItems)
          : null,
      turnItems,
      ...changes,
      pullRequest: null,
    };

    const threadModel =
      instance?.enabled && instance.textGeneration.generateSquireTurnSummary
        ? resolveInferenceModel(
            run.modelSelection,
            instance.driverKind,
            (yield* instance.snapshot.getSnapshot).models,
          )
        : null;
    return { input: squireSummaryInputFromRun(snapshot), threadModel };
  });

  return SquireSummaries.SquireRunSource.of({ load });
});

export const layer = Layer.effect(SquireSummaries.SquireRunSource, make);
