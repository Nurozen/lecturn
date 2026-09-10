import { ProjectId, IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { ProjectionRepositoryError } from "../Errors.ts";

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
  readonly listPending: () => Result<ReadonlyArray<StaveLifecycleRow>>;
  readonly listIncomplete: () => Result<ReadonlyArray<StaveLifecycleRow>>;
  readonly listUnrefreshed: () => Result<ReadonlyArray<StaveLifecycleRow>>;
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
  readonly markRefreshed: (input: {
    readonly projectId: ProjectId;
    readonly updatedAt: string;
    readonly refreshedAt: string;
  }) => Result<boolean>;
}
export class StaveLifecycleRepository extends Context.Service<
  StaveLifecycleRepository,
  StaveLifecycleRepositoryShape
>()("t3/persistence/Services/StaveLifecycleRepository") {}
