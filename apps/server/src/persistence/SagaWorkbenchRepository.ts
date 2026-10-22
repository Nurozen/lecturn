import {
  SagaWorkbenchActivity,
  SagaWorkbenchError,
  type SagaWorkbenchIdentity,
  SagaWorkbenchWorkflow,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
export const workflowIdentityKey = (identity: SagaWorkbenchIdentity) =>
  JSON.stringify([
    identity.projectId,
    identity.workspaceRoot,
    identity.spaceId,
    identity.createdAt,
  ]);
export const emptyWorkflow = (identity: SagaWorkbenchIdentity): SagaWorkbenchWorkflow => ({
  identity,
  revision: 0,
  stage: "spec",
  accepted: null,
  completedAt: null,
  summary: null,
});
export interface WorkflowReceiptKey {
  identity: SagaWorkbenchIdentity;
  actorKey: string;
  requestId: string;
  requestHash: string;
}
export class SagaWorkbenchRepository extends Context.Service<
  SagaWorkbenchRepository,
  {
    get: (
      identity: SagaWorkbenchIdentity,
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
    /** Read-only recovery after a verified archive move; ambiguous histories are unavailable. */
    findIncarnation: (
      identity: SagaWorkbenchIdentity,
    ) => Effect.Effect<SagaWorkbenchWorkflow | null, SagaWorkbenchError>;
    receipt: (
      input: WorkflowReceiptKey,
    ) => Effect.Effect<SagaWorkbenchWorkflow | null, SagaWorkbenchError>;
    save: (
      input: WorkflowReceiptKey & {
        expectedRevision: number;
        workflow: SagaWorkbenchWorkflow;
        activity: SagaWorkbenchActivity;
      },
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
    activity: (
      identity: SagaWorkbenchIdentity,
    ) => Effect.Effect<readonly SagaWorkbenchActivity[], SagaWorkbenchError>;
  }
>()("lecturn/persistence/SagaWorkbenchRepository") {}
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(SagaWorkbenchWorkflow));
const encode = Schema.encodeEffect(Schema.fromJsonString(SagaWorkbenchWorkflow));
const encodeActivity = Schema.encodeEffect(Schema.fromJsonString(SagaWorkbenchActivity));
const decodeActivity = Schema.decodeUnknownEffect(Schema.fromJsonString(SagaWorkbenchActivity));
const isWorkbenchError = Schema.is(SagaWorkbenchError);
const storage = (error: unknown) =>
  isWorkbenchError(error)
    ? error
    : new SagaWorkbenchError({
        code: "storage",
        message: "Workflow data could not be read or saved.",
      });
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get: SagaWorkbenchRepository["Service"]["get"] = (identity) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        workflow_json: string;
      }>`SELECT workflow_json FROM saga_workbench WHERE identity_key = ${workflowIdentityKey(identity)}`;
      return rows[0] ? yield* decode(rows[0].workflow_json) : emptyWorkflow(identity);
    }).pipe(Effect.mapError(storage));
  const findIncarnation: SagaWorkbenchRepository["Service"]["findIncarnation"] = (identity) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        workflow_json: string;
      }>`SELECT workflow_json FROM saga_workbench WHERE json_extract(workflow_json, '$.identity.projectId') = ${identity.projectId} AND json_extract(workflow_json, '$.identity.spaceId') = ${identity.spaceId} AND json_extract(workflow_json, '$.identity.createdAt') = ${identity.createdAt} LIMIT 2`;
      return rows.length === 1 ? yield* decode(rows[0]!.workflow_json) : null;
    }).pipe(Effect.mapError(storage));
  const receipt: SagaWorkbenchRepository["Service"]["receipt"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        request_hash: string;
        result_json: string;
      }>`SELECT request_hash, result_json FROM saga_workbench_receipts WHERE identity_key = ${workflowIdentityKey(input.identity)} AND actor_key = ${input.actorKey} AND request_id = ${input.requestId}`;
      if (!rows[0]) return null;
      if (rows[0].request_hash !== input.requestHash)
        return yield* new SagaWorkbenchError({
          code: "conflict",
          message: "This request identifier was already used for another workflow change.",
        });
      return yield* decode(rows[0].result_json);
    }).pipe(Effect.mapError(storage));
  const save: SagaWorkbenchRepository["Service"]["save"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const prior = yield* receipt(input);
          if (prior) return prior;
          const current = yield* get(input.identity);
          if (
            current.revision !== input.expectedRevision ||
            input.workflow.revision !== current.revision + 1 ||
            input.activity.revision !== input.workflow.revision ||
            workflowIdentityKey(input.workflow.identity) !== workflowIdentityKey(input.identity)
          )
            return yield* new SagaWorkbenchError({
              code: "conflict",
              message: "Workflow changed on another device. Refresh before trying again.",
            });
          const key = workflowIdentityKey(input.identity);
          const json = yield* encode(input.workflow);
          const activityJson = yield* encodeActivity(input.activity);
          yield* sql`INSERT INTO saga_workbench (identity_key, revision, workflow_json) VALUES (${key}, ${input.workflow.revision}, ${json}) ON CONFLICT(identity_key) DO UPDATE SET revision = excluded.revision, workflow_json = excluded.workflow_json`;
          yield* sql`INSERT INTO saga_workbench_receipts (identity_key, actor_key, request_id, request_hash, result_json) VALUES (${key},${input.actorKey},${input.requestId},${input.requestHash},${json})`;
          yield* sql`INSERT INTO saga_workbench_activity (identity_key, revision, activity_json) VALUES (${key},${input.activity.revision},${activityJson})`;
          yield* sql`DELETE FROM saga_workbench_activity WHERE identity_key = ${key} AND revision <= ${input.workflow.revision - 200}`;
          return input.workflow;
        }),
      )
      .pipe(Effect.mapError(storage));
  const activity: SagaWorkbenchRepository["Service"]["activity"] = (identity) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        activity_json: string;
      }>`SELECT activity_json FROM saga_workbench_activity WHERE identity_key = ${workflowIdentityKey(identity)} ORDER BY revision DESC LIMIT 200`;
      return yield* Effect.forEach(rows, (row) => decodeActivity(row.activity_json));
    }).pipe(Effect.mapError(storage));
  return SagaWorkbenchRepository.of({ get, findIncarnation, receipt, save, activity });
});
export const layer = Layer.effect(SagaWorkbenchRepository, make);
