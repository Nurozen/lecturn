import {
  AppBinding,
  type AppId,
  type ApplicationProjectEvent,
  IsoDateTime,
  ModelSelection,
  type OrchestrationProjectShell,
  StoredProjectIcon,
  ProjectId,
  ProjectScript,
  ThreadEnvMode,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class ProjectStoreV2Error extends Schema.TaggedError<ProjectStoreV2Error>()(
  "ProjectStoreV2Error",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project store operation '${this.operation}' failed.`;
  }
}

export const ProjectRow = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
  autoPull: Schema.Boolean,
  faviconPath: Schema.NullOr(Schema.String),
  projectIcon: Schema.NullOr(StoredProjectIcon),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  /** Lecturn connected apps; absent on every other project. */
  appBinding: Schema.optionalKey(AppBinding),
});
export type ProjectRow = typeof ProjectRow.Type;

const ProjectDbRow = Schema.Struct({
  ...ProjectRow.fields,
  defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  autoPull: Schema.BooleanFromBit,
  projectIcon: Schema.NullOr(Schema.fromJsonString(StoredProjectIcon)),
  scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  appBinding: Schema.NullOr(Schema.fromJsonString(AppBinding)),
});

const fromDbRow = ({ appBinding, ...row }: typeof ProjectDbRow.Type): ProjectRow =>
  appBinding === null ? row : { ...row, appBinding };

function toShell(row: ProjectRow): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    faviconPath: row.faviconPath,
    projectIcon: row.projectIcon,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.appBinding === undefined ? {} : { appBinding: row.appBinding }),
  };
}

export class ProjectStoreV2 extends Context.Service<
  ProjectStoreV2,
  {
    /** Call inside the commit transaction. */
    readonly apply: (event: ApplicationProjectEvent) => Effect.Effect<void, ProjectStoreV2Error>;
    readonly get: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<ProjectRow>, ProjectStoreV2Error>;
    readonly list: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
      readonly includeDeleted?: boolean;
    }) => Effect.Effect<ReadonlyArray<ProjectRow>, ProjectStoreV2Error>;
    /**
     * Workspace roots match by exact string; callers normalize before asking.
     * Never returns an app project: those share roots with normal projects
     * and are found only by `findActiveByAppWorkspace`.
     */
    readonly findActiveByWorkspaceRoot: (
      workspaceRoot: string,
    ) => Effect.Effect<Option.Option<ProjectRow>, ProjectStoreV2Error>;
    /** Matches the root exactly as the app sent it. */
    readonly findActiveByAppWorkspace: (
      appId: AppId,
      appWorkspaceRoot: string,
    ) => Effect.Effect<Option.Option<ProjectRow>, ProjectStoreV2Error>;
    readonly getShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectStoreV2Error>;
    readonly listShells: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectStoreV2Error>;
  }
>()("lecturn/orchestration-v2/ProjectStore/ProjectStoreV2") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeRow = Schema.encodeEffect(ProjectDbRow);

  const selectRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.optional(ProjectId),
      projectIds: Schema.optional(Schema.Array(ProjectId)),
      workspaceRoot: Schema.optional(Schema.String),
      appBinding: Schema.optional(Schema.NullOr(AppBinding)),
      includeDeleted: Schema.Boolean,
    }),
    Result: ProjectDbRow,
    execute: (request) => sql`
      SELECT
        project_id AS "projectId",
        title,
        workspace_root AS "workspaceRoot",
        default_model_selection_json AS "defaultModelSelection",
        default_thread_env_mode AS "defaultThreadEnvMode",
        auto_pull AS "autoPull",
        favicon_path AS "faviconPath",
        project_icon_json AS "projectIcon",
        scripts_json AS "scripts",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt",
        CASE WHEN app_id IS NULL THEN NULL
          ELSE json_object('appId', app_id, 'workspaceRoot', app_workspace_root)
        END AS "appBinding"
      FROM projection_projects
      WHERE ${sql.and([
        ...(request.includeDeleted ? [] : [sql`deleted_at IS NULL`]),
        ...(request.projectId === undefined ? [] : [sql`project_id = ${request.projectId}`]),
        ...(request.projectIds === undefined ? [] : [sql.in("project_id", request.projectIds)]),
        ...(request.workspaceRoot === undefined
          ? []
          : [sql`workspace_root = ${request.workspaceRoot}`]),
        ...(request.appBinding === undefined
          ? []
          : request.appBinding === null
            ? [sql`app_id IS NULL`]
            : [
                sql`app_id = ${request.appBinding.appId}`,
                sql`app_workspace_root = ${request.appBinding.workspaceRoot}`,
              ]),
      ])}
      ORDER BY created_at ASC, project_id ASC
    `,
  });

  // Every write rewrites the whole row, so a field read back from `get` that
  // is missing here is erased by the next update (appBinding included).
  const upsertRow = (row: ProjectRow) =>
    encodeRow({ ...row, appBinding: row.appBinding ?? null }).pipe(
      Effect.flatMap(
        (encoded) => sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            default_thread_env_mode,
            auto_pull,
            favicon_path,
            project_icon_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at,
            app_id,
            app_workspace_root
          )
          VALUES (
            ${encoded.projectId},
            ${encoded.title},
            ${encoded.workspaceRoot},
            ${encoded.defaultModelSelection},
            ${encoded.defaultThreadEnvMode},
            ${encoded.autoPull},
            ${encoded.faviconPath},
            ${encoded.projectIcon},
            ${encoded.scripts},
            ${encoded.createdAt},
            ${encoded.updatedAt},
            ${encoded.deletedAt},
            ${row.appBinding?.appId ?? null},
            ${row.appBinding?.workspaceRoot ?? null}
          )
          ON CONFLICT (project_id)
          DO UPDATE SET
            title = excluded.title,
            workspace_root = excluded.workspace_root,
            default_model_selection_json = excluded.default_model_selection_json,
            default_thread_env_mode = excluded.default_thread_env_mode,
            auto_pull = excluded.auto_pull,
            favicon_path = excluded.favicon_path,
            project_icon_json = excluded.project_icon_json,
            scripts_json = excluded.scripts_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            app_id = excluded.app_id,
            app_workspace_root = excluded.app_workspace_root
        `,
      ),
    );

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new ProjectStoreV2Error({ operation, cause })));

  const get: ProjectStoreV2["Service"]["get"] = (projectId, options) =>
    selectRows({ projectId, includeDeleted: options?.includeDeleted === true }).pipe(
      Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), fromDbRow)),
      mapError("get"),
    );

  const list: ProjectStoreV2["Service"]["list"] = (options) =>
    selectRows({
      ...(options?.projectIds === undefined ? {} : { projectIds: options.projectIds }),
      includeDeleted: options?.includeDeleted === true,
    }).pipe(
      Effect.map((rows) => rows.map(fromDbRow)),
      mapError("list"),
    );

  const findActiveByWorkspaceRoot: ProjectStoreV2["Service"]["findActiveByWorkspaceRoot"] = (
    workspaceRoot,
  ) =>
    selectRows({ workspaceRoot, appBinding: null, includeDeleted: false }).pipe(
      Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), fromDbRow)),
      mapError("findActiveByWorkspaceRoot"),
    );

  const findActiveByAppWorkspace: ProjectStoreV2["Service"]["findActiveByAppWorkspace"] = (
    appId,
    appWorkspaceRoot,
  ) =>
    selectRows({
      appBinding: { appId, workspaceRoot: appWorkspaceRoot },
      includeDeleted: false,
    }).pipe(
      Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), fromDbRow)),
      mapError("findActiveByAppWorkspace"),
    );

  const apply: ProjectStoreV2["Service"]["apply"] = Effect.fn("ProjectStoreV2.apply")(
    function* (event) {
      if (event.type === "project.created") {
        const payload = event.payload;
        return yield* upsertRow({
          projectId: payload.projectId,
          title: payload.title,
          workspaceRoot: payload.workspaceRoot,
          defaultModelSelection: payload.defaultModelSelection,
          defaultThreadEnvMode: payload.defaultThreadEnvMode ?? null,
          autoPull: false,
          faviconPath: payload.faviconPath ?? null,
          projectIcon: payload.projectIcon ?? null,
          scripts: payload.scripts,
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
          deletedAt: null,
          ...(payload.appBinding === undefined ? {} : { appBinding: payload.appBinding }),
        }).pipe(mapError("apply"));
      }
      // Lecturn: a refresh carries no state; shell readers re-read the row.
      if (event.type === "project.refreshed") return;
      const existing = yield* get(event.payload.projectId, { includeDeleted: true });
      if (Option.isNone(existing)) return;
      const row = existing.value;
      if (event.type === "project.deleted") {
        return yield* upsertRow({
          ...row,
          deletedAt: event.payload.deletedAt,
          updatedAt: event.payload.deletedAt,
        }).pipe(mapError("apply"));
      }
      const payload = event.payload;
      yield* upsertRow({
        ...row,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.workspaceRoot === undefined ? {} : { workspaceRoot: payload.workspaceRoot }),
        ...(payload.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: payload.defaultModelSelection }),
        ...(payload.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: payload.defaultThreadEnvMode }),
        ...(payload.autoPull === undefined ? {} : { autoPull: payload.autoPull }),
        ...(payload.faviconPath === undefined ? {} : { faviconPath: payload.faviconPath }),
        ...(payload.projectIcon === undefined ? {} : { projectIcon: payload.projectIcon }),
        ...(payload.scripts === undefined ? {} : { scripts: payload.scripts }),
        updatedAt: payload.updatedAt,
      }).pipe(mapError("apply"));
    },
  );

  return ProjectStoreV2.of({
    apply,
    get,
    list,
    findActiveByWorkspaceRoot,
    findActiveByAppWorkspace,
    getShell: (projectId) => get(projectId).pipe(Effect.map(Option.map(toShell))),
    listShells: (options) =>
      list(options?.projectIds === undefined ? undefined : { projectIds: options.projectIds }).pipe(
        Effect.map((rows) => rows.map(toShell)),
      ),
  });
});

export const layer = Layer.effect(ProjectStoreV2, make);
