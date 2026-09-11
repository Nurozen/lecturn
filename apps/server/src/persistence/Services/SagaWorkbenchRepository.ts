import { Context, Effect } from "effect";
import type {
  SagaWorkbenchActivity,
  SagaWorkbenchError,
  SagaWorkbenchIdentity,
  SagaWorkbenchWorkflow,
} from "@t3tools/contracts";
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
>()("t3/persistence/Services/SagaWorkbenchRepository") {}
