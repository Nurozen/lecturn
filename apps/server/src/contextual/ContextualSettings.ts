import { ContextualNotifications } from "./ContextualNotifications.ts";
import {
  ContextualError,
  ContextualProjectSettings,
  ContextualThreadSettings,
  ContextualSourcePolicy,
  type ContextualProjectSettingsUpdateRequest,
  type ContextualThreadSettingsUpdateRequest,
  type ProjectId,
  type ThreadId,
} from "@lecturn/contracts";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(ContextualSourcePolicy));
const isContextualError = Schema.is(ContextualError);
export const contextualBoundary = (error: unknown) =>
  isContextualError(error)
    ? error
    : new ContextualError({
        code: "unavailable",
        message: "Contextual is unavailable. Try again.",
      });
export const contextualNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));
export const staleContextual = () =>
  new ContextualError({
    code: "stale-revision",
    message: "Contextual changed. Refresh and try again.",
  });

export const requireContextualProject = (sql: SqlClient.SqlClient, projectId: ProjectId) =>
  Effect.gen(function* () {
    const rows =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`;
    if (!rows[0])
      return yield* new ContextualError({ code: "not-found", message: "Project unavailable." });
  });

export const requireContextualThread = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ project_id: string }>`SELECT t.project_id FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
    if (!rows[0])
      return yield* new ContextualError({ code: "not-found", message: "Thread unavailable." });
    return rows[0].project_id as ProjectId;
  });

export const appendContextualEvent = (
  sql: SqlClient.SqlClient,
  input: {
    threadId?: ThreadId;
    projectId?: ProjectId;
    revision: number;
    kind: string;
    entityId: string;
  },
) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO contextual_outbox(thread_id, project_id, revision, kind, entity_id, occurred_at)
    VALUES (${input.threadId ?? null}, ${input.projectId ?? null}, ${input.revision}, ${input.kind}, ${input.entityId}, ${yield* contextualNow})`;
    // Offline clients refetch authoritative state when their cursor precedes the retained outbox.
    yield* sql`DELETE FROM contextual_outbox WHERE sequence <= (SELECT COALESCE(MAX(sequence),0) - 4096 FROM contextual_outbox)`;
  });

/** Called in the thread-created projection transaction. Replays never recopy defaults. */
export const initializeContextualThread = (
  sql: SqlClient.SqlClient,
  input: {
    threadId: ThreadId;
    projectId: ProjectId;
    origin?: "new" | "unknown-import";
    parentThreadId?: ThreadId;
  },
) =>
  Effect.gen(function* () {
    const projects = yield* sql<{
      default_enabled: number;
      source_ids_json: string;
    }>`SELECT default_enabled, source_ids_json FROM contextual_project_settings WHERE project_id = ${input.projectId}`;
    const project = projects[0];
    const allowed = project ? yield* decodeIds(project.source_ids_json) : [];
    const parents = input.parentThreadId
      ? yield* sql<{
          enabled: number;
          source_ids_json: string;
        }>`SELECT enabled, source_ids_json FROM contextual_thread_settings WHERE thread_id = ${input.parentThreadId}`
      : [];
    const parent = parents[0];
    const inherited = parent ? yield* decodeIds(parent.source_ids_json) : allowed;
    const enabled =
      input.origin === "unknown-import"
        ? false
        : parent
          ? parent.enabled === 1
          : project?.default_enabled === 1;
    yield* sql`INSERT OR IGNORE INTO contextual_thread_settings(thread_id, project_id, enabled, source_ids_json, updated_at)
    VALUES (${input.threadId}, ${input.projectId}, ${Number(enabled)}, ${yield* encodeIds(inherited.filter((id) => allowed.includes(id)))}, ${yield* contextualNow})`;
  });

/** Applies lineage intent once; replay cannot overwrite later user settings. */
export const applyContextualOrigin = Effect.fn("Contextual.applyOrigin")(function* (
  sql: SqlClient.SqlClient,
  input: { threadId: ThreadId; projectId: ProjectId; parentThreadId?: ThreadId },
) {
  const rows = yield* sql<{
    origin_applied: number;
  }>`SELECT origin_applied FROM contextual_thread_settings WHERE thread_id=${input.threadId}`;
  if (!rows[0] || rows[0].origin_applied === 1) return;
  const parents = input.parentThreadId
    ? yield* sql<{
        enabled: number;
        source_ids_json: string;
      }>`SELECT enabled, source_ids_json FROM contextual_thread_settings WHERE thread_id=${input.parentThreadId}`
    : [];
  const parent = parents[0];
  const projects = yield* sql<{
    source_ids_json: string;
  }>`SELECT source_ids_json FROM contextual_project_settings WHERE project_id=${input.projectId}`;
  const allowed = projects[0] ? yield* decodeIds(projects[0].source_ids_json) : [];
  const inherited = parent ? yield* decodeIds(parent.source_ids_json) : [];
  yield* sql`UPDATE contextual_thread_settings SET enabled=${Number(parent?.enabled === 1)},
    source_ids_json=${yield* encodeIds(inherited.filter((id) => allowed.includes(id)))}, origin_applied=1 WHERE thread_id=${input.threadId}`;
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notifications = yield* Effect.serviceOption(ContextualNotifications);
  const publish = Option.isSome(notifications) ? notifications.value.publish : Effect.void;
  const project = Effect.fn("Contextual.projectSettings")(function* (projectId: ProjectId) {
    yield* requireContextualProject(sql, projectId);
    const rows = yield* sql<{
      default_enabled: number;
      source_ids_json: string;
      revision: number;
    }>`SELECT * FROM contextual_project_settings WHERE project_id = ${projectId}`;
    const row = rows[0];
    return ContextualProjectSettings.make({
      projectId,
      defaultEnabled: row?.default_enabled === 1,
      sourceIds: row ? yield* decodeIds(row.source_ids_json) : [],
      revision: row?.revision ?? 0,
    });
  }, Effect.mapError(contextualBoundary));
  const thread = Effect.fn("Contextual.threadSettings")(function* (threadId: ThreadId) {
    yield* requireContextualThread(sql, threadId);
    const rows = yield* sql<{
      enabled: number;
      source_ids_json: string;
      revision: number;
      exclusion_revision: number;
    }>`SELECT * FROM contextual_thread_settings WHERE thread_id = ${threadId}`;
    const row = rows[0];
    // Pre-feature threads are off. Reading never opts existing threads into a new project default.
    return ContextualThreadSettings.make({
      threadId,
      enabled: row?.enabled === 1,
      sourceIds: row ? yield* decodeIds(row.source_ids_json) : [],
      revision: row?.revision ?? 0,
      exclusionRevision: row?.exclusion_revision ?? 0,
    });
  }, Effect.mapError(contextualBoundary));
  const updateProject = Effect.fn("Contextual.updateProject")(
    function* (input: ContextualProjectSettingsUpdateRequest) {
      const old = yield* project(input.projectId);
      if (old.revision !== input.expectedRevision) return yield* staleContextual();
      const hosts = yield* sql<{
        source_policy_json: string;
      }>`SELECT source_policy_json FROM contextual_host_state WHERE singleton = 1`;
      const allowed = hosts[0]
        ? (yield* decodePolicy(hosts[0].source_policy_json)).allowedSourceIds
        : [];
      if (
        input.sourceIds.some(
          (id) =>
            id !== `decisions:${input.projectId}` &&
            !allowed.includes(id) &&
            !old.sourceIds.includes(id),
        )
      )
        return yield* new ContextualError({
          code: "forbidden",
          message: "Select sources enabled on this host.",
        });
      // Host policy can narrow while project controls still carry earlier selections.
      // Prune those selections without allowing a client to introduce a forbidden source.
      const sourceIds = input.sourceIds.filter(
        (id) => id === `decisions:${input.projectId}` || allowed.includes(id),
      );
      if (
        sourceIds.includes(`decisions:${input.projectId}`) &&
        !old.sourceIds.includes(`decisions:${input.projectId}`)
      )
        yield* sql`DELETE FROM contextual_suppression WHERE entity_kind='source' AND entity_id=${`decisions:${input.projectId}`}`;
      yield* sql`INSERT INTO contextual_project_settings(project_id, default_enabled, source_ids_json, revision, updated_at)
      VALUES (${input.projectId}, ${Number(input.defaultEnabled)}, ${yield* encodeIds(sourceIds)}, ${old.revision + 1}, ${yield* contextualNow})
      ON CONFLICT(project_id) DO UPDATE SET default_enabled=excluded.default_enabled, source_ids_json=excluded.source_ids_json, revision=excluded.revision, updated_at=excluded.updated_at`;
      yield* appendContextualEvent(sql, {
        projectId: input.projectId,
        revision: old.revision + 1,
        kind: "settings-changed",
        entityId: input.projectId,
      });
      return yield* project(input.projectId);
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );
  const updateThread = Effect.fn("Contextual.updateThread")(
    function* (input: ContextualThreadSettingsUpdateRequest) {
      const projectId = yield* requireContextualThread(sql, input.threadId);
      const parent = yield* project(projectId);
      const old = yield* thread(input.threadId);
      if (old.revision !== input.expectedRevision) return yield* staleContextual();
      if (
        input.sourceIds.some((id) => !parent.sourceIds.includes(id) && !old.sourceIds.includes(id))
      )
        return yield* new ContextualError({
          code: "forbidden",
          message: "Thread sources must be enabled for this project.",
        });
      // Clients can still hold selections removed by a project administrator. Drop those
      // old selections so toggles and source edits remain usable without granting new access.
      const sourceIds = input.sourceIds.filter((id) => parent.sourceIds.includes(id));
      yield* sql`INSERT INTO contextual_thread_settings(thread_id, project_id, enabled, source_ids_json, revision, updated_at)
      VALUES (${input.threadId}, ${projectId}, ${Number(input.enabled)}, ${yield* encodeIds(sourceIds)}, ${old.revision + 1}, ${yield* contextualNow})
      ON CONFLICT(thread_id) DO UPDATE SET enabled=excluded.enabled, source_ids_json=excluded.source_ids_json, revision=excluded.revision, updated_at=excluded.updated_at`;
      yield* appendContextualEvent(sql, {
        threadId: input.threadId,
        revision: old.revision + 1,
        kind: "settings-changed",
        entityId: input.threadId,
      });
      return yield* thread(input.threadId);
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );
  return { project, thread, updateProject, updateThread };
});

export class ContextualSettings extends Context.Service<
  ContextualSettings,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualSettings") {}
export const layer = Layer.effect(ContextualSettings, make);
