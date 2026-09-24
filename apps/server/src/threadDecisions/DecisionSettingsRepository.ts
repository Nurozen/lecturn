import {
  DecisionProjectSettings,
  DEFAULT_DECISION_TRACKING_DESCRIPTION,
  ThreadDecisionError,
  type ProjectId,
  type ThreadId,
  type ThreadDecisionSettingsInput,
} from "@lecturn/contracts";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { bumpDecisionRevision, requireDecisionProject } from "./DecisionRevisions.ts";

const isThreadDecisionError = Schema.is(ThreadDecisionError);
const boundary = (error: unknown) =>
  isThreadDecisionError(error)
    ? error
    : new ThreadDecisionError({
        code: "unavailable",
        message: "Decision settings are unavailable.",
      });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const conflict = () =>
  new ThreadDecisionError({
    code: "conflict",
    message: "Decision settings changed. Refresh and try again.",
  });
type Update = Extract<ThreadDecisionSettingsInput, { operation: "update" }>;
type Pause = Extract<ThreadDecisionSettingsInput, { operation: "pause-thread" }>;
export interface DecisionThreadState {
  readonly paused: boolean;
  readonly pauseEpoch: number;
  readonly sourceGeneration: number;
  readonly activationSequence: number;
}
interface SettingsRow {
  project_id: string;
  enabled: number;
  description: string;
  config_revision: number;
  cancellation_epoch: number;
  activation_sequence: number;
  activated_at: string | null;
  funding_json: string | null;
}
const FundingLabel = Schema.Struct({
  state: DecisionProjectSettings.fields.fundingState,
  accountLabel: Schema.NullOr(Schema.String),
  generation: Schema.optionalKey(Schema.Number),
});
const decodeFunding = Schema.decodeUnknownEffect(Schema.fromJsonString(FundingLabel));
const encodeFunding = Schema.encodeEffect(Schema.fromJsonString(FundingLabel));
export class DecisionSettingsRepository extends Context.Service<
  DecisionSettingsRepository,
  {
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<DecisionProjectSettings, ThreadDecisionError>;
    readonly update: (
      input: Update,
      activationSequence: number,
    ) => Effect.Effect<DecisionProjectSettings, ThreadDecisionError>;
    readonly pause: (
      input: Pause,
      activationSequence: number,
    ) => Effect.Effect<void, ThreadDecisionError>;
    readonly threadState: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<DecisionThreadState, ThreadDecisionError>;
    readonly purge: (
      projectId: ProjectId,
      expectedRevision?: number,
      deletedProject?: boolean,
    ) => Effect.Effect<void, ThreadDecisionError>;
    readonly setFunding: (
      projectId: ProjectId,
      state: DecisionProjectSettings["fundingState"],
      accountLabel: string | null,
      generation?: number,
    ) => Effect.Effect<void, ThreadDecisionError>;
  }
>()("lecturn/threadDecisions/DecisionSettingsRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cancelWork = Effect.fn("Decisions.cancelWork")(function* (
    projectId: ProjectId,
    reason: string,
  ) {
    const at = yield* now;
    yield* sql`UPDATE decision_jobs SET state = 'canceled', reason = ${reason}, fence = fence + 1, lease_owner = NULL, lease_until = NULL, updated_at = ${at}
      WHERE project_id = ${projectId} AND state NOT IN ('committed', 'no_match', 'canceled')`;
    yield* sql`UPDATE decision_coverage SET state = 'canceled', reason = ${reason}, updated_at = ${at}
      WHERE project_id = ${projectId} AND state IN ('pending', 'incomplete')`;
    yield* sql`UPDATE decision_scans SET state = 'canceled', cancellation_epoch = cancellation_epoch + 1, updated_at = ${at}
      WHERE project_id = ${projectId} AND state IN ('queued', 'running', 'incomplete')`;
  });
  const ensure = Effect.fn("Decisions.ensureSettings")(function* (projectId: ProjectId) {
    yield* requireDecisionProject(sql, projectId);
    yield* sql`INSERT OR IGNORE INTO decision_project_settings(project_id, updated_at) VALUES (${projectId}, ${yield* now})`;
  });
  const get = Effect.fn("Decisions.settings")(function* (projectId: ProjectId) {
    yield* requireDecisionProject(sql, projectId);
    const rows =
      yield* sql<SettingsRow>`SELECT * FROM decision_project_settings WHERE project_id = ${projectId}`;
    const row = rows[0];
    const funding = row?.funding_json ? yield* decodeFunding(row.funding_json) : null;
    return DecisionProjectSettings.make({
      projectId,
      enabled: row?.enabled === 1,
      description: row?.description.trim() || DEFAULT_DECISION_TRACKING_DESCRIPTION,
      revision: row?.config_revision ?? 0,
      cancellationEpoch: row?.cancellation_epoch ?? 0,
      activatedAt: row?.activated_at ?? null,
      activationSequence: row?.activated_at ? row.activation_sequence : null,
      fundingState: funding?.state ?? "unfunded",
      fundingAccountLabel: funding?.accountLabel ?? null,
    });
  }, Effect.mapError(boundary));
  const update = Effect.fn("Decisions.updateSettings")(
    function* (input: Update, activationSequence: number) {
      yield* ensure(input.projectId);
      const old = yield* get(input.projectId);
      if (old.revision !== input.expectedRevision) return yield* conflict();
      const at = yield* now;
      const enable = input.enabled && !old.enabled;
      const changedEnabled = old.enabled !== input.enabled;
      yield* sql`UPDATE decision_project_settings SET enabled = ${Number(input.enabled)}, description = ${input.description.trim() || DEFAULT_DECISION_TRACKING_DESCRIPTION},
      config_revision = config_revision + 1, cancellation_epoch = cancellation_epoch + ${Number(changedEnabled)},
      activation_sequence = ${enable ? activationSequence : (old.activationSequence ?? 0)},
      activated_at = ${enable ? at : old.activatedAt}, updated_at = ${at} WHERE project_id = ${input.projectId}`;
      if (changedEnabled) {
        yield* cancelWork(input.projectId, "disabled");
      }
      yield* bumpDecisionRevision(sql, input.projectId);
      return yield* get(input.projectId);
    },
    sql.withTransaction,
    Effect.mapError(boundary),
  );
  const requireThread = Effect.fn("Decisions.requireThread")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    yield* requireDecisionProject(sql, projectId);
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId} AND project_id = ${projectId} AND deleted_at IS NULL`;
    if (!rows[0])
      return yield* new ThreadDecisionError({
        code: "not-found",
        message: "This thread is no longer available in this project.",
      });
  });
  const threadState = Effect.fn("Decisions.threadState")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    yield* requireThread(projectId, threadId);
    const rows = yield* sql<{
      tracking_override: string;
      pause_epoch: number;
      source_generation: number;
      activation_sequence: number;
    }>`SELECT * FROM decision_thread_state WHERE thread_id = ${threadId} AND project_id = ${projectId}`;
    const row = rows[0];
    return {
      paused: row?.tracking_override === "paused",
      pauseEpoch: row?.pause_epoch ?? 0,
      sourceGeneration: row?.source_generation ?? 0,
      activationSequence: row?.activation_sequence ?? 0,
    };
  }, Effect.mapError(boundary));
  const pause = Effect.fn("Decisions.pauseThread")(
    function* (input: Pause, activationSequence: number) {
      const old = yield* threadState(input.projectId, input.threadId);
      if (old.pauseEpoch !== input.expectedPauseEpoch) return yield* conflict();
      const at = yield* now;
      yield* sql`INSERT INTO decision_thread_state(thread_id, project_id, tracking_override, pause_epoch, activation_sequence, updated_at)
      VALUES (${input.threadId}, ${input.projectId}, ${input.paused ? "paused" : "inherit"}, ${old.pauseEpoch + 1}, ${activationSequence}, ${at})
      ON CONFLICT(thread_id) DO UPDATE SET tracking_override = excluded.tracking_override, pause_epoch = excluded.pause_epoch, updated_at = excluded.updated_at`;
      yield* sql`UPDATE decision_jobs SET state = ${input.paused ? "waiting" : "queued"}, reason = ${input.paused ? "paused" : null},
      pause_epoch = ${old.pauseEpoch + 1}, fence = fence + 1, lease_owner = NULL, lease_until = NULL, updated_at = ${at}
      WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId} AND scan_id IS NULL
      AND state NOT IN ('committed', 'no_match', 'canceled') ${input.paused ? sql`` : sql`AND reason = 'paused'`}`;
      yield* bumpDecisionRevision(sql, input.projectId);
    },
    sql.withTransaction,
    Effect.mapError(boundary),
  );
  const purge = Effect.fn("Decisions.purge")(
    function* (projectId: ProjectId, expectedRevision?: number, deletedProject = false) {
      if (!deletedProject) {
        yield* ensure(projectId);
        if (expectedRevision !== undefined && (yield* get(projectId)).revision !== expectedRevision)
          return yield* conflict();
      }
      yield* sql`UPDATE decision_project_settings SET enabled = 0, config_revision = config_revision + 1, cancellation_epoch = cancellation_epoch + 1, updated_at = ${yield* now} WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM decision_evidence WHERE decision_id IN (SELECT id FROM thread_decisions WHERE project_id = ${projectId})`;
      for (const table of [
        "thread_decisions",
        "decision_relationships",
        "decision_suppression",
        "decision_jobs",
        "decision_scans",
        "decision_evaluations",
        "decision_coverage",
        "decision_sources",
        "decision_thread_state",
      ]) {
        yield* sql`DELETE FROM ${sql(table)} WHERE project_id = ${projectId}`;
      }
      yield* bumpDecisionRevision(sql, projectId);
    },
    sql.withTransaction,
    Effect.mapError(boundary),
  );
  const setFunding = Effect.fn("Decisions.setFunding")(
    function* (
      projectId: ProjectId,
      state: DecisionProjectSettings["fundingState"],
      accountLabel: string | null,
      generation = 0,
    ) {
      yield* ensure(projectId);
      // A challenge does not replace the active grant. A failed status read is
      // not an authorization change; dispatch still requires a fresh cloud check.
      if (state === "pending" || state === "unavailable") return;
      const rows = yield* sql<{
        funding_json: string | null;
      }>`SELECT funding_json FROM decision_project_settings WHERE project_id = ${projectId}`;
      const old = rows[0]?.funding_json ? yield* decodeFunding(rows[0].funding_json) : null;
      if (
        old?.state === state &&
        old.accountLabel === accountLabel &&
        old.generation === generation
      )
        return;
      const funding = yield* encodeFunding({
        state,
        accountLabel,
        generation,
      });
      const authorizationChanged =
        old !== null && (old.generation !== generation || old.state !== state);
      yield* sql`UPDATE decision_project_settings SET funding_json = ${funding}, cancellation_epoch = cancellation_epoch + ${Number(authorizationChanged)}, updated_at = ${yield* now} WHERE project_id = ${projectId}`;
      if (authorizationChanged) yield* cancelWork(projectId, "unfunded");
      yield* bumpDecisionRevision(sql, projectId);
    },
    sql.withTransaction,
    Effect.mapError(boundary),
  );
  return DecisionSettingsRepository.of({ get, update, pause, threadState, purge, setFunding });
});
export const layer = Layer.effect(DecisionSettingsRepository, make);
