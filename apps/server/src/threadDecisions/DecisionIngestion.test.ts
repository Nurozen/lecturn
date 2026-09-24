import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ThreadId,
  MessageId,
  type OrchestrationEvent,
} from "@lecturn/contracts";
import { Effect, PubSub, Stream, Result, Fiber } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { DecisionSettingsRepository, make as makeSettings } from "./DecisionSettingsRepository.ts";
import { DecisionJobRepository, make as makeJobs } from "./DecisionJobRepository.ts";
import { make } from "./DecisionIngestion.ts";

const projectId = ProjectId.make("ingestion-project");
const threadId = ThreadId.make("ingestion-thread");
const event = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`ingestion-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-09-23",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make("message"),
    role: "assistant",
    text: "",
    turnId: null,
    streaming: false,
    createdAt: "2026-09-23",
    updatedAt: "2026-09-23",
  },
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "decision_project_settings",
    "decision_thread_state",
    "decision_jobs",
    "decision_sources",
    "decision_coverage",
    "decision_outbox",
    "projection_thread_messages",
    "projection_threads",
    "projection_projects",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`UPDATE decision_ingestion_cursor SET sequence = 0`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Ingest','/tmp/ingest','[]','now','now')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES (${threadId},${projectId},'Thread','{}','now','now','full-access','default')`;
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('message',${threadId},'assistant','Use SQLite.',0,'now','now')`;
  const settings = yield* makeSettings;
  const jobs = yield* makeJobs.pipe(Effect.provideService(DecisionSettingsRepository, settings));
  return { sql, jobs, settings };
});

it.layer(SqlitePersistenceMemory)("Decision ingestion", (it) => {
  it.effect(
    "subscribes before snapshot, replays bounded pages, and drains a commit arriving during catch-up",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { jobs, settings } = yield* fixture;
          yield* settings.update(
            { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
            0,
          );
          const events = Array.from({ length: 450 }, (_, index) => event(index + 1));
          const changes = yield* PubSub.unbounded<OrchestrationEvent>();
          const order: string[] = [];
          const pageLimits: number[] = [];
          let firstSnapshot = true;
          const engine = OrchestrationEngineService.of({
            dispatch: () => Effect.die("unused"),
            readEvents: (cursor, limit = 200) => {
              pageLimits.push(limit);
              return Stream.fromIterable(
                events.filter((item) => item.sequence > cursor).slice(0, limit),
              );
            },
            latestSequence: Effect.gen(function* () {
              order.push("snapshot");
              if (firstSnapshot) {
                firstSnapshot = false;
                events.push(event(451));
                yield* PubSub.publish(changes, event(451));
                return 450;
              }
              return events.at(-1)?.sequence ?? 0;
            }),
            streamDomainEvents: Stream.fromPubSub(changes),
            subscribeDomainEvents: Effect.gen(function* () {
              order.push("subscribe");
              const subscription = yield* PubSub.subscribe(changes);
              return Stream.fromSubscription(subscription);
            }),
          });
          const ingestion = yield* make.pipe(
            Effect.provideService(OrchestrationEngineService, engine),
            Effect.provideService(DecisionJobRepository, jobs),
          );
          yield* ingestion.start;
          yield* ingestion.drainThrough(451);
          assert.deepEqual(order.slice(0, 2), ["subscribe", "snapshot"]);
          assert.equal(yield* jobs.cursor, 451);
          assert.isAtLeast(pageLimits.length, 3);
          assert.isTrue(pageLimits.every((limit) => limit === 200));
          const claimed = yield* jobs.claim({ owner: "worker" });
          assert.isNotNull(claimed);
          assert.equal(claimed!.fromSequence, 1);
          assert.isNull(yield* jobs.claim({ owner: "other" }));
          yield* ingestion.catchUp;
          assert.equal(yield* jobs.cursor, 451);
        }),
      ),
  );
  it.effect("does not advance the durable cursor over an unavailable replay range", () =>
    Effect.gen(function* () {
      const { jobs } = yield* fixture;
      const engine = OrchestrationEngineService.of({
        dispatch: () => Effect.die("unused"),
        readEvents: () => Stream.empty,
        latestSequence: Effect.succeed(10),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
      });
      const ingestion = yield* make.pipe(
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.provideService(DecisionJobRepository, jobs),
      );
      const result = yield* ingestion.catchUp.pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.equal(yield* jobs.cursor, 0);
    }),
  );
  it.effect("keeps explicit recovery subscribed when the initial durable drain fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, jobs, settings } = yield* fixture;
        yield* settings.update(
          { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
          0,
        );
        const engine = OrchestrationEngineService.of({
          dispatch: () => Effect.die("unused"),
          readEvents: (cursor) => Stream.fromIterable(cursor < 1 ? [event(1)] : []),
          latestSequence: Effect.succeed(1),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
        });
        const ingestion = yield* make.pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(DecisionJobRepository, jobs),
        );
        yield* sql`CREATE TRIGGER ingestion_fail BEFORE INSERT ON decision_jobs BEGIN SELECT RAISE(ABORT, 'synthetic startup failure'); END`;
        assert.isTrue(Result.isFailure(yield* ingestion.start.pipe(Effect.result)));
        assert.equal(yield* jobs.cursor, 0);
        yield* sql`DROP TRIGGER ingestion_fail`;
        const changes = yield* jobs.subscribeWake;
        const receipt = yield* changes.pipe(
          Stream.filterEffect(() => jobs.cursor.pipe(Effect.map((sequence) => sequence >= 1))),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* jobs.notify;
        yield* Fiber.join(receipt);
        assert.equal(yield* jobs.cursor, 1);
        assert.isNotNull(yield* jobs.claim({ owner: "recovered" }));
      }),
    ),
  );
});
