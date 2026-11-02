import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VcsProcessExitError,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointFileSummary,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { make } from "./SquireRunSource.ts";
import type { SquireSummaryStage } from "./SquireSummaries.ts";
import {
  assistantMessage,
  command,
  fileChange,
  summaryRunId,
  summaryThreadId,
  turnItem,
  userMessage,
} from "./testkit/summaryRun.ts";

const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const instanceId = ProviderInstanceId.make("claude-work");
const claudeAgent = ProviderDriverKind.make("claudeAgent");
const projectId = ProjectId.make("project-billing");
const rootNodeId = NodeId.make("node-root");
const modelSelection = { instanceId, model: "claude-opus-5" };

const run = (overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: summaryRunId,
  threadId: summaryThreadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("msg-user"),
  rootNodeId,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
  ...overrides,
});

const projection = (
  overrides: Partial<OrchestrationV2ThreadProjection> = {},
): OrchestrationV2ThreadProjection => ({
  thread: {
    id: summaryThreadId,
    projectId,
    title: "Fix invoice rounding",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/work/billing",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: summaryThreadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [run()],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
  ...overrides,
});

const scopeId = CheckpointScopeId.make("scope-1");

const checkpoint = (
  files: ReadonlyArray<OrchestrationV2CheckpointFileSummary>,
  overrides: Partial<OrchestrationV2Checkpoint> = {},
): OrchestrationV2Checkpoint => ({
  id: CheckpointId.make("checkpoint-1"),
  threadId: summaryThreadId,
  scopeId,
  runId: summaryRunId,
  nodeId: rootNodeId,
  parentCheckpointId: null,
  ordinalWithinScope: 1,
  appRunOrdinal: 1,
  ref: CheckpointRef.make("refs/lecturn/checkpoint-1"),
  status: "ready",
  files,
  capturedAt: now,
  ...overrides,
});

const baseline = checkpoint([], {
  id: CheckpointId.make("checkpoint-0"),
  runId: null,
  ordinalWithinScope: 0,
  appRunOrdinal: null,
  ref: CheckpointRef.make("refs/lecturn/checkpoint-0"),
});

const scope: OrchestrationV2CheckpointScope = {
  id: scopeId,
  threadId: summaryThreadId,
  runId: summaryRunId,
  nodeId: rootNodeId,
  parentScopeId: null,
  providerThreadId: null,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd: "/work/billing",
  createdAt: now,
};

/** What the checkpoint store's git reads return; a missing diff fails. */
interface GitState {
  readonly nameStatus?: string;
  readonly authoredPaths?: ReadonlySet<string> | null;
}

/** A pending runtime request raised by a node of this run. */
const runtimeRequest = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"],
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
) => {
  const nodeId = NodeId.make(`node-${id}`);
  return {
    request: {
      id: RuntimeRequestId.make(id),
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status,
      responseCapability: { type: "message" },
      createdAt: now,
      resolvedAt: null,
    } satisfies OrchestrationV2RuntimeRequest,
    node: {
      id: nodeId,
      threadId: summaryThreadId,
      runId: summaryRunId,
      parentNodeId: rootNodeId,
      rootNodeId,
      kind: kind === "user_input" ? "user_input_request" : "approval_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: RuntimeRequestId.make(id),
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    } satisfies OrchestrationV2ThreadProjection["nodes"][number],
  };
};

const changedFile = (fileName: string, additions: number, deletions: number, operation?: string) =>
  turnItem("file_change", {
    fileName,
    additions,
    deletions,
    ...(operation ? { changes: [{ operation, path: fileName }] } : {}),
  });

interface InstanceOptions {
  readonly enabled?: boolean;
  readonly summaries?: boolean;
}

// Only the members the run source reads.
const instance = ({ enabled = true, summaries = true }: InstanceOptions = {}) =>
  ({
    instanceId,
    driverKind: claudeAgent,
    enabled,
    snapshot: {
      getSnapshot: Effect.succeed({
        models: [{ slug: "claude-opus-5" }, { slug: "claude-sonnet-5" }],
      }),
    },
    textGeneration: summaries ? { generateSquireTurnSummary: () => Effect.die("unused") } : {},
  }) as unknown as ProviderInstance;

const load = (
  state: OrchestrationV2ThreadProjection,
  stage: SquireSummaryStage = "terminal",
  provider: ProviderInstance | null = instance(),
  runId = summaryRunId,
  git: GitState = {},
) =>
  Effect.gen(function* () {
    const source = yield* make;
    return yield* source.load({ threadId: summaryThreadId, runId, stage });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (threadId, _fields, filter) =>
            threadId === state.thread.id
              ? Effect.succeed({
                  ...state,
                  runs: state.runs.filter(
                    (row) => filter?.runIds === undefined || filter.runIds.includes(row.id),
                  ),
                  turnItems: state.turnItems.filter(
                    (row) =>
                      filter?.turnItemRunId === undefined || row.runId === filter.turnItemRunId,
                  ),
                })
              : Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              Option.some({
                projectId,
                title: "billing-service",
                workspaceRoot: "/repo/billing",
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: "2026-10-01T00:00:00.000Z",
                updatedAt: "2026-10-01T00:00:00.000Z",
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(provider ?? undefined),
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: (input) =>
            input.format === "name-status" &&
            input.cwd === scope.cwd &&
            input.fromCheckpointRef === baseline.ref &&
            git.nameStatus !== undefined
              ? Effect.succeed(git.nameStatus)
              : Effect.fail(
                  new VcsProcessExitError({
                    operation: "test",
                    command: "git diff",
                    cwd: input.cwd,
                    exitCode: 128,
                    detail: "unknown revision",
                  }),
                ),
          listAuthoredPaths: () => Effect.succeed(git.authoredPaths ?? null),
        }),
      ),
    ),
  );

const interruptRequest = (createdBy?: "user" | "agent" | "system"): OrchestrationV2TurnItem => {
  const item = turnItem("run_interrupt_request", { message: "Interrupt requested" });
  // Old history carries no `createdBy` on the item.
  return createdBy === undefined ? item : Object.assign(item, { createdBy });
};

it.effect("reads a completed run with its checkpoint", () =>
  Effect.gen(function* () {
    const { input, threadModel } = yield* load(
      projection({
        runs: [run({ checkpointId: CheckpointId.make("checkpoint-1") })],
        turnItems: [
          userMessage("Round invoices half-up"),
          changedFile("/work/billing/src/round.ts", 3, 1),
          changedFile("/work/billing/src/half-up.ts", 10, 0, "add"),
          command("vp test run src/round.test.ts", 0),
          assistantMessage("Rounding now uses half-up."),
          { ...userMessage("another run"), runId: RunId.make("run-2") },
        ],
        checkpoints: [
          checkpoint([
            { path: "src/round.ts", kind: "modified", additions: 3, deletions: 1 },
            { path: "src/half-up.ts", kind: "modified", additions: 12, deletions: 0 },
          ]),
        ],
      }),
    );
    assert.deepEqual(input.thread, {
      threadId: summaryThreadId,
      title: "Fix invoice rounding",
      project: "billing-service",
      projectId,
      provider: claudeAgent,
    });
    assert.deepEqual(input.session, {
      status: "completed",
      pendingRuntimeRequest: null,
      interruptedBy: null,
    });
    assert.deepEqual(input.files, [
      { path: "src/round.ts", change: "modified" },
      { path: "src/half-up.ts", change: "added" },
    ]);
    assert.deepEqual(input.diffStats, {
      added: 1,
      modified: 1,
      deleted: 0,
      insertions: 15,
      deletions: 1,
    });
    assert.deepEqual(input.messages, [
      { role: "user", text: "Round invoices half-up" },
      { role: "assistant", text: "Rounding now uses half-up.", final: true },
    ]);
    assert.deepInclude(input.toolCalls, {
      kind: "command",
      command: "vp test run src/round.test.ts",
      exitCode: 0,
    });
    assert.deepEqual(threadModel, {
      instanceId,
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "low" }],
    });
  }),
);

it.effect("takes terminal file kinds from the checkpoint's name-status diff", () =>
  Effect.gen(function* () {
    const state = projection({
      runs: [run({ checkpointId: CheckpointId.make("checkpoint-1") })],
      // The run's own items call every path a plain edit.
      turnItems: [
        changedFile("/work/billing/src/new.ts", 5, 0),
        changedFile("/work/billing/src/money.ts", 2, 2),
      ],
      checkpointScopes: [scope],
      checkpoints: [
        baseline,
        checkpoint(
          [
            { path: "src/new.ts", kind: "modified", additions: 5, deletions: 0 },
            { path: "src/money.ts", kind: "modified", additions: 2, deletions: 2 },
            { path: "src/legacy.ts", kind: "modified", additions: 0, deletions: 9 },
          ],
          { parentCheckpointId: baseline.id },
        ),
      ],
    });
    const nameStatus = [
      "A",
      "src/new.ts",
      "D",
      "src/legacy.ts",
      "D",
      "src/round.ts",
      "A",
      "src/money.ts",
      "M",
      "vendor/pulled.ts",
      "",
    ].join("\0");
    const authoredPaths = new Set(["src/new.ts", "src/legacy.ts", "src/round.ts", "src/money.ts"]);

    const { input } = yield* load(state, "terminal", instance(), summaryRunId, {
      nameStatus,
      authoredPaths,
    });
    // A rename (round.ts to money.ts) is a delete plus an add; a pulled path is dropped.
    assert.deepEqual(input.files, [
      { path: "src/new.ts", change: "added" },
      { path: "src/legacy.ts", change: "deleted" },
      { path: "src/round.ts", change: "deleted" },
      { path: "src/money.ts", change: "added" },
    ]);
    assert.deepEqual(input.diffStats, {
      added: 2,
      modified: 0,
      deleted: 2,
      insertions: 7,
      deletions: 11,
    });

    // Without a readable diff the kinds fall back to the run's file-change hints.
    const fallback = yield* load(state);
    assert.deepEqual(
      fallback.input.files.map((file) => file.change),
      ["modified", "modified", "modified"],
    );
  }),
);

it.effect("reads a provisional stage from file changes and the pending question", () =>
  Effect.gen(function* () {
    const asked = runtimeRequest("req-1", "user_input");
    const answered = runtimeRequest("req-0", "user_input", "resolved");
    const state = projection({
      runs: [run({ status: "waiting", completedAt: null })],
      nodes: [asked.node, answered.node],
      runtimeRequests: [answered.request, asked.request],
      turnItems: [
        fileChange("/work/billing/src/round.ts", "add"),
        changedFile("/work/billing/src/round.ts", 4, 2),
        changedFile("/work/billing/src/legacy.ts", 0, 9, "delete"),
        turnItem("user_input_request", {
          requestId: "req-1",
          questions: [
            { id: "q1", header: "Mode", question: "Round half-up or half-even?", options: [] },
            { id: "q2", header: "Scope", question: "Apply to refunds too?", options: [] },
          ],
        }),
      ],
      // A checkpoint is ignored before the run ends.
      checkpoints: [
        checkpoint([{ path: "stale.ts", kind: "modified", additions: 1, deletions: 1 }]),
      ],
    });

    const { input } = yield* load(state, "request:req-1");
    assert.deepEqual(input.session.pendingRuntimeRequest, {
      kind: "user_input",
      requestId: "req-1",
      question: "Round half-up or half-even?\nApply to refunds too?",
    });
    assert.deepEqual(input.files, [
      { path: "src/round.ts", change: "added" },
      { path: "src/legacy.ts", change: "deleted" },
    ]);
    assert.include(input.diffStats, { insertions: 4, deletions: 11 });

    const earlier = yield* load(state, "request:req-0");
    assert.isNull(earlier.input.session.pendingRuntimeRequest);
  }),
);

it.effect("reads a pending secret request as kind secret", () =>
  Effect.gen(function* () {
    const secret = turnItem("secret_request", {
      label: "STRIPE_API_KEY",
      reason: "Needed to run the billing integration tests.",
      secretStatus: "pending",
    });
    const { input } = yield* load(
      projection({ runs: [run({ status: "waiting" })], turnItems: [secret] }),
      `request:${secret.id}`,
    );
    assert.deepEqual(input.session.pendingRuntimeRequest, {
      kind: "secret",
      requestId: secret.id,
      question: "STRIPE_API_KEY: Needed to run the billing integration tests.",
    });
  }),
);

it.effect("reads who interrupted the run", () =>
  Effect.gen(function* () {
    const interruptedBy = (
      status: OrchestrationV2Run["status"],
      items: Array<OrchestrationV2TurnItem>,
    ) =>
      load(projection({ runs: [run({ status })], turnItems: items })).pipe(
        Effect.map(({ input }) => input.session.interruptedBy),
      );
    assert.equal(yield* interruptedBy("interrupted", [interruptRequest("agent")]), "agent");
    assert.equal(yield* interruptedBy("cancelled", [interruptRequest("system")]), "system");
    assert.equal(yield* interruptedBy("interrupted", [interruptRequest()]), "user");
    assert.isNull(yield* interruptedBy("interrupted", []));
    assert.isNull(yield* interruptedBy("completed", [interruptRequest("agent")]));
  }),
);

it.effect("offers the thread's model only when its instance writes Squire summaries", () =>
  Effect.gen(function* () {
    const state = projection();
    assert.isNull((yield* load(state, "terminal", instance({ summaries: false }))).threadModel);
    assert.isNull((yield* load(state, "terminal", instance({ enabled: false }))).threadModel);
  }),
);

it.effect("falls back to the recorded driver when the instance is gone", () =>
  Effect.gen(function* () {
    const providerThreadId = ProviderThreadId.make("provider-thread-1");
    const state = projection({
      runs: [run({ providerThreadId })],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: summaryThreadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "closed",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [],
          contextUsage: null,
          nativeMetadata: null,
          goal: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const { input, threadModel } = yield* load(state, "terminal", null);
    assert.equal(input.thread.provider, "codex");
    assert.isNull(threadModel);

    const unrecorded = yield* Effect.flip(load(projection(), "terminal", null));
    assert.equal(unrecorded.detail, "provider instance not found");
  }),
);

it.effect("fails with SquireRunSourceError for a missing run or thread", () =>
  Effect.gen(function* () {
    const missingRun = yield* Effect.flip(
      load(projection(), "terminal", instance(), RunId.make("run-gone")),
    );
    assert.equal(missingRun._tag, "SquireRunSourceError");
    assert.equal(missingRun.detail, "run not found");

    const missingThread = yield* Effect.flip(
      load(projection({ thread: { ...projection().thread, id: ThreadId.make("thr_other") } })),
    );
    assert.equal(missingThread.detail, "thread not found");
  }),
);
