import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_DECISION_TRACKING_DESCRIPTION,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@lecturn/contracts";
import { Effect, Result } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { DecisionSettingsRepository, make as makeSettings } from "./DecisionSettingsRepository.ts";
import {
  make,
  emptyDecisionJobStage,
  countDecisionUnscannedMessages,
} from "./DecisionJobRepository.ts";

const projectId = ProjectId.make("jobs-project");
const threadId = ThreadId.make("jobs-thread");
const event = (sequence: number, messageId = "message", streaming = false): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-09-23",
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make(messageId),
    role: "assistant",
    text: "",
    turnId: null,
    streaming,
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
    "decision_scans",
    "decision_sources",
    "decision_coverage",
    "decision_outbox",
    "decision_evaluations",
    "projection_thread_messages",
    "projection_threads",
    "projection_projects",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`UPDATE decision_ingestion_cursor SET sequence = 0`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Jobs','/tmp/jobs','[]','now','now')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES (${threadId},${projectId},'Thread','{}','now','now','full-access','default')`;
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('message',${threadId},'assistant','Use SQLite.',0,'2026-09-23','2026-09-23')`;
  const settings = yield* makeSettings;
  const jobs = yield* make.pipe(Effect.provideService(DecisionSettingsRepository, settings));
  return { sql, settings, jobs };
});

it.layer(SqlitePersistenceMemory)("Decision job storage", (it) => {
  it.effect("indexes finalized projection text once even when completion events are empty", () =>
    Effect.gen(function* () {
      const { sql, settings, jobs } = yield* fixture;
      yield* settings.update(
        {
          operation: "update",
          projectId,
          expectedRevision: 0,
          enabled: true,
          description: "Storage",
        },
        0,
      );
      yield* jobs.processEvent(event(1, "message", true));
      assert.isNull(yield* jobs.claim({ owner: "worker" }));
      yield* jobs.processEvent(event(2));
      yield* jobs.processEvent(event(2));
      yield* jobs.processEvent(event(3));
      assert.equal(yield* jobs.cursor, 3);
      const count = yield* sql<{ count: number }>`SELECT count(*) AS count FROM decision_jobs`;
      assert.equal(count[0]?.count, 1);
      const claimed = yield* jobs.claim({ owner: "worker" });
      assert.isNotNull(claimed);
      assert.equal(claimed!.fromSequence, 2);
      const sources = yield* jobs.listSources({
        projectId,
        threadId,
        sourceGeneration: 0,
        fromSequence: 2,
        throughSequence: 2,
        messageId: "message",
      });
      assert.equal(sources[0]?.text, "Use SQLite.");
      const coverage = yield* sql<{ state: string }>`SELECT state FROM decision_coverage`;
      assert.equal(coverage[0]?.state, "pending");
    }),
  );
  it.effect("rolls back the ingestion cursor when durable enqueue fails", () =>
    Effect.gen(function* () {
      const { sql, settings, jobs } = yield* fixture;
      yield* settings.update(
        { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
        0,
      );
      yield* sql`CREATE TRIGGER fail_enqueue BEFORE INSERT ON decision_jobs BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`;
      const failed = yield* jobs.processEvent(event(1)).pipe(Effect.result);
      assert.isTrue(Result.isFailure(failed));
      assert.equal(yield* jobs.cursor, 0);
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM decision_sources`)[0]?.count,
        0,
      );
      yield* sql`DROP TRIGGER fail_enqueue`;
      yield* jobs.processEvent(event(1));
      assert.equal(yield* jobs.cursor, 1);
      assert.isNotNull(yield* jobs.claim({ owner: "recovered" }));
    }),
  );
  it.effect("fences expired leases and preserves checkpoints through writer retry", () =>
    Effect.gen(function* () {
      const { settings, jobs } = yield* fixture;
      yield* settings.update(
        { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
        0,
      );
      yield* jobs.processEvent(event(1));
      const first = (yield* jobs.claim({ owner: "first", leaseMs: 1000 }))!;
      assert.equal(first.description, DEFAULT_DECISION_TRACKING_DESCRIPTION);
      assert.isNull(yield* jobs.claim({ owner: "second" }));
      const stage = {
        ...emptyDecisionJobStage,
        evaluatedFingerprints: ["reusable-jeV-result"],
        continuation: { target: "message" },
      };
      yield* jobs.checkpoint({
        jobId: first.id,
        owner: "first",
        fence: first.fence,
        state: "writing",
        stage,
        leaseMs: 1000,
      });
      yield* TestClock.adjust("2 seconds");
      const second = (yield* jobs.claim({ owner: "second" }))!;
      assert.equal(second.fence, first.fence + 1);
      assert.equal(second.stage.evaluatedFingerprints[0], "reusable-jeV-result");
      assert.isTrue(
        Result.isFailure(
          yield* jobs
            .finish({ jobId: first.id, owner: "first", fence: first.fence, state: "committed" })
            .pipe(Effect.result),
        ),
      );
      yield* jobs.finish({
        jobId: second.id,
        owner: "second",
        fence: second.fence,
        state: "waiting",
        reason: "provider-unavailable",
      });
      yield* jobs.retry({ projectId, jobId: second.id });
      const retried = (yield* jobs.claim({ owner: "retry" }))!;
      assert.equal(retried.stage.evaluatedFingerprints[0], "reusable-jeV-result");
      yield* jobs.finish({
        jobId: retried.id,
        owner: "retry",
        fence: retried.fence,
        state: "committed",
      });
      assert.isNull(yield* jobs.claim({ owner: "another" }));
    }),
  );
  it.effect(
    "funding replacement cancels jobs and coverage atomically instead of orphaning pending work",
    () =>
      Effect.gen(function* () {
        const { settings, jobs, sql } = yield* fixture;
        yield* settings.setFunding(projectId, "active", "Member", 4);
        yield* settings.update(
          { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
          0,
        );
        yield* jobs.processEvent(event(1));
        const job = (yield* jobs.claim({ owner: "worker" }))!;
        yield* sql`INSERT INTO decision_scans(id,project_id,state,from_sequence,through_sequence,created_at,updated_at) VALUES ('funding-scan',${projectId},'running',1,1,'now','now')`;
        yield* settings.setFunding(projectId, "pending", "Member", 5);
        yield* settings.setFunding(projectId, "unavailable", "Member", 4);
        yield* jobs.checkpoint({
          jobId: job.id,
          owner: "worker",
          fence: job.fence,
          state: "writing",
          stage: emptyDecisionJobStage,
        });
        yield* settings.setFunding(projectId, "active", "Replacement", 5);
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state FROM decision_jobs WHERE id = ${job.id}`)[0]
            ?.state,
          "canceled",
        );
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state FROM decision_coverage`)[0]?.state,
          "canceled",
        );
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM decision_scans WHERE id = 'funding-scan'`)[0]?.state,
          "canceled",
        );
        assert.isNull(yield* jobs.claim({ owner: "other" }));
        assert.isTrue(
          Result.isFailure(
            yield* jobs
              .finish({ jobId: job.id, owner: "worker", fence: job.fence, state: "committed" })
              .pipe(Effect.result),
          ),
        );
      }),
  );
  it.effect("keeps pause arrivals unscanned while resuming pre-pause work", () =>
    Effect.gen(function* () {
      const { sql, settings, jobs } = yield* fixture;
      yield* settings.update(
        { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
        0,
      );
      yield* jobs.processEvent(event(1));
      const before = (yield* jobs.claim({ owner: "first" }))!;
      yield* settings.pause(
        { operation: "pause-thread", projectId, threadId, expectedPauseEpoch: 0, paused: true },
        1,
      );
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('paused',${threadId},'assistant','Use Postgres.',0,'2026-09-24','2026-09-24')`;
      yield* jobs.processEvent(event(2, "paused"));
      assert.isTrue(
        Result.isFailure(
          yield* jobs
            .finish({ jobId: before.id, owner: "first", fence: before.fence, state: "committed" })
            .pipe(Effect.result),
        ),
      );
      assert.isNull(yield* jobs.claim({ owner: "second" }));
      yield* settings.pause(
        { operation: "pause-thread", projectId, threadId, expectedPauseEpoch: 1, paused: false },
        2,
      );
      const resumed = (yield* jobs.claim({ owner: "second" }))!;
      assert.equal(resumed.id, before.id);
      const unscanned = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM decision_coverage WHERE state = 'unscanned' AND reason = 'paused'`;
      assert.equal(unscanned[0]?.count, 1);
    }),
  );
  it.effect(
    "requires explicit history scan and binds previews to source/settings and consumer cancellation",
    () =>
      Effect.gen(function* () {
        const { sql, settings, jobs } = yield* fixture;
        yield* jobs.processEvent(event(1));
        yield* settings.update(
          { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
          1,
        );
        yield* jobs.processEvent(event(2));
        assert.isNull(yield* jobs.claim({ owner: "no-retroactive-work" }));
        const preview = yield* jobs.scan({ operation: "preview", projectId });
        assert.equal(preview.messageCount, 1);
        const started = yield* jobs.scan({
          operation: "start",
          projectId,
          expectedSettingsRevision: 1,
          previewToken: preview.previewToken!,
        });
        assert.isNotNull(started.scanId);
        assert.equal(
          (yield* jobs.scan({
            operation: "start",
            projectId,
            expectedSettingsRevision: 1,
            previewToken: preview.previewToken!,
          })).scanId,
          started.scanId,
        );
        assert.isNull(yield* jobs.claim({ owner: "prepare" }));
        const scanJob = (yield* jobs.claim({ owner: "scan" }))!;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('live',${threadId},'user','Switch to Postgres.',0,'2026-09-24','2026-09-24')`;
        yield* jobs.processEvent({
          ...event(3, "live"),
          payload: { ...event(3, "live").payload, role: "user" },
        } as OrchestrationEvent);
        const stale = yield* jobs
          .scan({
            operation: "start",
            projectId,
            expectedSettingsRevision: 1,
            previewToken: preview.previewToken!,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isSuccess(stale));
        if (Result.isSuccess(stale)) assert.equal(stale.success.scanId, started.scanId);
        yield* jobs.scan({ operation: "cancel", projectId, scanId: started.scanId! });
        assert.isTrue(
          Result.isFailure(
            yield* jobs
              .finish({
                jobId: scanJob.id,
                owner: "scan",
                fence: scanJob.fence,
                state: "committed",
              })
              .pipe(Effect.result),
          ),
        );
        const liveJob = (yield* jobs.claim({ owner: "live" }))!;
        assert.equal(liveJob.scanId, null);
        assert.equal(liveJob.sourceMessageId, "live");
      }),
  );
  it.effect("source generation changes fence old jobs without enqueuing copied history", () =>
    Effect.gen(function* () {
      const { sql, settings, jobs } = yield* fixture;
      yield* settings.update(
        { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
        0,
      );
      yield* jobs.processEvent(event(1));
      const old = (yield* jobs.claim({ owner: "old" }))!;
      yield* jobs.processEvent({
        ...event(2),
        type: "thread.reverted",
        payload: { threadId, turnCount: 0 },
      });
      assert.isNull(yield* jobs.claim({ owner: "new" }));
      assert.isTrue(
        Result.isFailure(
          yield* jobs
            .finish({ jobId: old.id, owner: "old", fence: old.fence, state: "committed" })
            .pipe(Effect.result),
        ),
      );
      const state = yield* sql<{
        source_generation: number;
      }>`SELECT source_generation FROM decision_thread_state WHERE thread_id = ${threadId}`;
      assert.equal(state[0]?.source_generation, 1);
      yield* jobs.processEvent({
        ...event(2),
        type: "thread.reverted",
        payload: { threadId, turnCount: 0 },
      });
      assert.equal(
        (yield* sql<{
          source_generation: number;
        }>`SELECT source_generation FROM decision_thread_state WHERE thread_id = ${threadId}`)[0]
          ?.source_generation,
        1,
      );
    }),
  );
  it.effect("bounds queued history and tracks tied source sequences independently", () =>
    Effect.gen(function* () {
      const { sql, settings, jobs } = yield* fixture;
      yield* settings.update(
        { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
        100,
      );
      yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v < 1001) INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) SELECT 'history-' || printf('%04d',v),${threadId},'user','Use Postgres.',0,'2026-09-22','2026-09-22' FROM n`;
      const preview = yield* jobs.scan({ operation: "preview", projectId });
      assert.equal(preview.messageCount, 1002);
      const forged = yield* jobs
        .scan({
          operation: "start",
          projectId,
          expectedSettingsRevision: 1,
          previewToken: preview.previewToken!.split(".")[0] + "." + "é".repeat(43),
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(forged));
      const scan = yield* jobs.scan({
        operation: "start",
        projectId,
        expectedSettingsRevision: 1,
        previewToken: preview.previewToken!,
      });
      assert.equal(scan.state, "queued");
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM decision_jobs`)[0]?.count,
        0,
      );
      for (let page = 0; page < 6; page++) assert.isNull(yield* jobs.claim({ owner: "prepare" }));
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM decision_jobs`)[0]?.count,
        1000,
      );
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM decision_coverage WHERE state = 'pending'`)[0]?.count,
        1000,
      );
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM decision_coverage WHERE reason = 'backlog'`)[0]?.count,
        2,
      );
      assert.equal(yield* countDecisionUnscannedMessages(sql, projectId), 2);
      const first = (yield* jobs.claim({ owner: "history" }))!;
      yield* jobs.finish({
        jobId: first.id,
        owner: "history",
        fence: first.fence,
        state: "no_match",
      });
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM decision_coverage WHERE state = 'complete'`)[0]?.count,
        1,
      );
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM decision_scans WHERE id = ${scan.scanId}`)[0]?.state,
        "running",
      );
      const sources = yield* jobs.listSources({
        projectId,
        threadId,
        sourceGeneration: 0,
        fromSequence: 0,
        throughSequence: 0,
        messageId: "history-0500",
        contextMessages: 2,
      });
      assert.deepEqual(
        sources.map((source) => source.messageId),
        ["history-0498", "history-0499", "history-0500", "history-0501", "history-0502"],
      );
      yield* settings.update(
        {
          operation: "update",
          projectId,
          expectedRevision: 1,
          enabled: true,
          description: "Changed after admission",
        },
        100,
      );
      let drained = 1;
      while (true) {
        const job = yield* jobs.claim({ owner: "drain" });
        if (!job) break;
        assert.equal(job.description, DEFAULT_DECISION_TRACKING_DESCRIPTION);
        yield* jobs.finish({ jobId: job.id, owner: "drain", fence: job.fence, state: "no_match" });
        drained++;
      }
      assert.equal(drained, 1002);
      assert.equal(yield* countDecisionUnscannedMessages(sql, projectId), 0);
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM decision_scans WHERE id = ${scan.scanId}`)[0]?.state,
        "completed",
      );
    }),
  );
  it.effect("history preview and admission exclude archived threads", () =>
    Effect.gen(function* () {
      const { sql, settings, jobs } = yield* fixture;
      yield* settings.update(
        { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
        0,
      );
      yield* sql`UPDATE projection_threads SET archived_at = '2026-09-23' WHERE thread_id = ${threadId}`;
      const preview = yield* jobs.scan({ operation: "preview", projectId });
      assert.equal(preview.messageCount, 0);
      const scan = yield* jobs.scan({
        operation: "start",
        projectId,
        expectedSettingsRevision: 1,
        previewToken: preview.previewToken!,
      });
      assert.equal(scan.state, "queued");
      assert.isNull(yield* jobs.claim({ owner: "history" }));
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM decision_scans WHERE id = ${scan.scanId}`)[0]?.state,
        "completed",
      );
    }),
  );
  it.effect(
    "recovers paged scan preparation after restart without claiming partial or changed snapshots",
    () =>
      Effect.gen(function* () {
        for (const changeSource of [false, true]) {
          const { sql, settings, jobs } = yield* fixture;
          yield* settings.update(
            {
              operation: "update",
              projectId,
              expectedRevision: 0,
              enabled: true,
              description: "Original scan scope",
            },
            0,
          );
          yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v < 400) INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) SELECT 'history-' || printf('%04d',v),${threadId},'user','Use Postgres.',0,'2026-09-22','2026-09-22' FROM n`;
          const preview = yield* jobs.scan({ operation: "preview", projectId });
          const scan = yield* jobs.scan({
            operation: "start",
            projectId,
            expectedSettingsRevision: 1,
            previewToken: preview.previewToken!,
          });
          assert.equal(scan.state, "queued");
          assert.equal(
            (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM decision_jobs`)[0]?.count,
            0,
          );
          assert.isNull(yield* jobs.claim({ owner: "before-restart" }));
          assert.equal(
            (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM decision_jobs`)[0]?.count,
            200,
          );
          const restarted = yield* make.pipe(
            Effect.provideService(DecisionSettingsRepository, settings),
          );
          yield* settings.update(
            {
              operation: "update",
              projectId,
              expectedRevision: 1,
              enabled: true,
              description: "New scope after admission",
            },
            0,
          );
          if (changeSource)
            yield* sql`UPDATE projection_thread_messages SET text = 'Changed after preview' WHERE message_id = 'history-0400'`;
          assert.isNull(yield* restarted.claim({ owner: "restart-page-2" }));
          assert.isNull(yield* restarted.claim({ owner: "restart-page-3" }));
          const first = yield* restarted.claim({ owner: "restart-ready" });
          if (changeSource) {
            assert.isNull(first);
            assert.equal(
              (yield* sql<{
                state: string;
              }>`SELECT state FROM decision_scans WHERE id = ${scan.scanId}`)[0]?.state,
              "canceled",
            );
          } else {
            assert.isNotNull(first);
            assert.equal(first!.description, "Original scan scope");
            assert.equal(
              (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM decision_jobs`)[0]
                ?.count,
              401,
            );
          }
        }
      }),
  );
  it.effect("returns a scan ID before preparation and honors cancellation between pages", () =>
    Effect.gen(function* () {
      for (const prepareOnePage of [false, true]) {
        const { sql, settings, jobs } = yield* fixture;
        yield* settings.update(
          { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
          0,
        );
        yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v < 400) INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) SELECT 'history-' || printf('%04d',v),${threadId},'user','Use Postgres.',0,'2026-09-22','2026-09-22' FROM n`;
        const preview = yield* jobs.scan({ operation: "preview", projectId });
        const scan = yield* jobs.scan({
          operation: "start",
          projectId,
          expectedSettingsRevision: 1,
          previewToken: preview.previewToken!,
        });
        assert.equal(scan.state, "queued");
        assert.equal(
          (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM decision_jobs`)[0]?.count,
          0,
        );
        if (prepareOnePage) assert.isNull(yield* jobs.claim({ owner: "prepare" }));
        const canceled = yield* jobs.scan({ operation: "cancel", projectId, scanId: scan.scanId! });
        assert.equal(canceled.messageCount, 401);
        assert.isNull(yield* jobs.claim({ owner: "after-cancel" }));
        assert.equal(
          (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM decision_jobs WHERE state <> 'canceled'`)[0]?.count,
          0,
        );
        assert.equal(
          (yield* sql<{
            prepared_message_count: number;
          }>`SELECT prepared_message_count FROM decision_scans WHERE id = ${scan.scanId}`)[0]
            ?.prepared_message_count,
          prepareOnePage ? 200 : 0,
        );
      }
    }),
  );
  it.effect("reports exact message counts for coalesced paused live gaps", () =>
    Effect.gen(function* () {
      const { sql, settings, jobs } = yield* fixture;
      yield* settings.update(
        { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
        0,
      );
      yield* settings.pause(
        { operation: "pause-thread", projectId, threadId, paused: true, expectedPauseEpoch: 0 },
        0,
      );
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('second',${threadId},'assistant','Use Postgres.',0,'2026-09-23','2026-09-23')`;
      yield* jobs.processEvent(event(1));
      yield* jobs.processEvent(event(2, "second"));
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM decision_coverage WHERE state = 'unscanned'`)[0]?.count,
        1,
      );
      assert.equal(yield* countDecisionUnscannedMessages(sql, projectId), 2);
      const preview = yield* jobs.scan({ operation: "preview", projectId });
      yield* jobs.scan({
        operation: "start",
        projectId,
        expectedSettingsRevision: 1,
        previewToken: preview.previewToken!,
      });
      assert.isNull(yield* jobs.claim({ owner: "prepare-recovery" }));
      for (const remaining of [1, 0]) {
        const job = (yield* jobs.claim({ owner: "recover" }))!;
        yield* jobs.finish({
          jobId: job.id,
          owner: "recover",
          fence: job.fence,
          state: "no_match",
        });
        assert.equal(yield* countDecisionUnscannedMessages(sql, projectId), remaining);
      }
      yield* sql`UPDATE projection_thread_messages SET text = 'Different decision' WHERE message_id = 'second'`;
      yield* jobs.processEvent(event(3, "second"));
      assert.equal(yield* countDecisionUnscannedMessages(sql, projectId), 1);
    }),
  );
  it.effect(
    "reports canceled thread targets as partial scan coverage after deletion or reversion",
    () =>
      Effect.gen(function* () {
        for (const operation of ["thread.deleted", "thread.reverted"] as const) {
          const { sql, settings, jobs } = yield* fixture;
          yield* settings.update(
            { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
            0,
          );
          const preview = yield* jobs.scan({ operation: "preview", projectId });
          const scan = yield* jobs.scan({
            operation: "start",
            projectId,
            expectedSettingsRevision: 1,
            previewToken: preview.previewToken!,
          });
          assert.isNull(yield* jobs.claim({ owner: "prepare" }));
          assert.isNotNull(yield* jobs.claim({ owner: "working" }));
          yield* jobs.processEvent(
            operation === "thread.deleted"
              ? { ...event(1), type: operation, payload: { threadId, deletedAt: "2026-09-24" } }
              : { ...event(1), type: operation, payload: { threadId, turnCount: 0 } },
          );
          assert.isNull(yield* jobs.claim({ owner: "after-cancel" }));
          assert.equal(
            (yield* sql<{
              state: string;
            }>`SELECT state FROM decision_scans WHERE id = ${scan.scanId}`)[0]?.state,
            "incomplete",
          );
          assert.equal(
            (yield* sql<{ state: string }>`SELECT state FROM decision_coverage`)[0]?.state,
            "canceled",
          );
        }
      }),
  );
});
