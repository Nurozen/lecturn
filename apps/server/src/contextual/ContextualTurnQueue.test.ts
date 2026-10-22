import { assert, it } from "@effect/vitest";
import { MessageId, RunId, ThreadId } from "@lecturn/contracts";
import { Effect, Result } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { clearV2Projection, insertV2Run } from "../threadDecisions/V2ProjectionTestFixtures.ts";
import { make } from "./ContextualTurnQueue.ts";

const threadId = ThreadId.make("queue-thread");
const now = "2026-09-26T00:00:00.000Z";
const run = (n: number) => ({
  threadId,
  runId: RunId.make(`run-${n}`),
  messageId: MessageId.make(`message-${n}`),
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* clearV2Projection(sql);
  yield* sql`DELETE FROM contextual_preparations`;
  yield* sql`DELETE FROM contextual_turn_queue`;
  yield* sql`DELETE FROM contextual_turn_watermarks`;
  return { sql, queue: yield* make };
});

it.layer(SqlitePersistence.layerMemory)("Contextual V2 admission ledger", (it) => {
  it.effect("admits a run once and never readmits it after it finishes", () =>
    Effect.gen(function* () {
      const { sql, queue } = yield* fixture;
      const first = yield* queue.admit(run(1));
      assert.equal(first?.state, "queued");
      assert.equal(first?.dispatchId, "contextual-dispatch:run-1");
      assert.equal((yield* queue.admit(run(1)))?.sequence, first?.sequence);
      yield* queue.finish(run(1).runId, "done");
      assert.isNull(yield* queue.admit(run(1)));
      assert.isNull(yield* queue.head(threadId));
      const rows = yield* sql<{
        event_json: string | null;
        through: number;
      }>`SELECT q.event_json, w.through_sequence AS through FROM contextual_turn_queue q JOIN contextual_turn_watermarks w ON w.thread_id=q.thread_id`;
      assert.deepEqual(rows, [{ event_json: null, through: first!.sequence }]);
    }),
  );

  it.effect("keeps per-thread FIFO and fences state changes to the head", () =>
    Effect.gen(function* () {
      const { queue } = yield* fixture;
      yield* queue.admit(run(1));
      yield* queue.admit(run(2));
      assert.equal((yield* queue.head(threadId))?.runId, "run-1");
      assert.isTrue(
        Result.isFailure(
          yield* queue.setState(threadId, run(2).runId, "preparing", null).pipe(Effect.result),
        ),
      );
      yield* queue.setState(threadId, run(1).runId, "held", "prep");
      yield* queue.finish(run(1).runId, "canceled");
      assert.equal((yield* queue.head(threadId))?.runId, "run-2");
    }),
  );

  it.effect("retains an uncertain dispatch across a service restart without resetting it", () =>
    Effect.gen(function* () {
      const { queue } = yield* fixture;
      yield* queue.admit(run(1));
      yield* queue.setState(threadId, run(1).runId, "dispatching", null);
      const reopened = yield* make;
      assert.equal((yield* reopened.get(run(1).runId))?.state, "dispatching");
      assert.isTrue(
        Result.isFailure(
          yield* reopened.setState(threadId, run(1).runId, "queued", null).pipe(Effect.result),
        ),
      );
    }),
  );

  it.effect(
    "a cancel or hold committed during optional evaluation fences even an unbound fail-open send",
    () =>
      Effect.gen(function* () {
        const { sql, queue } = yield* fixture;
        yield* queue.admit(run(1));
        yield* sql`INSERT INTO contextual_preparations(id,thread_id,project_id,submission_id,message_id,state,revision,preparation_json,created_at,updated_at)
          VALUES('racing-prep',${threadId},'queue-project','submission','message-1','canceled',1,'{}',${now},${now})`;
        assert.isTrue(
          Result.isFailure(
            yield* queue.setState(threadId, run(1).runId, "dispatching", null).pipe(Effect.result),
          ),
        );
        assert.equal((yield* queue.head(threadId))?.state, "queued");
        yield* sql`UPDATE contextual_preparations SET state='awaiting-conflict-review'`;
        assert.isTrue(
          Result.isFailure(
            yield* queue.setState(threadId, run(1).runId, "dispatching", null).pipe(Effect.result),
          ),
        );
        yield* sql`UPDATE contextual_preparations SET state='skipped'`;
        yield* queue.setState(threadId, run(1).runId, "dispatching", null);
        assert.equal((yield* queue.head(threadId))?.preparationId, "racing-prep");
      }),
  );

  it.effect("reconciles rows whose V2 run settled while the server was down", () =>
    Effect.gen(function* () {
      const { sql, queue } = yield* fixture;
      for (const n of [1, 2, 3]) yield* queue.admit(run(n));
      yield* queue.setState(threadId, run(1).runId, "dispatching", null);
      yield* insertV2Run(sql, { runId: "run-1", threadId, ordinal: 1, status: "completed" });
      yield* insertV2Run(sql, { runId: "run-2", threadId, ordinal: 2, status: "interrupted" });
      yield* insertV2Run(sql, { runId: "run-3", threadId, ordinal: 3, status: "starting" });
      const settled = yield* queue.reconcile(threadId);
      assert.deepEqual([...settled].sort(), ["run-1", "run-2"]);
      const states = yield* sql<{
        event_id: string;
        state: string;
      }>`SELECT event_id,state FROM contextual_turn_queue ORDER BY sequence`;
      assert.deepEqual(states, [
        { event_id: "run-1", state: "unknown" },
        { event_id: "run-2", state: "canceled" },
        { event_id: "run-3", state: "queued" },
      ]);
      assert.equal((yield* queue.head(threadId))?.runId, "run-3");
    }),
  );
});
