import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  StaveLifecycleRepository,
  StaveLifecycleRow,
  type StaveLifecycleRepositoryShape,
} from "../Services/StaveLifecycleRepository.ts";

const DbRow = StaveLifecycleRow.mapFields((fields) => ({
  ...fields,
  sagaRemoveConfirmed: Schema.Number,
}));
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(DbRow));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(
    'project_id AS "projectId", workspace_root AS "workspaceRoot", space_id AS "spaceId", manifest_created_at AS "manifestCreatedAt", disposition AS "disposition", delete_intent_sequence AS "deleteIntentSequence", saga_remove_confirmed AS "sagaRemoveConfirmed", refusal_code AS "refusalCode", refusal_message AS "refusalMessage", anchor_at AS "anchorAt", scheduled_at AS "scheduledAt", archive_deadline_at AS "archiveDeadlineAt", archive_basename AS "archiveBasename", lease_epoch AS "leaseEpoch", owner_token AS "ownerToken", lease_until AS "leaseUntil", updated_at AS "updatedAt", refreshed_at AS "refreshedAt"',
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
  const listPending: StaveLifecycleRepositoryShape["listPending"] = () =>
    read(
      sql`SELECT ${columns} FROM stave_project_lifecycle WHERE delete_intent_sequence IS NOT NULL OR disposition IN ('pending_evaluation','pending_destroy','pending_archive','archiving','restoring','destroying') ORDER BY project_id`,
    );
  const listIncomplete: StaveLifecycleRepositoryShape["listIncomplete"] = () =>
    read(
      sql`SELECT ${columns} FROM stave_project_lifecycle WHERE disposition IN ('archiving','restoring','destroying','destroyed') ORDER BY project_id`,
    );
  const listUnrefreshed: StaveLifecycleRepositoryShape["listUnrefreshed"] = () =>
    read(
      sql`SELECT ${columns} FROM stave_project_lifecycle WHERE refreshed_at IS NULL OR updated_at > refreshed_at ORDER BY project_id`,
    );
  const ensure: StaveLifecycleRepositoryShape["ensure"] = Effect.fn(
    "StaveLifecycleRepository.ensure",
  )(function* (input) {
    const rows =
      yield* read(sql`INSERT INTO stave_project_lifecycle (project_id,workspace_root,space_id,manifest_created_at,disposition,updated_at)
      VALUES (${input.projectId},${input.workspaceRoot},${input.spaceId},${input.manifestCreatedAt},'pending_evaluation',${input.now})
      ON CONFLICT(project_id) DO UPDATE SET project_id = excluded.project_id RETURNING ${columns}`);
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
    return changed(sql`UPDATE stave_project_lifecycle SET
      workspace_root = CASE WHEN ${patch.workspaceRoot !== undefined ? 1 : 0} THEN ${patch.workspaceRoot ?? null} ELSE workspace_root END,
      space_id = CASE WHEN ${patch.spaceId !== undefined ? 1 : 0} THEN ${patch.spaceId ?? null} ELSE space_id END,
      manifest_created_at = CASE WHEN ${patch.manifestCreatedAt !== undefined ? 1 : 0} THEN ${patch.manifestCreatedAt ?? null} ELSE manifest_created_at END,
      disposition = CASE WHEN ${patch.disposition !== undefined ? 1 : 0} THEN ${patch.disposition ?? null} ELSE disposition END,
      delete_intent_sequence = CASE WHEN ${patch.deleteIntentSequence !== undefined ? 1 : 0} THEN ${patch.deleteIntentSequence ?? null} ELSE delete_intent_sequence END,
      saga_remove_confirmed = CASE WHEN ${patch.sagaRemoveConfirmed !== undefined ? 1 : 0} THEN ${patch.sagaRemoveConfirmed === true ? 1 : 0} ELSE saga_remove_confirmed END,
      refusal_code = CASE WHEN ${patch.refusalCode !== undefined ? 1 : 0} THEN ${patch.refusalCode ?? null} ELSE refusal_code END,
      refusal_message = CASE WHEN ${patch.refusalMessage !== undefined ? 1 : 0} THEN ${patch.refusalMessage ?? null} ELSE refusal_message END,
      anchor_at = CASE WHEN ${patch.anchorAt !== undefined ? 1 : 0} THEN ${patch.anchorAt ?? null} ELSE anchor_at END,
      scheduled_at = COALESCE(scheduled_at, ${patch.scheduledAt ?? null}),
      archive_deadline_at = CASE WHEN ${patch.archiveDeadlineAt !== undefined ? 1 : 0} THEN ${patch.archiveDeadlineAt ?? null} ELSE archive_deadline_at END,
      archive_basename = CASE WHEN ${patch.archiveBasename !== undefined ? 1 : 0} THEN ${patch.archiveBasename ?? null} ELSE archive_basename END,
      updated_at = ${input.now}, refreshed_at = NULL
      WHERE project_id = ${input.projectId} AND lease_epoch = ${input.leaseEpoch} AND owner_token = ${input.ownerToken}
      AND lease_until > ${input.now} RETURNING project_id`);
  };
  const markRefreshed: StaveLifecycleRepositoryShape["markRefreshed"] = (input) =>
    changed(
      sql`UPDATE stave_project_lifecycle SET refreshed_at = ${input.refreshedAt} WHERE project_id = ${input.projectId} AND updated_at = ${input.updatedAt} RETURNING project_id`,
    );
  return {
    getByProjectId,
    getByWorkspaceRoot,
    listPending,
    listIncomplete,
    listUnrefreshed,
    ensure,
    acquireLease,
    renewLease,
    releaseLease,
    updateDisposition,
    markRefreshed,
  } satisfies StaveLifecycleRepositoryShape;
});
export const StaveLifecycleRepositoryLive = Layer.effect(StaveLifecycleRepository, make);
