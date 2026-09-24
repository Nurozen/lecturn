import {
  ThreadDecisionError,
  type ThreadDecisionSettingsInput,
  type ThreadDecisionSettingsResult,
  type ThreadDecisionStatusInput,
  type ThreadDecisionStatusResult,
  type ThreadDecisionSourceWindowInput,
  type ThreadDecisionSourceWindowResult,
  type ThreadDecisionChange,
  type ThreadId,
  type ProjectId,
  DecisionBlockedReason,
  DecisionScanId,
  DecisionJobId,
  ThreadId as ThreadIdSchema,
  DecisionJobState,
} from "@lecturn/contracts";
import { Context, Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DecisionRepository } from "./DecisionRepository.ts";
import { DecisionSettingsRepository } from "./DecisionSettingsRepository.ts";
import { DecisionJobRepository, countDecisionUnscannedMessages } from "./DecisionJobRepository.ts";
import { decisionSourceWindow } from "./DecisionSourceWindow.ts";
import { DecisionCloudClient } from "./DecisionCloudClient.ts";

export class DecisionWriterAvailability extends Context.Service<
  DecisionWriterAvailability,
  {
    readonly check: (
      projectId: ProjectId,
      threadId?: ThreadId,
    ) => Effect.Effect<{ supported: boolean; reason: string | null }, ThreadDecisionError>;
  }
>()("lecturn/threadDecisions/DecisionService/DecisionWriterAvailability") {}

const isThreadDecisionError = Schema.is(ThreadDecisionError);
const isBlockedReason = Schema.is(DecisionBlockedReason);
const isJobState = Schema.is(DecisionJobState);
const boundary = (error: unknown) =>
  isThreadDecisionError(error)
    ? error
    : new ThreadDecisionError({
        code: "unavailable",
        message: "Decisions are temporarily unavailable.",
      });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notes = yield* DecisionRepository;
  const settingsRepo = yield* DecisionSettingsRepository;
  const jobs = yield* DecisionJobRepository;
  const writer = yield* DecisionWriterAvailability;
  const cloud = yield* DecisionCloudClient;
  const changes = yield* PubSub.sliding<ThreadDecisionChange>({ capacity: 256 });
  // The outbox is committed with each data mutation. A restart or dropped stream
  // is repaired by clients rereading the project revision on reconnect.
  const publish = Effect.gen(function* () {
    const rows = yield* sql<{
      project_id: string;
      revision: number;
    }>`SELECT project_id, revision FROM decision_outbox WHERE revision > published_revision`;
    for (const row of rows) {
      yield* PubSub.publish(changes, {
        projectId: row.project_id as ProjectId,
        revision: row.revision,
      });
      yield* sql`UPDATE decision_outbox SET published_revision = ${row.revision} WHERE project_id = ${row.project_id} AND published_revision < ${row.revision}`;
    }
  }).pipe(Effect.catch(() => Effect.void));
  yield* publish.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
  const settings = Effect.fn("Decisions.settings")(function* (
    input: ThreadDecisionSettingsInput,
  ): Effect.fn.Return<ThreadDecisionSettingsResult, ThreadDecisionError> {
    const rows = yield* sql<{
      sequence: number;
    }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`.pipe(
      Effect.mapError(boundary),
    );
    const sequence = rows[0]?.sequence ?? 0;
    switch (input.operation) {
      case "get":
        break;
      case "update": {
        const funding = yield* cloud.fundingStatus;
        yield* settingsRepo.setFunding(
          input.projectId,
          funding.state,
          funding.accountLabel,
          funding.generation,
        );
        yield* settingsRepo.update(input, sequence);
        break;
      }
      case "pause-thread":
        yield* settingsRepo.pause(input, sequence);
        break;
      case "purge":
        yield* settingsRepo.purge(input.projectId, input.expectedRevision);
        break;
    }
    yield* jobs.notify;
    yield* publish;
    return {
      settings: yield* settingsRepo.get(input.projectId),
      projectRevision: yield* notes.projectRevision(input.projectId),
    };
  });
  const status = Effect.fn("Decisions.status")(function* (
    input: ThreadDecisionStatusInput,
  ): Effect.fn.Return<ThreadDecisionStatusResult, ThreadDecisionError> {
    const storedSettings = yield* settingsRepo.get(input.projectId);
    const funding = yield* cloud.fundingStatus;
    const settings = {
      ...storedSettings,
      fundingState: funding.state,
      fundingAccountLabel: funding.accountLabel,
    };
    const thread = input.threadId
      ? yield* settingsRepo.threadState(input.projectId, input.threadId)
      : null;
    const support = yield* writer.check(input.projectId, input.threadId);
    const fundingBlocked =
      funding?.state === "unavailable"
        ? "error"
        : funding.state !== "active"
          ? "unfunded"
          : !funding.eligible
            ? "access-expired"
            : funding.allowance && funding.allowance.remainingInputTokens <= 0
              ? "allowance-exhausted"
              : null;
    const records = yield* sql<{
      state: string;
      reason: string | null;
      count: number;
      at: string | null;
    }>`SELECT state, reason, COUNT(*) AS count, MAX(updated_at) AS at FROM decision_jobs WHERE project_id = ${input.projectId} AND ${input.threadId ? sql`thread_id = ${input.threadId}` : sql`1 = 1`} GROUP BY state, reason`.pipe(
      Effect.mapError(boundary),
    );
    const uncovered = yield* countDecisionUnscannedMessages(
      sql,
      input.projectId,
      input.threadId,
    ).pipe(Effect.mapError(boundary));
    const scanRows = yield* sql<{
      id: string;
      state: "queued" | "running" | "incomplete";
      count: number;
    }>`SELECT s.id, s.state, CASE WHEN s.expected_message_count > 0 THEN s.expected_message_count ELSE COUNT(j.id) END AS count FROM decision_scans s LEFT JOIN decision_jobs j ON j.scan_id = s.id WHERE s.project_id = ${input.projectId} AND s.state IN ('queued', 'running', 'incomplete') AND ${input.threadId ? sql`(s.thread_id IS NULL OR s.thread_id = ${input.threadId})` : sql`1 = 1`} GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 20`.pipe(
      Effect.mapError(boundary),
    );
    const incompleteRows = yield* sql<{
      id: string;
      thread_id: string;
      state: string;
      reason: string | null;
    }>`SELECT id, thread_id, state, reason FROM decision_jobs WHERE project_id = ${input.projectId} AND state IN ('incomplete', 'failed', 'waiting') AND ${input.threadId ? sql`thread_id = ${input.threadId}` : sql`1 = 1`} ORDER BY updated_at DESC LIMIT 50`.pipe(
      Effect.mapError(boundary),
    );
    const count = (states: readonly string[]) =>
      records.filter((row) => states.includes(row.state)).reduce((sum, row) => sum + row.count, 0);
    const active = count(["detecting", "localizing", "writing"]);
    const pendingCount = count(["queued", "waiting", "detecting", "localizing", "writing"]);
    const incompleteCount = count(["incomplete", "failed"]);
    const blocked = records.find(
      (row) => row.state === "waiting" || row.state === "incomplete" || row.state === "failed",
    )?.reason;
    const blockedReason = !settings.enabled
      ? "disabled"
      : thread?.paused
        ? "paused"
        : !support.supported
          ? "provider-unsupported"
          : fundingBlocked
            ? fundingBlocked
            : isBlockedReason(blocked)
              ? blocked
              : null;
    return {
      activeScans: scanRows.map((row) => ({
        scanId: DecisionScanId.make(row.id),
        state: row.state,
        messageCount: row.count,
      })),
      incompleteJobs: incompleteRows.map((row) => ({
        id: DecisionJobId.make(row.id),
        threadId: ThreadIdSchema.make(row.thread_id),
        state: isJobState(row.state) ? row.state : "failed",
        reason: isBlockedReason(row.reason) ? row.reason : "error",
      })),
      settings,
      projectRevision: yield* notes.projectRevision(input.projectId),
      processing: {
        projectId: input.projectId,
        threadId: input.threadId ?? null,
        paused: thread?.paused ?? false,
        pauseEpoch: thread?.pauseEpoch ?? 0,
        state: active
          ? "running"
          : incompleteCount
            ? "incomplete"
            : pendingCount || (settings.enabled && blockedReason)
              ? "waiting"
              : "idle",
        blockedReason,
        pendingCount,
        incompleteCount,
        unscannedMessageCount: uncovered,
        lastProcessedAt:
          records
            .filter((row) => ["committed", "no_match"].includes(row.state))
            .map((row) => row.at)
            .filter((at): at is string => at !== null)
            .sort()
            .at(-1) ?? null,
        writerSupported: support.supported,
        writerSupportReason: support.reason,
      },
    };
  });
  const sourceWindow = Effect.fn("Decisions.sourceWindow")(function* (
    input: ThreadDecisionSourceWindowInput,
  ): Effect.fn.Return<ThreadDecisionSourceWindowResult, ThreadDecisionError> {
    const note = yield* notes.get({ projectId: input.projectId, id: input.decisionId });
    const evidence = note.evidence.find((item) => item.id === input.evidenceId);
    if (!evidence)
      return yield* new ThreadDecisionError({
        code: "not-found",
        message: "The decision evidence no longer exists.",
      });
    return yield* decisionSourceWindow(input.projectId, evidence).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });
  return {
    fundingStatus: cloud.fundingStatus,
    funding: ((input) =>
      cloud.funding(input).pipe(
        Effect.tap((result) =>
          Effect.gen(function* () {
            if (input.operation === "challenge") return;
            const projects = yield* sql<{
              project_id: string;
            }>`SELECT project_id FROM projection_projects WHERE deleted_at IS NULL`;
            for (const project of projects)
              yield* settingsRepo.setFunding(
                project.project_id as ProjectId,
                result.status.state,
                result.status.accountLabel,
                result.status.generation,
              );
            yield* jobs.notify;
            yield* publish;
          }).pipe(Effect.mapError(boundary)),
        ),
      )) as typeof cloud.funding,
    list: notes.list,
    get: notes.get,
    export: notes.export,
    mutate: ((input) => notes.mutate(input).pipe(Effect.tap(() => publish))) as typeof notes.mutate,
    settings,
    status,
    sourceWindow,
    scan: ((input) => jobs.scan(input).pipe(Effect.tap(() => publish))) as typeof jobs.scan,
    changes: Stream.fromPubSub(changes),
  };
});
export class DecisionService extends Context.Service<
  DecisionService,
  Effect.Success<typeof make>
>()("lecturn/threadDecisions/DecisionService") {}
export const layer = Layer.effect(DecisionService, make);
