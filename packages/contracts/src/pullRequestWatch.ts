import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PullRequestCheck,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestState,
} from "./pullRequest.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const PullRequestWatchMergeMode = Schema.Literals(["follow-pr", "revision-only"]);
export type PullRequestWatchMergeMode = typeof PullRequestWatchMergeMode.Type;
export const PullRequestWatchChecksState = Schema.Literals([
  "passing",
  "failing",
  "pending",
  "none",
  "unknown",
]);
export const PullRequestWatchAuthorization = Schema.Struct({
  mode: PullRequestWatchMergeMode,
  headRevision: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: TrimmedNonEmptyString,
  mergeMethod: PullRequestMergeMethod,
  authorizedAt: IsoDateTime,
  authorizedBy: TrimmedNonEmptyString,
  status: Schema.Literals(["waiting", "armed", "merged", "needs-authorization", "blocked"]),
  message: Schema.NullOr(Schema.String),
});
export type PullRequestWatchAuthorization = typeof PullRequestWatchAuthorization.Type;
export const PullRequestWatchObservation = Schema.Struct({
  provider: SourceControlProviderKind,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
  headRevision: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: TrimmedNonEmptyString,
  reviewDecision: Schema.NullOr(Schema.String),
  checks: Schema.Array(PullRequestCheck),
  checksState: PullRequestWatchChecksState,
  requiredChecks: PullRequestWatchChecksState,
  checksRevision: Schema.NullOr(TrimmedNonEmptyString),
  mergeable: Schema.Boolean,
  autoMergeEnabled: Schema.NullOr(Schema.Boolean),
  supportsAutoMerge: Schema.Boolean,
  supportsRevisionMerge: Schema.Boolean,
  observedAt: IsoDateTime,
});
export type PullRequestWatchObservation = typeof PullRequestWatchObservation.Type;
export const PullRequestWatch = Schema.Struct({
  id: TrimmedNonEmptyString,
  reference: PullRequestRef,
  revision: NonNegativeInt,
  binding: TrimmedNonEmptyString,
  watching: Schema.Boolean,
  threadIds: Schema.Array(ThreadId),
  managerThreadId: Schema.NullOr(ThreadId),
  managerStatus: Schema.Literals(["working", "monitoring", "idle", "offline", "unassigned"]),
  observation: Schema.NullOr(PullRequestWatchObservation),
  authorization: Schema.NullOr(PullRequestWatchAuthorization),
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PullRequestWatch = typeof PullRequestWatch.Type;
export const PullRequestWatchSnapshot = Schema.Struct({
  watches: Schema.Array(PullRequestWatch),
  defaultMergeMode: PullRequestWatchMergeMode,
});
export type PullRequestWatchSnapshot = typeof PullRequestWatchSnapshot.Type;
export const PullRequestWatchListInput = Schema.Struct({
  projectIds: Schema.optional(Schema.Array(ProjectId)),
});
export type PullRequestWatchListInput = typeof PullRequestWatchListInput.Type;
export const PullRequestWatchTrackInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  reference: PullRequestRef,
  threadId: Schema.optional(ThreadId),
  manage: Schema.optional(Schema.Boolean),
});
export type PullRequestWatchTrackInput = typeof PullRequestWatchTrackInput.Type;
export const PullRequestWatchCommandInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  watchId: TrimmedNonEmptyString,
  action: Schema.Literals([
    "refresh",
    "resume",
    "pause",
    "authorize-merge",
    "revoke-merge",
    "set-manager",
  ]),
  mergeMode: Schema.optional(PullRequestWatchMergeMode),
  mergeMethod: Schema.optional(PullRequestMergeMethod),
  managerThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  expectedHeadRevision: Schema.optional(TrimmedNonEmptyString),
  expectedBaseBranch: Schema.optional(TrimmedNonEmptyString),
  expectedBinding: Schema.optional(TrimmedNonEmptyString),
});
export type PullRequestWatchCommandInput = typeof PullRequestWatchCommandInput.Type;
export const PullRequestWatchConfigureInput = Schema.Struct({
  defaultMergeMode: PullRequestWatchMergeMode,
});
export type PullRequestWatchConfigureInput = typeof PullRequestWatchConfigureInput.Type;
export class PullRequestWatchError extends Schema.TaggedErrorClass<PullRequestWatchError>()(
  "PullRequestWatchError",
  {
    code: Schema.Literals(["not-found", "invalid", "conflict", "unavailable", "forbidden"]),
    message: Schema.String,
  },
) {}
