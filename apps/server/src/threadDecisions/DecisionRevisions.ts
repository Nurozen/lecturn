import { ThreadDecisionError, type ProjectId } from "@lecturn/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const requireDecisionProject = Effect.fn("Decisions.requireProject")(function* (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
) {
  const rows = yield* sql<{
    project_id: string;
  }>`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`;
  if (!rows[0])
    return yield* new ThreadDecisionError({
      code: "not-found",
      message: "This project is no longer available.",
    });
});

export const readDecisionRevision = Effect.fn("Decisions.readRevision")(function* (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
) {
  const rows = yield* sql<{
    revision: number;
  }>`SELECT revision FROM decision_outbox WHERE project_id = ${projectId}`;
  return rows[0]?.revision ?? 0;
});

/** Invoke inside the mutation transaction; the durable outbox survives commit/notify crashes. */
export const bumpDecisionRevision = Effect.fn("Decisions.bumpRevision")(function* (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
) {
  yield* sql`INSERT INTO decision_outbox(project_id, revision) VALUES (${projectId}, 1)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1`;
  return yield* readDecisionRevision(sql, projectId);
});
