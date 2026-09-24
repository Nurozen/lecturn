import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  EnvironmentId,
  DecisionJobId,
  ThreadDecisionError,
  DecisionEvaluationError,
  type DecisionEvaluationRequest,
  type DecisionFundingStatusResult,
  type DecisionWriterOutput,
  type DecisionWriterInput,
  type HostPowerSnapshot,
  type ServerProvider,
} from "@lecturn/contracts";
import { Deferred, Effect, Layer, DateTime, PubSub, Ref, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { HostPowerMonitor } from "../background/HostPowerMonitor.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ProviderWorkAdmission, make as makeAdmission } from "../provider/ProviderWorkAdmission.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { DecisionSettingsRepository, make as makeSettings } from "./DecisionSettingsRepository.ts";
import { DecisionRepository, make as makeRepository } from "./DecisionRepository.ts";
import {
  DecisionJobRepository,
  DecisionJobStage,
  make as makeJobs,
} from "./DecisionJobRepository.ts";
import { DecisionCloudClient } from "./DecisionCloudClient.ts";
import { DecisionWriterBinding, type WriterBinding } from "./DecisionWriterBinding.ts";
import { make } from "./DecisionWorker.ts";
const projectId = ProjectId.make("worker-project");
const threadId = ThreadId.make("worker-thread");
const instanceId = ProviderInstanceId.make("custom-codex");
const decodeStage = Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionJobStage));
const isEvaluationError = Schema.is(DecisionEvaluationError);
const hostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "nominal",
  stale: false,
  updatedAt: DateTime.makeUnsafe("2026-09-23T00:00:00Z"),
};
const hostLayer = Layer.effect(
  HostPowerMonitor,
  Effect.gen(function* () {
    const state = yield* Ref.make(hostPower);
    return HostPowerMonitor.of({
      snapshot: Ref.get(state),
      report: (next) => Ref.set(state, next),
      streamChanges: Stream.empty,
    });
  }),
);
const testLayer = Layer.merge(
  SqlitePersistenceMemory,
  BackgroundPolicy.layer.pipe(
    Layer.provide(Layer.merge(hostLayer, ServerSettingsService.layerTest())),
  ),
);
const allowance = {
  windowStart: "2026-09-01",
  windowEnd: "2026-10-01",
  limitInputTokens: 10000000,
  usedInputTokens: 1,
  reservedInputTokens: 0,
  remainingInputTokens: 9999999,
};
const binding: WriterBinding = {
  projectId,
  threadId,
  cwd: "/tmp/decision-worker",
  modelSelection: { instanceId, model: "selected-model", options: [] },
  fingerprint: "same-account-config",
};
const goodOutput = (input: Omit<DecisionWriterInput, "modelSelection">): DecisionWriterOutput => ({
  actions: input.candidates.map((candidate) => ({
    action: "create",
    candidateId: candidate.id,
    title: "Use SQLite",
    body: "Use SQLite for storage.",
    rationale: null,
    attribution: "agent-chosen",
    evidence: [
      {
        evidenceId: candidate.evidenceIds[0]!,
        quote: input.evidence.find((item) => item.id === candidate.evidenceIds[0])!.quote,
      },
    ],
  })),
  complete: true,
  unresolvedCandidateIds: [],
});
interface Options {
  readonly unsupported?: boolean;
  readonly paid?: boolean;
  readonly writer?: (
    input: Omit<DecisionWriterInput, "modelSelection">,
    attempt: number,
    sql: SqlClient.SqlClient,
    settings: DecisionSettingsRepository["Service"],
  ) => Effect.Effect<DecisionWriterOutput, ThreadDecisionError>;
  readonly negative?: boolean;
  readonly evaluate?: (
    input: DecisionEvaluationRequest,
    attempt: number,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<void, DecisionEvaluationError>;
}
const fixture = (options: Options = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of [
      "decision_project_settings",
      "decision_thread_state",
      "decision_sources",
      "decision_jobs",
      "decision_scans",
      "decision_evaluations",
      "decision_coverage",
      "decision_outbox",
      "decision_evidence",
      "decision_relationships",
      "decision_suppression",
      "thread_decisions",
      "projection_thread_messages",
      "projection_threads",
      "projection_projects",
    ])
      yield* sql`DELETE FROM ${sql(table)}`;
    yield* sql`UPDATE decision_ingestion_cursor SET sequence = 0`;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Worker','/tmp/worker','[]','now','now')`;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES (${threadId},${projectId},'Thread','{}','now','now','full-access','default')`;
    yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('message',${threadId},'assistant','Use SQLite.',0,'2026-09-23','2026-09-23')`;
    const settings = yield* makeSettings;
    const repository = yield* makeRepository;
    const jobs = yield* makeJobs.pipe(Effect.provideService(DecisionSettingsRepository, settings));
    const admission = yield* makeAdmission;
    yield* settings.update(
      {
        operation: "update",
        projectId,
        expectedRevision: 0,
        enabled: true,
        description: "Storage choices",
      },
      0,
    );
    yield* jobs.processEvent({
      sequence: 1,
      eventId: EventId.make("worker-event"),
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
    const requests: DecisionEvaluationRequest[] = [];
    let writerCalls = 0;
    let unsupported = options.unsupported;
    const fundingEvents = yield* PubSub.unbounded<DecisionFundingStatusResult>();
    const instanceEvents = yield* PubSub.unbounded<void>();
    const providerEvents = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
    let status: DecisionFundingStatusResult = {
      environmentId: EnvironmentId.make("env"),
      state: "active",
      generation: 1,
      accountLabel: "Member",
      eligible: options.paid !== false,
      allowance,
      remoteRevocationPending: false,
    };
    const cloud = DecisionCloudClient.of({
      retryPendingRevocation: Effect.void,
      refreshFunding: Effect.void,
      subscribeFundingChanges: PubSub.subscribe(fundingEvents).pipe(
        Effect.map(Stream.fromSubscription),
      ),
      fundingStatus: Effect.sync(() => status),
      funding: () => Effect.die("unused"),
      evaluate: (input) =>
        Effect.sync(() => {
          requests.push(input);
          return {
            requestId: input.requestId,
            runId: input.runId,
            model: "jev-1.13.0",
            templateVersion: "decisions-v1",
            judgments: input.targets.map((target) => ({
              targetId: target.id,
              exists: options.negative ? ("no" as const) : ("yes" as const),
              relevant: "yes" as const,
            })),
            inputTokens: 10,
            allowance,
            replayed: false,
          };
        }).pipe(
          Effect.flatMap((result) =>
            options.evaluate
              ? options.evaluate(input, requests.length, sql).pipe(Effect.as(result))
              : Effect.succeed(result),
          ),
        ),
    });
    let currentBinding = binding;
    const writer = DecisionWriterBinding.of({
      capture: () =>
        unsupported
          ? Effect.fail(new ThreadDecisionError({ code: "unsupported", message: "Unsupported" }))
          : Effect.sync(() => currentBinding),
      validate: (captured) =>
        Effect.suspend(() =>
          captured.fingerprint === currentBinding.fingerprint
            ? Effect.void
            : Effect.fail(new ThreadDecisionError({ code: "conflict", message: "Writer changed" })),
        ),
      check: () => Effect.succeed({ supported: !options.unsupported, reason: null }),
      write: (_binding, input) =>
        Effect.suspend(() => {
          writerCalls++;
          return options.writer
            ? options.writer(input, writerCalls, sql, settings)
            : Effect.succeed(goodOutput(input));
        }),
    });
    const worker = yield* make.pipe(
      Effect.provideService(DecisionJobRepository, jobs),
      Effect.provideService(DecisionRepository, repository),
      Effect.provideService(DecisionSettingsRepository, settings),
      Effect.provideService(DecisionCloudClient, cloud),
      Effect.provideService(DecisionWriterBinding, writer),
      Effect.provideService(ProviderWorkAdmission, admission),
      Effect.provide(
        Layer.merge(
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([]),
            subscribeChanges: PubSub.subscribe(providerEvents).pipe(
              Effect.map(Stream.fromSubscription),
            ),
          }),
          Layer.mock(ProviderInstanceRegistry)({
            subscribeChanges: PubSub.subscribe(instanceEvents),
          }),
        ),
      ),
    );
    return {
      sql,
      jobs,
      repository,
      settings,
      admission,
      worker,
      requests,
      writerCalls: () => writerCalls,
      enableWriter: () => {
        unsupported = false;
      },
      notifyProvider: PubSub.publish(instanceEvents, undefined),
      notifyAuth: buildUnavailableProviderSnapshot({
        driverKind: "codex",
        instanceId,
        reason: "test",
      }).pipe(
        Effect.flatMap((snapshot) =>
          PubSub.publish(providerEvents, [{ ...snapshot, auth: { status: "authenticated" } }]),
        ),
      ),
      notifyFunding: Effect.suspend(() => PubSub.publish(fundingEvents, status)),
      revokeFunding: () => {
        status = { ...status, state: "revoked", eligible: false };
      },
      setFunding: (next: DecisionFundingStatusResult) => {
        status = next;
      },
      restoreFunding: () => {
        status = { ...status, state: "active", eligible: true };
      },
      changeWriter: () => {
        currentBinding = {
          ...binding,
          fingerprint: "new-account-config",
          modelSelection: { ...binding.modelSelection, model: "new-model" },
        };
      },
    };
  });
it.layer(testLayer)("Decision worker", (it) => {
  it.effect(
    "writes through the exact thread selection with no open clients and commits source-linked unreviewed notes",
    () =>
      Effect.gen(function* () {
        const { worker, repository, requests, writerCalls, sql } = yield* fixture();
        yield* worker.drive;
        const notes = (yield* repository.list({ projectId })).decisions;
        assert.equal(notes.length, 1);
        assert.equal(notes[0]?.reviewState, "unreviewed");
        assert.equal(notes[0]?.evidence[0]?.quote, "Use SQLite.");
        assert.equal(notes[0]?.provenance.writerSelection.instanceId, instanceId);
        assert.equal(notes[0]?.provenance.writerSelection.model, "selected-model");
        assert.equal(requests.length, 1);
        assert.equal(writerCalls(), 1);
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state FROM decision_jobs`)[0]?.state,
          "committed",
        );
        yield* worker.drive;
        assert.equal(writerCalls(), 1);
      }),
  );
  it.effect(
    "does not spend detection quota for unsupported writers, unpaid access or host suspension",
    () =>
      Effect.gen(function* () {
        for (const options of [{ unsupported: true }, { paid: false }]) {
          const { worker, requests, writerCalls } = yield* fixture(options);
          yield* worker.drive;
          assert.equal(requests.length, 0);
          assert.equal(writerCalls(), 0);
        }
        const { worker, requests } = yield* fixture();
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        yield* policy.reportHostPowerState({ ...hostPower, suspended: true });
        yield* worker.drive;
        assert.equal(requests.length, 0);
        yield* policy.reportHostPowerState(hostPower);
        yield* worker.drive;
        assert.equal(requests.length, 1);
      }),
  );
  it.effect("defers to foreground work and resumes without another detection charge", () =>
    Effect.gen(function* () {
      const { worker, requests, admission, jobs, repository } = yield* fixture();
      const token = yield* admission.beginForeground(instanceId, threadId);
      yield* worker.drive;
      assert.equal(requests.length, 0);
      yield* admission.abandonForeground(threadId, token);
      yield* jobs.wakeWaiting("provider-foreground");
      yield* worker.drive;
      assert.equal((yield* repository.list({ projectId })).decisions.length, 1);
      assert.equal(requests.length, 1);
    }),
  );
  it.effect(
    "explicit expiry retry checkpoints its replacement identity and crash recovery replays it under the same run budget",
    () =>
      Effect.gen(function* () {
        let originalId = "";
        let replacementId = "";
        const f = yield* fixture({
          evaluate: (input, attempt, sql) =>
            Effect.gen(function* () {
              if (attempt === 1) originalId = input.requestId;
              if (input.requestId === originalId)
                return yield* new DecisionEvaluationError({
                  code: "expired",
                  message: "Result retention elapsed",
                });
              const rows = yield* sql<{ stage_json: string }>`SELECT stage_json FROM decision_jobs`;
              const stage = yield* decodeStage(rows[0]!.stage_json);
              assert.isTrue(Object.values(stage.evaluationRequestIds).includes(input.requestId));
              if (!replacementId) {
                replacementId = input.requestId;
                return yield* new DecisionEvaluationError({
                  code: "unavailable",
                  message: "Host lost response",
                });
              }
            }).pipe(
              Effect.mapError((cause) =>
                isEvaluationError(cause)
                  ? cause
                  : new DecisionEvaluationError({ code: "unavailable", message: "fixture" }),
              ),
            ),
        });
        yield* f.worker.drive;
        const jobs = yield* f.sql<{
          id: string;
          reason: string;
        }>`SELECT id,reason FROM decision_jobs`;
        assert.equal(jobs[0]?.reason, "detector-unavailable");
        yield* f.jobs.retry({ projectId, jobId: DecisionJobId.make(jobs[0]!.id) });
        yield* f.worker.drive;
        assert.equal(f.requests.length, 3);
        assert.equal(f.requests[0]!.requestId, f.requests[1]!.requestId);
        assert.notEqual(replacementId, originalId);
        // Reconstruct the persisted in-flight state after a process crash: the last
        // dispatch identity was durable, but its successful relay result was not.
        yield* f.sql`UPDATE decision_jobs SET state = 'localizing',reason = 'user-retry',lease_owner = 'crashed',lease_until = '1970-01-01T00:00:00.000Z'`;
        yield* f.worker.drive;
        assert.equal(f.requests.length, 4);
        assert.equal(f.requests[3]!.requestId, replacementId);
        assert.equal(new Set(f.requests.map((request) => request.runId)).size, 1);
        assert.equal((yield* f.repository.list({ projectId })).decisions.length, 1);
      }),
  );
  it.effect(
    "ambiguous detector failures expose retry without minting a new request or waking on provider changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          evaluate: (_input, attempt) =>
            attempt === 1
              ? Effect.fail(
                  new DecisionEvaluationError({ code: "unavailable", message: "Timeout" }),
                )
              : Effect.void,
        });
        yield* f.worker.drive;
        yield* f.worker.start;
        yield* f.notifyProvider;
        yield* f.worker.drive;
        assert.equal(f.requests.length, 1);
        const rows = yield* f.sql<{ id: string }>`SELECT id FROM decision_jobs`;
        yield* f.jobs.retry({ projectId, jobId: DecisionJobId.make(rows[0]!.id) });
        yield* f.worker.drive;
        assert.equal(f.requests.length, 2);
        assert.equal(f.requests[0]!.requestId, f.requests[1]!.requestId);
        assert.equal((yield* f.repository.list({ projectId })).decisions.length, 1);
      }).pipe(Effect.scoped),
  );
  it.effect("funding and provider recovery events resume waiting work without a manual retry", () =>
    Effect.gen(function* () {
      for (const blocked of ["funding", "provider", "auth"]) {
        const written = yield* Deferred.make<void>();
        const f = yield* fixture({
          paid: blocked !== "funding",
          unsupported: blocked !== "funding",
          writer: (input) =>
            Deferred.succeed(written, undefined).pipe(Effect.as(goodOutput(input))),
        });
        yield* f.worker.drive;
        assert.equal(f.writerCalls(), 0);
        yield* f.worker.start;
        if (blocked === "funding") {
          f.restoreFunding();
          yield* f.notifyFunding;
        } else {
          f.enableWriter();
          yield* blocked === "provider" ? f.notifyProvider : f.notifyAuth;
        }
        yield* Deferred.await(written);
        yield* f.worker.drive;
        assert.equal((yield* f.repository.list({ projectId })).decisions.length, 1);
        assert.equal(f.requests.length, 1);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("wakes at an interrupted lease expiry on a quiet restarted host", () =>
    Effect.gen(function* () {
      const written = yield* Deferred.make<void>();
      const f = yield* fixture({
        writer: (input) => Deferred.succeed(written, undefined).pipe(Effect.as(goodOutput(input))),
      });
      const interrupted = (yield* f.jobs.claim({ owner: "old-process", leaseMs: 1000 }))!;
      yield* f.worker.start;
      assert.equal(f.requests.length, 0);
      yield* TestClock.adjust(1000);
      yield* Deferred.await(written);
      yield* f.worker.drive;
      const resumed = (yield* f.jobs.get(interrupted.id))!;
      assert.equal(resumed.state, "committed");
      assert.isAbove(resumed.fence, interrupted.fence);
      assert.equal(f.writerCalls(), 1);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "reconciles a redeemed funding generation after restart before replaying an old request",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.settings.setFunding(projectId, "active", "Member", 1);
        const old = (yield* f.jobs.claim({ owner: "old-process", leaseMs: 1000 }))!;
        yield* f.jobs.checkpoint({
          jobId: old.id,
          owner: "old-process",
          fence: old.fence,
          state: "localizing",
          stage: { ...old.stage, evaluationRequestIds: { old: "old-generation-request" } },
        });
        f.setFunding({
          environmentId: EnvironmentId.make("env"),
          state: "active",
          eligible: true,
          generation: 2,
          accountLabel: "Member",
          allowance,
          remoteRevocationPending: false,
        });
        yield* f.worker.drive;
        assert.equal((yield* f.jobs.get(old.id))!.state, "canceled");
        assert.equal(f.requests.length, 0);
        assert.equal(f.writerCalls(), 0);
      }),
  );
  it.effect(
    "explicit retry discards a checkpointed old writer result and retains paid detector results",
    () =>
      Effect.gen(function* () {
        let revoke = () => {};
        const f = yield* fixture({
          writer: (input, attempt) =>
            Effect.sync(() => {
              if (attempt === 1) revoke();
              return goodOutput(input);
            }),
        });
        revoke = f.revokeFunding;
        yield* f.worker.drive;
        const rows = yield* f.sql<{
          id: string;
          stage_json: string;
          state: string;
        }>`SELECT id,stage_json,state FROM decision_jobs`;
        assert.equal(rows[0]?.state, "waiting");
        const stage = yield* decodeStage(rows[0]!.stage_json);
        assert.isNotNull(stage.writerOutput);
        assert.equal(f.writerCalls(), 1);
        f.restoreFunding();
        f.changeWriter();
        yield* f.jobs.retry({ projectId, jobId: DecisionJobId.make(rows[0]!.id) });
        yield* f.worker.drive;
        assert.equal(f.requests.length, 1);
        assert.equal(f.writerCalls(), 2);
        const notes = (yield* f.repository.list({ projectId })).decisions;
        assert.equal(notes.length, 1);
        assert.equal(notes[0]?.provenance.writerSelection.model, "new-model");
      }),
  );
  it.effect("repairs invalid evidence once through the same writer without repeating Jev", () =>
    Effect.gen(function* () {
      const { worker, repository, requests, writerCalls } = yield* fixture({
        writer: (input, attempt) =>
          Effect.succeed(
            attempt === 1
              ? {
                  ...goodOutput(input),
                  actions: [
                    {
                      ...goodOutput(input).actions[0]!,
                      evidence: [
                        { evidenceId: input.evidence[0]!.id, quote: "fabricated quotation" },
                      ],
                    } as DecisionWriterOutput["actions"][number],
                  ],
                }
              : goodOutput(input),
          ),
      });
      yield* worker.drive;
      assert.equal(requests.length, 1);
      assert.equal(writerCalls(), 2);
      assert.equal((yield* repository.list({ projectId })).decisions.length, 1);
    }),
  );
  it.effect("rejects changed sources and purges during writing without a late note", () =>
    Effect.gen(function* () {
      for (const purge of [false, true]) {
        const { worker, repository, sql } = yield* fixture({
          writer: (input, _attempt, db, settings) =>
            Effect.gen(function* () {
              if (purge) yield* settings.purge(projectId);
              else yield* db`UPDATE projection_thread_messages SET text = 'Use Postgres.'`;
              return goodOutput(input);
            }).pipe(
              Effect.mapError(
                () =>
                  new ThreadDecisionError({ code: "unavailable", message: "Test mutation failed" }),
              ),
            ),
        });
        yield* worker.drive;
        assert.equal((yield* repository.list({ projectId })).decisions.length, 0);
        if (purge)
          assert.equal(
            (yield* sql<{ count: number }>`SELECT count(*) AS count FROM decision_jobs`)[0]?.count,
            0,
          );
      }
    }),
  );
  it.effect("retains provider failures for retry and reuses successful detection", () =>
    Effect.gen(function* () {
      const { worker, jobs, repository, requests, writerCalls, sql } = yield* fixture({
        writer: (input, attempt) =>
          attempt === 1
            ? Effect.fail(
                new ThreadDecisionError({
                  code: "unavailable",
                  message: "Provider usage exhausted",
                }),
              )
            : Effect.succeed(goodOutput(input)),
      });
      yield* worker.drive;
      const rows = yield* sql<{ id: string; state: string }>`SELECT id,state FROM decision_jobs`;
      assert.equal(rows[0]?.state, "waiting");
      yield* jobs.retry({ projectId, jobId: rows[0]!.id as Parameters<typeof jobs.get>[0] });
      yield* worker.drive;
      assert.equal(requests.length, 1);
      assert.equal(writerCalls(), 2);
      assert.equal((yield* repository.list({ projectId })).decisions.length, 1);
    }),
  );
  it.effect("keeps unresolved context incomplete after one bounded expansion", () =>
    Effect.gen(function* () {
      const { worker, writerCalls, sql, repository } = yield* fixture({
        writer: (input) =>
          Effect.succeed({
            actions: input.candidates.map((candidate) => ({
              action: "needs_context",
              candidateId: candidate.id,
              reason: "The antecedent is missing",
            })),
            complete: false,
            unresolvedCandidateIds: input.candidates.map((candidate) => candidate.id),
          }),
      });
      yield* worker.drive;
      assert.equal(writerCalls(), 2);
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM decision_jobs`)[0]?.state,
        "incomplete",
      );
      assert.equal((yield* repository.list({ projectId })).decisions.length, 0);
    }),
  );
  it.effect("revisits unresolved context once when a later finalized message arrives", () =>
    Effect.gen(function* () {
      for (const clarificationResolves of [true, false]) {
        const f = yield* fixture({
          writer: (input) => {
            const target = input.evidence.find(
              (evidence) => evidence.id === input.candidates[0]?.evidenceIds[0],
            );
            if (target?.messageId !== "message")
              return Effect.succeed({
                actions: input.candidates.map((candidate) => ({
                  action: "skip" as const,
                  candidateId: candidate.id,
                  reason: "irrelevant" as const,
                })),
                complete: true,
                unresolvedCandidateIds: [],
              });
            if (clarificationResolves && input.context.includes("first option"))
              return Effect.succeed(goodOutput(input));
            return Effect.succeed({
              actions: input.candidates.map((candidate) => ({
                action: "needs_context" as const,
                candidateId: candidate.id,
                reason: "Missing antecedent",
              })),
              complete: false,
              unresolvedCandidateIds: input.candidates.map((candidate) => candidate.id),
            });
          },
        });
        yield* f.worker.drive;
        const rows = yield* f.sql<{ id: string }>`SELECT id FROM decision_jobs`;
        const id = DecisionJobId.make(rows[0]!.id);
        assert.equal((yield* f.jobs.get(id))!.reason, "needs-context");
        for (const sequence of [2, 3]) {
          const messageId = MessageId.make(`clarification-${sequence}`);
          yield* f.sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES (${messageId},${threadId},'user','The first option refers to SQLite.',0,'2026-09-24','2026-09-24')`;
          yield* f.jobs.processEvent({
            sequence,
            eventId: EventId.make(`context-${sequence}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-09-24",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId,
              messageId,
              role: "user",
              text: "",
              turnId: null,
              streaming: false,
              createdAt: "2026-09-24",
              updatedAt: "2026-09-24",
            },
          });
          yield* f.worker.drive;
          const original = (yield* f.jobs.get(id))!;
          assert.equal(original.attempts, 2);
          assert.equal(original.state, clarificationResolves ? "committed" : "incomplete");
        }
        assert.equal(
          (yield* f.repository.list({ projectId })).decisions.length,
          clarificationResolves ? 1 : 0,
        );
      }
    }),
  );
  it.effect("marks clear negative coverage without launching a writer", () =>
    Effect.gen(function* () {
      const { worker, writerCalls, sql } = yield* fixture({ negative: true });
      yield* worker.drive;
      assert.equal(writerCalls(), 0);
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM decision_jobs`)[0]?.state,
        "no_match",
      );
    }),
  );
  for (const action of ["duplicate", "propose_replacement"] as const) {
    it.effect(`retrieves a related decision from another project thread for ${action}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          writer: (input, attempt) =>
            Effect.sync(() => {
              if (attempt === 1) return goodOutput(input);
              const prior = input.existingDecisions.find((note) => note.title === "Use SQLite");
              assert.isDefined(prior);
              assert.isAtMost(input.existingDecisions.length, 20);
              const candidate = input.candidates[0]!;
              const evidence = [
                {
                  evidenceId: candidate.evidenceIds[0]!,
                  quote: input.evidence.find((item) => item.id === candidate.evidenceIds[0])!.quote,
                },
              ];
              return {
                actions:
                  action === "duplicate"
                    ? [
                        {
                          action,
                          candidateId: candidate.id,
                          existingId: prior!.id,
                          expectedRevision: prior!.revision,
                          evidence,
                        },
                      ]
                    : [
                        {
                          action,
                          candidateId: candidate.id,
                          predecessorId: prior!.id,
                          expectedRevision: prior!.revision,
                          title: "Use PostgreSQL",
                          body: "Use PostgreSQL instead of SQLite.",
                          rationale: null,
                          attribution: "agent-chosen",
                          evidence,
                        },
                      ],
                complete: true,
                unresolvedCandidateIds: [],
              };
            }),
        });
        yield* f.worker.drive;
        const prior = (yield* f.repository.list({ projectId })).decisions[0]!;
        // The predecessor belongs to a different thread and has no overlapping
        // source ID; retrieval must use project text relevance, not recency.
        yield* f.sql`UPDATE thread_decisions SET thread_id = 'another-thread', occurred_at = '2000-01-01' WHERE id = ${prior.id}`;
        yield* f.sql`UPDATE decision_evidence SET thread_id = 'another-thread', message_id = 'old-message' WHERE decision_id = ${prior.id}`;
        yield* f.sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('new-message',${threadId},'assistant',${action === "duplicate" ? "Use SQLite." : "Use PostgreSQL instead of SQLite."},0,'2026-09-24','2026-09-24')`;
        yield* f.jobs.processEvent({
          sequence: 2,
          eventId: EventId.make(`cross-thread-${action}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-09-24",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId,
            messageId: MessageId.make("new-message"),
            role: "assistant",
            text: "",
            turnId: null,
            streaming: false,
            createdAt: "2026-09-24",
            updatedAt: "2026-09-24",
          },
        });
        yield* f.worker.drive;
        const notes = (yield* f.repository.list({ projectId })).decisions;
        assert.equal(f.writerCalls(), 2);
        assert.equal(notes.length, action === "duplicate" ? 1 : 2);
        const persisted = yield* f.repository.get({ projectId, id: prior.id });
        if (action === "duplicate") assert.equal(persisted.evidence.length, 2);
        else assert.equal(persisted.relationships[0]?.state, "proposed");
      }),
    );
  }
  it.effect("processes every qualifying localization branch", () =>
    Effect.gen(function* () {
      const { sql, jobs, worker, repository, requests } = yield* fixture();
      yield* sql`UPDATE projection_thread_messages SET text = ${"a".repeat(5000)}`;
      yield* jobs.processEvent({
        sequence: 2,
        eventId: EventId.make("branches"),
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
      yield* worker.drive;
      const notes = (yield* repository.list({ projectId })).decisions;
      assert.equal(notes.length, 4);
      assert.equal(requests.length, 4);
      assert.deepEqual(
        notes.map((note) => note.evidence[0]!.start).toSorted((a, b) => a - b),
        [0, 1250, 2500, 3750],
      );
    }),
  );
  it.effect(
    "persists eight-note overflow then completes the remaining decision without dropping it",
    () =>
      Effect.gen(function* () {
        const { worker, repository, writerCalls, requests } = yield* fixture({
          writer: (input, attempt) => {
            const action = goodOutput(input).actions[0]!;
            return Effect.succeed({
              actions: Array.from(
                { length: attempt === 1 ? 8 : 1 },
                (_, index) =>
                  ({
                    ...action,
                    title: `Decision ${attempt === 1 ? index : 8}`,
                  }) as DecisionWriterOutput["actions"][number],
              ),
              complete: attempt !== 1,
              unresolvedCandidateIds: attempt === 1 ? [input.candidates[0]!.id] : [],
            });
          },
        });
        yield* worker.drive;
        assert.equal((yield* repository.list({ projectId })).decisions.length, 9);
        assert.equal(writerCalls(), 2);
        assert.equal(requests.length, 1);
        yield* worker.drive;
        assert.equal(writerCalls(), 2);
      }),
  );
  it.effect(
    "repairs incomplete writer output without unresolved targets before committing actions",
    () =>
      Effect.gen(function* () {
        for (const repairSucceeds of [false, true]) {
          const { worker, writerCalls, sql, repository } = yield* fixture({
            writer: (input, attempt) =>
              Effect.succeed({
                ...goodOutput(input),
                complete: repairSucceeds && attempt === 2,
              }),
          });
          yield* worker.drive;
          assert.equal(writerCalls(), 2);
          assert.equal(
            (yield* repository.list({ projectId })).decisions.length,
            repairSucceeds ? 1 : 0,
          );
          assert.equal(
            (yield* sql<{ state: string }>`SELECT state FROM decision_jobs`)[0]?.state,
            repairSucceeds ? "committed" : "failed",
          );
          assert.equal(
            (yield* sql<{ state: string }>`SELECT state FROM decision_coverage`)[0]?.state,
            repairSucceeds ? "complete" : "incomplete",
          );
        }
      }),
  );
  it.effect(
    "reuses a completed live evaluation for a history consumer accepted while it was queued",
    () =>
      Effect.gen(function* () {
        const { jobs, worker, repository, requests, writerCalls, sql } = yield* fixture();
        const preview = yield* jobs.scan({ operation: "preview", projectId });
        const scan = yield* jobs.scan({
          operation: "start",
          projectId,
          expectedSettingsRevision: 1,
          previewToken: preview.previewToken!,
        });
        yield* worker.drive;
        assert.equal((yield* repository.list({ projectId })).decisions.length, 1);
        assert.equal(writerCalls(), 1);
        assert.equal(requests.length, 1);
        assert.equal(
          (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM decision_jobs`)[0]?.count,
          2,
        );
        assert.equal(
          (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM decision_coverage WHERE state = 'complete'`)[0]?.count,
          2,
        );
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM decision_scans WHERE id = ${scan.scanId}`)[0]?.state,
          "completed",
        );
        yield* worker.drive;
        assert.equal(writerCalls(), 1);
      }),
  );
  it.effect("keeps two stalled writer continuations visibly incomplete", () =>
    Effect.gen(function* () {
      const { worker, writerCalls, sql } = yield* fixture({
        writer: (input) =>
          Effect.succeed({
            actions: [],
            complete: false,
            unresolvedCandidateIds: input.candidates.map((candidate) => candidate.id),
          }),
      });
      yield* worker.drive;
      assert.equal(writerCalls(), 2);
      assert.equal(
        (yield* sql<{ state: string; reason: string }>`SELECT state,reason FROM decision_jobs`)[0]
          ?.reason,
        "writer-progress",
      );
    }),
  );
  it.effect("rechecks funding after writing and rejects a revoked sponsor before commit", () =>
    Effect.gen(function* () {
      let revoke = () => {};
      const built = yield* fixture({
        writer: (input) =>
          Effect.sync(() => {
            revoke();
            return goodOutput(input);
          }),
      });
      revoke = built.revokeFunding;
      yield* built.worker.drive;
      assert.equal((yield* built.repository.list({ projectId })).decisions.length, 0);
      assert.equal(built.requests.length, 1);
      assert.equal(built.writerCalls(), 1);
      const rows = yield* built.sql<{ state: string }>`SELECT state FROM decision_jobs`;
      assert.equal(rows[0]?.state, "waiting");
    }),
  );
});
