import { assert, it } from "@effect/vitest";
import {
  ContextualPreparation,
  EnvironmentId,
  ProjectId,
  EventId,
  MessageId,
  ThreadId,
  OrchestrationEvent,
} from "@lecturn/contracts";
import { Effect, Result, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { admitContextualTurn, make } from "./ContextualTurnQueue.ts";
import { applyContextualLifecycle } from "./ContextualLifecycle.ts";
const encodePreparation = Schema.encodeSync(Schema.fromJsonString(ContextualPreparation));
const threadId = ThreadId.make("queue-thread");
const now = "2026-09-26T00:00:00.000Z";
const event = (
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.turn-start-requested",
  payload: {
    threadId,
    messageId: MessageId.make(`message-${sequence}`),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
  },
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM contextual_preparations`;
  yield* sql`DELETE FROM contextual_turn_queue`;
  yield* sql`DELETE FROM contextual_turn_watermarks`;
  yield* sql`DELETE FROM contextual_thread_settings`;
  yield* sql`INSERT INTO contextual_thread_settings(thread_id,project_id,enabled,source_ids_json,updated_at) VALUES(${threadId},'queue-project',1,'[]',${now})`;
  return { sql, queue: yield* make };
});
it.layer(SqlitePersistenceMemory)("Contextual durable turn queue", (it) => {
  it.effect(
    "session stop cancels preparations durably while active-turn interrupts preserve queued work",
    () =>
      Effect.gen(function* () {
        const { sql, queue } = yield* fixture;
        yield* admitContextualTurn(sql, event(1));
        const preparation: ContextualPreparation = {
          id: "pending-stop",
          revision: 0,
          state: "evaluating",
          packetId: null,
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
          task: {
            environmentId: EnvironmentId.make("env"),
            projectId: ProjectId.make("queue-project"),
            threadId,
            submissionId: "submission",
            messageId: event(1).payload.messageId,
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
        };
        yield* sql`INSERT INTO contextual_preparations(id,thread_id,project_id,submission_id,message_id,state,revision,preparation_json,created_at,updated_at)
        VALUES(${preparation.id},${threadId},'queue-project','submission',${preparation.task.messageId},'evaluating',0,${encodePreparation(preparation)},${now},${now})`;
        yield* queue.setState(threadId, event(1).eventId, "preparing", preparation.id);
        yield* applyContextualLifecycle(sql, {
          ...event(2),
          type: "thread.turn-interrupt-requested",
          payload: { threadId, createdAt: now },
        });
        assert.equal((yield* queue.head(threadId))?.state, "preparing");
        const stop: OrchestrationEvent = {
          ...event(3),
          type: "thread.session-stop-requested",
          payload: { threadId, createdAt: now },
        };
        yield* applyContextualLifecycle(sql, stop);
        yield* applyContextualLifecycle(sql, stop);
        assert.isNull(yield* queue.head(threadId));
        const rows = yield* sql<{
          state: string;
          revision: number;
          continuation_json: string | null;
        }>`SELECT state,revision,continuation_json FROM contextual_preparations WHERE id=${preparation.id}`;
        assert.deepEqual(rows, [{ state: "canceled", revision: 1, continuation_json: null }]);
        assert.isTrue(
          Result.isFailure(
            yield* queue
              .setState(threadId, event(1).eventId, "dispatching", preparation.id)
              .pipe(Effect.result),
          ),
        );
        yield* admitContextualTurn(sql, event(1));
        assert.isNull(yield* queue.head(threadId));
        yield* admitContextualTurn(sql, event(4));
        assert.equal((yield* queue.head(threadId))?.event.sequence, 4);
      }),
  );
  it.effect("holds the first submission and preserves FIFO after a toggle off", () =>
    Effect.gen(function* () {
      const { sql, queue } = yield* fixture;
      yield* admitContextualTurn(sql, event(1));
      yield* queue.setState(threadId, event(1).eventId, "held", "prep");
      yield* sql`UPDATE contextual_thread_settings SET enabled=0`;
      yield* admitContextualTurn(sql, event(2));
      assert.equal((yield* queue.head(threadId))?.event.sequence, 1);
      assert.isTrue(
        Result.isFailure(
          yield* queue.finish(threadId, event(2).eventId, "done").pipe(Effect.result),
        ),
      );
      yield* queue.finish(threadId, event(1).eventId, "canceled");
      assert.equal((yield* queue.head(threadId))?.event.sequence, 2);
      assert.deepEqual(yield* queue.pendingThreads(""), [threadId]);
    }),
  );
  it.effect("never readmits or falls through after tombstones are compacted", () =>
    Effect.gen(function* () {
      const { sql, queue } = yield* fixture;
      yield* admitContextualTurn(sql, event(1));
      yield* queue.finish(threadId, event(1).eventId, "done");
      yield* admitContextualTurn(sql, event(5000));
      yield* queue.finish(threadId, event(5000).eventId, "done");
      yield* admitContextualTurn(sql, event(1));
      assert.isNull(yield* queue.head(threadId));
      assert.isTrue(yield* queue.contains(event(1)));
    }),
  );
  it.effect("retains uncertain dispatch across a service restart without resetting it", () =>
    Effect.gen(function* () {
      const { sql, queue } = yield* fixture;
      yield* admitContextualTurn(sql, event(1));
      yield* queue.setState(threadId, event(1).eventId, "dispatching", null);
      const reopened = yield* make;
      assert.equal((yield* reopened.head(threadId))?.state, "dispatching");
      assert.isTrue(
        Result.isFailure(
          yield* reopened.setState(threadId, event(1).eventId, "queued", null).pipe(Effect.result),
        ),
      );
      yield* reopened.finish(threadId, event(1).eventId, "unknown");
      assert.isNull(yield* reopened.head(threadId));
      const rows = yield* sql<{
        event_json: string | null;
      }>`SELECT event_json FROM contextual_turn_queue`;
      assert.isNull(rows[0]?.event_json);
    }),
  );
  it.effect(
    "a cancel or hold committed during optional evaluation fences even an unbound fail-open send",
    () =>
      Effect.gen(function* () {
        const { sql, queue } = yield* fixture;
        yield* admitContextualTurn(sql, event(1));
        yield* sql`INSERT INTO contextual_preparations(id,thread_id,project_id,submission_id,message_id,state,revision,preparation_json,created_at,updated_at)
      VALUES('racing-prep',${threadId},'queue-project','submission',${event(1).payload.messageId},'canceled',1,'{}',${now},${now})`;
        assert.isTrue(
          Result.isFailure(
            yield* queue
              .setState(threadId, event(1).eventId, "dispatching", null)
              .pipe(Effect.result),
          ),
        );
        assert.equal((yield* queue.head(threadId))?.state, "queued");
        yield* sql`UPDATE contextual_preparations SET state='awaiting-conflict-review'`;
        assert.isTrue(
          Result.isFailure(
            yield* queue
              .setState(threadId, event(1).eventId, "dispatching", null)
              .pipe(Effect.result),
          ),
        );
        yield* sql`UPDATE contextual_preparations SET state='skipped'`;
        yield* queue.setState(threadId, event(1).eventId, "dispatching", null);
        assert.equal((yield* queue.head(threadId))?.preparationId, "racing-prep");
      }),
  );
});
