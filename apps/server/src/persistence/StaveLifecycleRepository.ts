import {
  ProjectId,
  IsoDateTime,
  NonNegativeInt,
  StaveSagaTeardownAuthorization,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const StaveLifecycleDisposition = Schema.Literals([
  "live",
  "pending_evaluation",
  "pending_destroy",
  "pending_archive",
  "destroying",
  "archiving",
  "restoring",
  "destroyed",
  "archived",
  "kept",
  "refused",
  "not_stave",
]);
export const StaveLifecycleRow = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  spaceId: Schema.NullOr(Schema.String),
  manifestCreatedAt: Schema.NullOr(Schema.String),
  disposition: StaveLifecycleDisposition,
  deleteIntentSequence: Schema.NullOr(NonNegativeInt),
  sagaRemoveConfirmed: Schema.Boolean,
  sagaTeardown: Schema.NullOr(StaveSagaTeardownAuthorization),
  refusalCode: Schema.NullOr(Schema.String),
  refusalMessage: Schema.NullOr(Schema.String),
  anchorAt: Schema.NullOr(IsoDateTime),
  scheduledAt: Schema.NullOr(IsoDateTime),
  archiveDeadlineAt: Schema.NullOr(IsoDateTime),
  archiveBasename: Schema.NullOr(Schema.String),
  leaseEpoch: NonNegativeInt,
  ownerToken: Schema.NullOr(Schema.String),
  leaseUntil: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  refreshedAt: Schema.NullOr(IsoDateTime),
});
export type StaveLifecycleRow = typeof StaveLifecycleRow.Type;
export interface StaveLifecycleLease {
  readonly projectId: ProjectId;
  readonly leaseEpoch: number;
  readonly ownerToken: string;
  readonly now: string;
}
export type StaveLifecyclePatch = Partial<
  Pick<
    StaveLifecycleRow,
    | "workspaceRoot"
    | "spaceId"
    | "manifestCreatedAt"
    | "disposition"
    | "deleteIntentSequence"
    | "sagaRemoveConfirmed"
    | "sagaTeardown"
    | "refusalCode"
    | "refusalMessage"
    | "anchorAt"
    | "scheduledAt"
    | "archiveDeadlineAt"
    | "archiveBasename"
  >
>;
type Result<A> = Effect.Effect<A, ProjectionRepositoryError>;
export interface StaveLifecycleRepositoryShape {
  readonly getByProjectId: (projectId: ProjectId) => Result<Option.Option<StaveLifecycleRow>>;
  readonly getByWorkspaceRoot: (workspaceRoot: string) => Result<Option.Option<StaveLifecycleRow>>;
  /** Rows of non-deleted projects that last recorded `spaceId`, newest first. */
  readonly listActiveBySpaceId: (spaceId: string) => Result<ReadonlyArray<StaveLifecycleRow>>;
  readonly listPending: () => Result<ReadonlyArray<StaveLifecycleRow>>;
  readonly listDeletedCleanups: () => Result<ReadonlyArray<StaveLifecycleRow>>;
  readonly isProjectDeleted: (projectId: ProjectId) => Result<boolean>;
  readonly listIncomplete: () => Result<ReadonlyArray<StaveLifecycleRow>>;
  readonly listUnrefreshed: () => Result<ReadonlyArray<StaveLifecycleRow>>;
  readonly observePolicy: (input: {
    readonly enabled: boolean;
    readonly archiveMode: string;
  }) => Result<void>;
  readonly isScheduleResetRequested: (projectId: ProjectId) => Result<boolean>;
  readonly releaseExpiredLeases: (now: string) => Result<void>;
  readonly ensure: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly spaceId: string | null;
    readonly manifestCreatedAt: string | null;
    readonly now: string;
  }) => Result<StaveLifecycleRow>;
  readonly acquireLease: (input: {
    readonly projectId: ProjectId;
    readonly expectedEpoch: number;
    readonly ownerToken: string;
    readonly now: string;
    readonly leaseUntil: string;
  }) => Result<Option.Option<StaveLifecycleRow>>;
  readonly renewLease: (
    input: StaveLifecycleLease & { readonly leaseUntil: string },
  ) => Result<boolean>;
  readonly releaseLease: (input: StaveLifecycleLease) => Result<boolean>;
  readonly updateDisposition: (
    input: StaveLifecycleLease & { readonly patch: StaveLifecyclePatch },
  ) => Result<boolean>;
  readonly resetScheduleEpisode: (
    input: StaveLifecycleLease & {
      readonly anchorAt: string | null;
      readonly scheduledAt: string | null;
      readonly archiveDeadlineAt: string | null;
      readonly disposition: "live" | "pending_archive" | "kept";
    },
  ) => Result<boolean>;
  readonly markRefreshed: (input: {
    readonly projectId: ProjectId;
    readonly updatedAt: string;
    readonly refreshedAt: string;
  }) => Result<boolean>;
}
export class StaveLifecycleRepository extends Context.Service<
  StaveLifecycleRepository,
  StaveLifecycleRepositoryShape
>()("lecturn/persistence/StaveLifecycleRepository") {}

const DbRow = StaveLifecycleRow.mapFields((fields) => ({
  ...fields,
  sagaRemoveConfirmed: Schema.Number,
  sagaTeardown: Schema.NullOr(Schema.fromJsonString(StaveLifecycleRow.fields.sagaTeardown)),
}));
const encodeSagaTeardown = Schema.encodeEffect(
  Schema.fromJsonString(StaveLifecycleRow.fields.sagaTeardown),
);
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(DbRow));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(
    'project_id AS "projectId", workspace_root AS "workspaceRoot", space_id AS "spaceId", manifest_created_at AS "manifestCreatedAt", disposition AS "disposition", delete_intent_sequence AS "deleteIntentSequence", saga_remove_confirmed AS "sagaRemoveConfirmed", saga_teardown_json AS "sagaTeardown", refusal_code AS "refusalCode", refusal_message AS "refusalMessage", anchor_at AS "anchorAt", scheduled_at AS "scheduledAt", archive_deadline_at AS "archiveDeadlineAt", archive_basename AS "archiveBasename", lease_epoch AS "leaseEpoch", owner_token AS "ownerToken", lease_until AS "leaseUntil", updated_at AS "updatedAt", refreshed_at AS "refreshedAt"',
  );
  const read = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
    query.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) =>
        rows.map((row) => ({ ...row, sagaRemoveConfirmed: row.sagaRemoveConfirmed === 1 })),
      ),
      Effect.mapError(toPersistenceSqlError("StaveLifecycleRepository.read")),
    );
  const changed = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
    query.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("StaveLifecycleRepository.write")),
    );
  const getByProjectId: StaveLifecycleRepositoryShape["getByProjectId"] = (id) =>
    read(sql`SELECT ${columns} FROM stave_project_lifecycle WHERE project_id = ${id}`).pipe(
      Effect.map(Option.fromIterable),
    );
  const getByWorkspaceRoot: StaveLifecycleRepositoryShape["getByWorkspaceRoot"] = (root) =>
    read(
      sql`SELECT ${columns} FROM stave_project_lifecycle WHERE workspace_root = ${root} ORDER BY (owner_token IS NOT NULL) DESC, updated_at DESC LIMIT 1`,
    ).pipe(Effect.map(Option.fromIterable));
  const listActiveBySpaceId: StaveLifecycleRepositoryShape["listActiveBySpaceId"] = (spaceId) =>
    read(sql`SELECT ${columns} FROM stave_project_lifecycle
      WHERE space_id = ${spaceId}
        AND project_id IN (SELECT project_id FROM projection_projects WHERE deleted_at IS NULL)
      ORDER BY updated_at DESC`);
  const listPending: StaveLifecycleRepositoryShape["listPending"] = () =>
    read(
      sql`SELECT ${columns} FROM stave_project_lifecycle WHERE delete_intent_sequence IS NOT NULL OR disposition IN ('pending_evaluation','pending_destroy','pending_archive','archiving','restoring','destroying') ORDER BY project_id`,
    );
  const listDeletedCleanups: StaveLifecycleRepositoryShape["listDeletedCleanups"] = () =>
    read(sql`SELECT ${columns} FROM stave_project_lifecycle
      WHERE delete_intent_sequence IS NOT NULL
        AND disposition IN ('refused','pending_evaluation','pending_destroy','pending_archive')
        AND project_id IN (SELECT project_id FROM projection_projects WHERE deleted_at IS NOT NULL)
      ORDER BY project_id`);
  const isProjectDeleted: StaveLifecycleRepositoryShape["isProjectDeleted"] = (projectId) =>
    changed(sql`SELECT project_id FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NOT NULL`);
  const listIncomplete: StaveLifecycleRepositoryShape["listIncomplete"] = () =>
    read(
      sql`SELECT ${columns} FROM stave_project_lifecycle WHERE disposition IN ('archiving','restoring','destroying','destroyed') ORDER BY project_id`,
    );
  const listUnrefreshed: StaveLifecycleRepositoryShape["listUnrefreshed"] = () =>
    read(
      sql`SELECT ${columns} FROM stave_project_lifecycle WHERE refreshed_at IS NULL OR updated_at > refreshed_at ORDER BY project_id`,
    );
  const observePolicy: StaveLifecycleRepositoryShape["observePolicy"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* sql<{
            enabled: number;
            archive_mode: string;
          }>`SELECT enabled, archive_mode FROM stave_lifecycle_policy WHERE singleton = 1`;
          const before = previous[0];
          if (
            before?.enabled === (input.enabled ? 1 : 0) &&
            before.archive_mode === input.archiveMode
          )
            return;
          if (
            before !== undefined &&
            input.enabled &&
            (before.enabled === 0 ||
              (["suggest", "nothing"].includes(before.archive_mode) &&
                ["archive", "archive-after-grace"].includes(input.archiveMode)))
          ) {
            yield* sql`INSERT OR IGNORE INTO stave_lifecycle_schedule_resets
          SELECT project_id FROM stave_project_lifecycle
          WHERE delete_intent_sequence IS NULL AND disposition = 'pending_archive'`;
          }
          yield* sql`INSERT INTO stave_lifecycle_policy (singleton, enabled, archive_mode)
        VALUES (1, ${input.enabled ? 1 : 0}, ${input.archiveMode})
        ON CONFLICT(singleton) DO UPDATE SET enabled = excluded.enabled, archive_mode = excluded.archive_mode`;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("StaveLifecycleRepository.observePolicy")));
  const isScheduleResetRequested: StaveLifecycleRepositoryShape["isScheduleResetRequested"] = (
    projectId,
  ) =>
    changed(
      sql`SELECT project_id FROM stave_lifecycle_schedule_resets WHERE project_id = ${projectId}`,
    );
  const releaseExpiredLeases: StaveLifecycleRepositoryShape["releaseExpiredLeases"] = (now) =>
    sql`UPDATE stave_project_lifecycle SET owner_token = NULL, lease_until = NULL
      WHERE owner_token IS NOT NULL AND (lease_until IS NULL OR lease_until <= ${now})
        AND disposition NOT IN ('archiving','restoring','destroying')`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("StaveLifecycleRepository.releaseExpiredLeases")),
    );
  const ensure: StaveLifecycleRepositoryShape["ensure"] = Effect.fn(
    "StaveLifecycleRepository.ensure",
  )(function* (input) {
    // Active project metadata is authoritative when a row predates a root edit.
    yield* sql`UPDATE stave_project_lifecycle SET
      workspace_root = ${input.workspaceRoot}, space_id = ${input.spaceId}, manifest_created_at = ${input.manifestCreatedAt},
      disposition = 'pending_evaluation', anchor_at = NULL, scheduled_at = NULL, archive_deadline_at = NULL, archive_basename = NULL,
      saga_remove_confirmed = 0, saga_teardown_json = NULL, refusal_code = NULL, refusal_message = NULL,
      lease_epoch = lease_epoch + 1, owner_token = NULL, lease_until = NULL, updated_at = ${input.now}, refreshed_at = NULL
      WHERE project_id = ${input.projectId} AND workspace_root != ${input.workspaceRoot}
        AND delete_intent_sequence IS NULL AND disposition NOT IN ('archiving','restoring','destroying')
        AND (lease_until IS NULL OR lease_until <= ${input.now})
        AND EXISTS (SELECT 1 FROM projection_projects WHERE project_id = ${input.projectId}
          AND workspace_root = ${input.workspaceRoot} AND deleted_at IS NULL)`.pipe(
      Effect.mapError(toPersistenceSqlError("StaveLifecycleRepository.ensure")),
    );
    const rows =
      yield* read(sql`INSERT INTO stave_project_lifecycle (project_id,workspace_root,space_id,manifest_created_at,disposition,updated_at)
      VALUES (${input.projectId},${input.workspaceRoot},${input.spaceId},${input.manifestCreatedAt},'pending_evaluation',${input.now})
      ON CONFLICT(project_id) DO UPDATE SET
        space_id = CASE WHEN workspace_root = excluded.workspace_root THEN COALESCE(space_id, excluded.space_id) ELSE space_id END,
        manifest_created_at = CASE WHEN workspace_root = excluded.workspace_root THEN COALESCE(manifest_created_at, excluded.manifest_created_at) ELSE manifest_created_at END
      RETURNING ${columns}`);
    return rows[0]!;
  });
  const acquireLease: StaveLifecycleRepositoryShape["acquireLease"] = (input) =>
    read(sql`UPDATE stave_project_lifecycle
    SET lease_epoch = lease_epoch + 1, owner_token = ${input.ownerToken}, lease_until = ${input.leaseUntil}
    WHERE project_id = ${input.projectId} AND lease_epoch = ${input.expectedEpoch}
      AND (lease_until IS NULL OR lease_until <= ${input.now}) AND ${input.leaseUntil} > ${input.now}
      AND NOT EXISTS (SELECT 1 FROM stave_project_lifecycle AS other
        WHERE other.project_id != ${input.projectId}
          AND other.workspace_root = stave_project_lifecycle.workspace_root
          AND other.lease_until > ${input.now})
    RETURNING ${columns}`).pipe(Effect.map(Option.fromIterable));
  const renewLease: StaveLifecycleRepositoryShape["renewLease"] = (input) =>
    changed(sql`UPDATE stave_project_lifecycle SET lease_until = ${input.leaseUntil}
    WHERE project_id = ${input.projectId} AND lease_epoch = ${input.leaseEpoch} AND owner_token = ${input.ownerToken}
      AND lease_until > ${input.now} AND ${input.leaseUntil} > lease_until RETURNING project_id`);
  const releaseLease: StaveLifecycleRepositoryShape["releaseLease"] = (input) =>
    changed(sql`UPDATE stave_project_lifecycle SET owner_token = NULL, lease_until = NULL
    WHERE project_id = ${input.projectId} AND lease_epoch = ${input.leaseEpoch} AND owner_token = ${input.ownerToken} RETURNING project_id`);
  const updateDisposition: StaveLifecycleRepositoryShape["updateDisposition"] = (input) => {
    const patch = input.patch;
    return Effect.gen(function* () {
      const sagaTeardown =
        patch.sagaTeardown == null ? null : yield* encodeSagaTeardown(patch.sagaTeardown);
      return yield* changed(sql`UPDATE stave_project_lifecycle SET
      workspace_root = CASE WHEN ${patch.workspaceRoot !== undefined ? 1 : 0} THEN ${patch.workspaceRoot ?? null} ELSE workspace_root END,
      space_id = CASE WHEN ${patch.spaceId !== undefined ? 1 : 0} THEN ${patch.spaceId ?? null} ELSE space_id END,
      manifest_created_at = CASE WHEN ${patch.manifestCreatedAt !== undefined ? 1 : 0} THEN ${patch.manifestCreatedAt ?? null} ELSE manifest_created_at END,
      disposition = CASE WHEN ${patch.disposition !== undefined ? 1 : 0} THEN ${patch.disposition ?? null} ELSE disposition END,
      delete_intent_sequence = CASE WHEN ${patch.deleteIntentSequence !== undefined ? 1 : 0} THEN ${patch.deleteIntentSequence ?? null} ELSE delete_intent_sequence END,
      saga_remove_confirmed = CASE WHEN ${patch.sagaRemoveConfirmed !== undefined ? 1 : 0} THEN ${patch.sagaRemoveConfirmed === true ? 1 : 0} ELSE saga_remove_confirmed END,
      saga_teardown_json = CASE WHEN ${patch.sagaTeardown !== undefined ? 1 : 0} THEN ${sagaTeardown} ELSE saga_teardown_json END,
      refusal_code = CASE WHEN ${patch.refusalCode !== undefined ? 1 : 0} THEN ${patch.refusalCode ?? null} ELSE refusal_code END,
      refusal_message = CASE WHEN ${patch.refusalMessage !== undefined ? 1 : 0} THEN ${patch.refusalMessage ?? null} ELSE refusal_message END,
      anchor_at = CASE WHEN ${patch.anchorAt !== undefined ? 1 : 0} THEN ${patch.anchorAt ?? null} ELSE anchor_at END,
      scheduled_at = COALESCE(scheduled_at, ${patch.scheduledAt ?? null}),
      archive_deadline_at = CASE WHEN ${patch.archiveDeadlineAt !== undefined ? 1 : 0} THEN ${patch.archiveDeadlineAt ?? null} ELSE archive_deadline_at END,
      archive_basename = CASE WHEN ${patch.archiveBasename !== undefined ? 1 : 0} THEN ${patch.archiveBasename ?? null} ELSE archive_basename END,
      updated_at = ${input.now}, refreshed_at = NULL
      WHERE project_id = ${input.projectId} AND lease_epoch = ${input.leaseEpoch} AND owner_token = ${input.ownerToken}
      AND lease_until > ${input.now} RETURNING project_id`);
    }).pipe(Effect.mapError(toPersistenceSqlError("StaveLifecycleRepository.updateDisposition")));
  };
  const resetScheduleEpisode: StaveLifecycleRepositoryShape["resetScheduleEpisode"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const didReset = yield* changed(sql`UPDATE stave_project_lifecycle SET
      anchor_at = ${input.anchorAt}, scheduled_at = ${input.scheduledAt},
      archive_deadline_at = ${input.archiveDeadlineAt}, disposition = ${input.disposition},
      refusal_code = NULL, refusal_message = NULL, refreshed_at = NULL, updated_at = ${input.now}
      WHERE project_id = ${input.projectId} AND lease_epoch = ${input.leaseEpoch}
        AND owner_token = ${input.ownerToken} AND lease_until > ${input.now}
      RETURNING project_id`);
          if (didReset)
            yield* sql`DELETE FROM stave_lifecycle_schedule_resets WHERE project_id = ${input.projectId}`;
          return didReset;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("StaveLifecycleRepository.resetScheduleEpisode")),
      );
  const markRefreshed: StaveLifecycleRepositoryShape["markRefreshed"] = (input) =>
    changed(
      sql`UPDATE stave_project_lifecycle SET refreshed_at = ${input.refreshedAt} WHERE project_id = ${input.projectId} AND updated_at = ${input.updatedAt} RETURNING project_id`,
    );
  return {
    getByProjectId,
    getByWorkspaceRoot,
    listActiveBySpaceId,
    listPending,
    listDeletedCleanups,
    isProjectDeleted,
    listIncomplete,
    listUnrefreshed,
    observePolicy,
    isScheduleResetRequested,
    releaseExpiredLeases,
    ensure,
    acquireLease,
    renewLease,
    releaseLease,
    updateDisposition,
    resetScheduleEpisode,
    markRefreshed,
  } satisfies StaveLifecycleRepositoryShape;
});
export const layer = Layer.effect(StaveLifecycleRepository, make);
