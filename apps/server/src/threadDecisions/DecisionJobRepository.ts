import * as NodeCrypto from "node:crypto";
import {
  DecisionEvidence,
  DecisionEvaluationResult,
  DecisionJobId,
  DecisionScanId,
  DecisionWriterOutput,
  DEFAULT_DECISION_TRACKING_DESCRIPTION,
  ProjectId,
  ThreadId,
  ThreadDecisionError,
  type OrchestrationEvent,
  type ThreadDecisionScanInput,
  type ThreadDecisionScanResult,
  type DecisionJobState,
} from "@lecturn/contracts";
import {
  decisionFingerprint,
  decisionSourceHash,
  canonicalDecisionText,
} from "@lecturn/shared/decisionEvidence";
import {
  Clock,
  DateTime,
  Context,
  Effect,
  Layer,
  PubSub,
  Schema,
  Stream,
  type Scope,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  bumpDecisionRevision,
  readDecisionRevision,
  requireDecisionProject,
} from "./DecisionRevisions.ts";
import { DecisionSettingsRepository } from "./DecisionSettingsRepository.ts";

const boundedId = Schema.String.check(Schema.isMaxLength(256));
/** Traversal continuation is data only; each consumer validates its versioned payload. */
export const DecisionJobStage = Schema.Struct({
  version: Schema.Literal(1),
  evaluatedFingerprints: Schema.Array(boundedId).check(Schema.isMaxLength(256)),
  evaluationRequestIds: Schema.Record(boundedId, boundedId).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  evidence: Schema.Array(DecisionEvidence).check(Schema.isMaxLength(64)),
  writerOutput: Schema.NullOr(DecisionWriterOutput),
  resolvedCandidateIds: Schema.Array(boundedId).check(Schema.isMaxLength(256)),
  contextExpansionCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  contextRefreshCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  continuationCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 })),
  continuation: Schema.Unknown,
});
export type DecisionJobStage = typeof DecisionJobStage.Type;
export const emptyDecisionJobStage: DecisionJobStage = {
  version: 1,
  evaluatedFingerprints: [],
  evaluationRequestIds: {},
  evidence: [],
  writerOutput: null,
  resolvedCandidateIds: [],
  contextExpansionCount: 0,
  contextRefreshCount: 0,
  continuationCount: 0,
  continuation: null,
};
export interface DecisionJob {
  readonly id: DecisionJobId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly sourceMessageId: string;
  readonly consumerId: string;
  readonly scanId: DecisionScanId | null;
  readonly state: DecisionJobState;
  readonly sourceGeneration: number;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly configRevision: number;
  readonly description: string;
  readonly cancellationEpoch: number;
  readonly pauseEpoch: number;
  readonly fingerprint: string;
  readonly runId: string;
  readonly stage: DecisionJobStage;
  readonly providerBinding: unknown;
  readonly leaseOwner: string | null;
  readonly leaseUntil: string | null;
  readonly fence: number;
  readonly attempts: number;
  readonly reason: string | null;
}
export interface DecisionJobFence {
  readonly jobId: DecisionJobId;
  readonly owner: string;
  readonly fence: number;
}
export interface DecisionJobCheckpoint extends DecisionJobFence {
  readonly state: "detecting" | "localizing" | "writing";
  readonly stage: DecisionJobStage;
  readonly providerBinding?: unknown;
  readonly leaseMs?: number;
}
export interface DecisionJobFinish extends DecisionJobFence {
  readonly state: "committed" | "no_match" | "waiting" | "incomplete" | "failed" | "canceled";
  readonly stage?: DecisionJobStage;
  readonly reason?: string;
}
export interface DecisionJobSource {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly sourceHash: string;
  readonly sourceGeneration: number;
  readonly sourceSequence: number;
  readonly createdAt: string;
}
interface JobRow {
  id: string;
  project_id: string;
  thread_id: string;
  source_message_id: string;
  consumer_id: string;
  scan_id: string | null;
  state: DecisionJobState;
  source_generation: number;
  from_sequence: number;
  through_sequence: number;
  config_revision: number;
  description: string;
  cancellation_epoch: number;
  pause_epoch: number;
  fingerprint: string;
  run_id: string;
  stage_json: string;
  provider_binding_json: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  fence: number;
  attempts: number;
  reason: string | null;
}
interface ThreadRow {
  project_id: string;
  deleted_at: string | null;
  archived_at: string | null;
}
interface StateRow {
  source_generation: number;
  pause_epoch: number;
  tracking_override: string;
  activation_sequence: number;
  generation_sequence: number;
}
interface SettingsRow {
  enabled: number;
  config_revision: number;
  cancellation_epoch: number;
  activation_sequence: number;
  description: string;
}

/** Count messages, including coalesced live gaps, without counting overlapping scans twice. */
export const countDecisionUnscannedMessages = (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
  threadId?: ThreadId,
) =>
  sql<{ count: number }>`SELECT COUNT(*) AS count FROM (
    SELECT c.thread_id,c.source_generation,c.source_message_id AS message_id FROM decision_coverage c
    WHERE c.project_id = ${projectId} AND c.state = 'unscanned' AND c.source_message_id <> '' AND ${threadId ? sql`c.thread_id = ${threadId}` : sql`1 = 1`}
    UNION
    SELECT s.thread_id,s.source_generation,s.message_id FROM decision_coverage c JOIN decision_sources s
    ON s.project_id = c.project_id AND s.thread_id = c.thread_id AND s.source_generation = c.source_generation
    AND s.source_sequence BETWEEN c.from_sequence AND c.through_sequence
    WHERE c.project_id = ${projectId} AND c.state = 'unscanned' AND c.source_message_id = '' AND ${threadId ? sql`c.thread_id = ${threadId}` : sql`1 = 1`}
  ) gaps WHERE NOT EXISTS (
    SELECT 1 FROM decision_coverage complete JOIN decision_sources current
      ON current.project_id = complete.project_id AND current.thread_id = complete.thread_id
      AND current.source_generation = complete.source_generation AND current.message_id = complete.source_message_id
      AND current.source_hash = complete.source_hash
    WHERE complete.project_id = ${projectId} AND complete.thread_id = gaps.thread_id
      AND complete.source_generation = gaps.source_generation AND complete.source_message_id = gaps.message_id
      AND complete.state = 'complete'
  )`.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
interface SourceRow {
  message_id: string;
  thread_id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  source_sequence: number;
  source_generation: number;
  source_hash: string;
}
const error = (code: ThreadDecisionError["code"], message: string) =>
  new ThreadDecisionError({ code, message });
const isError = Schema.is(ThreadDecisionError);
const boundary = (cause: unknown) =>
  isError(cause) ? cause : error("unavailable", "Decision processing is currently unavailable.");
const decodeStage = Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionJobStage));
const encodeStage = Schema.encodeEffect(Schema.fromJsonString(DecisionJobStage));
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEvaluation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DecisionEvaluationResult),
);
const encodeEvaluation = Schema.encodeEffect(Schema.fromJsonString(DecisionEvaluationResult));
const instant = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => DateTime.formatIso(DateTime.makeUnsafe(ms))),
);
const lease = (milliseconds = 60000) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((ms) =>
      DateTime.formatIso(DateTime.makeUnsafe(ms + Math.min(300000, Math.max(1000, milliseconds)))),
    ),
  );
const decodeJob = Effect.fn("DecisionJobs.decode")(function* (
  row: JobRow,
): Effect.fn.Return<DecisionJob, Schema.SchemaError> {
  return {
    id: DecisionJobId.make(row.id),
    projectId: ProjectId.make(row.project_id),
    threadId: ThreadId.make(row.thread_id),
    sourceMessageId: row.source_message_id,
    consumerId: row.consumer_id,
    scanId: row.scan_id ? DecisionScanId.make(row.scan_id) : null,
    state: row.state,
    sourceGeneration: row.source_generation,
    fromSequence: row.from_sequence,
    throughSequence: row.through_sequence,
    configRevision: row.config_revision,
    description: row.description,
    cancellationEpoch: row.cancellation_epoch,
    pauseEpoch: row.pause_epoch,
    fingerprint: row.fingerprint,
    runId: row.run_id,
    stage: row.stage_json === "{}" ? emptyDecisionJobStage : yield* decodeStage(row.stage_json),
    providerBinding: row.provider_binding_json
      ? yield* decodeUnknownJson(row.provider_binding_json)
      : null,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    fence: row.fence,
    attempts: row.attempts,
    reason: row.reason,
  };
});
export class DecisionJobRepository extends Context.Service<
  DecisionJobRepository,
  {
    readonly cursor: Effect.Effect<number, ThreadDecisionError>;
    readonly nextLeaseDelay: Effect.Effect<number | null, ThreadDecisionError>;
    readonly processEvent: (event: OrchestrationEvent) => Effect.Effect<void, ThreadDecisionError>;
    readonly get: (jobId: DecisionJobId) => Effect.Effect<DecisionJob | null, ThreadDecisionError>;
    readonly claim: (input: {
      owner: string;
      leaseMs?: number;
    }) => Effect.Effect<DecisionJob | null, ThreadDecisionError>;
    readonly checkpoint: (
      input: DecisionJobCheckpoint,
    ) => Effect.Effect<DecisionJob, ThreadDecisionError>;
    readonly finish: (input: DecisionJobFinish) => Effect.Effect<DecisionJob, ThreadDecisionError>;
    readonly retry: (input: {
      projectId: ProjectId;
      jobId: DecisionJobId;
    }) => Effect.Effect<void, ThreadDecisionError>;
    readonly wakeWaiting: (reason: string) => Effect.Effect<void, ThreadDecisionError>;
    readonly scan: (
      input: ThreadDecisionScanInput,
    ) => Effect.Effect<ThreadDecisionScanResult, ThreadDecisionError>;
    readonly listSources: (input: {
      projectId: ProjectId;
      threadId: ThreadId;
      sourceGeneration: number;
      fromSequence: number;
      throughSequence: number;
      contextMessages?: number;
      messageId?: string;
    }) => Effect.Effect<ReadonlyArray<DecisionJobSource>, ThreadDecisionError>;
    readonly getEvaluation: (
      projectId: ProjectId,
      fingerprint: string,
    ) => Effect.Effect<DecisionEvaluationResult | null, ThreadDecisionError>;
    readonly putEvaluation: (
      projectId: ProjectId,
      fingerprint: string,
      result: DecisionEvaluationResult,
    ) => Effect.Effect<void, ThreadDecisionError>;
    readonly notify: Effect.Effect<void>;
    readonly subscribeWake: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("lecturn/threadDecisions/DecisionJobRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settingsRepository = yield* DecisionSettingsRepository;
  const wakes = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(wakes, undefined).pipe(Effect.asVoid);
  const get = Effect.fn("DecisionJobs.get")(function* (id: DecisionJobId) {
    const rows = yield* sql<JobRow>`SELECT * FROM decision_jobs WHERE id = ${id}`;
    return rows[0] ? yield* decodeJob(rows[0]) : null;
  });
  const cursor = Effect.gen(function* () {
    const rows = yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM decision_ingestion_cursor WHERE id = 1`;
    return rows[0]?.sequence ?? 0;
  });
  const nextLeaseDelay = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const at = DateTime.formatIso(DateTime.makeUnsafe(now));
    const rows = yield* sql<{
      expires: string | null;
    }>`SELECT MIN(lease_until) AS expires FROM decision_jobs WHERE state IN ('detecting','localizing','writing') AND lease_until > ${at}`;
    return rows[0]?.expires ? Math.max(1, Date.parse(rows[0].expires) - now) : null;
  });
  const threadState = Effect.fn("DecisionJobs.threadState")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
  ) {
    yield* sql`INSERT OR IGNORE INTO decision_thread_state(thread_id,project_id,updated_at) VALUES (${threadId},${projectId},${yield* instant})`;
    const rows =
      yield* sql<StateRow>`SELECT * FROM decision_thread_state WHERE thread_id = ${threadId}`;
    return rows[0]!;
  });
  const coverage = Effect.fn("DecisionJobs.coverage")(function* (input: {
    consumerId: string;
    projectId: ProjectId;
    threadId: ThreadId;
    generation: number;
    from: number;
    through: number;
    messageId?: string;
    sourceHash?: string;
    state: "pending" | "complete" | "incomplete" | "unscanned" | "canceled";
    reason?: string;
  }) {
    const at = yield* instant;
    const coalesce = input.state === "unscanned" && !input.consumerId.startsWith("scan:");
    if (coalesce) {
      // One coalesced marker per reason avoids an unbounded paused/backlog record per message.
      const existing = yield* sql<{
        from_sequence: number;
        through_sequence: number;
      }>`SELECT from_sequence,through_sequence FROM decision_coverage WHERE consumer_id = ${input.consumerId} AND thread_id = ${input.threadId} AND source_generation = ${input.generation} AND state = 'unscanned' AND reason = ${input.reason ?? ""} ORDER BY from_sequence LIMIT 1`;
      if (existing[0]) {
        yield* sql`UPDATE decision_coverage SET from_sequence = ${Math.min(existing[0].from_sequence, input.from)}, through_sequence = ${Math.max(existing[0].through_sequence, input.through)}, updated_at = ${at} WHERE consumer_id = ${input.consumerId} AND thread_id = ${input.threadId} AND source_generation = ${input.generation} AND from_sequence = ${existing[0].from_sequence} AND through_sequence = ${existing[0].through_sequence}`;
        return;
      }
    }
    yield* sql`INSERT INTO decision_coverage(consumer_id,project_id,thread_id,source_generation,from_sequence,through_sequence,source_message_id,source_hash,state,reason,updated_at) VALUES (${input.consumerId},${input.projectId},${input.threadId},${input.generation},${input.from},${input.through},${coalesce ? "" : (input.messageId ?? "")},${input.sourceHash ?? null},${input.state},${input.reason ?? null},${at}) ON CONFLICT(consumer_id,thread_id,source_generation,from_sequence,through_sequence,source_message_id) DO UPDATE SET state = excluded.state, source_hash = COALESCE(excluded.source_hash,decision_coverage.source_hash), reason = excluded.reason, updated_at = excluded.updated_at`;
  });
  const enqueue = Effect.fn("DecisionJobs.enqueue")(function* (input: {
    projectId: ProjectId;
    threadId: ThreadId;
    generation: number;
    sequence: number;
    messageId: string;
    sourceHash: string;
    settings: SettingsRow;
    pauseEpoch: number;
    paused: boolean;
    scanId?: DecisionScanId;
  }) {
    const consumerId = input.scanId
      ? `scan:${input.scanId}`
      : `live:${input.threadId}:${input.generation}:${input.settings.cancellation_epoch}`;
    const description = input.settings.description.trim() || DEFAULT_DECISION_TRACKING_DESCRIPTION;
    const fingerprint = decisionFingerprint([
      input.threadId,
      input.generation,
      input.messageId,
      input.sourceHash,
      input.settings.config_revision,
      description,
    ]);
    const baseCoverage = {
      consumerId,
      projectId: input.projectId,
      threadId: input.threadId,
      generation: input.generation,
      from: input.sequence,
      through: input.sequence,
      messageId: input.messageId,
      sourceHash: input.sourceHash,
    };
    if (input.paused && !input.scanId) {
      yield* coverage({ ...baseCoverage, state: "unscanned", reason: "paused" });
      return;
    }
    const existing =
      yield* sql<JobRow>`SELECT * FROM decision_jobs WHERE consumer_id = ${consumerId} AND fingerprint = ${fingerprint}`;
    if (existing[0]) return;
    const successful =
      yield* sql<JobRow>`SELECT * FROM decision_jobs WHERE project_id = ${input.projectId} AND fingerprint = ${fingerprint} AND state IN ('committed','no_match') LIMIT 1`;
    if (successful.length > 0) {
      yield* coverage({ ...baseCoverage, state: "complete" });
      return;
    }
    const count = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM decision_jobs WHERE project_id = ${input.projectId} AND state NOT IN ('committed','no_match','canceled')`;
    if ((count[0]?.count ?? 0) >= 1000) {
      yield* coverage({ ...baseCoverage, state: "unscanned", reason: "backlog" });
      return;
    }
    const at = yield* instant;
    const id = DecisionJobId.make(NodeCrypto.randomUUID());
    yield* sql`INSERT INTO decision_jobs(id,project_id,thread_id,consumer_id,scan_id,state,source_message_id,source_generation,from_sequence,through_sequence,config_revision,description,cancellation_epoch,pause_epoch,fingerprint,run_id,stage_json,created_at,updated_at) VALUES (${id},${input.projectId},${input.threadId},${consumerId},${input.scanId ?? null},'queued',${input.messageId},${input.generation},${input.sequence},${input.sequence},${input.settings.config_revision},${description},${input.settings.cancellation_epoch},${input.pauseEpoch},${fingerprint},${NodeCrypto.randomUUID()},${yield* encodeStage(emptyDecisionJobStage)},${at},${at})`;
    yield* coverage({ ...baseCoverage, state: "pending" });
  });
  const processEvent = Effect.fn("DecisionJobs.processEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.sequence <= (yield* cursor)) return;
    const at = yield* instant;
    if (event.type === "project.deleted") {
      yield* settingsRepository.purge(event.payload.projectId, undefined, true);
    } else if ("threadId" in event.payload) {
      const threadId = event.payload.threadId;
      const threads =
        yield* sql<ThreadRow>`SELECT project_id,deleted_at,archived_at FROM projection_threads WHERE thread_id = ${threadId}`;
      const thread = threads[0];
      if (thread) {
        const projectId = ProjectId.make(thread.project_id);
        const state = yield* threadState(threadId, projectId);
        if (
          event.type === "thread.created" ||
          event.type === "thread.forked" ||
          event.type === "thread.imported" ||
          event.type === "thread.reverted"
        ) {
          if (event.sequence > state.generation_sequence) {
            const generation =
              state.source_generation +
              (state.generation_sequence > 0 || event.type !== "thread.created" ? 1 : 0);
            yield* sql`UPDATE decision_thread_state SET source_generation = ${generation}, generation_sequence = ${event.sequence}, activation_sequence = ${event.sequence}, updated_at = ${at} WHERE thread_id = ${threadId}`;
            yield* sql`UPDATE decision_jobs SET state = 'canceled', reason = 'source-changed', fence = fence + 1, lease_owner = NULL, lease_until = NULL, updated_at = ${at} WHERE thread_id = ${threadId} AND state NOT IN ('committed','no_match','canceled')`;
            yield* sql`UPDATE decision_coverage SET state = 'canceled', reason = 'source-changed', updated_at = ${at} WHERE thread_id = ${threadId} AND state IN ('pending','incomplete')`;
          }
        } else if (event.type === "thread.deleted" || event.type === "thread.archived") {
          yield* sql`UPDATE decision_jobs SET state = ${event.type === "thread.deleted" ? "canceled" : "waiting"}, reason = ${event.type}, fence = fence + 1, lease_owner = NULL, lease_until = NULL, updated_at = ${at} WHERE thread_id = ${threadId} AND state NOT IN ('committed','no_match','canceled')`;
          if (event.type === "thread.deleted")
            yield* sql`UPDATE decision_coverage SET state = 'canceled', reason = 'thread.deleted', updated_at = ${at} WHERE thread_id = ${threadId} AND state IN ('pending','incomplete')`;
        } else if (event.type === "thread.unarchived") {
          yield* sql`UPDATE decision_jobs SET state = 'queued', reason = NULL, updated_at = ${at} WHERE thread_id = ${threadId} AND state = 'waiting' AND reason = 'thread.archived'`;
        } else if (
          event.type === "thread.message-sent" &&
          !event.payload.streaming &&
          (event.payload.role === "user" || event.payload.role === "assistant") &&
          thread.deleted_at === null
        ) {
          const messages = yield* sql<{
            text: string;
            role: "user" | "assistant";
            created_at: string;
          }>`SELECT text,role,created_at FROM projection_thread_messages WHERE thread_id = ${threadId} AND message_id = ${event.payload.messageId} AND is_streaming = 0 AND role IN ('user','assistant')`;
          const message = messages[0];
          if (message && message.text.trim().length > 0) {
            const sourceHash = decisionSourceHash(message.text);
            const prior = yield* sql<{
              source_hash: string;
              source_sequence: number;
            }>`SELECT source_hash,source_sequence FROM decision_sources WHERE thread_id = ${threadId} AND message_id = ${event.payload.messageId} AND source_generation = ${state.source_generation}`;
            // Repeated final events preserve the first occurrence order and cannot enqueue again.
            if (prior[0]?.source_hash !== sourceHash) {
              const sequence = prior[0]?.source_sequence ?? event.sequence;
              yield* sql`INSERT INTO decision_sources(thread_id,message_id,source_generation,project_id,source_hash,source_sequence,role,created_at) VALUES (${threadId},${event.payload.messageId},${state.source_generation},${projectId},${sourceHash},${sequence},${message.role},${message.created_at}) ON CONFLICT(thread_id,message_id,source_generation) DO UPDATE SET source_hash = excluded.source_hash`;
              const settings =
                yield* sql<SettingsRow>`SELECT * FROM decision_project_settings WHERE project_id = ${projectId}`;
              const config = settings[0];
              if (
                config?.enabled === 1 &&
                event.sequence > config.activation_sequence &&
                event.sequence > state.activation_sequence &&
                thread.archived_at === null
              ) {
                yield* enqueue({
                  projectId,
                  threadId,
                  generation: state.source_generation,
                  sequence,
                  messageId: event.payload.messageId,
                  sourceHash,
                  settings: config,
                  pauseEpoch: state.pause_epoch,
                  paused: state.tracking_override === "paused",
                });
                if (state.tracking_override !== "paused") {
                  const unresolved =
                    yield* sql<JobRow>`SELECT * FROM decision_jobs WHERE thread_id = ${threadId} AND source_generation = ${state.source_generation} AND cancellation_epoch = ${config.cancellation_epoch} AND state = 'incomplete' AND reason = 'needs-context' AND source_message_id <> ${event.payload.messageId} ORDER BY through_sequence DESC LIMIT 8`;
                  for (const row of unresolved) {
                    const job = yield* decodeJob(row);
                    if (job.stage.contextRefreshCount >= 1) continue;
                    const stage = yield* encodeStage({
                      ...job.stage,
                      evidence: [],
                      writerOutput: null,
                      contextRefreshCount: 1,
                    });
                    yield* sql`UPDATE decision_jobs SET state = 'queued',reason = 'context-arrived',stage_json = ${stage},updated_at = ${at} WHERE id = ${job.id}`;
                    yield* coverage({
                      consumerId: job.consumerId,
                      projectId,
                      threadId,
                      generation: job.sourceGeneration,
                      from: job.fromSequence,
                      through: job.throughSequence,
                      messageId: job.sourceMessageId,
                      state: "pending",
                    });
                    if (job.scanId) yield* updateScanState(job.scanId);
                  }
                }
                yield* bumpDecisionRevision(sql, projectId);
              }
            }
          }
        }
      } else if (event.type === "thread.deleted") {
        yield* sql`UPDATE decision_jobs SET state = 'canceled', reason = 'thread.deleted', fence = fence + 1, lease_owner = NULL, lease_until = NULL, updated_at = ${at} WHERE thread_id = ${threadId} AND state NOT IN ('committed','no_match','canceled')`;
        yield* sql`UPDATE decision_coverage SET state = 'canceled',reason = 'thread.deleted',updated_at = ${at} WHERE thread_id = ${threadId} AND state IN ('pending','incomplete')`;
      }
      if (event.type === "thread.deleted" || event.type === "thread.reverted") {
        const scans = yield* sql<{
          id: string;
          project_id: string;
        }>`SELECT DISTINCT scan.id,scan.project_id FROM decision_scans scan JOIN decision_coverage c ON c.consumer_id = 'scan:' || scan.id WHERE c.thread_id = ${threadId} AND scan.state <> 'canceled' AND scan.prepared = 1`;
        for (const scan of scans) {
          yield* updateScanState(DecisionScanId.make(scan.id));
          yield* bumpDecisionRevision(sql, ProjectId.make(scan.project_id));
        }
      }
    }
    yield* sql`UPDATE decision_ingestion_cursor SET sequence = ${event.sequence} WHERE id = 1`;
  });
  const assertFence = Effect.fn("DecisionJobs.assertFence")(function* (input: DecisionJobFence) {
    const job = yield* get(input.jobId);
    const at = yield* instant;
    if (
      !job ||
      job.leaseOwner !== input.owner ||
      job.fence !== input.fence ||
      job.leaseUntil === null ||
      job.leaseUntil <= at ||
      !["detecting", "localizing", "writing"].includes(job.state)
    )
      return yield* error("conflict", "This decision worker no longer owns the job.");
    const settings =
      yield* sql<SettingsRow>`SELECT * FROM decision_project_settings WHERE project_id = ${job.projectId}`;
    const thread =
      yield* sql<ThreadRow>`SELECT * FROM projection_threads WHERE thread_id = ${job.threadId} AND project_id = ${job.projectId}`;
    const state = yield* threadState(job.threadId, job.projectId);
    if (
      settings[0]?.enabled !== 1 ||
      settings[0].cancellation_epoch !== job.cancellationEpoch ||
      !thread[0] ||
      thread[0].deleted_at !== null ||
      thread[0].archived_at !== null ||
      state.source_generation !== job.sourceGeneration ||
      (job.scanId === null &&
        (state.pause_epoch !== job.pauseEpoch || state.tracking_override === "paused"))
    )
      return yield* error("conflict", "Decision processing was canceled or its source changed.");
    yield* requireDecisionProject(sql, job.projectId);
    return job;
  });
  const claim = Effect.fn("DecisionJobs.claim")(function* (input: {
    owner: string;
    leaseMs?: number;
  }) {
    if (!input.owner || input.owner.length > 256)
      return yield* error("invalid", "Invalid decision worker identity.");
    const preparing = yield* sql<{
      id: string;
    }>`SELECT id FROM decision_scans WHERE prepared = 0 AND state IN ('queued','running') ORDER BY created_at,id LIMIT 1`;
    if (preparing[0]) {
      yield* prepareScanPage(DecisionScanId.make(preparing[0].id));
      yield* notify;
    }
    yield* refillScanBacklog;
    const at = yield* instant;
    // Different consumers can accept the same source before either finishes.
    // Reuse its completed evaluation before admitting another provider call.
    const reusable = yield* sql<JobRow & { completed_state: "committed" | "no_match" }>`
      SELECT j.*,(SELECT done.state FROM decision_jobs done WHERE done.project_id = j.project_id AND done.fingerprint = j.fingerprint AND done.state IN ('committed','no_match') LIMIT 1) AS completed_state
      FROM decision_jobs j WHERE (j.state = 'queued' OR (j.state IN ('detecting','localizing','writing') AND j.lease_until <= ${at}))
      AND EXISTS (SELECT 1 FROM decision_jobs done WHERE done.project_id = j.project_id AND done.fingerprint = j.fingerprint AND done.state IN ('committed','no_match'))
      AND (j.scan_id IS NULL OR EXISTS (SELECT 1 FROM decision_scans scan WHERE scan.id = j.scan_id AND scan.prepared = 1 AND scan.state <> 'canceled'))
      LIMIT 200`;
    for (const row of reusable) {
      yield* sql`UPDATE decision_jobs SET state = ${row.completed_state},reason = NULL,lease_owner = NULL,lease_until = NULL,fence = fence + 1,updated_at = ${at} WHERE id = ${row.id}`;
      yield* coverage({
        consumerId: row.consumer_id,
        projectId: ProjectId.make(row.project_id),
        threadId: ThreadId.make(row.thread_id),
        generation: row.source_generation,
        from: row.from_sequence,
        through: row.through_sequence,
        messageId: row.source_message_id,
        state: "complete",
      });
      if (row.scan_id) yield* updateScanState(DecisionScanId.make(row.scan_id));
      yield* bumpDecisionRevision(sql, ProjectId.make(row.project_id));
    }
    if (reusable.length > 0) yield* notify;
    const rows = yield* sql<JobRow>`SELECT j.* FROM decision_jobs j
      JOIN projection_projects p ON p.project_id = j.project_id AND p.deleted_at IS NULL
      JOIN projection_threads t ON t.thread_id = j.thread_id AND t.project_id = j.project_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
      JOIN decision_project_settings ps ON ps.project_id = j.project_id AND ps.enabled = 1 AND ps.cancellation_epoch = j.cancellation_epoch
      JOIN decision_thread_state ts ON ts.thread_id = j.thread_id AND ts.source_generation = j.source_generation
      WHERE (j.state = 'queued' OR (j.state IN ('detecting','localizing','writing') AND j.lease_until <= ${at}))
      AND NOT EXISTS (SELECT 1 FROM decision_jobs done WHERE done.project_id = j.project_id AND done.fingerprint = j.fingerprint AND done.state IN ('committed','no_match'))
      AND (j.scan_id IS NULL OR EXISTS (SELECT 1 FROM decision_scans scan WHERE scan.id = j.scan_id AND scan.prepared = 1 AND scan.state <> 'canceled'))
      AND (j.scan_id IS NOT NULL OR (ts.tracking_override = 'inherit' AND ts.pause_epoch = j.pause_epoch))
      AND NOT EXISTS (SELECT 1 FROM decision_jobs active WHERE active.thread_id = j.thread_id AND active.id <> j.id AND active.state IN ('detecting','localizing','writing') AND active.lease_until > ${at})
      ORDER BY j.created_at,j.from_sequence,j.id LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    yield* sql`UPDATE decision_jobs SET state = CASE WHEN state = 'queued' THEN 'detecting' ELSE state END, lease_owner = ${input.owner}, lease_until = ${yield* lease(input.leaseMs)}, fence = fence + 1, attempts = attempts + 1, updated_at = ${at} WHERE id = ${row.id}`;
    return yield* get(DecisionJobId.make(row.id));
  });
  const checkpoint = Effect.fn("DecisionJobs.checkpoint")(function* (input: DecisionJobCheckpoint) {
    const job = yield* assertFence(input);
    const stage = yield* encodeStage(input.stage);
    if (stage.length > 512000)
      return yield* error("invalid", "The decision checkpoint exceeds its storage budget.");
    const binding =
      input.providerBinding === undefined
        ? undefined
        : yield* encodeUnknownJson(input.providerBinding);
    if (binding !== undefined && binding.length > 16000)
      return yield* error("invalid", "The provider binding is too large.");
    yield* sql`UPDATE decision_jobs SET state = ${input.state},stage_json = ${stage}, ${binding !== undefined ? sql`provider_binding_json = ${binding},` : sql``} lease_until = ${yield* lease(input.leaseMs)}, updated_at = ${yield* instant} WHERE id = ${job.id}`;
    return (yield* get(job.id))!;
  });
  const updateScanState = Effect.fn("DecisionJobs.updateScanState")(function* (
    scanId: DecisionScanId,
  ) {
    const consumer = `scan:${scanId}`;
    const rows = yield* sql<{
      pending: number;
      incomplete: number;
    }>`SELECT sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending, sum(CASE WHEN state IN ('incomplete','unscanned','canceled') THEN 1 ELSE 0 END) AS incomplete FROM decision_coverage WHERE consumer_id = ${consumer}`;
    const state =
      (rows[0]?.pending ?? 0) > 0
        ? "running"
        : (rows[0]?.incomplete ?? 0) > 0
          ? "incomplete"
          : "completed";
    yield* sql`UPDATE decision_scans SET state = ${state}, updated_at = ${yield* instant} WHERE id = ${scanId} AND state <> 'canceled'`;
  });
  // Accepted history targets remain lightweight coverage records until a queue
  // slot is available. Claims refill one bounded page; no timer or full rescan.
  const refillScanBacklog = Effect.gen(function* () {
    const eligible = sql`FROM decision_coverage c
      JOIN decision_scans scan ON c.consumer_id = 'scan:' || scan.id AND scan.prepared = 1 AND scan.state IN ('queued','running','incomplete')
      JOIN decision_project_settings ps ON ps.project_id = c.project_id AND ps.enabled = 1 AND ps.cancellation_epoch = scan.project_cancellation_epoch
      JOIN projection_projects p ON p.project_id = c.project_id AND p.deleted_at IS NULL
      JOIN projection_threads t ON t.thread_id = c.thread_id AND t.project_id = c.project_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
      JOIN decision_thread_state ts ON ts.thread_id = c.thread_id AND ts.source_generation = c.source_generation
      WHERE c.state = 'unscanned' AND c.reason = 'backlog' AND c.source_message_id <> '' AND c.source_hash IS NOT NULL`;
    const projects = yield* sql<{ project_id: string }>`SELECT DISTINCT c.project_id ${eligible}
      AND c.project_id IN (
        SELECT settings.project_id FROM decision_project_settings settings
        LEFT JOIN decision_jobs j ON j.project_id = settings.project_id AND j.state NOT IN ('committed','no_match','canceled')
        WHERE settings.enabled = 1 GROUP BY settings.project_id HAVING COUNT(j.id) < 1000
      )
      ORDER BY c.project_id LIMIT 1`;
    const project = projects[0];
    if (!project) return;
    const counts = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM decision_jobs WHERE project_id = ${project.project_id} AND state NOT IN ('committed','no_match','canceled')`;
    const available = Math.min(200, 1000 - (counts[0]?.count ?? 0));
    const rows = yield* sql<{
      thread_id: string;
      source_message_id: string;
      source_generation: number;
      from_sequence: number;
      source_hash: string;
      scan_id: string;
      config_revision: number;
      description: string;
      project_cancellation_epoch: number;
      pause_epoch: number;
    }>`SELECT c.thread_id,c.source_message_id,c.source_generation,c.from_sequence,c.source_hash,
      scan.id AS scan_id,scan.config_revision,scan.description,scan.project_cancellation_epoch,ts.pause_epoch
      ${eligible} AND c.project_id = ${project.project_id} ORDER BY scan.created_at,scan.id,c.thread_id,c.source_message_id LIMIT ${available}`;
    const scans = new Set<DecisionScanId>();
    for (const row of rows) {
      const scanId = DecisionScanId.make(row.scan_id);
      scans.add(scanId);
      const messages = yield* sql<{
        text: string;
      }>`SELECT text FROM projection_thread_messages WHERE thread_id = ${row.thread_id} AND message_id = ${row.source_message_id} AND is_streaming = 0`;
      if (!messages[0] || decisionSourceHash(messages[0].text) !== row.source_hash) {
        yield* sql`UPDATE decision_coverage SET reason = 'source-changed',updated_at = ${yield* instant}
          WHERE consumer_id = ${"scan:" + scanId} AND thread_id = ${row.thread_id} AND source_generation = ${row.source_generation} AND source_message_id = ${row.source_message_id}`;
        continue;
      }
      yield* enqueue({
        projectId: ProjectId.make(project.project_id),
        threadId: ThreadId.make(row.thread_id),
        generation: row.source_generation,
        sequence: row.from_sequence,
        messageId: row.source_message_id,
        sourceHash: row.source_hash,
        pauseEpoch: row.pause_epoch,
        paused: false,
        scanId,
        settings: {
          enabled: 1,
          config_revision: row.config_revision,
          description: row.description,
          cancellation_epoch: row.project_cancellation_epoch,
          activation_sequence: 0,
        },
      });
    }
    for (const scanId of scans) yield* updateScanState(scanId);
    if (rows.length) {
      yield* bumpDecisionRevision(sql, ProjectId.make(project.project_id));
      yield* notify;
    }
  });
  const finish = Effect.fn("DecisionJobs.finish")(function* (input: DecisionJobFinish) {
    const job = yield* assertFence(input);
    const stage = input.stage ? yield* encodeStage(input.stage) : undefined;
    if (stage !== undefined && stage.length > 512000)
      return yield* error("invalid", "The decision checkpoint exceeds its storage budget.");
    yield* sql`UPDATE decision_jobs SET state = ${input.state}, reason = ${input.reason ?? null}, ${stage !== undefined ? sql`stage_json = ${stage},` : sql``} lease_owner = NULL, lease_until = NULL, updated_at = ${yield* instant} WHERE id = ${job.id}`;
    yield* coverage({
      consumerId: job.consumerId,
      projectId: job.projectId,
      threadId: job.threadId,
      generation: job.sourceGeneration,
      from: job.fromSequence,
      through: job.throughSequence,
      messageId: job.sourceMessageId,
      state:
        input.state === "committed" || input.state === "no_match"
          ? "complete"
          : input.state === "waiting"
            ? "pending"
            : input.state === "canceled"
              ? "canceled"
              : "incomplete",
      ...(input.reason ? { reason: input.reason } : {}),
    });
    if (job.scanId) yield* updateScanState(job.scanId);
    yield* bumpDecisionRevision(sql, job.projectId);
    return (yield* get(job.id))!;
  });
  const retry = Effect.fn("DecisionJobs.retry")(function* (input: {
    projectId: ProjectId;
    jobId: DecisionJobId;
  }) {
    yield* requireDecisionProject(sql, input.projectId);
    const job = yield* get(input.jobId);
    if (!job || job.projectId !== input.projectId)
      return yield* error("not-found", "This decision job no longer exists.");
    if (!["waiting", "incomplete", "failed"].includes(job.state))
      return yield* error("conflict", "Only paused or unsuccessful jobs can be retried.");
    const state = yield* threadState(job.threadId, job.projectId);
    const config =
      yield* sql<SettingsRow>`SELECT * FROM decision_project_settings WHERE project_id = ${job.projectId}`;
    if (
      config[0]?.enabled !== 1 ||
      config[0].cancellation_epoch !== job.cancellationEpoch ||
      state.source_generation !== job.sourceGeneration ||
      (!job.scanId && state.tracking_override === "paused")
    )
      return yield* error(
        "conflict",
        "This job's source or authorization changed. Start a new scan.",
      );
    // Explicit retry may bind to a different provider/account. Keep detector
    // evidence and committed continuation, but never relabel an old writer result.
    const stage = yield* encodeStage({ ...job.stage, writerOutput: null });
    yield* sql`UPDATE decision_jobs SET state = 'queued',reason = 'user-retry',provider_binding_json = NULL,stage_json = ${stage},pause_epoch = ${state.pause_epoch},fence = fence + 1,lease_owner = NULL,lease_until = NULL,updated_at = ${yield* instant} WHERE id = ${job.id}`;
    yield* coverage({
      consumerId: job.consumerId,
      projectId: job.projectId,
      threadId: job.threadId,
      generation: job.sourceGeneration,
      from: job.fromSequence,
      through: job.throughSequence,
      messageId: job.sourceMessageId,
      state: "pending",
    });
    yield* bumpDecisionRevision(sql, job.projectId);
  });
  const scanSecret = NodeCrypto.randomBytes(32);
  const Preview = Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.NullOr(ThreadId),
    revision: Schema.Number,
    cancellationEpoch: Schema.Number,
    fingerprint: Schema.String,
    count: Schema.Number,
    inputTokens: Schema.Number,
    expires: Schema.Number,
  });
  const encodePreview = Schema.encodeEffect(Schema.fromJsonString(Preview));
  const decodePreview = Schema.decodeUnknownEffect(Schema.fromJsonString(Preview));
  const historicalMessages = Effect.fn("DecisionJobs.historicalMessages")(function* (
    projectId: ProjectId,
    threadId: ThreadId | undefined,
    afterThread: string,
    afterMessage: string,
  ) {
    return yield* sql<{
      thread_id: string;
      message_id: string;
      role: "user" | "assistant";
      text: string;
      created_at: string;
    }>`SELECT m.thread_id,m.message_id,m.role,m.text,m.created_at FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id = m.thread_id AND t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.archived_at IS NULL JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL WHERE m.is_streaming = 0 AND m.role IN ('user','assistant') AND length(trim(m.text)) > 0 AND ${threadId ? sql`m.thread_id = ${threadId}` : sql`1 = 1`} AND (m.thread_id > ${afterThread} OR (m.thread_id = ${afterThread} AND m.message_id > ${afterMessage})) ORDER BY m.thread_id,m.message_id LIMIT 200`;
  });
  const snapshot = Effect.fn("DecisionJobs.scanSnapshot")(function* (
    projectId: ProjectId,
    threadId?: ThreadId,
  ) {
    yield* requireDecisionProject(sql, projectId);
    const config =
      yield* sql<SettingsRow>`SELECT * FROM decision_project_settings WHERE project_id = ${projectId}`;
    if (!config[0])
      return yield* error("invalid", "Configure decision tracking before scanning history.");
    let fingerprint = decisionFingerprint([]);
    let count = 0;
    let inputTokens = 0;
    let afterThread = "";
    let afterMessage = "";
    while (true) {
      const messages = yield* historicalMessages(projectId, threadId, afterThread, afterMessage);
      if (messages.length === 0) break;
      for (const message of messages) {
        fingerprint = decisionFingerprint([
          fingerprint,
          message.thread_id,
          message.message_id,
          message.role,
          message.created_at,
          decisionSourceHash(message.text),
        ]);
        count++;
        inputTokens += Math.min(64000, message.text.length);
      }
      afterThread = messages.at(-1)!.thread_id;
      afterMessage = messages.at(-1)!.message_id;
    }
    return { config: config[0], fingerprint, count, inputTokens };
  });
  const prepareScanPage = Effect.fn("DecisionJobs.prepareScanPage")(function* (
    scanId: DecisionScanId,
  ) {
    const rows = yield* sql<{
      project_id: string;
      thread_id: string | null;
      state: string;
      prepared: number;
      config_revision: number;
      description: string;
      project_cancellation_epoch: number;
      source_fingerprint: string;
      preparation_fingerprint: string;
      preparation_thread: string;
      preparation_message: string;
      expected_message_count: number;
      prepared_message_count: number;
    }>`SELECT * FROM decision_scans WHERE id = ${scanId}`;
    const row = rows[0];
    if (!row || row.state === "canceled") return "canceled" as const;
    if (row.prepared === 1) return "ready" as const;
    const projectId = ProjectId.make(row.project_id);
    const configs =
      yield* sql<SettingsRow>`SELECT * FROM decision_project_settings WHERE project_id = ${projectId}`;
    const cancel = Effect.gen(function* () {
      const at = yield* instant;
      yield* sql`UPDATE decision_scans SET state = 'canceled',updated_at = ${at} WHERE id = ${scanId}`;
      yield* sql`UPDATE decision_jobs SET state = 'canceled',reason = 'source-changed',fence = fence + 1,lease_owner = NULL,lease_until = NULL,updated_at = ${at} WHERE scan_id = ${scanId}`;
      yield* sql`UPDATE decision_coverage SET state = 'canceled',reason = 'source-changed',updated_at = ${at} WHERE consumer_id = ${"scan:" + scanId}`;
      yield* bumpDecisionRevision(sql, projectId);
    });
    if (
      configs[0]?.enabled !== 1 ||
      configs[0].cancellation_epoch !== row.project_cancellation_epoch
    ) {
      yield* cancel;
      return "canceled" as const;
    }
    const messages = yield* historicalMessages(
      projectId,
      row.thread_id ? ThreadId.make(row.thread_id) : undefined,
      row.preparation_thread,
      row.preparation_message,
    );
    if (messages.length === 0) {
      if (
        row.preparation_fingerprint !== row.source_fingerprint ||
        row.prepared_message_count !== row.expected_message_count
      ) {
        yield* cancel;
        return "changed" as const;
      }
      yield* sql`UPDATE decision_scans SET prepared = 1,updated_at = ${yield* instant} WHERE id = ${scanId}`;
      yield* updateScanState(scanId);
      yield* bumpDecisionRevision(sql, projectId);
      return "ready" as const;
    }
    let fingerprint = row.preparation_fingerprint;
    for (const message of messages) {
      const threadId = ThreadId.make(message.thread_id);
      const state = yield* threadState(threadId, projectId);
      const existing = yield* sql<{
        source_sequence: number;
      }>`SELECT source_sequence FROM decision_sources WHERE thread_id = ${threadId} AND message_id = ${message.message_id} AND source_generation = ${state.source_generation}`;
      const sourceHash = decisionSourceHash(message.text);
      const sequence = existing[0]?.source_sequence ?? state.generation_sequence;
      fingerprint = decisionFingerprint([
        fingerprint,
        message.thread_id,
        message.message_id,
        message.role,
        message.created_at,
        sourceHash,
      ]);
      yield* sql`INSERT INTO decision_sources(thread_id,message_id,source_generation,project_id,source_hash,source_sequence,role,created_at) VALUES (${threadId},${message.message_id},${state.source_generation},${projectId},${sourceHash},${sequence},${message.role},${message.created_at}) ON CONFLICT(thread_id,message_id,source_generation) DO UPDATE SET source_hash = excluded.source_hash`;
      yield* enqueue({
        projectId,
        threadId,
        generation: state.source_generation,
        sequence,
        messageId: message.message_id,
        sourceHash,
        settings: {
          enabled: 1,
          config_revision: row.config_revision,
          description: row.description,
          cancellation_epoch: row.project_cancellation_epoch,
          activation_sequence: 0,
        },
        pauseEpoch: state.pause_epoch,
        paused: false,
        scanId,
      });
    }
    const last = messages.at(-1)!;
    yield* sql`UPDATE decision_scans SET preparation_thread = ${last.thread_id},preparation_message = ${last.message_id},preparation_fingerprint = ${fingerprint},prepared_message_count = prepared_message_count + ${messages.length},updated_at = ${yield* instant} WHERE id = ${scanId}`;
    return "more" as const;
  }, sql.withTransaction);
  const scan = Effect.fn("DecisionJobs.scan")(function* (
    input: ThreadDecisionScanInput,
  ): Effect.fn.Return<
    ThreadDecisionScanResult,
    ThreadDecisionError | import("effect/unstable/sql/SqlError").SqlError | Schema.SchemaError
  > {
    yield* requireDecisionProject(sql, input.projectId);
    if (input.operation === "retry") {
      yield* retry(input);
      return {
        scanId: null,
        previewToken: null,
        messageCount: 0,
        estimatedInputTokens: 0,
        state: "queued",
        projectRevision: yield* readDecisionRevision(sql, input.projectId),
      };
    }
    if (input.operation === "cancel") {
      const scans = yield* sql<{
        state: string;
        expected_message_count: number;
      }>`SELECT state,expected_message_count FROM decision_scans WHERE id = ${input.scanId} AND project_id = ${input.projectId}`;
      if (!scans[0]) return yield* error("not-found", "This history scan no longer exists.");
      const at = yield* instant;
      yield* sql`UPDATE decision_scans SET state = 'canceled',cancellation_epoch = cancellation_epoch + 1,updated_at = ${at} WHERE id = ${input.scanId}`;
      yield* sql`UPDATE decision_jobs SET state = 'canceled',reason = 'scan-canceled',fence = fence + 1,lease_owner = NULL,lease_until = NULL,updated_at = ${at} WHERE scan_id = ${input.scanId} AND state NOT IN ('committed','no_match','canceled')`;
      yield* sql`UPDATE decision_coverage SET state = 'canceled',reason = 'scan-canceled',updated_at = ${at} WHERE consumer_id = ${"scan:" + input.scanId} AND state <> 'complete'`;
      return {
        scanId: input.scanId,
        previewToken: null,
        messageCount: scans[0].expected_message_count,
        estimatedInputTokens: 0,
        state: "canceled",
        projectRevision: yield* bumpDecisionRevision(sql, input.projectId),
      };
    }
    const milliseconds = yield* Clock.currentTimeMillis;
    if (input.operation === "preview") {
      const captured = yield* snapshot(input.projectId, input.threadId);
      const body = Buffer.from(
        yield* encodePreview({
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          revision: captured.config.config_revision,
          cancellationEpoch: captured.config.cancellation_epoch,
          fingerprint: captured.fingerprint,
          count: captured.count,
          inputTokens: captured.inputTokens,
          expires: milliseconds + 900000,
        }),
      ).toString("base64url");
      const signature = NodeCrypto.createHmac("sha256", scanSecret)
        .update(body)
        .digest("base64url");
      return {
        scanId: null,
        previewToken: `${body}.${signature}`,
        messageCount: captured.count,
        estimatedInputTokens: captured.inputTokens,
        state: "preview",
        projectRevision: yield* readDecisionRevision(sql, input.projectId),
      };
    }
    const [body, signature, ...extra] = input.previewToken.split(".");
    const expected = body
      ? NodeCrypto.createHmac("sha256", scanSecret).update(body).digest("base64url")
      : "";
    if (
      !body ||
      !signature ||
      extra.length ||
      Buffer.byteLength(signature) !== Buffer.byteLength(expected) ||
      !NodeCrypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return yield* error("invalid", "Invalid history scan preview. Preview again.");
    const preview = yield* decodePreview(Buffer.from(body, "base64url").toString("utf8")).pipe(
      Effect.mapError(() => error("invalid", "Invalid history scan preview.")),
    );
    const configs =
      yield* sql<SettingsRow>`SELECT * FROM decision_project_settings WHERE project_id = ${input.projectId}`;
    const config = configs[0];
    if (
      !config ||
      preview.projectId !== input.projectId ||
      preview.threadId !== (input.threadId ?? null) ||
      preview.revision !== input.expectedSettingsRevision ||
      preview.revision !== config.config_revision ||
      preview.cancellationEpoch !== config.cancellation_epoch ||
      preview.expires < milliseconds
    )
      return yield* error("conflict", "The source or settings changed. Preview this scan again.");
    if (config.enabled !== 1)
      return yield* error("conflict", "Enable decision tracking before scanning history.");
    const previewKey = decisionFingerprint([input.previewToken]);
    const scanId = yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior = yield* sql<{
          id: string;
        }>`SELECT id FROM decision_scans WHERE preview_key = ${previewKey} AND project_id = ${input.projectId}`;
        if (prior[0]) return DecisionScanId.make(prior[0].id);
        const current =
          yield* sql<SettingsRow>`SELECT * FROM decision_project_settings WHERE project_id = ${input.projectId}`;
        if (
          current[0]?.enabled !== 1 ||
          current[0].cancellation_epoch !== config.cancellation_epoch ||
          current[0].config_revision !== config.config_revision
        )
          return yield* error(
            "conflict",
            "The source or settings changed. Preview this scan again.",
          );
        const id = DecisionScanId.make(NodeCrypto.randomUUID());
        const at = yield* instant;
        yield* sql`INSERT INTO decision_scans(id,project_id,thread_id,preview_key,state,from_sequence,through_sequence,config_revision,description,project_cancellation_epoch,prepared,source_fingerprint,preparation_fingerprint,expected_message_count,created_at,updated_at) VALUES (${id},${input.projectId},${input.threadId ?? null},${previewKey},'queued',0,${yield* cursor},${config.config_revision},${config.description.trim() || DEFAULT_DECISION_TRACKING_DESCRIPTION},${config.cancellation_epoch},0,${preview.fingerprint},${decisionFingerprint([])},${preview.count},${at},${at})`;
        return id;
      }),
    );
    const scanRows = yield* sql<{
      state: ThreadDecisionScanResult["state"];
    }>`SELECT state FROM decision_scans WHERE id = ${scanId}`;
    return {
      scanId,
      previewToken: null,
      messageCount: preview.count,
      estimatedInputTokens: preview.inputTokens,
      state: scanRows[0]?.state ?? "queued",
      projectRevision: yield* bumpDecisionRevision(sql, input.projectId),
    };
  });
  const listSources = Effect.fn("DecisionJobs.listSources")(function* (input: {
    projectId: ProjectId;
    threadId: ThreadId;
    sourceGeneration: number;
    fromSequence: number;
    throughSequence: number;
    contextMessages?: number;
    messageId?: string;
  }) {
    yield* requireDecisionProject(sql, input.projectId);
    const context = Math.min(10, Math.max(0, input.contextMessages ?? 2));
    const sourceFrom = sql`FROM decision_sources s JOIN projection_thread_messages m ON m.thread_id = s.thread_id AND m.message_id = s.message_id AND m.is_streaming = 0 JOIN projection_threads t ON t.thread_id = m.thread_id AND t.project_id = ${input.projectId} AND t.deleted_at IS NULL WHERE s.project_id = ${input.projectId} AND s.thread_id = ${input.threadId} AND s.source_generation = ${input.sourceGeneration}`;
    const columns = sql`m.message_id,m.thread_id,m.role,m.text,m.created_at,s.source_sequence,s.source_generation,s.source_hash`;
    const targets =
      yield* sql<SourceRow>`SELECT ${columns} ${sourceFrom} AND ${input.messageId ? sql`m.message_id = ${input.messageId}` : sql`s.source_sequence >= ${input.fromSequence} AND s.source_sequence <= ${input.throughSequence}`} ORDER BY s.source_sequence,m.created_at,m.message_id LIMIT 21`;
    const first = targets[0];
    const last = targets.at(-1);
    if (!first || !last) return [];
    const before =
      yield* sql<SourceRow>`SELECT ${columns} ${sourceFrom} AND (s.source_sequence < ${first.source_sequence} OR (s.source_sequence = ${first.source_sequence} AND m.created_at < ${first.created_at}) OR (s.source_sequence = ${first.source_sequence} AND m.created_at = ${first.created_at} AND m.message_id < ${first.message_id})) ORDER BY s.source_sequence DESC,m.created_at DESC,m.message_id DESC LIMIT ${context}`;
    const after =
      yield* sql<SourceRow>`SELECT ${columns} ${sourceFrom} AND (s.source_sequence > ${last.source_sequence} OR (s.source_sequence = ${last.source_sequence} AND m.created_at > ${last.created_at}) OR (s.source_sequence = ${last.source_sequence} AND m.created_at = ${last.created_at} AND m.message_id > ${last.message_id})) ORDER BY s.source_sequence,m.created_at,m.message_id LIMIT ${context}`;
    const rows = [...before.toReversed(), ...targets, ...after];
    return rows
      .filter((row) => decisionSourceHash(row.text) === row.source_hash)
      .map((row): DecisionJobSource => ({
        threadId: ThreadId.make(row.thread_id),
        messageId: row.message_id,
        role: row.role,
        text: canonicalDecisionText(row.text).text,
        sourceHash: row.source_hash,
        sourceGeneration: row.source_generation,
        sourceSequence: row.source_sequence,
        createdAt: row.created_at,
      }));
  });
  const wakeWaiting = Effect.fn("DecisionJobs.wakeWaiting")(function* (reason: string) {
    if (reason === "paused" || reason === "thread.archived") return;
    yield* sql`UPDATE decision_jobs SET state = 'queued',reason = NULL,updated_at = ${yield* instant} WHERE state = 'waiting' AND reason = ${reason}`;
  });
  const getEvaluation = Effect.fn("DecisionJobs.getEvaluation")(function* (
    projectId: ProjectId,
    fingerprint: string,
  ) {
    yield* requireDecisionProject(sql, projectId);
    const rows = yield* sql<{
      result_json: string;
    }>`SELECT result_json FROM decision_evaluations WHERE project_id = ${projectId} AND fingerprint = ${fingerprint}`;
    return rows[0] ? yield* decodeEvaluation(rows[0].result_json) : null;
  });
  const putEvaluation = Effect.fn("DecisionJobs.putEvaluation")(function* (
    projectId: ProjectId,
    fingerprint: string,
    result: DecisionEvaluationResult,
  ) {
    yield* requireDecisionProject(sql, projectId);
    yield* sql`INSERT OR IGNORE INTO decision_evaluations(fingerprint,project_id,request_id,result_json,created_at) VALUES (${fingerprint},${projectId},${result.requestId},${yield* encodeEvaluation(result)},${yield* instant})`;
  });
  return DecisionJobRepository.of({
    cursor: cursor.pipe(Effect.mapError(boundary)),
    nextLeaseDelay: nextLeaseDelay.pipe(Effect.mapError(boundary)),
    processEvent: (event) =>
      processEvent(event).pipe(
        sql.withTransaction,
        Effect.tap(() => notify),
        Effect.mapError(boundary),
      ),
    get: (id) => get(id).pipe(Effect.mapError(boundary)),
    claim: (input) => claim(input).pipe(sql.withTransaction, Effect.mapError(boundary)),
    checkpoint: (input) => checkpoint(input).pipe(sql.withTransaction, Effect.mapError(boundary)),
    finish: (input) =>
      finish(input).pipe(
        sql.withTransaction,
        Effect.tap(() => notify),
        Effect.mapError(boundary),
      ),
    retry: (input) =>
      retry(input).pipe(
        sql.withTransaction,
        Effect.tap(() => notify),
        Effect.mapError(boundary),
      ),
    scan: (input) =>
      scan(input).pipe(
        input.operation === "retry" || input.operation === "cancel"
          ? sql.withTransaction
          : (effect) => effect,
        Effect.tap(() => notify),
        Effect.mapError(boundary),
      ),
    wakeWaiting: (reason) =>
      wakeWaiting(reason).pipe(
        sql.withTransaction,
        Effect.tap(() => notify),
        Effect.mapError(boundary),
      ),
    listSources: (input) => listSources(input).pipe(Effect.mapError(boundary)),
    getEvaluation: (projectId, fingerprint) =>
      getEvaluation(projectId, fingerprint).pipe(Effect.mapError(boundary)),
    putEvaluation: (projectId, fingerprint, result) =>
      putEvaluation(projectId, fingerprint, result).pipe(
        sql.withTransaction,
        Effect.mapError(boundary),
      ),
    notify,
    subscribeWake: PubSub.subscribe(wakes).pipe(Effect.map(Stream.fromSubscription)),
  });
});
export const layer = Layer.effect(DecisionJobRepository, make);
