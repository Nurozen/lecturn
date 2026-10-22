/**
 * StaveOrchestrationLive - `StaveOrchestration` on the V2 orchestrator.
 *
 * Project commands go through `ProjectService` (which runs in the calling
 * fiber, so `StaveReconciliation` reaches commit admission), run interrupts
 * through `OrchestratorV2`, reads through `StaveProjectShells` and the V2
 * projection tables, tails through the application event log, and runtime
 * quiescence closes live `ProviderSessionManagerV2` sessions found in the
 * provider-session projection.
 *
 * @module StaveOrchestrationLive
 */
import {
  type CommandId,
  IsoDateTime,
  type ProjectId,
  type ProviderSessionId,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  StaveOrchestration,
  StaveOrchestrationError,
  type StaveInferenceTurnPair,
  type StaveOrchestrationCommand,
  type StaveOrchestrationShape,
  StaveReconciliation,
  type StaveRuntimeSession,
  type StaveThreadView,
} from "./StaveOrchestration.ts";
import { StaveProjectShells } from "./StaveProjectShells.ts";

const iso = (value: DateTime.DateTime | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

const AnchorRow = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  settledAt: Schema.NullOr(IsoDateTime),
  unsettledAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
});

const SessionRow = Schema.Struct({
  providerSessionId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  status: Schema.String,
  cwd: Schema.NullOr(Schema.String),
});

/** About two minutes of 250 ms polls; a later sweep retries a slower drain. */
const DRAIN_ATTEMPTS = 480;

const LIVE_SESSION_STATUSES = ["starting", "ready", "running", "waiting"] as const;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const shells = yield* StaveProjectShells;
  const projectService = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const events = yield* OrchestrationEventStore;

  const fail =
    (operation: string) =>
    (cause: unknown): StaveOrchestrationError =>
      new StaveOrchestrationError({ operation, cause });

  const toThreadView = (
    thread: Effect.Success<
      ReturnType<Orchestrator.OrchestratorV2["Service"]["getShellSnapshot"]>
    >["threads"][number],
  ): StaveThreadView => ({
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    worktreePath: thread.worktreePath,
    archivedAt: iso(thread.archivedAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
    activeRunId: thread.activeRunId,
  });

  const getShellSnapshot: StaveOrchestrationShape["getShellSnapshot"] = () =>
    Effect.gen(function* () {
      const [projects, active, archived] = yield* Effect.all(
        [
          shells.list,
          orchestrator.getShellSnapshot(),
          orchestrator.getShellSnapshot({ location: "archive" }),
        ],
        { concurrency: 3 },
      );
      const projectIds = new Set(projects.map((project) => project.id));
      const seen = new Set<string>();
      const threads: StaveThreadView[] = [];
      for (const thread of [
        ...active.threads,
        ...active.archivedThreads,
        ...archived.threads,
        ...archived.archivedThreads,
      ]) {
        if (seen.has(thread.id) || !projectIds.has(thread.projectId)) continue;
        seen.add(thread.id);
        threads.push(toThreadView(thread));
      }
      return {
        snapshotSequence: Math.max(active.snapshotSequence, archived.snapshotSequence),
        projects,
        threads,
      };
    }).pipe(Effect.mapError(fail("getShellSnapshot")));

  const getThreadShellById: StaveOrchestrationShape["getThreadShellById"] = (threadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map((thread) => (thread === null ? Option.none() : Option.some(toThreadView(thread)))),
      Effect.mapError(fail("getThreadShellById")),
    );

  const listThreadLifecycleAnchorsByProjectId: StaveOrchestrationShape["listThreadLifecycleAnchorsByProjectId"] =
    (projectId) =>
      sql`
        SELECT
          thread_id AS "threadId",
          json_extract(payload_json, '$.createdAt') AS "createdAt",
          updated_at AS "updatedAt",
          json_extract(payload_json, '$.settledAt') AS "settledAt",
          json_extract(payload_json, '$.unsettledAt') AS "unsettledAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt",
          json_extract(payload_json, '$.settledOverride') AS "settledOverride"
        FROM orchestration_v2_projection_threads
        WHERE project_id = ${projectId}
          AND COALESCE(json_extract(payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
        ORDER BY thread_id
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AnchorRow))),
        Effect.mapError(fail("listThreadLifecycleAnchorsByProjectId")),
      );

  const getInferenceTurnPairs: StaveOrchestrationShape["getInferenceTurnPairs"] = (input) =>
    sql<{ question: string; response: string | null }>`
      SELECT
        CASE WHEN length(json_extract(question.payload_json, '$.text')) <= 12000
          THEN json_extract(question.payload_json, '$.text')
          ELSE substr(json_extract(question.payload_json, '$.text'), 1, 6000) || char(10) || '[Middle content truncated]' || char(10) || substr(json_extract(question.payload_json, '$.text'), -6000)
        END AS question,
        (SELECT CASE WHEN length(body) <= 12000 THEN body
          ELSE substr(body, 1, 6000) || char(10) || '[Middle content truncated]' || char(10) || substr(body, -6000) END
        FROM (
          SELECT group_concat(text, char(10) || char(10)) AS body FROM (
            SELECT json_extract(segment.payload_json, '$.text') AS text
            FROM orchestration_v2_projection_messages AS segment
            WHERE segment.thread_id = run.thread_id AND segment.run_id = run.run_id
              AND segment.role = 'assistant' AND segment.streaming = 0
              AND trim(json_extract(segment.payload_json, '$.text')) <> ''
            ORDER BY segment.created_at, segment.message_id
          )
        )) AS response
      FROM orchestration_v2_projection_runs AS run
      JOIN orchestration_v2_projection_messages AS question
        ON question.message_id = json_extract(run.payload_json, '$.userMessageId')
        AND question.thread_id = run.thread_id
      WHERE run.thread_id = ${input.threadId}
        AND run.status = 'completed'
        AND json_extract(run.payload_json, '$.sourcePlanRef') IS NULL
        AND question.role = 'user' AND question.streaming = 0
        AND trim(json_extract(question.payload_json, '$.text')) <> ''
        AND (${input.beforeMessageId ?? null} IS NULL OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_messages AS boundary
          WHERE boundary.message_id = ${input.beforeMessageId ?? null}
            AND boundary.thread_id = run.thread_id AND boundary.role = 'user'
            AND question.created_at < boundary.created_at
            AND run.completed_at <= boundary.created_at
        ))
      ORDER BY question.created_at DESC, question.message_id DESC
      LIMIT 3
    `.pipe(
      Effect.map((rows) =>
        rows
          .filter((row): row is StaveInferenceTurnPair => (row.response ?? "").trim() !== "")
          .toReversed(),
      ),
      Effect.mapError(fail("getInferenceTurnPairs")),
    );

  const latestSequence = events.latestApplicationSequence.pipe(
    Effect.mapError(fail("latestSequence")),
  );

  const interrupt = (commandId: CommandId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* orchestrator.getThreadShell(threadId);
      if (thread === null || thread.activeRunId === null) {
        return { sequence: yield* latestSequence };
      }
      const result = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId,
        threadId,
        runId: thread.activeRunId,
        reason: "Stave space operation",
      });
      return { sequence: result.sequence };
    });

  const dispatchUnlabeled = (command: StaveOrchestrationCommand) =>
    Effect.gen(function* () {
      switch (command.type) {
        case "project.create":
          yield* projectService.create({
            commandId: command.commandId,
            projectId: command.projectId,
            title: command.title,
            workspaceRoot: command.workspaceRoot,
            createWorkspaceRootIfMissing: false,
          });
          return { sequence: yield* latestSequence };
        case "project.meta.update":
          yield* projectService.update({
            commandId: command.commandId,
            projectId: command.projectId,
            workspaceRoot: command.workspaceRoot,
          });
          return { sequence: yield* latestSequence };
        case "project.delete":
          yield* projectService.delete({
            commandId: command.commandId,
            projectId: command.projectId,
            ...(command.force === undefined ? {} : { force: command.force }),
          });
          return { sequence: yield* latestSequence };
        case "project.refresh":
          return yield* refreshProject(command.commandId, command.projectId);
        case "thread.turn.interrupt":
          return yield* interrupt(command.commandId, command.threadId);
      }
    });

  // `project.refreshed` re-pushes the project shell so subscribers re-read its
  // Stave fields; callers already invalidated the cached manifest.
  const refreshProject = (commandId: CommandId, projectId: ProjectId) =>
    Effect.gen(function* () {
      yield* projectService.refresh({ commandId, projectId });
      return { sequence: yield* latestSequence };
    });

  const dispatch: StaveOrchestrationShape["dispatch"] = (command, options) =>
    dispatchUnlabeled(command).pipe(
      Effect.provideService(StaveReconciliation, options?.staveReconciliation === true),
      Effect.mapError(fail(command.type)),
    );

  const listSessions: StaveOrchestrationShape["listSessions"] = () =>
    sql`
      SELECT
        provider_session_id AS "providerSessionId",
        thread_id AS "threadId",
        status,
        json_extract(payload_json, '$.cwd') AS cwd
      FROM orchestration_v2_projection_provider_sessions
      WHERE ${sql.in("status", LIVE_SESSION_STATUSES)}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionRow))),
      Effect.map((rows) =>
        rows.flatMap((row): ReadonlyArray<StaveRuntimeSession> =>
          row.threadId === null
            ? []
            : [
                {
                  providerSessionId: row.providerSessionId as ProviderSessionId,
                  threadId: ThreadId.make(row.threadId),
                  ...(row.cwd === null ? {} : { cwd: row.cwd }),
                  active: row.status === "running",
                },
              ],
        ),
      ),
      Effect.mapError(fail("listSessions")),
    );

  const close = (providerSessionId: ProviderSessionId) =>
    sessions.close(providerSessionId).pipe(Effect.mapError(fail("stopSession")));

  const isUnder = (root: string, candidate: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const pendingCleanup = (projectId: ProjectId) =>
    sql<{ readonly pending: number }>`
      SELECT COUNT(*) AS pending
      FROM orchestration_v2_effect_outbox AS effect
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = effect.thread_id
      WHERE thread.project_id = ${projectId}
        AND effect.status IN ('pending', 'running')
    `.pipe(Effect.map((rows) => rows[0]?.pending ?? 0));

  const drainThreadCleanup: StaveOrchestrationShape["drainThreadCleanup"] = ({ projectId }) =>
    pendingCleanup(projectId).pipe(
      Effect.flatMap((pending) =>
        pending === 0 ? Effect.void : Effect.fail("thread cleanup still pending" as const),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: DRAIN_ATTEMPTS }),
      Effect.mapError(fail("drainThreadCleanup")),
    );

  return StaveOrchestration.of({
    getShellSnapshot,
    getProjectShellById: (projectId) =>
      shells.getById(projectId).pipe(Effect.mapError(fail("getProjectShellById"))),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      shells
        .getActiveByWorkspaceRoot(workspaceRoot)
        .pipe(Effect.mapError(fail("getActiveProjectByWorkspaceRoot"))),
    getThreadShellById,
    listThreadLifecycleAnchorsByProjectId,
    getInferenceTurnPairs,
    dispatch,
    listSessions,
    stopSession: ({ threadId }) =>
      listSessions().pipe(
        Effect.flatMap((live) =>
          Effect.forEach(
            live.filter((session) => session.threadId === threadId),
            (session) => close(session.providerSessionId),
            { discard: true },
          ),
        ),
      ),
    stopSessionsUnder: (root) =>
      listSessions().pipe(
        Effect.flatMap((live) =>
          Effect.forEach(
            live.filter((session) => session.cwd !== undefined && isUnder(root, session.cwd)),
            (session) => close(session.providerSessionId),
            { discard: true },
          ),
        ),
      ),
    drainThreadCleanup,
    latestSequence,
    streamEvents: (afterSequence) =>
      events.streamApplicationEvents({ afterSequence }).pipe(Stream.mapError(fail("streamEvents"))),
  });
});

export const layer = Layer.effect(StaveOrchestration, make);
