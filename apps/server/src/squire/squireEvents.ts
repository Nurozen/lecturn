import {
  type ApplicationStoredEvent,
  type OrchestrationV2Actor,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
  RunId,
  type ProjectId,
  SquireEvidence,
  type SquireEventToggles,
  type SquireThreadMarker,
  SquireTurnOutcome,
  type ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
  squireOutcome,
} from "@lecturn/contracts";
import {
  backgroundWorkHoldsCompletion,
  type PendingBackgroundWorkTask,
  turnItemUpdateCanEndBackgroundWork,
} from "@lecturn/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { SquireEventRow } from "./SquireRepository.ts";

/** The thread events the reactor turns into `squire_event` rows. */
export type SquireThreadEventKind =
  | "turn-finished"
  | "thread-stopped"
  | "waiting-on-user"
  | "pull-request-changed";

/** Delivery waits this long for a summary-bearing event's summary, then sends `partial`. */
export const SQUIRE_SUMMARY_WAIT_MS = 20_000;

export type SquirePullRequestState =
  | "checks:failed"
  | "checks:passed"
  | `review:${PullRequestReviewDecision}`
  | `mergeable:${Exclude<PullRequestMergeability, "unknown">}`
  | "merged"
  | "closed";

export const SquireEventPendingRequest = Schema.Struct({
  /** A runtime request kind, or `secret` for a pending secret-request item. */
  kind: Schema.String,
  requestId: Schema.String,
  createdAt: Schema.String,
  question: Schema.NullOr(Schema.String),
});
export type SquireEventPendingRequest = typeof SquireEventPendingRequest.Type;

/** The link snapshot as it was at this event's sequence, not as the projection holds it now. */
export const SquireEventPullRequest = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  /** Full sha, or `squirePullRequestRevision`'s fallback; render shortens it. */
  headSha: Schema.String,
  transition: Schema.String,
  state: PullRequestState,
  title: Schema.String,
  headBranch: Schema.String,
  baseBranch: Schema.String,
  checksState: Schema.NullOr(PullRequestChecksState),
  reviewDecision: Schema.NullOr(PullRequestReviewDecision),
  mergeability: Schema.NullOr(PullRequestMergeability),
  /** The thread's own agent is watching this PR, so it hears about it without the Squire. */
  threadSelfWatching: Schema.Boolean,
});
export type SquireEventPullRequest = typeof SquireEventPullRequest.Type;

/** `squire_event.payload_json`: the per-event overlay merged over the run-level summary. */
export const SquireEventPayload = Schema.Struct({
  /** Null for pull-request-changed: it renders the run summary's own outcome. */
  outcome: Schema.NullOr(SquireTurnOutcome),
  /** The run whose summary this event renders; null when the payload names none. */
  runId: Schema.NullOr(RunId),
  pendingRequest: Schema.NullOr(SquireEventPendingRequest),
  pullRequest: Schema.NullOr(SquireEventPullRequest),
  /** CI log lines, branch, and diff stats the batch quotes; absent when nothing captured them. */
  evidence: Schema.optionalKey(SquireEvidence),
});
export type SquireEventPayload = typeof SquireEventPayload.Type;
export const SquireEventPayloadJson = Schema.fromJsonString(SquireEventPayload);

/**
 * When the row may deliver. `at` is the moment the deferral counts from:
 * the run's terminal event for summary and background, the request's
 * creation for the waiting threshold.
 */
export type SquireEventTiming =
  | { readonly reason: "summary"; readonly at: DateTime.Utc }
  | { readonly reason: "background"; readonly at: DateTime.Utc }
  | { readonly reason: "threshold"; readonly at: DateTime.Utc };

export interface SquireEventCandidate {
  readonly kind: SquireThreadEventKind;
  readonly threadId: ThreadId;
  readonly stateKey: string;
  readonly timing: SquireEventTiming;
  readonly payload: SquireEventPayload;
}

/** Work the reactor does for an event besides inserting rows. */
export type SquireReactorEffect =
  /** A pending request or secret item stopped pending: drop its deferred row, outdate its cards. */
  | {
      readonly type: "request-resolved";
      readonly threadId: ThreadId;
      readonly requestId: string;
    }
  /** Drops the thread's deferred turn-finished rows of other runs. */
  | { readonly type: "run-started"; readonly threadId: ThreadId; readonly runId: RunId }
  /** Re-evaluate the thread's `background` deferred rows against its pending tasks now. */
  | { readonly type: "background-work-ended"; readonly threadId: ThreadId }
  | {
      readonly type: "thread-created";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly squire: SquireThreadMarker | null;
    }
  /** Cascade: grants, exclusions, key rows, cards; a deleted home thread re-homes. */
  | {
      readonly type: "thread-deleted";
      readonly threadId: ThreadId;
      readonly squire: SquireThreadMarker | null;
    }
  | { readonly type: "project-deleted"; readonly projectId: ProjectId }
  /** An approval-kind request on a home or probe thread: respond decline and log. */
  | {
      readonly type: "auto-decline";
      readonly threadId: ThreadId;
      readonly squire: SquireThreadMarker;
      readonly requestId: OrchestrationV2RuntimeRequest["id"];
      readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
    }
  /**
   * A run on a home thread (batch finalize, FYI rule) or a probe (answer)
   * reached a terminal status. Fires again for each later update of that run.
   */
  | {
      readonly type: "squire-run-ended";
      readonly threadId: ThreadId;
      readonly squire: SquireThreadMarker;
      readonly runId: RunId;
      readonly status: OrchestrationV2Run["status"];
    };

export interface SquireClassification {
  readonly candidates: ReadonlyArray<SquireEventCandidate>;
  readonly effects: ReadonlyArray<SquireReactorEffect>;
}

/**
 * What the stored payload cannot carry. Read only the fields
 * {@link squireClassifyNeeds} asks for; the rest are ignored.
 */
export interface SquireClassifyContext {
  /** The event thread's Squire marker; null for an ordinary thread. Not needed for project events. */
  readonly threadMarker: SquireThreadMarker | null;
  /** {@link squireInterruptActor} over the run's turn items; null when there is no interrupt request. */
  readonly interruptedBy: OrchestrationV2Actor | null;
  /** The thread's pending background tasks when the reactor reads the completed run. */
  readonly pendingBackgroundTasks: ReadonlyArray<
    Pick<PendingBackgroundWorkTask, "kind" | "awaited">
  >;
}

type DomainEvent<T extends OrchestrationV2DomainEvent["type"]> = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: T }
>;
type TurnItem<T extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { readonly type: T }
>;

const NONE: SquireClassification = { candidates: [], effects: [] };

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

const isApprovalKind = (kind: OrchestrationV2RuntimeRequest["kind"]) =>
  kind !== "user_input" && kind !== "auth_refresh";

/** Which context fields `classifySquireEvent` reads for this event. */
export function squireClassifyNeeds(stored: ApplicationStoredEvent): {
  readonly threadMarker: boolean;
  readonly interruptedBy: boolean;
  readonly pendingBackgroundTasks: boolean;
} {
  if (!("event" in stored)) {
    return { threadMarker: false, interruptedBy: false, pendingBackgroundTasks: false };
  }
  const { event } = stored;
  const status = event.type === "run.updated" ? event.payload.status : null;
  return {
    // thread.created and thread.deleted carry the marker in their own payload;
    // streaming and other ignored events need no read at all.
    threadMarker: MARKER_EVENT_TYPES.has(event.type) && turnItemMayClassify(event),
    interruptedBy: status === "interrupted" || status === "cancelled",
    pendingBackgroundTasks: status === "completed",
  };
}

const MARKER_EVENT_TYPES = new Set<OrchestrationV2DomainEvent["type"]>([
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "turn-item.updated",
  "run.background-work-cancelled",
  "thread.pull-request-link-updated",
]);

const turnItemMayClassify = (event: OrchestrationV2DomainEvent) =>
  event.type !== "turn-item.updated" ||
  event.payload.type === "secret_request" ||
  turnItemUpdateCanEndBackgroundWork(event.payload);

/**
 * The actor of the run's last interrupt request; one with no recorded
 * provenance (history from before it was recorded) counts as the user's. Null when the
 * run has none, which is a crash or reconcile, not a user stop.
 */
export function squireInterruptActor(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: RunId,
): OrchestrationV2Actor | null {
  const request = items.findLast(
    (item): item is TurnItem<"run_interrupt_request"> =>
      item.type === "run_interrupt_request" && item.runId === runId,
  );
  if (!request) return null;
  return request.createdBy ?? "user";
}

const THREAD_EVENT_KINDS = new Set<string>([
  "turn-finished",
  "thread-stopped",
  "waiting-on-user",
  "pull-request-changed",
]);

/**
 * Takes any `squire_event.kind`. The thread events carry a turn summary
 * (contracts `threadEventFields`), so delivery waits for it and the FYI rule
 * applies; voice notes, messages, triggers, and the Lead's kinds do not.
 */
export function isSummaryBearing(kind: string): kind is SquireThreadEventKind {
  return THREAD_EVENT_KINDS.has(kind);
}

export function squireEventToggle(
  kind: SquireThreadEventKind,
): Exclude<keyof SquireEventToggles, "waitingThresholdMinutes"> {
  switch (kind) {
    case "turn-finished":
      return "turnFinished";
    case "thread-stopped":
      return "threadStopped";
    case "waiting-on-user":
      return "waitingOnUser";
    case "pull-request-changed":
      return "pullRequestChanged";
  }
}

export type SquireStateKeyInput =
  | { readonly kind: "turn-finished" | "thread-stopped"; readonly runId: RunId }
  | { readonly kind: "waiting-on-user"; readonly pendingItemId: string }
  | {
      readonly kind: "pull-request-changed";
      readonly pullRequest: Pick<ThreadPullRequestLink, "host" | "repository" | "number" | "url">;
      readonly headSha: string;
      readonly state: SquirePullRequestState;
    };

/** The event's dedupe key; a PR's is `<host>/<repo>#<number>:<fullHeadSha>:<state>`. */
export function squireStateKey(input: SquireStateKeyInput): string {
  switch (input.kind) {
    case "turn-finished":
    case "thread-stopped":
      return input.runId;
    case "waiting-on-user":
      return input.pendingItemId;
    case "pull-request-changed":
      return `${threadPullRequestKeyOf(input.pullRequest)}:${input.headSha}:${input.state}`;
  }
}

const UPDATED_REVISION_PREFIX = "updated-";

/**
 * What a PR event is keyed per: the head sha, or for a provider that
 * reports none (Azure DevOps) the PR's last-updated time, so each state still
 * fires once per revision. None when the snapshot has neither. Colon-free,
 * like a sha, so `<prKey>:<revision>:<state>` still parses.
 */
export function squirePullRequestRevision(
  snapshot: Pick<ThreadPullRequestSnapshot, "headSha" | "updatedAt">,
): string | undefined {
  if (snapshot.headSha !== undefined) return snapshot.headSha;
  if (snapshot.updatedAt === null) return undefined;
  return `${UPDATED_REVISION_PREFIX}${snapshot.updatedAt.replaceAll(/\D/g, "")}`;
}

/** A revision that names a commit, not `squirePullRequestRevision`'s fallback. */
export const isHeadShaRevision = (revision: string) =>
  !revision.startsWith(UPDATED_REVISION_PREFIX);

/**
 * Every absolute state the snapshot is in. `pending` and `unknown`
 * are never states; a closed or merged PR is only that.
 */
export function squirePullRequestStates(
  snapshot: Pick<
    ThreadPullRequestSnapshot,
    "state" | "checksState" | "reviewDecision" | "mergeability"
  >,
): ReadonlyArray<SquirePullRequestState> {
  if (snapshot.state !== "open") return [snapshot.state];
  const states: Array<SquirePullRequestState> = [];
  if (snapshot.checksState === "failing") states.push("checks:failed");
  if (snapshot.checksState === "passing") states.push("checks:passed");
  // Only the GitHub provider fills reviewDecision, which makes review GitHub-only.
  if (snapshot.reviewDecision) states.push(`review:${snapshot.reviewDecision}`);
  if (snapshot.mergeability === "mergeable" || snapshot.mergeability === "conflicting") {
    states.push(`mergeable:${snapshot.mergeability}`);
  }
  return states;
}

/** The row's initial `status`, `defer_reason`, and `not_before` for one Squire. */
export function scheduleSquireEvent(
  timing: SquireEventTiming,
  squire: { readonly waitingThresholdMinutes: number },
): Pick<SquireEventRow, "status" | "defer_reason" | "not_before"> {
  switch (timing.reason) {
    // The reactor promotes it to `pending` once the summary settles or
    // not_before passes; delivery consumes only `pending` rows.
    case "summary":
      return {
        status: "deferred",
        defer_reason: "summary",
        not_before: DateTime.formatIso(
          DateTime.add(timing.at, { milliseconds: SQUIRE_SUMMARY_WAIT_MS }),
        ),
      };
    // Released by the reactor to `deferred`/`summary` with this same
    // not_before, so a summary that finished during the wait delivers at once.
    case "background":
      return {
        status: "deferred",
        defer_reason: "background",
        not_before: DateTime.formatIso(
          DateTime.add(timing.at, { milliseconds: SQUIRE_SUMMARY_WAIT_MS }),
        ),
      };
    case "threshold":
      return {
        status: "deferred",
        defer_reason: "threshold",
        not_before: DateTime.formatIso(
          DateTime.add(timing.at, { minutes: squire.waitingThresholdMinutes }),
        ),
      };
  }
}

function classifyRun(
  event: DomainEvent<"run.created" | "run.updated">,
  context: SquireClassifyContext,
): SquireClassification {
  const run = event.payload;
  const marker = context.threadMarker;
  if (marker !== null) {
    return event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(run.status)
      ? {
          candidates: [],
          effects: [
            {
              type: "squire-run-ended",
              threadId: event.threadId,
              squire: marker,
              runId: run.id,
              status: run.status,
            },
          ],
        }
      : NONE;
  }
  if (run.status === "starting" || run.status === "running") {
    return {
      candidates: [],
      effects: [{ type: "run-started", threadId: event.threadId, runId: run.id }],
    };
  }
  if (event.type !== "run.updated") return NONE;
  const outcome = squireOutcome({
    status: run.status,
    pendingRuntimeRequest: null,
    interruptedBy:
      run.status === "interrupted" || run.status === "cancelled" ? context.interruptedBy : null,
  });
  if (outcome === null) return NONE;
  const kind = outcome === "finished" ? "turn-finished" : "thread-stopped";
  const holds =
    kind === "turn-finished" && backgroundWorkHoldsCompletion(context.pendingBackgroundTasks);
  return {
    candidates: [
      {
        kind,
        threadId: event.threadId,
        stateKey: squireStateKey({ kind, runId: run.id }),
        timing: { reason: holds ? "background" : "summary", at: event.occurredAt },
        payload: { outcome, runId: run.id, pendingRequest: null, pullRequest: null },
      },
    ],
    effects: [],
  };
}

function classifyRuntimeRequest(
  event: DomainEvent<"runtime-request.updated">,
  context: SquireClassifyContext,
): SquireClassification {
  const request = event.payload;
  const marker = context.threadMarker;
  if (marker !== null) {
    return request.status === "pending" && isApprovalKind(request.kind)
      ? {
          candidates: [],
          effects: [
            {
              type: "auto-decline",
              threadId: event.threadId,
              squire: marker,
              requestId: request.id,
              requestKind: request.kind,
            },
          ],
        }
      : NONE;
  }
  if (request.kind === "auth_refresh") return NONE;
  if (request.status !== "pending") {
    return {
      candidates: [],
      effects: [{ type: "request-resolved", threadId: event.threadId, requestId: request.id }],
    };
  }
  const outcome = squireOutcome({
    status: "running",
    pendingRuntimeRequest: { kind: request.kind, requestId: request.id, question: null },
    interruptedBy: null,
  });
  return {
    candidates: [
      {
        kind: "waiting-on-user",
        threadId: event.threadId,
        stateKey: squireStateKey({ kind: "waiting-on-user", pendingItemId: request.id }),
        timing: { reason: "threshold", at: request.createdAt },
        payload: {
          outcome,
          runId: event.runId ?? null,
          pendingRequest: {
            kind: request.kind,
            requestId: request.id,
            createdAt: DateTime.formatIso(request.createdAt),
            question: null,
          },
          pullRequest: null,
        },
      },
    ],
    effects: [],
  };
}

function classifySecretRequest(
  event: DomainEvent<"turn-item.updated">,
  item: TurnItem<"secret_request">,
): SquireClassification {
  if (item.secretStatus !== "pending") {
    return {
      candidates: [],
      effects: [{ type: "request-resolved", threadId: event.threadId, requestId: item.id }],
    };
  }
  const createdAt = item.startedAt ?? item.updatedAt;
  const reason = item.reason.trim();
  return {
    candidates: [
      {
        kind: "waiting-on-user",
        threadId: event.threadId,
        stateKey: squireStateKey({ kind: "waiting-on-user", pendingItemId: item.id }),
        timing: { reason: "threshold", at: createdAt },
        payload: {
          outcome: "waiting-on-input",
          runId: item.runId ?? event.runId ?? null,
          pendingRequest: {
            kind: "secret",
            requestId: item.id,
            createdAt: DateTime.formatIso(createdAt),
            question: reason ? `${item.label}: ${reason}` : item.label,
          },
          pullRequest: null,
        },
      },
    ],
    effects: [],
  };
}

function classifyTurnItem(
  event: DomainEvent<"turn-item.updated">,
  context: SquireClassifyContext,
): SquireClassification {
  if (context.threadMarker !== null) return NONE;
  const item = event.payload;
  const secret = item.type === "secret_request" ? classifySecretRequest(event, item) : NONE;
  return turnItemUpdateCanEndBackgroundWork(item)
    ? {
        candidates: secret.candidates,
        effects: [...secret.effects, { type: "background-work-ended", threadId: event.threadId }],
      }
    : secret;
}

function classifyPullRequestLink(
  event: DomainEvent<"thread.pull-request-link-updated">,
  context: SquireClassifyContext,
): SquireClassification {
  const link = event.payload;
  const { snapshot } = link;
  if (context.threadMarker !== null || link.source === "stack-dismissed" || snapshot === null) {
    return NONE;
  }
  // A snapshot with no revision cannot be keyed per revision, so it could never fire twice.
  const headSha = squirePullRequestRevision(snapshot);
  if (headSha === undefined) return NONE;
  const candidates = squirePullRequestStates(snapshot).map((state): SquireEventCandidate => ({
    kind: "pull-request-changed",
    threadId: event.threadId,
    stateKey: squireStateKey({ kind: "pull-request-changed", pullRequest: link, headSha, state }),
    timing: { reason: "summary", at: event.occurredAt },
    payload: {
      outcome: null,
      runId: null,
      pendingRequest: null,
      pullRequest: {
        host: link.host,
        repository: link.repository,
        number: link.number,
        url: link.url,
        headSha,
        transition: state,
        state: snapshot.state,
        title: snapshot.title,
        headBranch: snapshot.headBranch,
        baseBranch: snapshot.baseBranch,
        checksState: snapshot.checksState ?? null,
        reviewDecision: snapshot.reviewDecision ?? null,
        mergeability: snapshot.mergeability ?? null,
        threadSelfWatching: link.watch !== undefined,
      },
    },
  }));
  return { candidates, effects: [] };
}

/**
 * Classifies one committed application event from its own payload, so
 * a lagging reactor still sees every transition. Squire actions on a thread
 * and user stops produce nothing; scope, toggles, and fixture
 * ownership are the reactor's to apply.
 */
export function classifySquireEvent(
  stored: ApplicationStoredEvent,
  context: SquireClassifyContext,
): SquireClassification {
  if (!("event" in stored)) {
    return stored.type === "project.deleted"
      ? {
          candidates: [],
          effects: [{ type: "project-deleted", projectId: stored.payload.projectId }],
        }
      : NONE;
  }
  const { event } = stored;
  switch (event.type) {
    case "run.created":
    case "run.updated":
      return classifyRun(event, context);
    case "runtime-request.updated":
      return classifyRuntimeRequest(event, context);
    case "turn-item.updated":
      return classifyTurnItem(event, context);
    case "run.background-work-cancelled":
      return context.threadMarker === null
        ? { candidates: [], effects: [{ type: "background-work-ended", threadId: event.threadId }] }
        : NONE;
    case "thread.pull-request-link-updated":
      return classifyPullRequestLink(event, context);
    case "thread.created":
      return {
        candidates: [],
        effects: [
          {
            type: "thread-created",
            threadId: event.threadId,
            projectId: event.payload.projectId,
            squire: event.payload.squire ?? null,
          },
        ],
      };
    case "thread.deleted":
      return {
        candidates: [],
        effects: [
          {
            type: "thread-deleted",
            threadId: event.threadId,
            squire: event.payload.squire ?? null,
          },
        ],
      };
    default:
      return NONE;
  }
}
