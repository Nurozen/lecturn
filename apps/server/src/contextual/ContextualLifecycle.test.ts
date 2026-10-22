import { assert, it } from "@effect/vitest";
import {
  ContextualPreparation,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  clearV2Projection,
  insertV2Message,
  insertV2Run,
} from "../threadDecisions/V2ProjectionTestFixtures.ts";
import { applyFork, make } from "./ContextualLifecycle.ts";
import { make as makeQueue } from "./ContextualTurnQueue.ts";

const encodePreparation = Schema.encodeSync(Schema.fromJsonString(ContextualPreparation));
const parent = ThreadId.make("parent");
const child = ThreadId.make("child");
const projectId = ProjectId.make("p");
const now = "2026-09-26T00:00:00.000Z";
const preparation = (id: string, messageId: string, state: ContextualPreparation["state"]) =>
  ({
    id,
    revision: 0,
    state,
    packetId: ["prepared", "dispatching"].includes(state) ? `packet-${id}` : null,
    dispatchId: state === "dispatching" ? `dispatch-${id}` : null,
    conflictIds: [],
    attemptsUsed: 1,
    comparisonPairsChecked: 0,
    updatedAt: now,
    coverage: { complete: true, missingAntecedents: false, truncated: false, unexaminedCount: 0 },
    task: {
      environmentId: EnvironmentId.make("env"),
      projectId,
      threadId: parent,
      submissionId: "submission",
      messageId: MessageId.make(messageId),
      turnId: null,
      providerInstanceId: "codex",
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
    },
  }) as ContextualPreparation;

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* clearV2Projection(sql);
  for (const table of [
    "contextual_supply",
    "contextual_inherited_disclosures",
    "contextual_exclusions",
    "contextual_candidate_observations",
    "contextual_context_boundaries",
    "contextual_thread_settings",
    "contextual_outbox",
    "contextual_preparations",
    "contextual_packets",
    "contextual_turn_queue",
    "contextual_turn_watermarks",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT INTO contextual_thread_settings(thread_id,project_id,enabled,updated_at) VALUES(${parent},${projectId},1,${now})`;
  const insertPreparation = (value: ContextualPreparation) =>
    sql`INSERT INTO contextual_preparations(id,thread_id,project_id,submission_id,message_id,state,revision,preparation_json,created_at,updated_at)
      VALUES(${value.id},${parent},${projectId},${value.id},${value.task.messageId},${value.state},0,${encodePreparation(value)},${now},${now})`;
  const stateOf = (id: string) =>
    sql<{ state: string }>`SELECT state FROM contextual_preparations WHERE id=${id}`.pipe(
      Effect.map((rows) => rows[0]?.state),
    );
  return { sql, lifecycle: yield* make, queue: yield* makeQueue, insertPreparation, stateOf };
});

it.layer(SqlitePersistenceMemory)("Contextual V2 lifecycle", (it) => {
  it.effect("a fork child inherits supply, exclusions and observations idempotently", () =>
    Effect.gen(function* () {
      const { sql } = yield* fixture;
      for (const message of ["one", "later"])
        yield* sql`INSERT INTO contextual_supply VALUES(${parent},${message},${message},'initial',${message},${message},${message},1,'accepted',${now})`;
      yield* sql`INSERT INTO contextual_exclusions VALUES(${parent},'excluded','action')`;
      yield* applyFork(sql, { parentThreadId: parent, threadId: child });
      yield* applyFork(sql, { parentThreadId: parent, threadId: child });
      const rows = yield* sql<{
        guidance_id: string;
        context_epoch: string;
      }>`SELECT guidance_id, context_epoch FROM contextual_supply WHERE thread_id=${child} ORDER BY guidance_id`;
      assert.deepEqual(rows, [
        { guidance_id: "later", context_epoch: "initial" },
        { guidance_id: "one", context_epoch: "initial" },
      ]);
      assert.equal(
        (yield* sql`SELECT * FROM contextual_exclusions WHERE thread_id=${child}`).length,
        1,
      );
    }),
  );

  it.effect("deduplicates a V2 compaction boundary across restart", () =>
    Effect.gen(function* () {
      const { sql, lifecycle } = yield* fixture;
      const input = { threadId: parent, boundaryKey: "v2:compaction-item", at: now };
      yield* lifecycle.observeCompaction(input);
      const restarted = yield* make;
      yield* restarted.observeCompaction(input);
      assert.equal((yield* sql`SELECT * FROM contextual_context_boundaries`).length, 1);
      assert.equal(
        (yield* sql<{
          context_epoch: string;
        }>`SELECT context_epoch FROM contextual_thread_settings`)[0]?.context_epoch,
        "compaction:v2:compaction-item",
      );
    }),
  );

  it.effect("cancelling a run cancels its in-flight preparation; a bound packet is unknown", () =>
    Effect.gen(function* () {
      const { lifecycle, queue, insertPreparation, stateOf } = yield* fixture;
      yield* insertPreparation(preparation("prep-1", "message-1", "evaluating"));
      yield* insertPreparation(preparation("prep-2", "message-2", "dispatching"));
      yield* queue.admit({
        threadId: parent,
        runId: RunId.make("run-1"),
        messageId: MessageId.make("message-1"),
      });
      yield* lifecycle.cancelQueuedTurns({ threadId: parent, runId: RunId.make("run-1"), at: now });
      assert.equal(yield* stateOf("prep-1"), "canceled");
      assert.equal(yield* stateOf("prep-2"), "dispatching");
      assert.isNull(yield* queue.get(RunId.make("run-1")));
      yield* queue.admit({
        threadId: parent,
        runId: RunId.make("run-2"),
        messageId: MessageId.make("message-2"),
      });
      yield* lifecycle.cancelQueuedTurns({ threadId: parent, at: now });
      assert.equal(yield* stateOf("prep-2"), "delivery-unknown");
    }),
  );

  it.effect("a rollback only invalidates preparations of messages it removed", () =>
    Effect.gen(function* () {
      const { sql, lifecycle, insertPreparation, stateOf } = yield* fixture;
      yield* insertV2Run(sql, { runId: "kept", threadId: parent, ordinal: 1, status: "completed" });
      yield* insertV2Run(sql, {
        runId: "undone",
        threadId: parent,
        ordinal: 2,
        status: "rolled_back",
      });
      yield* insertV2Message(sql, {
        messageId: "kept-message",
        threadId: parent,
        role: "user",
        text: "Keep",
        runId: "kept",
      });
      yield* insertV2Message(sql, {
        messageId: "undone-message",
        threadId: parent,
        role: "user",
        text: "Undo",
        runId: "undone",
      });
      yield* insertPreparation(preparation("kept-prep", "kept-message", "prepared"));
      yield* insertPreparation(preparation("undone-prep", "undone-message", "prepared"));
      yield* lifecycle.applyThreadRemoval({ threadId: parent, kind: "rolled-back", at: now });
      assert.equal(yield* stateOf("kept-prep"), "prepared");
      assert.equal(yield* stateOf("undone-prep"), "canceled");
      const settings = yield* sql<{
        enabled: number;
      }>`SELECT enabled FROM contextual_thread_settings WHERE thread_id=${parent}`;
      assert.equal(settings[0]?.enabled, 1);
    }),
  );

  it.effect("thread and project deletion cancel everything and disable the thread", () =>
    Effect.gen(function* () {
      const { sql, lifecycle, insertPreparation, stateOf } = yield* fixture;
      yield* insertPreparation(preparation("prep", "message", "prepared"));
      yield* lifecycle.applyProjectDeleted({ projectId, at: now });
      assert.equal(yield* stateOf("prep"), "canceled");
      const settings = yield* sql<{
        enabled: number;
      }>`SELECT enabled FROM contextual_thread_settings WHERE thread_id=${parent}`;
      assert.equal(settings[0]?.enabled, 0);
    }),
  );
});
