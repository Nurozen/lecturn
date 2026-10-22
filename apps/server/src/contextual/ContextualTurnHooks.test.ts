import { assert, it } from "@effect/vitest";
import * as C from "@lecturn/contracts";
import { Effect, Fiber, Result, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type {
  LecturnTurnStartDecision,
  LecturnTurnStartInput,
  LecturnRunTerminalNotice,
} from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import { LecturnHookRejectedError } from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import { renderContextualEvidence } from "../provider/ContextualDispatch.ts";
import {
  clearV2Projection,
  insertV2Message,
  insertV2Run,
  insertV2Thread,
} from "../threadDecisions/V2ProjectionTestFixtures.ts";
import { ContextualLifecycle, make as makeLifecycle } from "./ContextualLifecycle.ts";
import { ContextualNotifications, make as makeNotifications } from "./ContextualNotifications.ts";
import { ContextualRepository } from "./ContextualRepository.ts";
import { ContextualService } from "./ContextualService.ts";
import { ContextualSettings, make as makeSettings } from "./ContextualSettings.ts";
import { ContextualTurnCoordinator, makeCoordinator } from "./ContextualTurnCoordinator.ts";
import { make } from "./ContextualTurnHooks.ts";
import { ContextualTurnQueue, make as makeQueue } from "./ContextualTurnQueue.ts";

const now = "2026-09-26T00:00:00.000Z";
const encodePreparation = Schema.encodeSync(Schema.fromJsonString(C.ContextualPreparation));
const projectId = C.ProjectId.make("hooks-project");
const threadId = C.ThreadId.make("hooks-thread");
const instanceId = C.ProviderInstanceId.make("codex");

const task = (messageId: string): C.ContextualTaskSnapshot => ({
  environmentId: C.EnvironmentId.make("env"),
  projectId,
  threadId,
  submissionId: `submission-${messageId}`,
  messageId: C.MessageId.make(messageId),
  turnId: null,
  providerInstanceId: instanceId,
  providerContextEpoch: "initial",
  taskFingerprint: "task",
  knownContextFingerprint: "known",
  threadSettingsRevision: 0,
  projectSettingsRevision: 0,
  sourceScopeRevision: 0,
  threadExclusionRevision: 0,
  fundingGeneration: 0,
  purgeGeneration: 0,
  newestMessage: "Build storage",
  projectDescription: "",
  recentContext: "",
  explicitReferences: [],
  trigger: "submission",
});
const evidence = {
  locator: {
    sourceKind: "slack",
    workspaceId: "workspace",
    channelId: "channel",
    messageTs: "1.000001",
    threadTs: null,
  },
  id: "evidence-1",
  sourceId: "slack:synthetic",
  sourceKind: "slack",
  occurrenceId: "occurrence",
  sourceRevision: 1,
  sourceHash: "h".repeat(64),
  canonicalVersion: "slack-text-v1",
  coordinateSystem: "utf16",
  quote: "Use SQLite for local storage.",
  start: 0,
  end: 29,
  prefix: "",
  suffix: "",
  author: "Alice",
  occurredAt: now,
  observedAt: now,
  sourceUrl: null,
  availability: "available",
  lineageIds: [],
} as unknown as C.ContextualEvidence;
const packetFor = (preparation: C.ContextualPreparation): C.ContextualPacket =>
  ({
    id: `packet-${preparation.id}`,
    preparationId: preparation.id,
    task: preparation.task,
    groups: [
      {
        candidateId: "candidate",
        occurrenceId: "occurrence",
        guidanceId: "guidance",
        contentFingerprint: "content",
        recordRevision: 1,
        evidence: [evidence],
        attribution: null,
        derivedSummary: null,
        reasons: [],
      },
    ],
    tokenCount: 40,
    tokenCounting: "conservative-bound",
    payloadRef: "payload",
    createdAt: now,
    resolutionIds: [],
    purpose: "new-context",
  }) as unknown as C.ContextualPacket;

const runFor = (runId: string, messageId: string) =>
  ({
    id: C.RunId.make(runId),
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    userMessageId: C.MessageId.make(messageId),
    status: "starting",
  }) as unknown as C.OrchestrationV2Run;
const turnInput = (runId: string, messageId: string): LecturnTurnStartInput =>
  ({
    thread: { id: threadId, projectId } as unknown as C.OrchestrationV2AppThread,
    run: runFor(runId, messageId),
    message: {
      id: C.MessageId.make(messageId),
      threadId,
      role: "user",
      text: "Build storage",
      attachments: [],
    } as unknown as LecturnTurnStartInput["message"],
    compaction: false,
  }) as LecturnTurnStartInput;
const terminal = (
  runId: string,
  status: LecturnRunTerminalNotice["status"],
  reconciled = false,
): LecturnRunTerminalNotice => ({
  threadId,
  runId: C.RunId.make(runId),
  status,
  sequence: 1,
  reconciled,
});

const harness = (
  options: { initialState?: C.ContextualPreparationState; notifications?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* clearV2Projection(sql);
    for (const table of [
      "contextual_turn_queue",
      "contextual_turn_watermarks",
      "contextual_thread_settings",
      "contextual_project_settings",
      "contextual_preparations",
      "contextual_supply",
      "contextual_outbox",
      "orchestration_v2_projection_run_attempts",
      "orchestration_v2_projection_provider_turns",
      "projection_projects",
    ])
      yield* sql`DELETE FROM ${sql(table)}`;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Hooks','/tmp/hooks','[]',${now},${now})`;
    yield* insertV2Thread(sql, { threadId, projectId });
    yield* insertV2Message(sql, {
      messageId: "earlier",
      threadId,
      role: "assistant",
      text: "Earlier answer",
      createdAt: "2026-09-25T00:00:00.000Z",
    });
    yield* sql`INSERT INTO contextual_thread_settings(thread_id,project_id,enabled,source_ids_json,updated_at) VALUES (${threadId},${projectId},1,'[]',${now})`;
    const preparations = new Map<string, C.ContextualPreparation>();
    const receipts: C.ContextualDeliveryReceipt[] = [];
    const prepareCalls: Array<{ recentContext: string }> = [];
    const settingsUpdates: C.ContextualThreadSettingsUpdateRequest[] = [];
    const stateFor = { next: options.initialState ?? ("prepared" as C.ContextualPreparationState) };
    const unavailable = new C.ContextualError({ code: "not-found", message: "missing" });
    const service = {
      taskSnapshot: (input: { messageId: C.MessageId; recentContext: string }) =>
        Effect.sync(() => {
          prepareCalls.push({ recentContext: input.recentContext });
          return task(input.messageId);
        }),
      prepare: (snapshot: C.ContextualTaskSnapshot) =>
        Effect.sync(() => {
          const preparation = {
            id: `prep-${snapshot.messageId}`,
            revision: 0,
            state: stateFor.next,
            packetId: `packet-prep-${snapshot.messageId}`,
            dispatchId: null,
            conflictIds: [],
            attemptsUsed: 1,
            comparisonPairsChecked: 0,
            updatedAt: now,
            coverage: {
              complete: true,
              missingAntecedents: false,
              truncated: false,
              unexaminedCount: 0,
            },
            task: snapshot,
          } as unknown as C.ContextualPreparation;
          preparations.set(preparation.id, preparation);
          return preparation;
        }),
      revalidate: (id: string) =>
        Effect.sync(() => {
          const preparation = preparations.get(id)!;
          return {
            preparation,
            packet: preparation.state === "prepared" ? packetFor(preparation) : null,
          };
        }),
      recover: () => Effect.void,
      updateThreadSettings: (input: C.ContextualThreadSettingsUpdateRequest) =>
        Effect.sync(() => {
          settingsUpdates.push(input);
          return input;
        }),
    };
    const repository = {
      get: (id: string) =>
        Effect.suspend(() => {
          const preparation = preparations.get(id);
          return preparation ? Effect.succeed(preparation) : Effect.fail(unavailable);
        }),
      update: (next: C.ContextualPreparation) =>
        Effect.sync(() => {
          preparations.set(next.id, next);
          return next;
        }),
      receipt: (receipt: C.ContextualDeliveryReceipt) =>
        Effect.sync(() => {
          receipts.push(receipt);
        }),
    };
    const queue = yield* makeQueue;
    const lifecycle = yield* makeLifecycle;
    const settings = yield* makeSettings;
    const coordinator = makeCoordinator(
      service as unknown as Parameters<typeof makeCoordinator>[0],
      repository as unknown as Parameters<typeof makeCoordinator>[1],
      queue,
    );
    const notifications = options.notifications ? yield* makeNotifications : undefined;
    const hooks = yield* make.pipe(
      notifications === undefined
        ? (effect) => effect
        : Effect.provideService(ContextualNotifications, notifications),
      Effect.provideService(ContextualTurnQueue, queue),
      Effect.provideService(ContextualTurnCoordinator, coordinator),
      Effect.provideService(ContextualLifecycle, lifecycle),
      Effect.provideService(ContextualSettings, settings),
      Effect.provideService(ContextualService, service as unknown as ContextualService["Service"]),
      Effect.provideService(
        ContextualRepository,
        repository as unknown as ContextualRepository["Service"],
      ),
    );
    const queueState = (runId: string) =>
      sql<{
        state: string;
      }>`SELECT state FROM contextual_turn_queue WHERE event_id=${runId}`.pipe(
        Effect.map((rows) => rows[0]?.state ?? null),
      );
    const providerTurn = (runId: string, nativeId: string | null) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,provider_turn_id,status,payload_json)
          VALUES (${`attempt-${runId}`},${threadId},${runId},1,'node','codex','provider-thread',${`turn-${runId}`},'completed','{}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json)
          VALUES (${`turn-${runId}`},${threadId},'provider-thread','node',${`attempt-${runId}`},1,'completed',${nativeId === null ? '{"nativeTurnRef":null}' : `{"nativeTurnRef":{"nativeId":"${nativeId}"}}`})`;
      });
    return {
      sql,
      hooks,
      preparations,
      receipts,
      prepareCalls,
      settingsUpdates,
      stateFor,
      queueState,
      providerTurn,
      notifications,
      /** A deferred run stays "starting" in the V2 projection between attempts. */
      startingRun: (runId: string, ordinal: number) =>
        insertV2Run(sql, { runId, threadId, ordinal, status: "starting" }),
    };
  });

const deferralOf = (decision: LecturnTurnStartDecision | void) =>
  decision && "defer" in decision ? decision.defer : undefined;

it.layer(SqlitePersistenceMemory)("Contextual V2 turn hooks", (it) => {
  it.effect("does nothing for threads without Contextual intent", () =>
    Effect.gen(function* () {
      const f = yield* harness();
      yield* f.sql`UPDATE contextual_thread_settings SET enabled=0`;
      assert.isUndefined(yield* f.hooks.beforeTurnStart(turnInput("run-off", "message-off")));
      assert.isNull(yield* f.queueState("run-off"));
      assert.equal(f.prepareCalls.length, 0);
      // Enabling Contextual mid-run never makes a restart of that run hold.
      yield* f.sql`UPDATE contextual_thread_settings SET enabled=1`;
      assert.deepEqual(yield* f.hooks.beforeTurnStart(turnInput("run-off", "message-off")), {});
      assert.isNull(yield* f.queueState("run-off"));
      assert.equal(f.prepareCalls.length, 0);
      // The run's terminal releases the pin; its next run sees the setting.
      yield* f.hooks.onRunTerminal(terminal("run-off", "completed"));
      assert.isDefined(yield* f.hooks.beforeTurnStart(turnInput("run-on", "message-on")));
      assert.equal(f.prepareCalls.length, 1);
      // A rolled-back run's terminal releases its pin too.
      yield* f.sql`UPDATE contextual_thread_settings SET enabled=0`;
      assert.isUndefined(yield* f.hooks.beforeTurnStart(turnInput("run-back", "message-back")));
      yield* f.sql`UPDATE contextual_thread_settings SET enabled=1`;
      yield* f.hooks.onRunTerminal(terminal("run-back", "rolled_back"));
      yield* f.hooks.beforeTurnStart(turnInput("run-back", "message-back"));
      assert.equal(f.prepareCalls.length, 2);
    }),
  );

  it.effect(
    "injects the bound packet as provider-only context and records an accepted receipt",
    () =>
      Effect.gen(function* () {
        const f = yield* harness();
        const decision = yield* f.hooks.beforeTurnStart(turnInput("run-1", "message-1"));
        const prefix = decision && "contextPrefix" in decision ? decision.contextPrefix : undefined;
        assert.isString(prefix);
        assert.isTrue(prefix!.startsWith(renderContextualEvidence("").split("\n")[0]!));
        assert.include(prefix!, "Use SQLite for local storage.");
        assert.equal(f.prepareCalls[0]?.recentContext, "assistant: Earlier answer");
        assert.equal(yield* f.queueState("run-1"), "dispatching");
        assert.equal(f.preparations.get("prep-message-1")?.state, "dispatching");
        // A retried start attempt of the same run reuses the bound dispatch.
        assert.deepEqual(yield* f.hooks.beforeTurnStart(turnInput("run-1", "message-1")), {
          contextPrefix: prefix!,
        });
        assert.equal(f.prepareCalls.length, 1);
        yield* f.providerTurn("run-1", "native-turn-1");
        yield* f.hooks.onRunTerminal(terminal("run-1", "completed"));
        assert.equal(f.receipts.length, 1);
        const receipt = f.receipts[0]!;
        assert.equal(receipt.acceptance, "accepted");
        assert.isTrue(receipt.evidenceIncluded);
        assert.equal(receipt.turnId, "turn-run-1");
        assert.equal(receipt.providerReceiptId, "native-turn-1");
        assert.deepEqual(receipt.suppliedEvidenceIds, ["evidence-1"]);
        assert.equal(receipt.dispatchId, "contextual-dispatch:run-1");
        assert.equal(yield* f.queueState("run-1"), "done");
        // Finished runs are never readmitted (projection rebuilds never call the hook at all).
        assert.isUndefined(yield* f.hooks.beforeTurnStart(turnInput("run-1", "message-1")));
        assert.equal(yield* f.queueState("run-1"), "done");
      }),
  );

  it.effect("records a rejected receipt when the provider never started the turn", () =>
    Effect.gen(function* () {
      const f = yield* harness();
      yield* f.hooks.beforeTurnStart(turnInput("run-2", "message-2"));
      yield* f.hooks.onRunTerminal(terminal("run-2", "failed"));
      assert.equal(f.receipts[0]?.acceptance, "rejected");
      assert.deepEqual(f.receipts[0]?.suppliedEvidenceIds, []);
      assert.equal(yield* f.queueState("run-2"), "done");
    }),
  );

  it.effect("a reconciled terminal leaves delivery unknown", () =>
    Effect.gen(function* () {
      const f = yield* harness();
      yield* f.hooks.beforeTurnStart(turnInput("run-3", "message-3"));
      yield* f.providerTurn("run-3", "native-turn-3");
      yield* f.hooks.onRunTerminal(terminal("run-3", "interrupted", true));
      assert.equal(f.receipts[0]?.acceptance, "unknown");
      assert.equal(yield* f.queueState("run-3"), "unknown");
    }),
  );

  it.effect(
    "defers a held turn without a hold limit and cancels (not fails) it when the user cancels",
    () =>
      Effect.gen(function* () {
        const f = yield* harness({ initialState: "awaiting-conflict-review" });
        yield* f.startingRun("run-4", 4);
        const first = yield* f.hooks.beforeTurnStart(turnInput("run-4", "message-4"));
        assert.isDefined(deferralOf(first));
        assert.equal(yield* f.queueState("run-4"), "held");
        // No fail-open: a long review keeps deferring (the run holds no effect slot).
        yield* TestClock.adjust("2 hours");
        assert.isDefined(
          deferralOf(yield* f.hooks.beforeTurnStart(turnInput("run-4", "message-4"))),
        );
        assert.equal(f.prepareCalls.length, 1);
        // The conflict resolution "cancel-turn" cancels the preparation.
        const held = f.preparations.get("prep-message-4")!;
        f.preparations.set(held.id, { ...held, state: "canceled", revision: held.revision + 1 });
        const result = yield* f.hooks
          .beforeTurnStart(turnInput("run-4", "message-4"))
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, LecturnHookRejectedError);
          assert.equal(result.failure.contribution, "contextual");
          assert.equal(result.failure.disposition, "cancelled");
        }
        assert.equal(yield* f.queueState("run-4"), "canceled");
        // A later attempt of the canceled run stays canceled; it is never sent without context.
        const again = yield* f.hooks
          .beforeTurnStart(turnInput("run-4", "message-4"))
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(again));
      }),
  );

  it.effect("a deferred turn sends on the next attempt once the conflict is resolved", () =>
    Effect.gen(function* () {
      const f = yield* harness({ initialState: "awaiting-conflict-review" });
      yield* f.startingRun("run-5", 5);
      assert.isDefined(deferralOf(yield* f.hooks.beforeTurnStart(turnInput("run-5", "message-5"))));
      assert.equal(yield* f.queueState("run-5"), "held");
      const held = f.preparations.get("prep-message-5")!;
      f.preparations.set(held.id, { ...held, state: "prepared", revision: held.revision + 1 });
      const decision = yield* f.hooks.beforeTurnStart(turnInput("run-5", "message-5"));
      assert.include(
        decision && "contextPrefix" in decision ? (decision.contextPrefix ?? "") : "",
        "Use SQLite",
      );
      assert.equal(yield* f.queueState("run-5"), "dispatching");
      // The re-attempt resumed the preparation by id instead of preparing again.
      assert.equal(f.prepareCalls.length, 1);
    }),
  );

  it.effect("a deferral wakes on the next Contextual change", () =>
    Effect.gen(function* () {
      const f = yield* harness({ initialState: "awaiting-conflict-review", notifications: true });
      const deferral = deferralOf(yield* f.hooks.beforeTurnStart(turnInput("run-8", "message-8")));
      assert.isDefined(deferral?.wake);
      const woke = yield* Effect.forkChild(deferral!.wake!);
      yield* Effect.yieldNow;
      assert.isUndefined(woke.pollUnsafe());
      yield* f.notifications!.publish;
      yield* Fiber.join(woke);
    }),
  );

  it.effect(
    "interrupting a deferred run (run.interrupt) cancels its preparation, never sends",
    () =>
      Effect.gen(function* () {
        const f = yield* harness({ initialState: "awaiting-conflict-review" });
        assert.isDefined(
          deferralOf(yield* f.hooks.beforeTurnStart(turnInput("run-6", "message-6"))),
        );
        assert.equal(yield* f.queueState("run-6"), "held");
        // run.interrupt cancels the pending start effect and settles the run; the
        // terminal notice cancels the queued turn.
        yield* f.sql`INSERT INTO contextual_preparations(id,thread_id,project_id,submission_id,message_id,state,revision,preparation_json,created_at,updated_at)
        VALUES ('prep-message-6',${threadId},${projectId},'submission','message-6','evaluating',0,${encodePreparation({ ...f.preparations.get("prep-message-6")!, state: "evaluating" })},${now},${now})`;
        yield* f.hooks.onRunTerminal(terminal("run-6", "interrupted"));
        assert.equal(yield* f.queueState("run-6"), "canceled");
        const rows = yield* f.sql<{
          state: string;
        }>`SELECT state FROM contextual_preparations WHERE id='prep-message-6'`;
        assert.equal(rows[0]?.state, "canceled");
        assert.equal(f.receipts.length, 0);
      }),
  );

  it.effect("compaction runs never receive optional context", () =>
    Effect.gen(function* () {
      const f = yield* harness();
      assert.isUndefined(
        yield* f.hooks.beforeTurnStart({ ...turnInput("run-7", "message-7"), compaction: true }),
      );
      assert.isNull(yield* f.queueState("run-7"));
    }),
  );

  it.effect("thread.create applies its contextual option after commit", () =>
    Effect.gen(function* () {
      const f = yield* harness();
      const applied: Array<unknown> = [];
      const command = {
        type: "thread.create",
        threadId,
        contextual: { enabled: false, sourceIds: ["decisions:x"] },
      } as unknown as C.OrchestrationV2ServerCommand;
      const result = yield* f.hooks.contribution.aroundCommand!(
        { scope: "thread", command },
        Effect.sync(() => {
          applied.push("commit");
          return "committed";
        }),
      );
      assert.equal(result, "committed");
      assert.deepEqual(applied, ["commit"]);
      assert.deepEqual(f.settingsUpdates, [
        { threadId, expectedRevision: 0, enabled: false, sourceIds: ["decisions:x"] },
      ]);
      // Other commands pass through untouched.
      yield* f.hooks.contribution.aroundCommand!(
        { scope: "thread", command: { type: "thread.archive", threadId } as never },
        Effect.void,
      );
      assert.equal(f.settingsUpdates.length, 1);
    }),
  );
});
