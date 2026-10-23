import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type ApplicationStoredEvent } from "@lecturn/contracts";
import { Effect, Fiber, PubSub, Result, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import { DecisionSettingsRepository, make as makeSettings } from "./DecisionSettingsRepository.ts";
import { DecisionJobRepository, make as makeJobs } from "./DecisionJobRepository.ts";
import { make } from "./DecisionIngestion.ts";
import {
  clearV2Projection,
  installLegacyProjectionMirror,
  v2MessageEvent,
  v2ThreadEvent,
} from "./V2ProjectionTestFixtures.ts";

const projectId = ProjectId.make("ingestion-project");
const threadId = ThreadId.make("ingestion-thread");
const event = (sequence: number, messageId = "message") =>
  v2MessageEvent(sequence, { threadId, messageId });

/** In-memory application event source with the store's replay/live contract. */
const makeStore = (
  initial: ReadonlyArray<ApplicationStoredEvent>,
  options: {
    readonly latest?: () => Effect.Effect<number>;
    readonly onRead?: (afterSequence: number) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const events = [...initial];
    const live = yield* PubSub.unbounded<ApplicationStoredEvent>();
    const latest = () => events.at(-1)?.sequence ?? 0;
    const read = (afterSequence: number, throughSequence = Number.MAX_SAFE_INTEGER) =>
      events.filter((item) => item.sequence > afterSequence && item.sequence <= throughSequence);
    const store = {
      latestApplicationSequence: Effect.suspend(() =>
        options.latest ? options.latest() : Effect.succeed(latest()),
      ),
      readApplicationEvents: ({ afterSequence, throughSequence }) =>
        Stream.suspend(() => {
          options.onRead?.(afterSequence);
          return Stream.fromIterable(read(afterSequence, throughSequence));
        }),
      streamApplicationEvents: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(live);
            return Stream.concat(
              Stream.fromIterable(read(input?.afterSequence ?? 0)),
              Stream.fromSubscription(subscription),
            );
          }),
        ),
    } satisfies Partial<OrchestrationEventStore["Service"]>;
    const commit = (event: ApplicationStoredEvent) =>
      Effect.gen(function* () {
        events.push(event);
        yield* PubSub.publish(live, event);
      });
    return {
      store: OrchestrationEventStore.of(store as unknown as OrchestrationEventStore["Service"]),
      commit,
      events,
    };
  });

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* installLegacyProjectionMirror(sql);
  yield* clearV2Projection(sql);
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

const enable = (settings: DecisionSettingsRepository["Service"]) =>
  settings.update(
    { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
    0,
  );

it.layer(SqlitePersistence.layerMemory)("Decision ingestion on the V2 application log", (it) => {
  it.effect("replays bounded pages from the cursor and drains a commit racing startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { jobs, settings } = yield* fixture;
        yield* enable(settings);
        const reads: number[] = [];
        let first = true;
        let commitDuringSnapshot: Effect.Effect<void> = Effect.void;
        const { store, commit } = yield* makeStore(
          Array.from({ length: 450 }, (_, index) => event(index + 1)),
          {
            onRead: (after) => reads.push(after),
            latest: () =>
              Effect.gen(function* () {
                if (!first) return 451;
                first = false;
                // Commits after the high-water capture must still be delivered.
                yield* commitDuringSnapshot;
                return 450;
              }),
          },
        );
        commitDuringSnapshot = commit(event(451));
        const ingestion = yield* make.pipe(
          Effect.provideService(OrchestrationEventStore, store),
          Effect.provideService(DecisionJobRepository, jobs),
        );
        yield* ingestion.start;
        yield* ingestion.drainThrough(451);
        assert.equal(yield* jobs.cursor, 451);
        // 200-event pages: replay reads resume from each page boundary.
        assert.deepEqual(reads.slice(0, 3), [0, 200, 400]);
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
      const { store } = yield* makeStore([], { latest: () => Effect.succeed(10) });
      const ingestion = yield* make.pipe(
        Effect.provideService(OrchestrationEventStore, store),
        Effect.provideService(DecisionJobRepository, jobs),
      );
      const result = yield* ingestion.catchUp.pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.equal(yield* jobs.cursor, 0);
    }),
  );
  it.effect("leaves the cursor in place when compaction removed a drain target", () =>
    Effect.gen(function* () {
      const { jobs } = yield* fixture;
      // Sequence 2 was superseded by 3 and compacted before its live drain ran.
      const { store } = yield* makeStore([event(1), event(3)]);
      const ingestion = yield* make.pipe(
        Effect.provideService(OrchestrationEventStore, store),
        Effect.provideService(DecisionJobRepository, jobs),
      );
      yield* ingestion.drainThrough(1);
      yield* ingestion.drainThrough(2);
      assert.equal(yield* jobs.cursor, 1);
      yield* ingestion.drainThrough(3);
      assert.equal(yield* jobs.cursor, 3);
    }),
  );
  it.effect("keeps explicit recovery subscribed when the initial durable drain fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, jobs, settings } = yield* fixture;
        yield* enable(settings);
        const { store } = yield* makeStore([event(1)]);
        const ingestion = yield* make.pipe(
          Effect.provideService(OrchestrationEventStore, store),
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
  it.effect(
    "resumes a V1-era cursor at the first V2 event without replaying legacy-import history",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sql, jobs, settings } = yield* fixture;
          yield* enable(settings);
          // V1 ingestion stopped at sequence 1000; V1 already indexed this message.
          yield* sql`UPDATE decision_ingestion_cursor SET sequence = 1000`;
          yield* sql`UPDATE decision_project_settings SET activation_sequence = 10`;
          yield* sql`INSERT INTO decision_thread_state(thread_id,project_id,updated_at,generation_sequence) VALUES (${threadId},${projectId},'now',5)`;
          const importId = (suffix: string) => `migration:v1:${suffix}`;
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('fresh',${threadId},'user','Adopt Postgres.',0,'now','now')`;
          const { store, commit } = yield* makeStore([
            // The legacy importer re-materializes V1 history above the V1 cursor.
            v2ThreadEvent(1001, "thread.created", threadId, {
              eventId: importId(`thread:${threadId}:created`),
            }),
            v2MessageEvent(1002, {
              threadId,
              messageId: "message",
              eventId: importId("message:message"),
            }),
            // The first genuine V2 event right after the import.
            v2MessageEvent(1003, { threadId, messageId: "fresh", role: "user" }),
            ...Array.from({ length: 500 }, (_, index) =>
              v2MessageEvent(1004 + index, {
                threadId,
                messageId: "message",
                eventId: importId(`message:bulk-${index}`),
              }),
            ),
          ]);
          const ingestion = yield* make.pipe(
            Effect.provideService(OrchestrationEventStore, store),
            Effect.provideService(DecisionJobRepository, jobs),
          );
          yield* ingestion.start;
          assert.equal(yield* jobs.cursor, 1503);
          const state = yield* sql<{
            source_generation: number;
          }>`SELECT source_generation FROM decision_thread_state WHERE thread_id = ${threadId}`;
          // An imported thread.created must not start a new source generation.
          assert.equal(state[0]?.source_generation, 0);
          const jobRows = yield* sql<{
            source_message_id: string;
            from_sequence: number;
          }>`SELECT source_message_id, from_sequence FROM decision_jobs ORDER BY from_sequence`;
          assert.deepEqual(
            jobRows.map((row) => [row.source_message_id, row.from_sequence]),
            [["fresh", 1003]],
          );
          // Live V2 commits after startup keep flowing.
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('later',${threadId},'assistant','Keep SQLite for tests.',0,'now','now')`;
          yield* commit(v2MessageEvent(1504, { threadId, messageId: "later" }));
          yield* ingestion.drainThrough(1504);
          assert.equal(yield* jobs.cursor, 1504);
          const later = yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM decision_jobs WHERE source_message_id = 'later'`;
          assert.equal(later[0]?.count, 1);
        }),
      ),
  );
});
